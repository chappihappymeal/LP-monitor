/**
 * Бэктест стратегий ребаланса LP-позиции (Monte-Carlo, GBM-цена).
 *
 * Модель: цена ходит геометрическим броуновским движением с заданным дрейфом
 * (тренд, %/день) и волатильностью (%/день). Позиция — симметричный диапазон
 * ±w от цены входа. При касании границы — ребаланс: свап ~половины стоимости
 * (комиссия пула), сетевые издержки, новый диапазон вокруг текущей цены.
 * Комиссии начисляются как доля позиции в активной ликвидности пула от
 * фактических комиссий пула за 24ч (пока цена в диапазоне) и не реинвестируются.
 *
 * Зафиксированный импермалосс отдельно не моделируется — он возникает сам из
 * функции стоимости LP: у границы позиция полностью в дешевеющем токене, и
 * ребаланс закрепляет эту потерю против HODL.
 *
 * Запуск: npm run backtest [-- <стоимость-позиции-usd> <адрес-пула>]
 */
import { fetchPoolDoc } from "./lib/orcaApi.js";

const DEFAULT_POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"; // SOL/USDC 0.04%

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const VALUE_USD = Number(args[0]) || 320;
const POOL = args[1] ?? DEFAULT_POOL;

const HORIZON_DAYS = 30;
const STEPS_PER_DAY = 96; // 15-минутный шаг
const PATHS = 800;
const NETWORK_FEE_USD = 0.12; // close+swap+open, ~0.0015 SOL + приоритет

interface Strategy {
  name: string;
  width: number; // полуширина диапазона, доля от цены
  rebalance: boolean;
}

interface Scenario {
  name: string;
  muDaily: number; // дрейф, доля/день
  sigmaDaily: number; // волатильность, доля/день
}

interface PathResult {
  finalWealth: number;
  fees: number;
  costs: number;
  rebalances: number;
  hodlFinal: number;
}

// Детерминированный ГПСЧ, чтобы сравнение стратегий шло по одним и тем же путям цены.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianPair(rng: () => number): [number, number] {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  const r = Math.sqrt(-2 * Math.log(u1));
  return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

// k(w): стоимость позиции = L·√p·k при цене в центре диапазона (в единицах B).
const kWidth = (w: number): number => 2 - 1 / Math.sqrt(1 + w) - Math.sqrt(1 - w);

interface PoolParams {
  fees24hUsd: number;
  poolLiquidity: number; // raw
  price: number; // human, B за A
  feeRate: number; // доля (0.0004 = 0.04%)
  rawScale: number; // 10^(decB−decA): human price → raw price
  decB: number;
}

function simulatePath(
  strat: Strategy,
  scen: Scenario,
  pool: PoolParams,
  seed: number,
): PathResult {
  const rng = mulberry32(seed);
  const dt = 1 / STEPS_PER_DAY;
  const drift = (scen.muDaily - 0.5 * scen.sigmaDaily ** 2) * dt;
  const volStep = scen.sigmaDaily * Math.sqrt(dt);

  let p = pool.price;
  const p0 = p;
  const toRawSqrt = (price: number): number => Math.sqrt(price * pool.rawScale);

  // Инициализация позиции вокруг p
  let lower = p * (1 - strat.width);
  let upper = p * (1 + strat.width);
  let L =
    (VALUE_USD * 10 ** pool.decB) / (toRawSqrt(p) * kWidth(strat.width));

  const lpValueUsd = (price: number): number => {
    const sp = toRawSqrt(price);
    const sl = toRawSqrt(lower);
    const su = toRawSqrt(upper);
    let vRawB: number;
    if (price <= lower) {
      vRawB = L * (1 / sl - 1 / su) * price * pool.rawScale; // всё в A
    } else if (price >= upper) {
      vRawB = L * (su - sl); // всё в B
    } else {
      vRawB = L * (2 * sp - (price * pool.rawScale) / su - sl);
    }
    return vRawB / 10 ** pool.decB;
  };

  let fees = 0;
  let costs = 0;
  let rebalances = 0;
  const feePerDayInRange = pool.fees24hUsd * (L / pool.poolLiquidity);
  let curFeePerDay = feePerDayInRange;

  const steps = HORIZON_DAYS * STEPS_PER_DAY;
  let zCache: number | null = null;
  for (let i = 0; i < steps; i++) {
    let z: number;
    if (zCache != null) {
      z = zCache;
      zCache = null;
    } else {
      const [z1, z2] = gaussianPair(rng);
      z = z1;
      zCache = z2;
    }
    p *= Math.exp(drift + volStep * z);

    const inRange = p > lower && p < upper;
    if (inRange) fees += curFeePerDay * dt;

    if (!inRange && strat.rebalance) {
      // Ребаланс: фиксируем стоимость у границы, платим за свап половины и сеть.
      let v = lpValueUsd(p);
      const swapCost = 0.5 * v * pool.feeRate + NETWORK_FEE_USD;
      costs += swapCost;
      v -= swapCost;
      rebalances++;
      lower = p * (1 - strat.width);
      upper = p * (1 + strat.width);
      L = (v * 10 ** pool.decB) / (toRawSqrt(p) * kWidth(strat.width));
      curFeePerDay = pool.fees24hUsd * (L / pool.poolLiquidity);
    }
  }

  const finalWealth = lpValueUsd(p) + fees;
  const hodlFinal = (VALUE_USD / 2) * (p / p0) + VALUE_USD / 2;
  return { finalWealth, fees, costs, rebalances, hodlFinal };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

const pctile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

const doc = await fetchPoolDoc(POOL);
if (!doc) {
  console.error("Не удалось получить данные пула из Orca API");
  process.exit(1);
}
const pool: PoolParams = {
  fees24hUsd: doc.stats["24h"]?.fees ?? 0,
  poolLiquidity: Number(doc.liquidity),
  price: doc.price,
  feeRate: doc.feeRate / 1e6,
  rawScale: 10 ** (doc.tokenB.decimals - doc.tokenA.decimals),
  decB: doc.tokenB.decimals,
};

console.log(
  `Пул ${doc.tokenA.symbol}/${doc.tokenB.symbol} ${doc.feeRate / 1e4}%: цена ${pool.price.toFixed(2)}, комиссии 24ч $${pool.fees24hUsd.toFixed(0)}, TVL $${doc.tvlUsdc.toFixed(0)}`,
);
console.log(
  `Позиция: $${VALUE_USD}, горизонт ${HORIZON_DAYS} дн., ${PATHS} путей, шаг 15 мин, издержки ребаланса: свап 0.5·V·${(pool.feeRate * 100).toFixed(2)}% + $${NETWORK_FEE_USD}\n`,
);

const strategies: Strategy[] = [
  { name: "±2.5% ребаланс", width: 0.025, rebalance: true },
  { name: "±5%   ребаланс", width: 0.05, rebalance: true },
  { name: "±11.7% ребаланс", width: 0.117, rebalance: true },
  { name: "±11.7% без реб.", width: 0.117, rebalance: false },
  { name: "±20%  ребаланс", width: 0.2, rebalance: true },
];

const scenarios: Scenario[] = [
  { name: "штиль:    σ=1%/д,  тренд 0", muDaily: 0, sigmaDaily: 0.01 },
  { name: "спокойно: σ=2%/д,  тренд 0", muDaily: 0, sigmaDaily: 0.02 },
  { name: "обычно:   σ=4%/д,  тренд 0", muDaily: 0, sigmaDaily: 0.04 },
  { name: "шторм:    σ=7%/д,  тренд 0", muDaily: 0, sigmaDaily: 0.07 },
  { name: "рост:     σ=2%/д, +1%/день", muDaily: 0.01, sigmaDaily: 0.02 },
  { name: "падение:  σ=2%/д, −1%/день", muDaily: -0.01, sigmaDaily: 0.02 },
  { name: "сил.рост: σ=3%/д, +3%/день", muDaily: 0.03, sigmaDaily: 0.03 },
  { name: "обвал:    σ=3%/д, −3%/день", muDaily: -0.03, sigmaDaily: 0.03 },
];

const fmt = (v: number, w = 8): string =>
  (v >= 0 ? "+" : "") + v.toFixed(2).padStart(w - 1);

for (const scen of scenarios) {
  console.log(`━━ ${scen.name} ` + "━".repeat(46 - scen.name.length));
  console.log(
    "  стратегия        | PnL 30д  | vs HODL  | комиссии | издержки | ребал. | 10%-худш.",
  );
  for (const strat of strategies) {
    const rs: PathResult[] = [];
    for (let i = 0; i < PATHS; i++) {
      rs.push(simulatePath(strat, scen, pool, 1000 + i * 7919));
    }
    const pnl = rs.map((r) => r.finalWealth - VALUE_USD);
    const vsHodl = rs.map((r) => r.finalWealth - r.hodlFinal);
    console.log(
      `  ${strat.name.padEnd(16)} | ${fmt(mean(pnl))} | ${fmt(mean(vsHodl))} | ${fmt(mean(rs.map((r) => r.fees)))} | ${fmt(-mean(rs.map((r) => r.costs)))} | ${mean(rs.map((r) => r.rebalances)).toFixed(1).padStart(6)} | ${fmt(pctile(vsHodl, 0.1))}`,
    );
  }
  console.log();
}
console.log(`Чтение таблицы: PnL — средний результат за 30 дней в $ (включая движение цены);
vs HODL — насколько LP-стратегия обгоняет простое удержание токенов 50/50
(комиссии минус импермалосс минус издержки); 10%-худш. — худший дециль vs HODL.`);
