import type { Candle } from "./candles.js";

// Технический анализ: уровни поддержки/сопротивления (свинг-точки + объёмный
// профиль), EMA, RSI, ATR. Всё считается из часовых свечей.

export interface Level {
  price: number;
  touches: number; // сколько раз цена тестировала уровень
  kind: "swing" | "volume";
  lastTouchDaysAgo: number;
}

export interface TaState {
  ema20: number;
  ema50: number;
  ema200: number;
  rsi14: number;
  atrPct: number; // средний дневной диапазон, %
  poc: number; // point of control объёмного профиля за 90 дней
  supports: Level[]; // ниже цены, ближайшие первыми
  resistances: Level[]; // выше цены, ближайшие первыми
}

interface Daily {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

function toDaily(candles: Candle[]): Daily[] {
  const byDay = new Map<number, Daily>();
  for (const c of candles) {
    const day = Math.floor(c.time / 86400) * 86400;
    const d = byDay.get(day);
    if (!d) {
      byDay.set(day, { time: day, open: c.open, high: c.high, low: c.low, close: c.close, volumeUsd: c.volumeUsd });
    } else {
      d.high = Math.max(d.high, c.high);
      d.low = Math.min(d.low, c.low);
      d.close = c.close;
      d.volumeUsd += c.volumeUsd;
    }
  }
  return [...byDay.values()].sort((a, b) => a.time - b.time);
}

function ema(values: number[], n: number): number {
  const k = 2 / (n + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(closes: number[], n = 14): number {
  if (closes.length < n + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

// Свинг-точки: локальные экстремумы дневных high/low (окно ±2 дня),
// кластеризация в уровни с допуском 1.5%.
function swingLevels(daily: Daily[], lookbackDays: number, now: number): Array<{ price: number; time: number }> {
  const from = now - lookbackDays * 86400;
  const pts: Array<{ price: number; time: number }> = [];
  for (let i = 2; i < daily.length - 2; i++) {
    const d = daily[i];
    if (d.time < from) continue;
    const isHigh = daily.slice(i - 2, i + 3).every((x) => x.high <= d.high);
    const isLow = daily.slice(i - 2, i + 3).every((x) => x.low >= d.low);
    if (isHigh) pts.push({ price: d.high, time: d.time });
    if (isLow) pts.push({ price: d.low, time: d.time });
  }
  return pts;
}

function clusterLevels(
  pts: Array<{ price: number; time: number }>,
  tolerance: number,
  now: number,
): Level[] {
  const sorted = [...pts].sort((a, b) => a.price - b.price);
  const out: Level[] = [];
  let group: Array<{ price: number; time: number }> = [];
  const flush = (): void => {
    if (!group.length) return;
    const price = group.reduce((s, p) => s + p.price, 0) / group.length;
    const lastTouch = Math.max(...group.map((p) => p.time));
    out.push({
      price,
      touches: group.length,
      kind: "swing",
      lastTouchDaysAgo: (now - lastTouch) / 86400,
    });
    group = [];
  };
  for (const p of sorted) {
    if (group.length && p.price / group[group.length - 1].price - 1 > tolerance) flush();
    group.push(p);
  }
  flush();
  return out;
}

// Объёмный профиль за 90 дней: логарифмические корзины по 1%.
function volumeProfile(candles: Candle[], days: number, now: number): { poc: number; hvns: Level[] } {
  const from = now - days * 86400;
  const buckets = new Map<number, number>();
  for (const c of candles) {
    if (c.time < from) continue;
    const key = Math.round(Math.log(c.close) / 0.01);
    buckets.set(key, (buckets.get(key) ?? 0) + c.volumeUsd);
  }
  const entries = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  if (!entries.length) return { poc: 0, hvns: [] };
  let pocKey = entries[0][0];
  let pocVol = 0;
  for (const [k, v] of entries) if (v > pocVol) { pocVol = v; pocKey = k; }
  // Локальные максимумы профиля (high-volume nodes), кроме самого POC
  const hvns: Level[] = [];
  for (let i = 1; i < entries.length - 1; i++) {
    const [k, v] = entries[i];
    if (k !== pocKey && v > entries[i - 1][1] && v > entries[i + 1][1] && v > pocVol * 0.35) {
      hvns.push({ price: Math.exp(k * 0.01), touches: Math.round((v / pocVol) * 10), kind: "volume", lastTouchDaysAgo: 0 });
    }
  }
  hvns.sort((a, b) => b.touches - a.touches);
  return { poc: Math.exp(pocKey * 0.01), hvns: hvns.slice(0, 3) };
}

export function computeTA(candles: Candle[], price: number): TaState {
  const daily = toDaily(candles);
  const closes = daily.map((d) => d.close);
  const now = daily[daily.length - 1].time;

  let atr = 0;
  const atrN = Math.min(14, daily.length - 1);
  for (let i = daily.length - atrN; i < daily.length; i++) {
    const tr = Math.max(
      daily[i].high - daily[i].low,
      Math.abs(daily[i].high - daily[i - 1].close),
      Math.abs(daily[i].low - daily[i - 1].close),
    );
    atr += tr / daily[i].close;
  }
  atr = (atr / atrN) * 100;

  const swings = clusterLevels(swingLevels(daily, 180, now), 0.015, now);
  const { poc, hvns } = volumeProfile(candles, 90, now);
  const all = [...swings, ...hvns];

  const supports = all
    .filter((l) => l.price < price * 0.995)
    .sort((a, b) => b.price - a.price)
    .slice(0, 3);
  const resistances = all
    .filter((l) => l.price > price * 1.005)
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);

  return {
    ema20: ema(closes.slice(-120), 20),
    ema50: ema(closes.slice(-250), 50),
    ema200: ema(closes, 200),
    rsi14: rsi(closes.slice(-60)),
    atrPct: atr,
    poc,
    supports,
    resistances,
  };
}

// Диапазон по уровням: нижняя граница — сильная поддержка, верхняя — сильное
// сопротивление (в разумных пределах ширины); фолбэк — симметричные ±12%.
export function suggestRange(
  ta: TaState,
  price: number,
): { lower: number; upper: number; basis: string } {
  const sup = ta.supports.find(
    (l) => l.touches >= 2 && price / l.price - 1 > 0.02 && price / l.price - 1 < 0.2,
  );
  const res = ta.resistances.find(
    (l) => l.touches >= 2 && l.price / price - 1 > 0.02 && l.price / price - 1 < 0.25,
  );
  const lower = sup ? sup.price * 0.995 : price * 0.88;
  const upper = res ? res.price * 1.005 : price * 1.12;
  const parts: string[] = [];
  parts.push(
    sup
      ? `низ — поддержка ~${sup.price.toFixed(1)} (${sup.touches} касаний)`
      : "низ — ±12% (сильной поддержки рядом нет)",
  );
  parts.push(
    res
      ? `верх — сопротивление ~${res.price.toFixed(1)} (${res.touches} касаний)`
      : "верх — +12% (сильного сопротивления рядом нет)",
  );
  return { lower, upper, basis: parts.join(", ") };
}
