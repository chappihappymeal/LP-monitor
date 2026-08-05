import { ORCA_API } from "../config.js";

export interface OrcaTokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  imageUrl?: string;
}

export interface OrcaPoolStats {
  volume: number;
  fees: number;
  rewards: number | null;
  yieldOverTvl: number;
}

export interface OrcaPoolDoc {
  address: string;
  price: number;
  tvlUsdc: number;
  feeRate: number; // hundredths of bps (1e-6)
  protocolFeeRate: number; // basis points of fee (1e-4 of feeRate)
  tickSpacing: number;
  liquidity: string;
  tokenA: OrcaTokenInfo;
  tokenB: OrcaTokenInfo;
  stats: { "24h"?: OrcaPoolStats; "7d"?: OrcaPoolStats; "30d"?: OrcaPoolStats };
  rewards: Array<{
    mint: string;
    active: boolean;
  }>;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Orca API ${res.status} for ${url}`);
  return res.json();
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const poolCache = new Map<string, { at: number; doc: OrcaPoolDoc }>();

export async function fetchPoolDoc(address: string): Promise<OrcaPoolDoc | null> {
  const cached = poolCache.get(address);
  if (cached && Date.now() - cached.at < 60_000) return cached.doc;
  try {
    const { data } = await getJson(`${ORCA_API}/pools/${address}`);
    const stats: OrcaPoolDoc["stats"] = {};
    for (const period of ["24h", "7d", "30d"] as const) {
      const s = data.stats?.[period];
      if (s) {
        stats[period] = {
          volume: num(s.volume),
          fees: num(s.fees),
          rewards: s.rewards == null ? null : num(s.rewards),
          yieldOverTvl: num(s.yieldOverTvl),
        };
      }
    }
    const doc: OrcaPoolDoc = {
      address: data.address,
      price: num(data.price),
      tvlUsdc: num(data.tvlUsdc),
      feeRate: num(data.feeRate),
      protocolFeeRate: num(data.protocolFeeRate),
      tickSpacing: num(data.tickSpacing),
      liquidity: String(data.liquidity ?? "0"),
      tokenA: data.tokenA,
      tokenB: data.tokenB,
      stats,
      rewards: (data.rewards ?? []).map((r: any) => ({
        mint: r.mint ?? r.address,
        active: Boolean(r.active),
      })),
    };
    poolCache.set(address, { at: Date.now(), doc });
    return doc;
  } catch (e) {
    console.warn(`fetchPoolDoc(${address}) failed:`, e);
    return cached?.doc ?? null;
  }
}

export interface TokenDoc {
  address: string;
  symbol: string;
  decimals: number;
  priceUsd: number | null;
}

const tokenCache = new Map<string, { at: number; doc: TokenDoc }>();

export async function fetchTokenDoc(mint: string): Promise<TokenDoc | null> {
  const cached = tokenCache.get(mint);
  if (cached && Date.now() - cached.at < 60_000) return cached.doc;
  try {
    const { data } = await getJson(`${ORCA_API}/tokens/${mint}`);
    const price = num(data.priceUsdc);
    const doc: TokenDoc = {
      address: mint,
      symbol: data.metadata?.symbol ?? mint.slice(0, 4),
      decimals: num(data.decimals),
      priceUsd: price > 0 ? price : null,
    };
    tokenCache.set(mint, { at: Date.now(), doc });
    return doc;
  } catch {
    return cached?.doc ?? null;
  }
}

export async function fetchTokenPriceUsd(mint: string): Promise<number | null> {
  return (await fetchTokenDoc(mint))?.priceUsd ?? null;
}
