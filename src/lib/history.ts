import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { address, signature as asSignature } from "@solana/kit";
import { WHIRLPOOL_PROGRAM_ADDRESS } from "@orca-so/whirlpools-client";
import { MAX_HISTORY_TX, STABLE_MINTS } from "../config.js";
import type { HydratedContext } from "./positions.js";
import { uiAmount } from "./positions.js";
import { fetchTokenDoc } from "./orcaApi.js";

export interface HistoryEvent {
  signature: string;
  blockTime: number | null;
  kind: "deposit" | "withdraw" | "collectFees" | "collectReward";
  amountA: number; // ui-суммы потока с точки зрения пользователя
  amountB: number;
  rewardUsd: number; // для collectReward — USD-оценка по текущей цене реварда
  derivedPrice: number | null; // цена пула (B за A) в момент операции, если восстановима
  valueUsd: number | null; // историческая USD-оценка потока
}

export interface PositionPnl {
  events: HistoryEvent[];
  openedAt: number | null;
  ageDays: number | null;
  depositedValueUsd: number | null; // историческая стоимость внесённого
  depositedA: number;
  depositedB: number;
  withdrawnValueUsd: number; // по текущим ценам
  collectedYieldUsd: number; // по текущим ценам
  txFeesSol: number;
  historyTruncated: boolean;
  totalPnlUsd: number | null; // текущая ст-ть + весь доход + выведенное − внесённое (историч.)
  vsHodlUsd: number | null; // против стратегии «просто держать внесённые токены»
  realizedAprPct: number | null;
  note: string | null;
}

// Дискриминаторы инструкций Whirlpool (первые 8 байт данных, hex).
const DISC_KINDS: Record<string, HistoryEvent["kind"]> = {
  "2e9cf3760dcdfbb2": "deposit", // increaseLiquidity
  "851d59df45eeb00a": "deposit", // increaseLiquidityV2
  effb097cd2c6352b: "deposit", // increaseLiquidityByTokenAmountsV2
  a026d06f685b2c01: "withdraw", // decreaseLiquidity
  "3a7fbc3e4f52c460": "withdraw", // decreaseLiquidityV2
  a498cf631eba13b6: "collectFees",
  cf755fbfe5b4e20f: "collectFees", // v2
  "4605845756ebb122": "collectReward",
  b16b25b4a01331d1: "collectReward", // v2
};

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58DecodeHexPrefix(s: string, bytes: number): string {
  let x = 0n;
  for (const ch of s) {
    const v = BASE58_ALPHABET.indexOf(ch);
    if (v < 0) return "";
    x = x * 58n + BigInt(v);
  }
  let hex = x.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let zeros = 0;
  for (const ch of s) {
    if (ch === "1") zeros++;
    else break;
  }
  return "00".repeat(zeros).concat(hex).slice(0, bytes * 2);
}

// Восстановление цены пула из соотношения внесённых/выведенных сумм.
// a = L*(1/√P − 1/√Pu), b = L*(√P − √Pl)  ⇒  квадратное уравнение на √P.
function derivePriceFromAmounts(
  aUi: number,
  bUi: number,
  lowerPrice: number,
  upperPrice: number,
): number | null {
  const sl = Math.sqrt(lowerPrice);
  const su = Math.sqrt(upperPrice);
  if (aUi > 0 && bUi > 0) {
    const r = bUi / aUi;
    // su·s² + (r − su·sl)·s − r·su = 0
    const A = su;
    const B = r - su * sl;
    const C = -r * su;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    const s = (-B + Math.sqrt(disc)) / (2 * A);
    return s > 0 ? s * s : null;
  }
  if (aUi > 0) return lowerPrice; // цена ниже диапазона — оцениваем по нижней границе
  if (bUi > 0) return upperPrice; // цена выше диапазона — по верхней
  return null;
}

interface FlatIx {
  programId: string;
  accounts: string[];
  dataB58: string | null;
  stackHeight: number;
  parsed: any | null;
}

// Разворачивает top-level и inner-инструкции в один поток в порядке исполнения.
function flattenInstructions(tx: any): FlatIx[] {
  const msg = tx.transaction.message;
  const inner: Map<number, any[]> = new Map(
    (tx.meta.innerInstructions ?? []).map((g: any) => [Number(g.index), g.instructions]),
  );
  const toFlat = (ix: any, stackHeight: number): FlatIx => ({
    programId: ix.programId,
    accounts: (ix.accounts ?? []).map((a: any) => (typeof a === "string" ? a : a.pubkey)),
    dataB58: typeof ix.data === "string" ? ix.data : null,
    stackHeight: ix.stackHeight ?? stackHeight,
    parsed: ix.parsed ?? null,
  });
  const out: FlatIx[] = [];
  (msg.instructions ?? []).forEach((ix: any, i: number) => {
    out.push(toFlat(ix, 1));
    for (const child of inner.get(i) ?? []) out.push(toFlat(child, 2));
  });
  return out;
}

interface IxFlows {
  kind: HistoryEvent["kind"];
  aIn: bigint;
  aOut: bigint;
  bIn: bigint;
  bOut: bigint;
  rewardOut: Map<string, bigint>; // mint -> amount (для collectReward)
}

// Потоки токенов конкретной инструкции: переводы глубже по стеку до следующей
// инструкции той же/меньшей глубины принадлежат ей.
function extractIxFlows(
  flat: FlatIx[],
  positionAddress: string,
  vaultA: string,
  vaultB: string,
  rewardVaults: Map<string, string>, // vault -> mint
): IxFlows[] {
  const results: IxFlows[] = [];
  for (let i = 0; i < flat.length; i++) {
    const ix = flat[i];
    if (ix.programId !== WHIRLPOOL_PROGRAM_ADDRESS) continue;
    if (!ix.dataB58) continue;
    const disc = base58DecodeHexPrefix(ix.dataB58, 8);
    const kind = DISC_KINDS[disc];
    if (!kind) continue;
    if (!ix.accounts.includes(positionAddress)) continue;

    const flows: IxFlows = {
      kind,
      aIn: 0n,
      aOut: 0n,
      bIn: 0n,
      bOut: 0n,
      rewardOut: new Map(),
    };
    for (let j = i + 1; j < flat.length; j++) {
      const child = flat[j];
      if (child.stackHeight <= ix.stackHeight) break;
      const p = child.parsed;
      if (!p || (p.type !== "transfer" && p.type !== "transferChecked")) continue;
      const info = p.info;
      const amount = BigInt(info.tokenAmount?.amount ?? info.amount ?? 0);
      if (amount === 0n) continue;
      if (info.destination === vaultA) flows.aIn += amount;
      else if (info.destination === vaultB) flows.bIn += amount;
      else if (info.source === vaultA) flows.aOut += amount;
      else if (info.source === vaultB) flows.bOut += amount;
      else if (rewardVaults.has(info.source)) {
        const mint = rewardVaults.get(info.source)!;
        flows.rewardOut.set(mint, (flows.rewardOut.get(mint) ?? 0n) + amount);
      }
    }
    results.push(flows);
  }
  return results;
}

export async function computePnl(
  ctx: HydratedContext,
  view: {
    valueUsd: number | null;
    pendingYieldUsd: number | null;
    lowerPrice: number;
    upperPrice: number;
  },
): Promise<PositionPnl> {
  const { rpc, decimalsA, decimalsB, priceAUsd, priceBUsd, pool } = ctx;
  const posAddr = ctx.position.address;

  const sigs = await rpc
    .getSignaturesForAddress(address(posAddr), { limit: MAX_HISTORY_TX })
    .send();
  const historyTruncated = sigs.length >= MAX_HISTORY_TX;
  const ordered = [...sigs].reverse(); // от старых к новым

  const rewardVaults = new Map<string, string>();
  for (const r of pool.rewardInfos) {
    if (r.vault && r.mint && !r.mint.startsWith("111111")) rewardVaults.set(r.vault, r.mint);
  }

  const events: HistoryEvent[] = [];
  let txFeesSol = 0;

  for (const s of ordered) {
    if (s.err) continue;
    let tx: any;
    try {
      tx = await rpc
        .getTransaction(asSignature(s.signature), {
          maxSupportedTransactionVersion: 0,
          encoding: "jsonParsed",
        })
        .send();
    } catch {
      continue;
    }
    if (!tx?.meta) continue;

    txFeesSol += Number(tx.meta.fee ?? 0) / 1e9;

    const flat = flattenInstructions(tx);
    const ixFlows = extractIxFlows(flat, posAddr, pool.tokenVaultA, pool.tokenVaultB, rewardVaults);

    for (const f of ixFlows) {
      const aUi = uiAmount(f.kind === "deposit" ? f.aIn : f.aOut, decimalsA);
      const bUi = uiAmount(f.kind === "deposit" ? f.bIn : f.bOut, decimalsB);

      let rewardUsd = 0;
      for (const [mint, amt] of f.rewardOut) {
        const doc = await fetchTokenDoc(mint);
        if (doc?.priceUsd != null) rewardUsd += uiAmount(amt, doc.decimals) * doc.priceUsd;
      }
      if (aUi === 0 && bUi === 0 && rewardUsd === 0) continue;

      const derivedPrice =
        f.kind === "deposit" || f.kind === "withdraw"
          ? derivePriceFromAmounts(aUi, bUi, view.lowerPrice, view.upperPrice)
          : null;

      // Историческая USD-оценка: если один из токенов — стейбл, цена пула даёт
      // USD-цену второго токена в момент операции.
      let valueUsd: number | null = null;
      const stableB = STABLE_MINTS.has(pool.tokenMintB);
      const stableA = STABLE_MINTS.has(pool.tokenMintA);
      if (stableB && derivedPrice != null) valueUsd = aUi * derivedPrice + bUi;
      else if (stableB && aUi === 0) valueUsd = bUi;
      else if (stableA && derivedPrice != null) valueUsd = bUi / derivedPrice + aUi;
      else if (stableA && bUi === 0) valueUsd = aUi;
      else if (f.kind !== "deposit") {
        valueUsd =
          priceAUsd != null && priceBUsd != null
            ? aUi * priceAUsd + bUi * priceBUsd + rewardUsd
            : null;
      }

      events.push({
        signature: s.signature,
        blockTime: s.blockTime != null ? Number(s.blockTime) : null,
        kind: f.kind,
        amountA: aUi,
        amountB: bUi,
        rewardUsd,
        derivedPrice,
        valueUsd,
      });
    }
  }

  const deposits = events.filter((e) => e.kind === "deposit");
  const withdraws = events.filter((e) => e.kind === "withdraw");
  const collects = events.filter((e) => e.kind === "collectFees" || e.kind === "collectReward");

  const openedAt = deposits[0]?.blockTime ?? events[0]?.blockTime ?? null;
  const ageDays = openedAt ? (Date.now() / 1000 - openedAt) / 86400 : null;

  const depositedA = deposits.reduce((s, e) => s + e.amountA, 0);
  const depositedB = deposits.reduce((s, e) => s + e.amountB, 0);
  const depositedValueUsd = deposits.length
    ? deposits.reduce<number | null>(
        (s, e) => (s == null || e.valueUsd == null ? null : s + e.valueUsd),
        0,
      )
    : null;

  const valueNow = (a: number, b: number): number | null =>
    priceAUsd != null && priceBUsd != null ? a * priceAUsd + b * priceBUsd : null;

  const withdrawnValueUsd = withdraws.reduce(
    (s, e) => s + (valueNow(e.amountA, e.amountB) ?? e.valueUsd ?? 0),
    0,
  );
  const collectedYieldUsd = collects.reduce(
    (s, e) => s + (valueNow(e.amountA, e.amountB) ?? 0) + e.rewardUsd,
    0,
  );

  let totalPnlUsd: number | null = null;
  let vsHodlUsd: number | null = null;
  let realizedAprPct: number | null = null;
  let note: string | null = null;

  const currentTotal =
    view.valueUsd != null && view.pendingYieldUsd != null
      ? view.valueUsd + view.pendingYieldUsd
      : null;

  if (currentTotal != null && depositedValueUsd != null && depositedValueUsd > 0) {
    totalPnlUsd = currentTotal + collectedYieldUsd + withdrawnValueUsd - depositedValueUsd;
    const hodlNow = valueNow(depositedA, depositedB);
    if (hodlNow != null) {
      vsHodlUsd = currentTotal + collectedYieldUsd + withdrawnValueUsd - hodlNow;
    }
    if (ageDays && ageDays > 0.04) {
      const yieldTotal = collectedYieldUsd + (view.pendingYieldUsd ?? 0);
      realizedAprPct = ((yieldTotal / depositedValueUsd) * 365 * 100) / ageDays;
    }
  } else if (deposits.length === 0) {
    note = historyTruncated
      ? "История позиции длиннее лимита — депозиты не найдены в последних транзакциях, PnL не рассчитан."
      : "Не удалось найти депозиты в истории позиции — PnL не рассчитан.";
  } else {
    note =
      "Историческая USD-оценка депозита недоступна для этой пары — показан только PnL против HODL.";
    const hodlNow = valueNow(depositedA, depositedB);
    if (currentTotal != null && hodlNow != null) {
      vsHodlUsd = currentTotal + collectedYieldUsd + withdrawnValueUsd - hodlNow;
    }
  }

  if (historyTruncated && !note) {
    note = `Разобраны последние ${MAX_HISTORY_TX} транзакций позиции — старые операции могли не попасть в расчёт.`;
  }

  return {
    events,
    openedAt,
    ageDays,
    depositedValueUsd,
    depositedA,
    depositedB,
    withdrawnValueUsd,
    collectedYieldUsd,
    txFeesSol,
    historyTruncated,
    totalPnlUsd,
    vsHodlUsd,
    realizedAprPct,
    note,
  };
}
