/**
 * Бэктест на реальной истории цены SOL (часовые свечи Coinbase, до 1 года).
 *
 * Комиссии пула моделируются от фактического часового объёма CEX,
 * откалиброванного к текущему объёму пула Orca (fees ∝ volume);
 * доля позиции — от текущей активной ликвидности пула (константа — допущение).
 *
 * Стратегии:
 *  - фиксированная ширина ±w, ребаланс при касании границы;
 *  - адаптивная: ширина зависит от реализованной волы (48ч), при шторме — выход
 *    в 50/50 вне пула; гистерезис и мин. время удержания режима;
 *  - momentum-вариант: асимметричный диапазон по знаку тренда за 72ч.
 *
 * Запуск: npm run backtest:history [-- <дней> <value-usd> <адрес-пула>]
 */
import { fetchHourlyCandles, realizedVolDaily, type Candle } from "./lib/candles.js";
import { fetchPoolDoc } from "./lib/orcaApi.js";

const DEFAULT_POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"; // SOL/USDC 0.04%

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const DAYS = Number(args[0]) || 365;
const VALUE_USD = Number(args[1]) || 320;
const POOL = args[2] ?? DEFAULT_POOL;
const NETWORK_FEE_USD = 0.12;
const VOL_WINDOW_H = 48;

interface PoolParams {
  feeRate: number;
  poolLiquidity: number;
  rawScale: number;
  decB: number;
  feePerUsdVolume: number; // комиссии пула на $1 объёма CEX (калибровка)
}

interface Result {
  name: string;
  final: number;
  fees: number;
  costs: number;
  rebalances: number;
  monthly: Map<string, { pnl: number; hodl: number }>;
}

type WidthRule = (volDaily: number, trend72h: number) => {
  width: number | null; // null = вне пула (50/50)
  biasUp?: number; // сдвиг диапазона: доля ширины, добавленная сверху (0.5 = симметрично)
};

const kWidth = (wl: number, wu: number): number =>
  2 - 1 / Math.sqrt(1 + wu) - Math.sqrt(1 - wl);

function runStrategy(
  name: string,
  candles: Candle[],
  pool: PoolParams,
  rule: WidthRule,
  minHoldHours = 12,
  hysteresis = 0.15,
): Result {
  const toRawSqrt = (price: number): number => Math.sqrt(price * pool.rawScale);
  let p0 = candles[VOL_WINDOW_H].close;

  // Состояние: либо LP-позиция (L, границы), либо 50/50 вне пула (amtA, amtB).
  let inPool = false;
  let lower = 0;
  let upper = 0;
  let L = 0;
  let wl = 0;
  let wu = 0;
  let amtA = (VALUE_USD / 2 / p0);
  let amtB = VALUE_USD / 2;
  let fees = 0;
  let costs = 0;
  let rebalances = 0;
  let currentWidth: number | null = null;
  let lastRegimeChange = -Infinity;
  const monthly = new Map<string, { pnl: number; hodl: number }>();

  const lpValueUsd = (price: number): number => {
    const sp = toRawSqrt(price);
    const sl = toRawSqrt(lower);
    const su = toRawSqrt(upper);
    let vRawB: number;
    if (price <= lower) vRawB = L * (1 / sl - 1 / su) * price * pool.rawScale;
    else if (price >= upper) vRawB = L * (su - sl);
    else vRawB = L * (2 * sp - (price * pool.rawScale) / su - sl);
    return vRawB / 10 ** pool.decB;
  };
  const totalValue = (price: number): number =>
    inPool ? lpValueUsd(price) : amtA * price + amtB;

  const enterPool = (price: number, w: number, biasUp: number): void => {
    let v = totalValue(price);
    // свап к нужному соотношению ≈ четверть стоимости в среднем
    const cost = 0.25 * v * pool.feeRate + NETWORK_FEE_USD;
    costs += cost;
    v -= cost;
    rebalances++;
    wl = w * 2 * (1 - biasUp);
    wu = w * 2 * biasUp;
    lower = price * (1 - wl);
    upper = price * (1 + wu);
    L = (v * 10 ** pool.decB) / (toRawSqrt(price) * kWidth(wl, wu));
    inPool = true;
  };
  const exitPool = (price: number): void => {
    let v = lpValueUsd(price);
    const cost = 0.25 * v * pool.feeRate + NETWORK_FEE_USD;
    costs += cost;
    v -= cost;
    amtA = v / 2 / price;
    amtB = v / 2;
    inPool = false;
  };

  let prevValue = VALUE_USD;
  let prevHodl = VALUE_USD;
  const hodlA = (VALUE_USD / 2) / p0;

  for (let i = VOL_WINDOW_H; i < candles.length; i++) {
    const c = candles[i];
    const vol = realizedVolDaily(candles, i, VOL_WINDOW_H);
    const trend = Math.log(c.close / candles[Math.max(0, i - 72)].close);
    const want = rule(vol, trend);

    // Смена режима ширины (с гистерезисом по мин. времени удержания)
    const regimeChanged =
      want.width !== currentWidth &&
      (currentWidth == null ||
        want.width == null ||
        Math.abs(want.width - currentWidth) / currentWidth > hysteresis);
    if (regimeChanged && i - lastRegimeChange >= minHoldHours) {
      if (want.width == null) {
        if (inPool) exitPool(c.close);
      } else {
        if (inPool) exitPool(c.close);
        enterPool(c.close, want.width, want.biasUp ?? 0.5);
      }
      currentWidth = want.width;
      lastRegimeChange = i;
    }

    if (inPool) {
      // Касание границы внутри часа → ребаланс на границе
      const touchedLower = c.low <= lower;
      const touchedUpper = c.high >= upper;
      if (touchedLower || touchedUpper) {
        const edge = touchedLower ? lower : upper;
        let v = lpValueUsd(edge);
        const cost = 0.5 * v * pool.feeRate + NETWORK_FEE_USD;
        costs += cost;
        v -= cost;
        rebalances++;
        const w = (wl + wu) / 2;
        lower = edge * (1 - wl);
        upper = edge * (1 + wu);
        L = (v * 10 ** pool.decB) / (toRawSqrt(edge) * kWidth(wl, wu));
        fees += 0.5 * pool.feePerUsdVolume * c.volumeUsd * (L / pool.poolLiquidity);
        void w;
      } else if (c.close > lower && c.close < upper) {
        fees += pool.feePerUsdVolume * c.volumeUsd * (L / pool.poolLiquidity);
      }
    }

    // Помесячная разбивка
    const month = new Date(c.time * 1000).toISOString().slice(0, 7);
    const v = totalValue(c.close) + fees;
    const hodl = hodlA * c.close + VALUE_USD / 2;
    const m = monthly.get(month) ?? { pnl: 0, hodl: 0 };
    m.pnl += v - prevValue;
    m.hodl += hodl - prevHodl;
    monthly.set(month, m);
    prevValue = v;
    prevHodl = hodl;
  }

  const last = candles[candles.length - 1].close;
  return {
    name,
    final: totalValue(last) + fees,
    fees,
    costs,
    rebalances,
    monthly,
  };
}

// ── Загрузка данных и калибровка ────────────────────────────────────────────
const [doc, candles] = await Promise.all([
  fetchPoolDoc(POOL),
  fetchHourlyCandles("SOL-USD", DAYS),
]);
if (!doc) throw new Error("Orca API недоступен");

const cex7dVol = candles.slice(-168).reduce((s, c) => s + c.volumeUsd, 0);
const pool7dVol = doc.stats["7d"]?.volume ?? 0;
const volScale = pool7dVol / cex7dVol; // объём пула на $1 объёма CEX
const pool: PoolParams = {
  feeRate: doc.feeRate / 1e6,
  poolLiquidity: Number(doc.liquidity),
  rawScale: 10 ** (doc.tokenB.decimals - doc.tokenA.decimals),
  decB: doc.tokenB.decimals,
  feePerUsdVolume: (doc.feeRate / 1e6) * volScale,
};

const p0 = candles[VOL_WINDOW_H].close;
const pEnd = candles[candles.length - 1].close;
console.log(
  `История: ${((candles.length - VOL_WINDOW_H) / 24).toFixed(0)} дн., цена ${p0.toFixed(1)} → ${pEnd.toFixed(1)} (${((pEnd / p0 - 1) * 100).toFixed(1)}%)`,
);
console.log(
  `Калибровка: объём пула/CEX = ${volScale.toFixed(2)}, комиссии пула ≈ $${((doc.stats["24h"]?.fees ?? 0) / 1000).toFixed(1)}k/день сейчас, позиция $${VALUE_USD}\n`,
);

const hodl5050 = (VALUE_USD / 2) * (pEnd / p0) + VALUE_USD / 2;

// ── Стратегии ───────────────────────────────────────────────────────────────
const fixed = (w: number): WidthRule => () => ({ width: w });

const adaptive =
  (t1: number, t2: number, t3: number, w1: number, w2: number, w3: number): WidthRule =>
  (vol) => {
    if (vol >= t3) return { width: null };
    if (vol >= t2) return { width: w3 };
    if (vol >= t1) return { width: w2 };
    return { width: w1 };
  };

const adaptiveMomentum =
  (t1: number, t2: number, t3: number, w1: number, w2: number, w3: number): WidthRule =>
  (vol, trend) => {
    const base = adaptive(t1, t2, t3, w1, w2, w3)(vol, trend);
    if (base.width == null) return base;
    // тренд за 72ч сильнее ±3% — смещаем диапазон по тренду
    if (trend > 0.03) return { width: base.width, biasUp: 0.7 };
    if (trend < -0.03) return { width: base.width, biasUp: 0.3 };
    return base;
  };

const strategies: Array<{ res: Result }> = [];
const run = (name: string, rule: WidthRule): Result => {
  const r = runStrategy(name, candles, pool, rule);
  strategies.push({ res: r });
  return r;
};

run("±2.5% фикс", fixed(0.025));
run("±5%   фикс", fixed(0.05));
run("±11.7% фикс", fixed(0.117));
run("±20%  фикс", fixed(0.2));
run("адаптив 2/3.5/6 → 3/8/15%", adaptive(0.02, 0.035, 0.06, 0.03, 0.08, 0.15));
run("адаптив+моментум", adaptiveMomentum(0.02, 0.035, 0.06, 0.03, 0.08, 0.15));

// Грид-поиск порогов адаптива
let best: { res: Result; desc: string } | null = null;
for (const t1 of [0.015, 0.02, 0.025, 0.03]) {
  for (const t3 of [0.045, 0.06, 0.08, 99]) {
    const t2 = (t1 + t3) / 2 > 0.05 ? 0.04 : (t1 + t3) / 2;
    for (const w1 of [0.025, 0.04, 0.06]) {
      for (const w3 of [0.12, 0.2]) {
        const w2 = Math.sqrt(w1 * w3);
        const r = runStrategy(
          `адаптив t=${t1 * 100}/${t2 * 100}/${t3 === 99 ? "∞" : t3 * 100} w=${w1 * 100}/${(w2 * 100).toFixed(1)}/${w3 * 100}%`,
          candles,
          pool,
          adaptive(t1, t2, t3, w1, w2, w3),
        );
        if (!best || r.final > best.res.final) best = { res: r, desc: r.name };
      }
    }
  }
}

console.log("  стратегия                  | итог $   | PnL      | vs HODL50/50 | комиссии | издержки | ребал.");
const row = (r: Result): void => {
  const f = (v: number, w = 8): string => (v >= 0 ? "+" : "") + v.toFixed(2).padStart(w - 1);
  console.log(
    `  ${r.name.padEnd(26)} | ${r.final.toFixed(0).padStart(7)} | ${f(r.final - VALUE_USD)} | ${f(r.final - hodl5050, 12)} | ${f(r.fees)} | ${f(-r.costs)} | ${String(r.rebalances).padStart(5)}`,
  );
};
for (const s of strategies) row(s.res);
console.log(`  ${"HODL 50/50".padEnd(26)} | ${hodl5050.toFixed(0).padStart(7)} | ${(hodl5050 - VALUE_USD >= 0 ? "+" : "") + (hodl5050 - VALUE_USD).toFixed(2)} |            — |        — |        — |     —`);
console.log(`\nЛучший адаптив по грид-поиску: ${best!.desc}`);
row(best!.res);

// Помесячная разбивка: лучший адаптив vs узкий фикс vs HODL
console.log("\nПо месяцам (PnL стратегии − PnL HODL50/50, $):");
console.log("  месяц    | ±5% фикс | адаптив(грид) | вола ср. | тренд");
const fixed5 = strategies[1].res;
const months = [...fixed5.monthly.keys()];
for (const m of months) {
  const f5 = fixed5.monthly.get(m)!;
  const ad = best!.res.monthly.get(m);
  // средняя вола и тренд месяца
  const idxs = candles
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => new Date(c.time * 1000).toISOString().slice(0, 7) === m);
  const vols = idxs
    .filter(({ i }) => i >= VOL_WINDOW_H && i % 24 === 0)
    .map(({ i }) => realizedVolDaily(candles, i, VOL_WINDOW_H));
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const trendM =
    idxs.length > 1 ? (idxs[idxs.length - 1].c.close / idxs[0].c.open - 1) * 100 : 0;
  const f = (v: number | undefined): string =>
    v == null ? "      —" : ((v >= 0 ? "+" : "") + v.toFixed(1)).padStart(7);
  console.log(
    `  ${m} | ${f(f5.pnl - f5.hodl)}  | ${f(ad ? ad.pnl - ad.hodl : undefined)}       | ${(avgVol * 100).toFixed(1).padStart(6)}% | ${(trendM >= 0 ? "+" : "") + trendM.toFixed(0)}%`,
  );
}
