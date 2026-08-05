import {
  decreaseLiquidityQuote,
  increaseLiquidityQuote,
  priceToTickIndex,
  tickIndexToPrice,
  sqrtPriceToPrice,
} from "@orca-so/whirlpools-core";
import { REBALANCE_TX_COST_SOL, SOL_MINT } from "../config.js";
import { fetchTokenPriceUsd } from "./orcaApi.js";
import type { HydratedContext, PositionView } from "./positions.js";
import { uiAmount } from "./positions.js";

export interface SimulateRequest {
  newLowerPrice: number;
  newUpperPrice: number;
  swapSlippageBps?: number; // допуск слиппеджа на свап (для max-оценки), по умолчанию 50
}

export interface SimulateResult {
  input: { lowerPrice: number; upperPrice: number; lowerTick: number; upperTick: number };
  current: {
    lowerPrice: number;
    upperPrice: number;
    valueUsd: number;
    dailyFeesUsd: number | null;
    aprPct: number | null;
  };
  withdraw: { amountA: number; amountB: number; pendingYieldUsd: number };
  swap: {
    direction: "none" | "AtoB" | "BtoA";
    amountIn: number; // ui, в исходном токене свапа
    amountInSymbol: string;
    valueUsd: number;
    feeUsd: number; // комиссия пула за свап
    priceImpactPct: number; // оценка сдвига цены
    priceImpactUsd: number; // потери на сдвиге цены
    maxSlippageUsd: number; // при заданном допуске
  };
  costs: {
    swapFeeUsd: number;
    priceImpactUsd: number;
    networkFeeSol: number;
    networkFeeUsd: number | null;
    totalUsd: number | null;
  };
  next: {
    valueUsd: number;
    amountA: number;
    amountB: number;
    inRange: boolean;
    shareOfPoolPct: number | null;
    dailyFeesUsd: number | null;
    aprPct: number | null;
    concentrationVsCurrent: number | null; // во сколько раз плотнее ликвидность
  };
  outcome: {
    immediateLossUsd: number | null; // издержки ребаланса = мгновенный убыток
    dailyFeesDeltaUsd: number | null;
    breakEvenDays: number | null;
    note: string[];
  };
}

export async function simulateRebalance(
  ctx: HydratedContext,
  view: PositionView,
  req: SimulateRequest,
): Promise<SimulateResult> {
  const { pool, decimalsA, decimalsB, priceAUsd, priceBUsd, poolDoc } = ctx;
  const notes: string[] = [];
  if (priceAUsd == null || priceBUsd == null) {
    throw new Error("Нет USD-цен токенов пары — симуляция невозможна");
  }
  if (!(req.newLowerPrice > 0) || !(req.newUpperPrice > req.newLowerPrice)) {
    throw new Error("Некорректный диапазон: нижняя цена должна быть > 0 и меньше верхней");
  }

  const spacing = pool.tickSpacing;
  const snap = (price: number, mode: "floor" | "ceil"): number => {
    const t = priceToTickIndex(price, decimalsA, decimalsB);
    const q = t / spacing;
    return (mode === "floor" ? Math.floor(q) : Math.ceil(q)) * spacing;
  };
  let lowerTick = snap(req.newLowerPrice, "floor");
  let upperTick = snap(req.newUpperPrice, "ceil");
  if (lowerTick === upperTick) upperTick = lowerTick + spacing;

  const lowerPrice = tickIndexToPrice(lowerTick, decimalsA, decimalsB);
  const upperPrice = tickIndexToPrice(upperTick, decimalsA, decimalsB);
  const curPrice = sqrtPriceToPrice(pool.sqrtPrice, decimalsA, decimalsB);

  // 1. Закрытие текущей позиции: возвращаемые токены + несобранный доход.
  const p = ctx.position.data;
  const closeQuote = decreaseLiquidityQuote(
    p.liquidity,
    0,
    pool.sqrtPrice,
    p.tickLowerIndex,
    p.tickUpperIndex,
  );
  const pendingYieldUsd = view.pendingYieldUsd ?? 0;
  const feeARaw = BigInt(view.pendingFees.tokenA.amount);
  const feeBRaw = BigInt(view.pendingFees.tokenB.amount);
  let holdA = uiAmount(closeQuote.tokenEstA + feeARaw, decimalsA);
  let holdB = uiAmount(closeQuote.tokenEstB + feeBRaw, decimalsB);
  // Реварды в других токенах учитываем по USD, добавляя к стороне B.
  const rewardsUsd = view.pendingRewards.reduce((s, r) => s + (r.usd ?? 0), 0);
  holdB += rewardsUsd / priceBUsd;

  const totalValueUsd = holdA * priceAUsd + holdB * priceBUsd;

  // 2. Целевое соотношение токенов для нового диапазона при текущей цене.
  const UNIT = 10n ** 12n;
  const unit = increaseLiquidityQuote(UNIT, 0, pool.sqrtPrice, lowerTick, upperTick);
  const unitA = uiAmount(unit.tokenEstA, decimalsA);
  const unitB = uiAmount(unit.tokenEstB, decimalsB);
  const unitValueUsd = unitA * priceAUsd + unitB * priceBUsd;
  if (unitValueUsd <= 0) {
    throw new Error("Не удалось построить котировку для нового диапазона");
  }

  // 3. Свап до целевого соотношения.
  const targetFracA = (unitA * priceAUsd) / unitValueUsd;
  const targetAUsd = totalValueUsd * targetFracA;
  const haveAUsd = holdA * priceAUsd;
  const deltaAUsd = targetAUsd - haveAUsd; // >0: докупить A, <0: продать A

  const feeRate = pool.feeRate / 1e6;
  let direction: SimulateResult["swap"]["direction"] = "none";
  let amountIn = 0;
  let amountInSymbol = "";
  let swapValueUsd = Math.abs(deltaAUsd);
  if (swapValueUsd < 0.01) swapValueUsd = 0;
  else if (deltaAUsd < 0) {
    direction = "AtoB";
    amountIn = swapValueUsd / priceAUsd;
    amountInSymbol = ctx.symbolA;
  } else {
    direction = "BtoA";
    amountIn = swapValueUsd / priceBUsd;
    amountInSymbol = ctx.symbolB;
  }

  const swapFeeUsd = swapValueUsd * feeRate;

  // Оценка сдвига цены: в CLMM внутри текущего тика Δ√P = Δb/L.
  // Работаем в "сырых" единицах; для больших свапов (через несколько тиков)
  // это нижняя оценка — отмечаем в примечаниях.
  let priceImpactPct = 0;
  const poolL = Number(pool.liquidity);
  if (swapValueUsd > 0 && poolL > 0) {
    const sqrtP = Number(pool.sqrtPrice) / 2 ** 64;
    if (direction === "BtoA") {
      const bRaw = (swapValueUsd / priceBUsd) * 10 ** decimalsB;
      const newSqrt = sqrtP + bRaw / poolL;
      priceImpactPct = Math.abs((newSqrt / sqrtP) ** 2 - 1) * 100;
    } else {
      const aRaw = (swapValueUsd / priceAUsd) * 10 ** decimalsA;
      const newSqrt = 1 / (1 / sqrtP + aRaw / poolL);
      priceImpactPct = Math.abs((newSqrt / sqrtP) ** 2 - 1) * 100;
    }
    if (priceImpactPct > 1) {
      notes.push(
        "Свап двигает цену более чем на 1% — оценка сдвига приблизительна (не учитывает пересечение тиков и внешние маршруты). Крупный свап выгоднее выполнить через агрегатор.",
      );
    }
  }
  // Средняя цена исполнения ≈ половина полного сдвига.
  const priceImpactUsd = swapValueUsd * (priceImpactPct / 100) / 2;
  const slippageBps = req.swapSlippageBps ?? 50;
  const maxSlippageUsd = swapValueUsd * (slippageBps / 10_000);

  const solPrice =
    ctx.pool.tokenMintA === SOL_MINT
      ? priceAUsd
      : ctx.pool.tokenMintB === SOL_MINT
        ? priceBUsd
        : await fetchTokenPriceUsd(SOL_MINT);
  const networkFeeUsd = solPrice != null ? REBALANCE_TX_COST_SOL * solPrice : null;

  const totalCostsUsd =
    networkFeeUsd != null ? swapFeeUsd + priceImpactUsd + networkFeeUsd : null;

  // 4. Новая позиция на оставшуюся стоимость.
  const valueAfterCosts = totalValueUsd - (totalCostsUsd ?? swapFeeUsd + priceImpactUsd);
  const scale = valueAfterCosts / unitValueUsd;
  const nextA = unitA * scale;
  const nextB = unitB * scale;
  const nextL = Number(UNIT) * scale;

  const inRange = pool.tickCurrentIndex >= lowerTick && pool.tickCurrentIndex < upperTick;
  if (!inRange) {
    notes.push(
      "Новый диапазон не включает текущую цену: позиция будет односторонней и не будет зарабатывать комиссии, пока цена не войдёт в диапазон.",
    );
  }

  // 5. Доходность: доля в активной ликвидности пула * комиссии за 24ч.
  const fees24h = poolDoc?.stats["24h"]?.fees ?? null;
  const oldL = Number(p.liquidity);
  const oldInRange = view.status === "priceInRange";
  const currentDaily =
    fees24h != null && poolL > 0 && oldInRange ? fees24h * (oldL / poolL) : oldInRange ? null : 0;
  const currentApr =
    currentDaily != null && view.valueUsd ? ((currentDaily * 365) / view.valueUsd) * 100 : null;

  // После ребаланса: старая ликвидность уходит из пула, новая приходит.
  const poolLAfter = poolL - (oldInRange ? oldL : 0) + (inRange ? nextL : 0);
  const nextShare = inRange && poolLAfter > 0 ? nextL / poolLAfter : 0;
  const nextDaily = fees24h != null ? (inRange ? fees24h * nextShare : 0) : null;
  const nextApr =
    nextDaily != null && valueAfterCosts > 0 ? ((nextDaily * 365) / valueAfterCosts) * 100 : null;

  // Концентрация: насколько плотнее размазана та же стоимость.
  const widthOld = view.upperPrice - view.lowerPrice;
  const widthNew = upperPrice - lowerPrice;
  const concentrationVsCurrent =
    widthOld > 0 && widthNew > 0 ? widthOld / widthNew : null;

  if (fees24h == null) {
    notes.push("Статистика комиссий пула недоступна — прогноз доходности не рассчитан.");
  }
  notes.push(
    "Прогноз дохода — оценка: предполагает, что объём торгов и распределение ликвидности пула останутся как за последние 24ч и цена останется в диапазоне.",
  );

  const immediateLossUsd = totalCostsUsd;
  const dailyDelta =
    nextDaily != null && currentDaily != null ? nextDaily - currentDaily : null;
  let breakEvenDays: number | null = null;
  if (immediateLossUsd != null && dailyDelta != null && dailyDelta > 0) {
    breakEvenDays = immediateLossUsd / dailyDelta;
  } else if (immediateLossUsd != null && dailyDelta != null && dailyDelta <= 0) {
    notes.push(
      "Новый диапазон даёт не больше комиссий, чем текущий — издержки ребаланса не окупятся ростом доходности.",
    );
  }

  return {
    input: { lowerPrice, upperPrice, lowerTick, upperTick },
    current: {
      lowerPrice: view.lowerPrice,
      upperPrice: view.upperPrice,
      valueUsd: totalValueUsd,
      dailyFeesUsd: currentDaily,
      aprPct: currentApr,
    },
    withdraw: {
      amountA: uiAmount(closeQuote.tokenEstA, decimalsA),
      amountB: uiAmount(closeQuote.tokenEstB, decimalsB),
      pendingYieldUsd,
    },
    swap: {
      direction,
      amountIn,
      amountInSymbol,
      valueUsd: swapValueUsd,
      feeUsd: swapFeeUsd,
      priceImpactPct,
      priceImpactUsd,
      maxSlippageUsd,
    },
    costs: {
      swapFeeUsd,
      priceImpactUsd,
      networkFeeSol: REBALANCE_TX_COST_SOL,
      networkFeeUsd,
      totalUsd: totalCostsUsd,
    },
    next: {
      valueUsd: valueAfterCosts,
      amountA: nextA,
      amountB: nextB,
      inRange,
      shareOfPoolPct: inRange ? nextShare * 100 : null,
      dailyFeesUsd: nextDaily,
      aprPct: nextApr,
      concentrationVsCurrent,
    },
    outcome: {
      immediateLossUsd,
      dailyFeesDeltaUsd: dailyDelta,
      breakEvenDays,
      note: notes,
    },
  };
}
