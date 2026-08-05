import { type Rpc, type SolanaRpcApi, address } from "@solana/kit";
import { fetchPositionsForOwner, type HydratedPosition } from "@orca-so/whirlpools";
import {
  fetchWhirlpool,
  fetchAllTickArray,
  getTickArrayAddress,
  type Whirlpool,
} from "@orca-so/whirlpools-client";
import {
  collectFeesQuote,
  collectRewardsQuote,
  decreaseLiquidityQuote,
  getTickArrayStartTickIndex,
  getTickIndexInArray,
  sqrtPriceToPrice,
  tickIndexToPrice,
  positionStatus,
  type WhirlpoolFacade,
  type PositionFacade,
  type TickFacade,
} from "@orca-so/whirlpools-core";
import { fetchPoolDoc, fetchTokenDoc, type OrcaPoolDoc } from "./orcaApi.js";

export { makeRpc } from "./rpc.js";

const DEFAULT_MINT = "11111111111111111111111111111111";

export interface TokenAmount {
  mint: string;
  symbol: string;
  decimals: number;
  amount: string; // raw
  uiAmount: number;
  usd: number | null;
}

export interface PositionView {
  positionAddress: string;
  positionMint: string;
  whirlpool: string;
  pair: string;
  status: "priceInRange" | "priceBelowRange" | "priceAboveRange" | "invalid";
  currentPrice: number;
  currentTick: number;
  lowerPrice: number;
  upperPrice: number;
  tickLowerIndex: number;
  tickUpperIndex: number;
  tickSpacing: number;
  feeRatePct: number; // pool fee tier, percent
  liquidity: string;
  poolLiquidity: string;
  shareOfPoolPct: number | null;
  tokenA: TokenAmount;
  tokenB: TokenAmount;
  valueUsd: number | null;
  pendingFees: { tokenA: TokenAmount; tokenB: TokenAmount; totalUsd: number | null };
  pendingRewards: TokenAmount[];
  pendingYieldUsd: number | null;
  pool: {
    tvlUsd: number;
    volume24hUsd: number;
    fees24hUsd: number;
    poolFeeAprPct: number | null;
    positionFeeAprPct: number | null;
    priceHint: number;
  } | null;
}

function toWhirlpoolFacade(w: Whirlpool): WhirlpoolFacade {
  return {
    feeTierIndexSeed: (w as any).feeTierIndexSeed ?? (w as any).tickSpacingSeed,
    tickSpacing: w.tickSpacing,
    feeRate: w.feeRate,
    protocolFeeRate: w.protocolFeeRate,
    liquidity: w.liquidity,
    sqrtPrice: w.sqrtPrice,
    tickCurrentIndex: w.tickCurrentIndex,
    feeGrowthGlobalA: w.feeGrowthGlobalA,
    feeGrowthGlobalB: w.feeGrowthGlobalB,
    rewardLastUpdatedTimestamp: w.rewardLastUpdatedTimestamp,
    rewardInfos: w.rewardInfos.map((r) => ({
      emissionsPerSecondX64: r.emissionsPerSecondX64,
      growthGlobalX64: r.growthGlobalX64,
    })),
  };
}

function toPositionFacade(p: HydratedPosition["data"]): PositionFacade {
  return {
    liquidity: p.liquidity,
    tickLowerIndex: p.tickLowerIndex,
    tickUpperIndex: p.tickUpperIndex,
    feeGrowthCheckpointA: p.feeGrowthCheckpointA,
    feeOwedA: p.feeOwedA,
    feeGrowthCheckpointB: p.feeGrowthCheckpointB,
    feeOwedB: p.feeOwedB,
    rewardInfos: p.rewardInfos.map((r) => ({
      growthInsideCheckpoint: r.growthInsideCheckpoint,
      amountOwed: r.amountOwed,
    })),
  };
}

export function uiAmount(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

async function fetchTickFacades(
  rpc: Rpc<SolanaRpcApi>,
  whirlpoolAddr: string,
  pool: Whirlpool,
  tickLowerIndex: number,
  tickUpperIndex: number,
): Promise<{ lower: TickFacade; upper: TickFacade }> {
  const lowerStart = getTickArrayStartTickIndex(tickLowerIndex, pool.tickSpacing);
  const upperStart = getTickArrayStartTickIndex(tickUpperIndex, pool.tickSpacing);
  const [lowerAddr] = await getTickArrayAddress(address(whirlpoolAddr), lowerStart);
  const [upperAddr] = await getTickArrayAddress(address(whirlpoolAddr), upperStart);
  const arrays = await fetchAllTickArray(
    rpc,
    lowerStart === upperStart ? [lowerAddr] : [lowerAddr, upperAddr],
  );
  const byStart = new Map(arrays.map((a) => [a.data.startTickIndex, a]));
  const pick = (start: number, tickIndex: number): TickFacade => {
    const arr = byStart.get(start);
    if (!arr) throw new Error(`tick array ${start} not found`);
    const i = getTickIndexInArray(tickIndex, start, pool.tickSpacing);
    const t = arr.data.ticks[i];
    return {
      initialized: t.initialized,
      liquidityNet: t.liquidityNet,
      liquidityGross: t.liquidityGross,
      feeGrowthOutsideA: t.feeGrowthOutsideA,
      feeGrowthOutsideB: t.feeGrowthOutsideB,
      rewardGrowthsOutside: [...t.rewardGrowthsOutside],
    };
  };
  return {
    lower: pick(lowerStart, tickLowerIndex),
    upper: pick(upperStart, tickUpperIndex),
  };
}

export interface HydratedContext {
  rpc: Rpc<SolanaRpcApi>;
  position: HydratedPosition;
  pool: Whirlpool;
  poolAddress: string;
  poolDoc: OrcaPoolDoc | null;
  decimalsA: number;
  decimalsB: number;
  symbolA: string;
  symbolB: string;
  priceAUsd: number | null;
  priceBUsd: number | null;
}

export async function hydratePosition(
  rpc: Rpc<SolanaRpcApi>,
  position: HydratedPosition,
): Promise<{ view: PositionView; ctx: HydratedContext }> {
  const poolAddress = position.data.whirlpool;
  const [poolAcc, poolDoc] = await Promise.all([
    fetchWhirlpool(rpc, poolAddress),
    fetchPoolDoc(poolAddress),
  ]);
  const pool = poolAcc.data;

  const [tokADoc, tokBDoc] = await Promise.all([
    fetchTokenDoc(pool.tokenMintA),
    fetchTokenDoc(pool.tokenMintB),
  ]);
  const decimalsA = poolDoc?.tokenA.decimals ?? tokADoc?.decimals ?? 9;
  const decimalsB = poolDoc?.tokenB.decimals ?? tokBDoc?.decimals ?? 6;
  const symbolA = poolDoc?.tokenA.symbol ?? tokADoc?.symbol ?? "A";
  const symbolB = poolDoc?.tokenB.symbol ?? tokBDoc?.symbol ?? "B";
  const priceAUsd = tokADoc?.priceUsd ?? null;
  const priceBUsd = tokBDoc?.priceUsd ?? null;

  const p = position.data;
  const currentPrice = sqrtPriceToPrice(pool.sqrtPrice, decimalsA, decimalsB);
  const lowerPrice = tickIndexToPrice(p.tickLowerIndex, decimalsA, decimalsB);
  const upperPrice = tickIndexToPrice(p.tickUpperIndex, decimalsA, decimalsB);
  const status = positionStatus(pool.sqrtPrice, p.tickLowerIndex, p.tickUpperIndex);

  // Текущий состав позиции: сколько токенов вернётся при выводе всей ликвидности.
  const amounts = decreaseLiquidityQuote(
    p.liquidity,
    0,
    pool.sqrtPrice,
    p.tickLowerIndex,
    p.tickUpperIndex,
  );

  const { lower, upper } = await fetchTickFacades(
    rpc,
    poolAddress,
    pool,
    p.tickLowerIndex,
    p.tickUpperIndex,
  );
  const poolFacade = toWhirlpoolFacade(pool);
  const posFacade = toPositionFacade(p);
  const fees = collectFeesQuote(poolFacade, posFacade, lower, upper);
  const rewardsQuote = collectRewardsQuote(
    poolFacade,
    posFacade,
    lower,
    upper,
    BigInt(Math.floor(Date.now() / 1000)),
  );

  const mkAmount = (
    mint: string,
    symbol: string,
    decimals: number,
    raw: bigint,
    priceUsd: number | null,
  ): TokenAmount => ({
    mint,
    symbol,
    decimals,
    amount: raw.toString(),
    uiAmount: uiAmount(raw, decimals),
    usd: priceUsd == null ? null : uiAmount(raw, decimals) * priceUsd,
  });

  const tokenA = mkAmount(pool.tokenMintA, symbolA, decimalsA, amounts.tokenEstA, priceAUsd);
  const tokenB = mkAmount(pool.tokenMintB, symbolB, decimalsB, amounts.tokenEstB, priceBUsd);
  const feeA = mkAmount(pool.tokenMintA, symbolA, decimalsA, fees.feeOwedA, priceAUsd);
  const feeB = mkAmount(pool.tokenMintB, symbolB, decimalsB, fees.feeOwedB, priceBUsd);

  const pendingRewards: TokenAmount[] = [];
  for (let i = 0; i < rewardsQuote.rewards.length; i++) {
    const owed = rewardsQuote.rewards[i].rewardsOwed;
    const mint = pool.rewardInfos[i]?.mint;
    if (owed > 0n && mint && mint !== DEFAULT_MINT) {
      const doc = await fetchTokenDoc(mint);
      pendingRewards.push(
        mkAmount(mint, doc?.symbol ?? "?", doc?.decimals ?? 0, owed, doc?.priceUsd ?? null),
      );
    }
  }

  const sumUsd = (...vals: Array<number | null>): number | null => {
    let s = 0;
    for (const v of vals) {
      if (v == null) return null;
      s += v;
    }
    return s;
  };

  const valueUsd = sumUsd(tokenA.usd, tokenB.usd);
  const pendingFeesUsd = sumUsd(feeA.usd, feeB.usd);
  const rewardsUsd = pendingRewards.length
    ? sumUsd(...pendingRewards.map((r) => r.usd))
    : 0;
  const pendingYieldUsd = sumUsd(pendingFeesUsd, rewardsUsd);

  const poolL = Number(pool.liquidity);
  const posL = Number(p.liquidity);
  const inRange = status === "priceInRange";
  const shareOfPoolPct = inRange && poolL > 0 ? (posL / poolL) * 100 : null;

  let poolBlock: PositionView["pool"] = null;
  if (poolDoc) {
    const fees24h = poolDoc.stats["24h"]?.fees ?? 0;
    const poolFeeAprPct =
      poolDoc.tvlUsdc > 0 ? ((fees24h * 365) / poolDoc.tvlUsdc) * 100 : null;
    // Доля позиции в активной ликвидности * дневные комиссии пула = оценка
    // дневного дохода позиции; годовая ставка — относительно стоимости позиции.
    let positionFeeAprPct: number | null = null;
    if (inRange && poolL > 0 && valueUsd && valueUsd > 0) {
      positionFeeAprPct = ((fees24h * (posL / poolL) * 365) / valueUsd) * 100;
    } else if (!inRange) {
      positionFeeAprPct = 0;
    }
    poolBlock = {
      tvlUsd: poolDoc.tvlUsdc,
      volume24hUsd: poolDoc.stats["24h"]?.volume ?? 0,
      fees24hUsd: fees24h,
      poolFeeAprPct,
      positionFeeAprPct,
      priceHint: poolDoc.price,
    };
  }

  const view: PositionView = {
    positionAddress: position.address,
    positionMint: p.positionMint,
    whirlpool: poolAddress,
    pair: `${symbolA}/${symbolB}`,
    status,
    currentPrice,
    currentTick: pool.tickCurrentIndex,
    lowerPrice,
    upperPrice,
    tickLowerIndex: p.tickLowerIndex,
    tickUpperIndex: p.tickUpperIndex,
    tickSpacing: pool.tickSpacing,
    feeRatePct: pool.feeRate / 10_000,
    liquidity: p.liquidity.toString(),
    poolLiquidity: pool.liquidity.toString(),
    shareOfPoolPct,
    tokenA,
    tokenB,
    valueUsd,
    pendingFees: { tokenA: feeA, tokenB: feeB, totalUsd: pendingFeesUsd },
    pendingRewards,
    pendingYieldUsd,
    pool: poolBlock,
  };

  const ctx: HydratedContext = {
    rpc,
    position,
    pool,
    poolAddress,
    poolDoc,
    decimalsA,
    decimalsB,
    symbolA,
    symbolB,
    priceAUsd,
    priceBUsd,
  };

  return { view, ctx };
}

export async function fetchWalletPositions(
  rpc: Rpc<SolanaRpcApi>,
  wallet: string,
): Promise<HydratedPosition[]> {
  const all = await fetchPositionsForOwner(rpc, address(wallet));
  const flat: HydratedPosition[] = [];
  for (const p of all) {
    if (p.isPositionBundle) {
      for (const inner of p.positions) {
        flat.push({ ...inner, isPositionBundle: false } as HydratedPosition);
      }
    } else {
      flat.push(p);
    }
  }
  return flat.filter((p) => p.data.liquidity > 0n || hasPendingAmounts(p));
}

function hasPendingAmounts(p: HydratedPosition): boolean {
  return (
    p.data.feeOwedA > 0n ||
    p.data.feeOwedB > 0n ||
    p.data.rewardInfos.some((r) => r.amountOwed > 0n)
  );
}
