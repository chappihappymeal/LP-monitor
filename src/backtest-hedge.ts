/**
 * Бэктест дельта-хеджированной LP-стратегии на реальной истории.
 *
 * Конструкция: LP-позиция ±w в пуле Orca + шорт SOL-перпа размером в текущую
 * дельту LP (количество SOL в позиции). Ре-хедж — по правилу: когда рассинхрон
 * |шорт − дельта| превышает порог (в % от стоимости LP), шорт подтягивается к
 * дельте. Фандинг перпа — реальная почасовая история Hyperliquid (положительный
 * фандинг платят лонги, т.е. наш шорт его получает). Издержки хеджа: тейкер +
 * слиппедж (по умолчанию 5 б.п. с нотионала сделки).
 *
 * Хедж убирает направленный риск SOL, но гамма-издержки LP (LVR) остаются:
 * итог ≈ комиссии − LVR ± фандинг − издержки. Бэктест показывает, был ли этот
 * керри положительным на фактической истории.
 *
 * Запуск: npm run backtest:hedge [-- <дней> <value-usd> <адрес-пула>]
 */
import { fetchHourlyCandles, realizedVolDaily, type Candle } from "./lib/candles.js";
import { fetchFundingHistory, fundingByHour } from "./lib/funding.js";
import { fetchPoolDoc } from "./lib/orcaApi.js";

const DEFAULT_POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const DAYS = Number(args[0]) || 365;
const VALUE_USD = Number(args[1]) || 320;
const POOL = args[2] ?? DEFAULT_POOL;

const NETWORK_FEE_USD = 0.12;
const HEDGE_FEE = 0.0005; // тейкер+слиппедж перпа, доля нотионала сделки
const VOL_WINDOW_H = 48;

interface PoolParams {
  feeRate: number;
  poolLiquidity: number;
  rawScale: number;
  decB: number;
  feePerUsdVolume: number;
}

interface HedgeResult {
  name: string;
  pnl: number; // абсолютный итог, $
  lpFees: number;
  lpCosts: number;
  funding: number; // + получено / − заплачено
  hedgeCosts: number;
  rebalances: number;
  rehedges: number;
  maxDrawdown: number;
}

function run(
  name: string,
  candles: Candle[],
  fundingRates: Map<number, number>,
  pool: PoolParams,
  width: number,
  hedgeBand: number | null, // порог ре-хеджа в долях стоимости LP; null = без хеджа
  volPausePct: number | null = null,
): HedgeResult {
  const toRawSqrt = (p: number): number => Math.sqrt(p * pool.rawScale);
  const kWidth = (w: number): number => 2 - 1 / Math.sqrt(1 + w) - Math.sqrt(1 - w);

  let lower = 0;
  let upper = 0;
  let L = 0;
  let inPool = false;
  let idleA = 0; // вне пула: держим 50/50
  let idleB = 0;

  // Дельта LP в единицах SOL (= количество токена A в позиции).
  const amountA = (p: number): number => {
    if (!inPool) return idleA;
    const su = toRawSqrt(upper);
    const sl = toRawSqrt(lower);
    const sp = toRawSqrt(Math.min(Math.max(p, lower), upper));
    return (L * (1 / sp - 1 / su)) / (10 ** pool.decB / pool.rawScale);
  };
  const lpValue = (p: number): number => {
    if (!inPool) return idleA * p + idleB;
    const sp = toRawSqrt(p);
    const sl = toRawSqrt(lower);
    const su = toRawSqrt(upper);
    let vRawB: number;
    if (p <= lower) vRawB = L * (1 / sl - 1 / su) * p * pool.rawScale;
    else if (p >= upper) vRawB = L * (su - sl);
    else vRawB = L * (2 * sp - (p * pool.rawScale) / su - sl);
    return vRawB / 10 ** pool.decB;
  };

  let lpFees = 0;
  let lpCosts = 0;
  let funding = 0;
  let hedgeCosts = 0;
  let rebalances = 0;
  let rehedges = 0;
  let short = 0; // размер шорта, SOL
  let perpPnl = 0;

  const p0 = candles[VOL_WINDOW_H].close;
  const enter = (p: number, v: number): void => {
    const cost = 0.25 * v * pool.feeRate + NETWORK_FEE_USD;
    lpCosts += cost;
    v -= cost;
    lower = p * (1 - width);
    upper = p * (1 + width);
    L = (v * 10 ** pool.decB) / (toRawSqrt(p) * kWidth(width));
    inPool = true;
    rebalances++;
  };
  const exit = (p: number): number => {
    const v = lpValue(p);
    const cost = 0.25 * v * pool.feeRate + NETWORK_FEE_USD;
    lpCosts += cost;
    inPool = false;
    return v - cost;
  };
  const setHedge = (target: number, p: number): void => {
    const delta = Math.abs(target - short);
    if (delta * p < 0.5) return;
    hedgeCosts += delta * p * HEDGE_FEE;
    short = target;
    rehedges++;
  };

  enter(p0, VALUE_USD);
  if (hedgeBand != null) setHedge(amountA(p0), p0);

  let prevP = p0;
  let peak = VALUE_USD;
  let maxDrawdown = 0;

  for (let i = VOL_WINDOW_H; i < candles.length; i++) {
    const c = candles[i];
    const p = c.close;

    // Перп: PnL шорта + фандинг (реальная почасовая ставка)
    perpPnl += short * (prevP - p);
    const rate = fundingRates.get(Math.floor(c.time / 3600) * 3600) ?? 0;
    funding += short * p * rate;
    prevP = p;

    const vol = volPausePct != null ? realizedVolDaily(candles, i, VOL_WINDOW_H) * 100 : 0;

    if (inPool) {
      const touched = c.low <= lower || c.high >= upper;
      const storm = volPausePct != null && vol >= volPausePct;
      if (touched || storm) {
        const edge = c.low <= lower ? lower : c.high >= upper ? upper : p;
        const v0 = lpValue(edge);
        const swapCost = 0.5 * v0 * pool.feeRate;
        lpCosts += swapCost;
        const v = v0 - swapCost - NETWORK_FEE_USD;
        lpCosts += NETWORK_FEE_USD;
        if (storm) {
          inPool = false;
          idleA = v / 2 / p;
          idleB = v / 2;
        } else {
          lower = edge * (1 - width);
          upper = edge * (1 + width);
          L = (v * 10 ** pool.decB) / (toRawSqrt(edge) * kWidth(width));
          rebalances++;
        }
        if (hedgeBand != null) setHedge(amountA(p), p);
      } else {
        if (p > lower && p < upper) {
          lpFees += pool.feePerUsdVolume * c.volumeUsd * (L / pool.poolLiquidity);
        }
        if (hedgeBand != null) {
          const target = amountA(p);
          const v = lpValue(p);
          if (Math.abs(target - short) * p > hedgeBand * v) setHedge(target, p);
        }
      }
    } else if (volPausePct != null && vol < volPausePct * 0.8) {
      enter(p, idleA * p + idleB);
      idleA = 0;
      idleB = 0;
      if (hedgeBand != null) setHedge(amountA(p), p);
    }

    const wealth = lpValue(p) + lpFees + perpPnl + funding - hedgeCosts;
    peak = Math.max(peak, wealth);
    maxDrawdown = Math.max(maxDrawdown, peak - wealth);
  }

  const pEnd = candles[candles.length - 1].close;
  return {
    name,
    pnl: lpValue(pEnd) + lpFees + perpPnl + funding - hedgeCosts - VALUE_USD,
    lpFees,
    lpCosts,
    funding,
    hedgeCosts,
    rebalances,
    rehedges,
    maxDrawdown,
  };
}

// ── Данные ──────────────────────────────────────────────────────────────────
const [doc, candles, fundingPts] = await Promise.all([
  fetchPoolDoc(POOL),
  fetchHourlyCandles("SOL-USD", DAYS),
  fetchFundingHistory("SOL", DAYS),
]);
if (!doc) throw new Error("Orca API недоступен");
const fundingRates = fundingByHour(fundingPts);

const cex7dVol = candles.slice(-168).reduce((s, c) => s + c.volumeUsd, 0);
const volScale = (doc.stats["7d"]?.volume ?? 0) / cex7dVol;
const pool: PoolParams = {
  feeRate: doc.feeRate / 1e6,
  poolLiquidity: Number(doc.liquidity),
  rawScale: 10 ** (doc.tokenB.decimals - doc.tokenA.decimals),
  decB: doc.tokenB.decimals,
  feePerUsdVolume: (doc.feeRate / 1e6) * volScale,
};

const p0 = candles[VOL_WINDOW_H].close;
const pEnd = candles[candles.length - 1].close;
const avgFundingApr =
  (fundingPts.reduce((s, f) => s + f.rate, 0) / fundingPts.length) * 24 * 365 * 100;
console.log(
  `История ${((candles.length - VOL_WINDOW_H) / 24).toFixed(0)} дн.: цена ${p0.toFixed(1)} → ${pEnd.toFixed(1)} (${((pEnd / p0 - 1) * 100).toFixed(1)}%), фандинг SOL в среднем ${avgFundingApr.toFixed(1)}% годовых (${fundingPts.length} час. точек)`,
);
console.log(
  `LP $${VALUE_USD}, издержки хеджа ${HEDGE_FEE * 1e4} б.п., шорт-хедж = дельта LP (кол-во SOL в позиции)\n`,
);

const results: HedgeResult[] = [];
for (const width of [0.05, 0.117, 0.2]) {
  results.push(run(`±${(width * 100).toFixed(1)}% без хеджа`, candles, fundingRates, pool, width, null));
  for (const band of [0.01, 0.03, 0.07]) {
    results.push(
      run(
        `±${(width * 100).toFixed(1)}% хедж-порог ${(band * 100).toFixed(0)}%`,
        candles,
        fundingRates,
        pool,
        width,
        band,
      ),
    );
  }
}
results.push(run("±11.7% хедж 3% + вола-пауза 5%", candles, fundingRates, pool, 0.117, 0.03, 5));

const hodl = (VALUE_USD / 2) * (pEnd / p0) + VALUE_USD / 2 - VALUE_USD;
const f = (v: number, w = 9): string => ((v >= 0 ? "+" : "") + v.toFixed(2)).padStart(w);
console.log(
  "  стратегия                      |    PnL $  | комиссии | LP-издерж | фандинг | издержки хеджа | ребал | ре-хедж | max просадка",
);
for (const r of results) {
  console.log(
    `  ${r.name.padEnd(30)} | ${f(r.pnl)} | ${f(r.lpFees)} | ${f(-r.lpCosts)} | ${f(r.funding)} | ${f(-r.hedgeCosts, 14)} | ${String(r.rebalances).padStart(5)} | ${String(r.rehedges).padStart(7)} | ${f(-r.maxDrawdown, 12)}`,
  );
}
console.log(`  ${"HODL 50/50".padEnd(30)} | ${f(hodl)} |        — |         — |       — |              — |     — |       — |            —`);
console.log(`  ${"100% USDC".padEnd(30)} | ${f(0)} |        — |         — |       — |              — |     — |       — |            —`);
console.log(`\nПримечание: хедж требует маржи на перпе (~половина стоимости LP при 1x по шорту);
доходность на суммарный капитал (LP + маржа) ниже табличной примерно в 1.4–1.5 раза.`);
