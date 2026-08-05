/**
 * Бэктест асимметричной защиты LP-позиции: «рост наш, падение режем».
 *
 * Базовая нога: LP ±w с ребалансом на границе (как в боте).
 * Защитные варианты:
 *  A. Трейлинг-выход: цена ниже 30-дневного максимума на X% → полностью
 *     закрываемся в USDC; возврат — когда цена поднимается выше уровня
 *     максимум·(1−R), R < X (гистерезис). Перп не нужен.
 *  B. Триггерный шорт (синтетический пут): LP держим всегда; когда цена ниже
 *     максимума на X% — включаем шорт перпа размером в дельту LP (ре-хедж при
 *     рассинхроне 3% стоимости), выше уровня X−2% — выключаем. Фандинг перпа —
 *     реальная история Hyperliquid, начисляется только пока шорт активен.
 *
 * Все переключения защиты оплачиваются (свапы/перп-комиссии) и учитываются
 * отдельной строкой «guard-издержки» — это и есть цена whipsaw.
 *
 * Запуск: npm run backtest:guard [-- <дней> <value-usd> <адрес-пула>]
 */
import { fetchHourlyCandles, type Candle } from "./lib/candles.js";
import { fetchFundingHistory, fundingByHour } from "./lib/funding.js";
import { fetchPoolDoc } from "./lib/orcaApi.js";

const DEFAULT_POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const MIRROR = process.argv.includes("--mirror"); // зеркальный рынок: инвертируем доходности
const DAYS = Number(args[0]) || 365;
const VALUE_USD = Number(args[1]) || 320;
const POOL = args[2] ?? DEFAULT_POOL;

const NETWORK_FEE_USD = 0.12;
const HEDGE_FEE = 0.0005; // тейкер+слиппедж перпа
const SWAP_FEE = 0.0005; // свап SOL<->USDC при выходе/входе (агрегатор)
const HEDGE_BAND = 0.03; // порог ре-хеджа дельты при активном шорте
const TRAIL_WINDOW_H = 720; // окно трейлинг-максимума, 30 дней
const WARMUP_H = 720;

type Guard =
  | { type: "none" }
  | { type: "exit"; x: number; r: number }
  | { type: "short"; x: number; hyst: number }
  | { type: "fullhedge" };

interface Res {
  name: string;
  pnl: number;
  fees: number;
  lpCosts: number;
  funding: number;
  guardCosts: number;
  switches: number;
  inMarketPct: number;
  maxDD: number;
}

interface PoolParams {
  feeRate: number;
  poolLiquidity: number;
  rawScale: number;
  decB: number;
  feePerUsdVolume: number;
}

function rollingMax(candles: Candle[], window: number): number[] {
  const out = new Array<number>(candles.length);
  const deque: number[] = []; // индексы с убывающими high
  for (let i = 0; i < candles.length; i++) {
    while (deque.length && candles[deque[deque.length - 1]].high <= candles[i].high) deque.pop();
    deque.push(i);
    while (deque[0] <= i - window) deque.shift();
    out[i] = candles[deque[0]].high;
  }
  return out;
}

function run(
  name: string,
  candles: Candle[],
  trailHigh: number[],
  fundingRates: Map<number, number>,
  pool: PoolParams,
  width: number,
  guard: Guard,
): Res {
  const toRawSqrt = (p: number): number => Math.sqrt(p * pool.rawScale);
  const kWidth = (w: number): number => 2 - 1 / Math.sqrt(1 + w) - Math.sqrt(1 - w);

  let inPool = false;
  let lower = 0;
  let upper = 0;
  let L = 0;
  let usdc = 0; // вне рынка (вариант exit)
  let fees = 0;
  let lpCosts = 0;
  let guardCosts = 0;
  let funding = 0;
  let switches = 0;
  let short = 0;
  let perpPnl = 0;
  let hoursIn = 0;

  const amountA = (p: number): number => {
    if (!inPool) return 0;
    const su = toRawSqrt(upper);
    const sp = toRawSqrt(Math.min(Math.max(p, lower), upper));
    return (L * (1 / sp - 1 / su)) / (10 ** pool.decB / pool.rawScale);
  };
  const lpValue = (p: number): number => {
    if (!inPool) return usdc;
    const sp = toRawSqrt(p);
    const sl = toRawSqrt(lower);
    const su = toRawSqrt(upper);
    let vRawB: number;
    if (p <= lower) vRawB = L * (1 / sl - 1 / su) * p * pool.rawScale;
    else if (p >= upper) vRawB = L * (su - sl);
    else vRawB = L * (2 * sp - (p * pool.rawScale) / su - sl);
    return vRawB / 10 ** pool.decB;
  };

  const enter = (p: number, v: number, chargeSwap: boolean): void => {
    let cost = 0.25 * v * pool.feeRate + NETWORK_FEE_USD;
    if (chargeSwap) cost += 0.5 * v * SWAP_FEE; // USDC → 50/50
    if (chargeSwap) guardCosts += cost;
    else lpCosts += cost;
    v -= cost;
    lower = p * (1 - width);
    upper = p * (1 + width);
    L = (v * 10 ** pool.decB) / (toRawSqrt(p) * kWidth(width));
    inPool = true;
  };
  const exitToUsdc = (p: number): void => {
    let v = lpValue(p);
    const a = amountA(p);
    const cost = 0.25 * v * pool.feeRate + NETWORK_FEE_USD + a * p * SWAP_FEE;
    guardCosts += cost;
    usdc = v - cost;
    inPool = false;
  };
  const setShort = (target: number, p: number): void => {
    const d = Math.abs(target - short);
    if (d * p < 0.5) return;
    guardCosts += d * p * HEDGE_FEE;
    short = target;
  };

  const start = WARMUP_H;
  enter(candles[start].close, VALUE_USD, false);
  if (guard.type === "fullhedge") setShort(amountA(candles[start].close), candles[start].close);

  let prevP = candles[start].close;
  let peakW = VALUE_USD;
  let maxDD = 0;
  let riskOff = false;

  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const p = c.close;

    perpPnl += short * (prevP - p);
    if (short !== 0) {
      const rate = fundingRates.get(Math.floor(c.time / 3600) * 3600) ?? 0;
      funding += short * p * rate;
    }
    prevP = p;

    const high = trailHigh[i];
    const drawFromHigh = 1 - p / high;

    // ── Логика защиты ──
    if (guard.type === "exit") {
      if (!riskOff && drawFromHigh >= guard.x) {
        if (inPool) exitToUsdc(p);
        riskOff = true;
        switches++;
      } else if (riskOff && drawFromHigh <= guard.r) {
        enter(p, usdc, true);
        usdc = 0;
        riskOff = false;
        switches++;
      }
    } else if (guard.type === "short") {
      if (!riskOff && drawFromHigh >= guard.x) {
        riskOff = true;
        switches++;
        setShort(amountA(p), p);
      } else if (riskOff && drawFromHigh <= guard.x - guard.hyst) {
        riskOff = false;
        switches++;
        setShort(0, p);
      }
    }

    // ── LP-нога ──
    if (inPool) {
      hoursIn++;
      const touched = c.low <= lower || c.high >= upper;
      if (touched) {
        const edge = c.low <= lower ? lower : upper;
        let v = lpValue(edge);
        const cost = 0.5 * v * pool.feeRate + NETWORK_FEE_USD;
        lpCosts += cost;
        v -= cost;
        lower = edge * (1 - width);
        upper = edge * (1 + width);
        L = (v * 10 ** pool.decB) / (toRawSqrt(edge) * kWidth(width));
        fees += 0.5 * pool.feePerUsdVolume * c.volumeUsd * (L / pool.poolLiquidity);
      } else if (p > lower && p < upper) {
        fees += pool.feePerUsdVolume * c.volumeUsd * (L / pool.poolLiquidity);
      }
    }

    // ── Поддержание шорта ──
    if (guard.type === "fullhedge" || (guard.type === "short" && riskOff)) {
      const target = amountA(p);
      const v = Math.max(lpValue(p), 1);
      if (Math.abs(target - short) * p > HEDGE_BAND * v) setShort(target, p);
    }

    const wealth = lpValue(p) + fees + perpPnl + funding - (guard.type === "fullhedge" ? 0 : 0);
    const w = wealth - guardCosts + (inPool ? 0 : 0);
    peakW = Math.max(peakW, w);
    maxDD = Math.max(maxDD, peakW - w);
  }

  const pEnd = candles[candles.length - 1].close;
  return {
    name,
    pnl: lpValue(pEnd) + fees + perpPnl + funding - guardCosts - VALUE_USD,
    fees,
    lpCosts,
    funding,
    guardCosts,
    switches,
    inMarketPct: (hoursIn / (candles.length - start)) * 100,
    maxDD,
  };
}

// ── Данные ──────────────────────────────────────────────────────────────────
const [doc, candlesRaw, fundingPts] = await Promise.all([
  fetchPoolDoc(POOL),
  fetchHourlyCandles("SOL-USD", DAYS + 30), // +30 дней на прогрев трейлинг-окна
  fetchFundingHistory("SOL", DAYS + 30),
]);
if (!doc) throw new Error("Orca API недоступен");

// Зеркальный рынок: p' = p0²/p инвертирует каждую лог-доходность
// (high/low меняются местами); знак фандинга тоже инвертируем — в бычьем
// рынке лонги платят шортам. Объёмы оставляем как есть.
const candles = MIRROR
  ? (() => {
      const b = candlesRaw[0].close;
      return candlesRaw.map((c) => ({
        time: c.time,
        open: (b * b) / c.open,
        high: (b * b) / c.low,
        low: (b * b) / c.high,
        close: (b * b) / c.close,
        volumeUsd: c.volumeUsd,
      }));
    })()
  : candlesRaw;
const fundingRates = fundingByHour(
  MIRROR ? fundingPts.map((f) => ({ ...f, rate: -f.rate })) : fundingPts,
);
const trailHigh = rollingMax(candles, TRAIL_WINDOW_H);

const cex7dVol = candles.slice(-168).reduce((s, c) => s + c.volumeUsd, 0);
const volScale = (doc.stats["7d"]?.volume ?? 0) / cex7dVol;
const pool: PoolParams = {
  feeRate: doc.feeRate / 1e6,
  poolLiquidity: Number(doc.liquidity),
  rawScale: 10 ** (doc.tokenB.decimals - doc.tokenA.decimals),
  decB: doc.tokenB.decimals,
  feePerUsdVolume: (doc.feeRate / 1e6) * volScale,
};

const p0 = candles[WARMUP_H].close;
const pEnd = candles[candles.length - 1].close;
console.log(
  `История ${((candles.length - WARMUP_H) / 24).toFixed(0)} дн.: цена ${p0.toFixed(1)} → ${pEnd.toFixed(1)} (${((pEnd / p0 - 1) * 100).toFixed(1)}%), LP $${VALUE_USD}, ширина ±12%, трейлинг-окно 30 дн.\n`,
);

const W = 0.12;
const results: Res[] = [];
results.push(run("без защиты", candles, trailHigh, fundingRates, pool, W, { type: "none" }));
results.push(run("полный дельта-хедж", candles, trailHigh, fundingRates, pool, W, { type: "fullhedge" }));
for (const x of [0.08, 0.12, 0.16, 0.2]) {
  results.push(
    run(`A: выход при −${x * 100}%, возврат −${(x * 100) / 2}%`, candles, trailHigh, fundingRates, pool, W, {
      type: "exit",
      x,
      r: x / 2,
    }),
  );
}
for (const x of [0.05, 0.08, 0.12, 0.16]) {
  results.push(
    run(`B: шорт при −${x * 100}%, стоп −${x * 100 - 2}%`, candles, trailHigh, fundingRates, pool, W, {
      type: "short",
      x,
      hyst: 0.02,
    }),
  );
}

const hodl = (VALUE_USD / 2) * (pEnd / p0) + VALUE_USD / 2 - VALUE_USD;
const solOnly = VALUE_USD * (pEnd / p0) - VALUE_USD;
const f = (v: number, w = 9): string => ((v >= 0 ? "+" : "") + v.toFixed(2)).padStart(w);
console.log(
  "  стратегия                        |    PnL $  | комиссии | guard-издерж | фандинг | перекл. | в рынке | max просадка",
);
for (const r of results) {
  console.log(
    `  ${r.name.padEnd(32)} | ${f(r.pnl)} | ${f(r.fees)} | ${f(-r.guardCosts, 12)} | ${f(r.funding, 7)} | ${String(r.switches).padStart(6)} | ${(r.inMarketPct.toFixed(0) + "%").padStart(6)} | ${f(-r.maxDD, 12)}`,
  );
}
console.log(`  ${"HODL 50/50".padEnd(32)} | ${f(hodl)} |        — |            — |       — |      — |      — |            —`);
console.log(`  ${"100% SOL".padEnd(32)} | ${f(solOnly)} |        — |            — |       — |      — |      — |            —`);
console.log(`  ${"100% USDC".padEnd(32)} | ${f(0)} |        — |            — |       — |      — |      — |            —`);
