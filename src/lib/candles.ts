import fs from "node:fs";
import path from "node:path";

export interface Candle {
  time: number; // unix seconds, начало часа
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number; // объём за час в USD
}

const CACHE_DIR = ".cache";

// Низкоуровневый фетч диапазона часовых свечей Coinbase (300 за запрос).
async function fetchRange(product: string, startSec: number, endSec: number): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let t = startSec; t < endSec; t += 300 * 3600) {
    const chunkEnd = Math.min(t + 300 * 3600, endSec);
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${new Date(t * 1000).toISOString()}&end=${new Date(chunkEnd * 1000).toISOString()}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "lp-monitor" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Coinbase ${res.status}: ${await res.text()}`);
    const rows: number[][] = await res.json();
    // формат: [time, low, high, open, close, volume(base)]
    for (const [time, low, high, open, close, vol] of rows) {
      out.push({ time, open, high, low, close, volumeUsd: vol * close });
    }
    await new Promise((r) => setTimeout(r, 350)); // rate limit
  }
  out.sort((a, b) => a.time - b.time);
  // Дедупликация на стыках чанков
  return out.filter((c, i) => i === 0 || c.time !== out[i - 1].time);
}

// Coinbase Exchange: до 300 свечей за запрос, пагинация по start/end.
export async function fetchHourlyCandles(
  product: string,
  days: number,
  ttlMs = 6 * 3600_000,
): Promise<Candle[]> {
  const cacheFile = path.join(CACHE_DIR, `${product}-1h-${days}d.json`);
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (Date.now() - cached.fetchedAt < ttlMs) return cached.candles;
  }

  const end = Math.floor(Date.now() / 1000 / 3600) * 3600;
  const dedup = await fetchRange(product, end - days * 86400, end);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), candles: dedup }));
  return dedup;
}

// ── Годовой store часовых свечей: бэкфилл один раз, дальше дотяжка ──────────

const STORE_DAYS = 365;
const storeTouchedAt = new Map<string, number>(); // троттлинг дотяжки

export async function ensureCandleStore(product: string): Promise<Candle[]> {
  const file = path.join(CACHE_DIR, `store-${product}-1h.json`);
  let candles: Candle[] = [];
  if (fs.existsSync(file)) {
    candles = (JSON.parse(fs.readFileSync(file, "utf8")) as { candles: Candle[] }).candles;
  }
  const nowHour = Math.floor(Date.now() / 1000 / 3600) * 3600;
  const last = candles.length ? candles[candles.length - 1].time : 0;
  const throttled = Date.now() - (storeTouchedAt.get(product) ?? 0) < 10 * 60_000;
  if (last >= nowHour || (candles.length > 0 && throttled)) return candles;

  const from = candles.length ? last + 3600 : nowHour - STORE_DAYS * 86400;
  const fresh = await fetchRange(product, from, nowHour);
  const merged = [...candles, ...fresh.filter((c) => c.time > last)];
  // Не даём файлу расти бесконечно: держим год + месяц запаса.
  const cutoff = nowHour - (STORE_DAYS + 30) * 86400;
  const trimmed = merged.filter((c) => c.time >= cutoff);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ product, updatedAt: Date.now(), candles: trimmed }));
  storeTouchedAt.set(product, Date.now());
  return trimmed;
}

export type Timeframe = "1h" | "4h" | "1d" | "1w" | "1M";

// Агрегация часовых свечей в старшие таймфреймы.
// Недели — с понедельника (эпоха 1970-01-01 — четверг), месяцы — календарные UTC.
export function aggregateCandles(candles: Candle[], tf: Timeframe): Candle[] {
  if (tf === "1h") return candles;
  const keyOf = (t: number): number => {
    if (tf === "4h") return Math.floor(t / (4 * 3600)) * 4 * 3600;
    if (tf === "1d") return Math.floor(t / 86400) * 86400;
    if (tf === "1w") return Math.floor((t - 4 * 86400) / (7 * 86400)) * 7 * 86400 + 4 * 86400;
    const d = new Date(t * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  };
  const byBucket = new Map<number, Candle>();
  for (const c of candles) {
    const k = keyOf(c.time);
    const g = byBucket.get(k);
    if (!g) {
      byBucket.set(k, { ...c, time: k });
    } else {
      g.high = Math.max(g.high, c.high);
      g.low = Math.min(g.low, c.low);
      g.close = c.close;
      g.volumeUsd += c.volumeUsd;
    }
  }
  return [...byBucket.values()].sort((a, b) => a.time - b.time);
}

// Реализованная волатильность (доля/день) по часовым доходностям за окно.
export function realizedVolDaily(candles: Candle[], endIdx: number, hours: number): number {
  const from = Math.max(1, endIdx - hours + 1);
  let sum = 0;
  let n = 0;
  for (let i = from; i <= endIdx; i++) {
    const r = Math.log(candles[i].close / candles[i - 1].close);
    sum += r * r;
    n++;
  }
  if (n === 0) return 0;
  return Math.sqrt((sum / n) * 24);
}
