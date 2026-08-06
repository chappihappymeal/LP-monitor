import fs from "node:fs";
import path from "node:path";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { address, signature as asSignature } from "@solana/kit";
import { WHIRLPOOL_PROGRAM_ADDRESS, fetchWhirlpool } from "@orca-so/whirlpools-client";
import { SOL_MINT, STABLE_MINTS } from "../config.js";
import { ensureCandleStore, type Candle } from "./candles.js";

// Журнал сделок торгового кошелька: поступления/выводы, сделки Orca с
// диапазонами, сетевые комиссии, комментарии. Хранится в data/ (вне git).
// Поле contributor — заготовка под будущий «фонд» с долями вкладчиков.

export type JournalEventType =
  | "deposit"
  | "withdraw"
  | "swap"
  | "open"
  | "increase"
  | "decrease"
  | "close"
  | "collect"
  | "other";

export interface JournalEvent {
  signature: string;
  blockTime: number | null;
  type: JournalEventType;
  solDelta: number; // экономическое изменение SOL кошелька (без сетевой комиссии)
  tokenDeltas: Record<string, number>; // символ → изменение количества
  valueUsd: number | null; // историческая USD-оценка события (модуль потока)
  feeSol: number | null; // сетевая комиссия, если платил этот кошелёк
  position: string | null; // адрес позиции для сделок Orca
  range: { lower: number; upper: number } | null; // диапазон сделки в ценах
  priceUsd: number | null; // цена SOL на момент события
  contributor: string | null; // задел под фонд: кто внёс/вывел
  comment: string;
}

interface JournalFile {
  wallet: string;
  newestSignature: string | null; // до какой подписи история уже разобрана
  backfillBefore: string | null; // курсор незавершённого первичного скана
  backfillDone: boolean;
  events: JournalEvent[]; // от старых к новым
}

interface BalanceSnapshot {
  time: number;
  walletUsd: number;
  positionsUsd: number;
  pendingUsd: number;
  totalUsd: number;
}

const DATA_DIR = "data";

const journalPath = (wallet: string): string => path.join(DATA_DIR, `journal-${wallet}.json`);
const balancesPath = (wallet: string): string => path.join(DATA_DIR, `balances-${wallet}.json`);

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
}

export function loadJournal(wallet: string): JournalFile {
  return readJson<JournalFile>(journalPath(wallet), {
    wallet,
    newestSignature: null,
    backfillBefore: null,
    backfillDone: false,
    events: [],
  });
}

export function loadSnapshots(wallet: string): BalanceSnapshot[] {
  return readJson<{ snapshots: BalanceSnapshot[] }>(balancesPath(wallet), { snapshots: [] })
    .snapshots;
}

export function saveComment(wallet: string, signature: string, comment: string): boolean {
  const j = loadJournal(wallet);
  const ev = j.events.find((e) => e.signature === signature);
  if (!ev) return false;
  ev.comment = comment;
  writeJson(journalPath(wallet), j);
  return true;
}

// Снапшот баланса — вызывается из /api/positions после успешного ответа.
export function snapshotBalance(
  wallet: string,
  walletUsd: number,
  positionsUsd: number,
  pendingUsd: number,
): void {
  const file = balancesPath(wallet);
  const data = readJson<{ snapshots: BalanceSnapshot[] }>(file, { snapshots: [] });
  const now = Math.floor(Date.now() / 1000);
  const lastSnap = data.snapshots[data.snapshots.length - 1];
  // Не чаще раза в 5 минут, чтобы файл не пух от автообновления.
  if (lastSnap && now - lastSnap.time < 5 * 60) return;
  data.snapshots.push({
    time: now,
    walletUsd,
    positionsUsd,
    pendingUsd,
    totalUsd: walletUsd + positionsUsd + pendingUsd,
  });
  writeJson(file, data);
}

// Баланс кошелька в USD: нативный SOL + стейблы + WSOL по текущей цене.
export async function fetchWalletUsd(
  rpc: Rpc<SolanaRpcApi>,
  wallet: string,
  solPriceUsd: number | null,
): Promise<number> {
  let usd = 0;
  const lamports = await rpc.getBalance(address(wallet)).send();
  if (solPriceUsd != null) usd += (Number(lamports.value) / 1e9) * solPriceUsd;
  const tokens = await rpc
    .getTokenAccountsByOwner(
      address(wallet),
      { programId: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") },
      { encoding: "jsonParsed" },
    )
    .send();
  for (const acc of tokens.value) {
    const info = (acc.account.data as any).parsed?.info;
    if (!info) continue;
    const amount = Number(info.tokenAmount?.uiAmount ?? 0);
    if (STABLE_MINTS.has(info.mint)) usd += amount;
    else if (info.mint === SOL_MINT && solPriceUsd != null) usd += amount * solPriceUsd;
  }
  return usd;
}

// ── Дневной лог fee (для отчёта бота и будущего графика) ────────────────────

export interface FeeLogEntry {
  time: number;
  pendingUsd: number; // несобранные fee на момент замера
  estDailyUsd: number; // расчётный темп: Σ доля × комиссии пула за 24ч
  positionsUsd: number;
  earnedUsd: number | null; // заработано с прошлого замера (Δ pending)
  rebalanced: boolean; // pending упал — был ребаланс, оценка занижена
}

export function appendFeeLog(
  wallet: string,
  pendingUsd: number,
  estDailyUsd: number,
  positionsUsd: number,
): FeeLogEntry {
  const file = path.join(DATA_DIR, `feelog-${wallet}.json`);
  const data = readJson<{ entries: FeeLogEntry[] }>(file, { entries: [] });
  const prev = data.entries[data.entries.length - 1];
  let earnedUsd: number | null = null;
  let rebalanced = false;
  if (prev) {
    const d = pendingUsd - prev.pendingUsd;
    if (d >= 0) {
      earnedUsd = d;
    } else {
      // pending сбросился при закрытии позиции — считаем накопленное заново
      earnedUsd = pendingUsd;
      rebalanced = true;
    }
  }
  const entry: FeeLogEntry = {
    time: Math.floor(Date.now() / 1000),
    pendingUsd,
    estDailyUsd,
    positionsUsd,
    earnedUsd,
    rebalanced,
  };
  data.entries.push(entry);
  writeJson(file, data);
  return entry;
}

// ── Скан истории ────────────────────────────────────────────────────────────

// Дискриминаторы Anchor (sha256("global:<name>")[0..8]) инструкций Whirlpool.
const DISC_TYPES: Record<string, JournalEventType> = {
  "87802f4d0f98f031": "open", // openPosition
  f21d86303a6e0e3c: "open", // openPositionWithMetadata
  d42f5f5c726683fa: "open", // openPositionWithTokenExtensions
  "7b86510031446262": "close", // closePosition
  "01b6873b9b1963df": "close", // closePositionWithTokenExtensions
  "2e9cf3760dcdfbb2": "increase", // increaseLiquidity
  "851d59df45eeb00a": "increase", // increaseLiquidityV2
  effb097cd2c6352b: "increase", // increaseLiquidityByTokenAmountsV2
  a026d06f685b2c01: "decrease", // decreaseLiquidity
  "3a7fbc3e4f52c460": "decrease", // decreaseLiquidityV2
  a498cf631eba13b6: "collect", // collectFees
  cf755fbfe5b4e20f: "collect", // collectFeesV2
  "4605845756ebb122": "collect", // collectReward
  b16b25b4a01331d1: "collect", // collectRewardV2
};

// Смещение тиков (после 8 байт дискриминатора) в данных open-инструкций.
const OPEN_TICKS_OFFSET: Record<string, number> = {
  "87802f4d0f98f031": 1, // openPosition: bump u8, затем тики
  f21d86303a6e0e3c: 2, // withMetadata: два bump'а
  d42f5f5c726683fa: 0, // withTokenExtensions: тики сразу
};

// Индекс аккаунта позиции в каждой инструкции (по IDL Whirlpool).
const POSITION_IDX: Record<string, number> = {
  "87802f4d0f98f031": 2, // openPosition: funder, owner, position, …
  f21d86303a6e0e3c: 2,
  d42f5f5c726683fa: 2,
  "7b86510031446262": 2, // closePosition: authority, receiver, position, …
  "01b6873b9b1963df": 2,
  "2e9cf3760dcdfbb2": 3, // increaseLiquidity: whirlpool, tokenProgram, authority, position, …
  a026d06f685b2c01: 3, // decreaseLiquidity
  "851d59df45eeb00a": 5, // v2: whirlpool, tokenProgramA/B, memo, authority, position, …
  effb097cd2c6352b: 5,
  "3a7fbc3e4f52c460": 5,
  a498cf631eba13b6: 2, // collectFees: whirlpool, authority, position, …
  cf755fbfe5b4e20f: 2,
  "4605845756ebb122": 2, // collectReward
  b16b25b4a01331d1: 2,
};

const TYPE_PRIORITY: JournalEventType[] = ["open", "close", "increase", "decrease", "collect"];

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58ToBytes(s: string): Uint8Array {
  let x = 0n;
  for (const ch of s) {
    const v = BASE58.indexOf(ch);
    if (v < 0) return new Uint8Array();
    x = x * 58n + BigInt(v);
  }
  let hex = x.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const body = Uint8Array.from(hex.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
  let zeros = 0;
  for (const ch of s) {
    if (ch === "1") zeros++;
    else break;
  }
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}

const toHex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function readI32LE(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset).getInt32(off, true);
}

// Известные символы минтов для читаемых дельт.
const MINT_SYMBOLS: Record<string, string> = {
  [SOL_MINT]: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: "ORCA",
};
const symbolFor = (mint: string): string => MINT_SYMBOLS[mint] ?? mint.slice(0, 4) + "…";

// Кэш пулов: whirlpool address → { decimalsGap } (10^(decA−decB) для цен из тиков).
const poolCache = new Map<string, { decA: number; decB: number; mintA: string; mintB: string }>();

async function resolvePool(
  rpc: Rpc<SolanaRpcApi>,
  candidates: string[],
  mintDecimals: Map<string, number>,
): Promise<{ decA: number; decB: number } | null> {
  for (const c of candidates) {
    const cached = poolCache.get(c);
    if (cached) return cached;
  }
  for (const c of candidates) {
    try {
      const wp = await fetchWhirlpool(rpc, address(c));
      const mintA = wp.data.tokenMintA;
      const mintB = wp.data.tokenMintB;
      const decA = mintDecimals.get(mintA) ?? (mintA === SOL_MINT ? 9 : 6);
      const decB = mintDecimals.get(mintB) ?? (STABLE_MINTS.has(mintB) ? 6 : 9);
      const info = { decA, decB, mintA, mintB };
      poolCache.set(c, info);
      return info;
    } catch {
      // не whirlpool-аккаунт — пробуем следующий
    }
  }
  return null;
}

const tickToPrice = (tick: number, decA: number, decB: number): number =>
  Math.pow(1.0001, tick) * Math.pow(10, decA - decB);

// Историческая цена SOL по годовому store свечей (ближайшая свеча не позже t).
function solPriceAt(candles: Candle[], t: number | null): number | null {
  if (t == null || candles.length === 0) return null;
  if (t < candles[0].time) return null;
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (candles[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  return candles[lo].close;
}

interface SyncState {
  running: boolean;
  processed: number;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

const syncStates = new Map<string, SyncState>();

export function getSyncState(wallet: string): SyncState | null {
  return syncStates.get(wallet) ?? null;
}

// Запуск фонового синка (если не идёт). Возвращает актуальное состояние.
export function startSync(rpc: Rpc<SolanaRpcApi>, wallet: string): SyncState {
  const cur = syncStates.get(wallet);
  if (cur?.running) return cur;
  if (cur && cur.finishedAt != null && Date.now() - cur.finishedAt < 60_000) return cur;
  const state: SyncState = {
    running: true,
    processed: 0,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  syncStates.set(wallet, state);
  syncJournal(rpc, wallet, state)
    .catch((e) => {
      state.error = e?.message ?? String(e);
      console.error(`journal sync ${wallet}:`, e);
    })
    .finally(() => {
      state.running = false;
      state.finishedAt = Date.now();
    });
  return state;
}

async function syncJournal(
  rpc: Rpc<SolanaRpcApi>,
  wallet: string,
  state: SyncState,
): Promise<void> {
  const j = loadJournal(wallet);
  const candles = await ensureCandleStore("SOL-USD").catch(() => [] as Candle[]);

  // 1. Собираем подписи для разбора: новые (до newestSignature) + хвост
  //    незавершённого первичного скана (от backfillBefore вглубь).
  const toProcess: Array<{ signature: string; blockTime: number | null; err: unknown }> = [];

  let before: string | undefined;
  let newestSeen: string | null = null;
  outer: while (true) {
    const page = await rpc
      .getSignaturesForAddress(address(wallet), {
        limit: 1000,
        ...(before ? { before: asSignature(before) } : {}),
      })
      .send();
    if (page.length === 0) break;
    if (!newestSeen && !before) newestSeen = page[0].signature;
    for (const s of page) {
      if (j.newestSignature && s.signature === j.newestSignature) break outer;
      toProcess.push({
        signature: s.signature,
        blockTime: s.blockTime != null ? Number(s.blockTime) : null,
        err: s.err,
      });
    }
    before = page[page.length - 1].signature;
    if (j.newestSignature == null && j.backfillBefore && before === j.backfillBefore) {
      // достигли курсора прошлого прерванного скана — он продолжит сам
      break;
    }
  }
  // Хвост прерванного первичного скана.
  if (!j.backfillDone && j.backfillBefore) {
    before = j.backfillBefore;
    while (true) {
      const page = await rpc
        .getSignaturesForAddress(address(wallet), { limit: 1000, before: asSignature(before) })
        .send();
      if (page.length === 0) break;
      for (const s of page)
        toProcess.push({
          signature: s.signature,
          blockTime: s.blockTime != null ? Number(s.blockTime) : null,
          err: s.err,
        });
      before = page[page.length - 1].signature;
    }
  }

  // 2. Разбор от старых к новым, прогресс сохраняем порциями.
  toProcess.reverse();
  const newEvents: JournalEvent[] = [];
  for (const s of toProcess) {
    state.processed++;
    if (s.err) continue;
    let ev: JournalEvent | null = null;
    try {
      ev = await parseTx(rpc, wallet, s.signature, s.blockTime, candles);
    } catch (e) {
      console.warn(`journal parse ${s.signature}:`, e);
    }
    if (ev) newEvents.push(ev);
    if (state.processed % 25 === 0) {
      persist(j, wallet, newEvents, newestSeen, false);
    }
    await new Promise((r) => setTimeout(r, 120)); // щадим публичный RPC
  }
  persist(j, wallet, newEvents, newestSeen, true);
}

function persist(
  j: JournalFile,
  wallet: string,
  newEvents: JournalEvent[],
  newestSeen: string | null,
  done: boolean,
): void {
  if (newEvents.length) {
    const known = new Set(j.events.map((e) => e.signature));
    const fresh = newEvents.filter((e) => !known.has(e.signature));
    j.events = [...j.events, ...fresh].sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
  }
  if (done) {
    if (newestSeen) j.newestSignature = newestSeen;
    j.backfillDone = true;
    j.backfillBefore = null;
    // close/decrease наследуют диапазон последнего open/increase той же позиции
    const lastRange = new Map<string, { lower: number; upper: number }>();
    for (const e of j.events) {
      if (!e.position) continue;
      if (e.range && (e.type === "open" || e.type === "increase")) lastRange.set(e.position, e.range);
      else if (!e.range && lastRange.has(e.position)) e.range = lastRange.get(e.position)!;
    }
  }
  writeJson(journalPath(wallet), j);
}

async function parseTx(
  rpc: Rpc<SolanaRpcApi>,
  wallet: string,
  sig: string,
  blockTime: number | null,
  candles: Candle[],
): Promise<JournalEvent | null> {
  const tx: any = await rpc
    .getTransaction(asSignature(sig), { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" })
    .send();
  if (!tx?.meta) return null;

  const keys: string[] = (tx.transaction.message.accountKeys ?? []).map((k: any) =>
    typeof k === "string" ? k : k.pubkey,
  );
  const walletIdx = keys.indexOf(wallet);
  const feePayer = keys[0] === wallet;
  const feeSol = Number(tx.meta.fee ?? 0) / 1e9;

  // Экономическая дельта SOL: изменение баланса + возврат сетевой комиссии.
  let solDelta =
    walletIdx >= 0
      ? (Number(tx.meta.postBalances[walletIdx]) - Number(tx.meta.preBalances[walletIdx])) / 1e9
      : 0;
  if (feePayer) solDelta += feeSol;

  // Дельты токен-аккаунтов кошелька по минтам (+ decimals минтов для тиков).
  const mintDecimals = new Map<string, number>();
  const byMint = new Map<string, number>();
  const addTb = (tb: any, sign: number): void => {
    mintDecimals.set(tb.mint, Number(tb.uiTokenAmount?.decimals ?? 0));
    if (tb.owner !== wallet) return;
    const amt = Number(tb.uiTokenAmount?.uiAmount ?? 0);
    byMint.set(tb.mint, (byMint.get(tb.mint) ?? 0) + sign * amt);
  };
  for (const tb of tx.meta.preTokenBalances ?? []) addTb(tb, -1);
  for (const tb of tx.meta.postTokenBalances ?? []) addTb(tb, +1);
  // WSOL считаем частью SOL-дельты (wrap/unwrap внутри сделок).
  const wsolDelta = byMint.get(SOL_MINT) ?? 0;
  byMint.delete(SOL_MINT);
  solDelta += wsolDelta;

  const tokenDeltas: Record<string, number> = {};
  for (const [mint, d] of byMint) {
    // NFT позиции (0 decimals, ±1) — служебный шум, не денежный поток.
    if (mintDecimals.get(mint) === 0 && Math.abs(Math.abs(d) - 1) < 1e-9) continue;
    if (Math.abs(d) > 1e-9) tokenDeltas[symbolFor(mint)] = d;
  }

  // Классификация по инструкциям Whirlpool.
  const msg = tx.transaction.message;
  const inner = (tx.meta.innerInstructions ?? []).flatMap((g: any) => g.instructions);
  const allIx: any[] = [...(msg.instructions ?? []), ...inner];
  let evType: JournalEventType | null = null;
  let range: { lower: number; upper: number } | null = null;
  let position: string | null = null;

  for (const ix of allIx) {
    if (ix.programId !== WHIRLPOOL_PROGRAM_ADDRESS || typeof ix.data !== "string") continue;
    const data = b58ToBytes(ix.data);
    if (data.length < 8) continue;
    const disc = toHex(data.slice(0, 8));
    const t = DISC_TYPES[disc];
    if (!t) continue;
    const accounts: string[] = (ix.accounts ?? []).map((a: any) =>
      typeof a === "string" ? a : a.pubkey,
    );
    const posIdx = POSITION_IDX[disc];
    const ixPosition = posIdx != null ? (accounts[posIdx] ?? null) : null;
    if (!evType || TYPE_PRIORITY.indexOf(t) < TYPE_PRIORITY.indexOf(evType)) {
      evType = t;
      if (ixPosition) position = ixPosition;
    } else if (position == null && ixPosition) {
      position = ixPosition;
    }
    if (t === "open") {
      const off = 8 + (OPEN_TICKS_OFFSET[disc] ?? 0);
      if (data.length >= off + 8) {
        const tickLower = readI32LE(data, off);
        const tickUpper = readI32LE(data, off + 4);
        if (Math.abs(tickLower) < 500_000 && Math.abs(tickUpper) < 500_000 && tickLower < tickUpper) {
          const pool = await resolvePool(rpc, accounts, mintDecimals);
          if (pool) {
            range = {
              lower: tickToPrice(tickLower, pool.decA, pool.decB),
              upper: tickToPrice(tickUpper, pool.decA, pool.decB),
            };
          }
        }
      }
    }
  }

  const priceUsd = solPriceAt(candles, blockTime);
  const stableFlow = Object.entries(tokenDeltas)
    .filter(([sym]) => sym === "USDC" || sym === "USDT")
    .reduce((s, [, v]) => s + v, 0);
  const solUsd = priceUsd != null ? solDelta * priceUsd : null;

  if (!evType) {
    const hasFlow = Math.abs(solDelta) > 1e-6 || Object.keys(tokenDeltas).length > 0;
    if (!hasFlow) return null; // служебная транзакция без движения средств
    // Свап: одновременный существенный приток и отток разных активов
    // (SOL↔стейбл или неизвестный токен против оценимого потока).
    const unknownSigns = Object.entries(tokenDeltas)
      .filter(([sym]) => sym !== "USDC" && sym !== "USDT")
      .map(([, v]) => Math.sign(v));
    const flows: number[] = [];
    if (solUsd != null && Math.abs(solUsd) > 0.5) flows.push(solUsd);
    if (Math.abs(stableFlow) > 0.5) flows.push(stableFlow);
    const hasPos = flows.some((v) => v > 0) || unknownSigns.includes(1);
    const hasNeg = flows.some((v) => v < 0) || unknownSigns.includes(-1);
    if (hasPos && hasNeg) {
      evType = "swap";
    } else {
      const net = (solUsd ?? solDelta) + stableFlow;
      evType = net > 0 ? "deposit" : net < 0 ? "withdraw" : "other";
    }
  }

  let valueUsd: number | null = null;
  if (evType === "swap") {
    const pos = Math.max(0, solUsd ?? 0) + Math.max(0, stableFlow);
    const neg = Math.max(0, -(solUsd ?? 0)) + Math.max(0, -stableFlow);
    valueUsd = Math.max(pos, neg) || null;
  } else if (priceUsd != null) {
    valueUsd = Math.abs(solDelta * priceUsd + stableFlow);
  } else if (Math.abs(solDelta) < 1e-9 && stableFlow !== 0) {
    valueUsd = Math.abs(stableFlow);
  }

  return {
    signature: sig,
    blockTime,
    type: evType,
    solDelta: Math.round(solDelta * 1e9) / 1e9,
    tokenDeltas,
    valueUsd,
    feeSol: feePayer ? feeSol : null,
    position,
    range,
    priceUsd,
    contributor: null,
    comment: "",
  };
}

const stableOf = (e: JournalEvent): number =>
  Object.entries(e.tokenDeltas)
    .filter(([sym]) => sym === "USDC" || sym === "USDT")
    .reduce((s, [, v]) => s + v, 0);

// Денежный поток события в USD с точки зрения портфеля (с учётом fee).
function flowUsd(e: JournalEvent): number | null {
  if (e.priceUsd == null) return null;
  return (e.solDelta - (e.feeSol ?? 0)) * e.priceUsd + stableOf(e);
}

// Группировка: свапы и пыль (<$1) в пределах ±3 минут от LP-события — части
// той же операции (подготовка входа/выхода). Сливаются в одну строку: суммы
// объединяются, эпизодная дельта включает свап-издержки.
export interface GroupedEvent extends JournalEvent {
  groupedTypes?: JournalEventType[]; // типы влитых событий
  extraSol?: number; // потоки влитых событий — для снимка баланса
  extraStable?: number;
}

const LP_TYPES = new Set<JournalEventType>(["open", "increase", "decrease", "close", "collect"]);
const GROUP_WINDOW_SEC = 180;

function groupEvents(events: JournalEvent[]): GroupedEvent[] {
  const lpIdx = events.map((e, i) => (LP_TYPES.has(e.type) ? i : -1)).filter((i) => i >= 0);
  const host = new Map<number, number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (LP_TYPES.has(e.type) || e.blockTime == null) continue;
    const dust = e.type === "withdraw" && (e.valueUsd ?? 0) < 1;
    if (!(e.type === "swap" || e.type === "other" || dust)) continue;
    let best = -1;
    let bestDt = GROUP_WINDOW_SEC + 1;
    for (const li of lpIdx) {
      const lt = events[li].blockTime;
      if (lt == null) continue;
      const dt = Math.abs(lt - e.blockTime);
      if (dt < bestDt) {
        bestDt = dt;
        best = li;
      }
    }
    if (best >= 0) host.set(i, best);
  }
  const kidsOf = new Map<number, number[]>();
  for (const [c, h] of host) {
    if (!kidsOf.has(h)) kidsOf.set(h, []);
    kidsOf.get(h)!.push(c);
  }
  const out: GroupedEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    if (host.has(i)) continue;
    const e = events[i];
    const kids = kidsOf.get(i);
    if (!kids?.length) {
      out.push(e);
      continue;
    }
    const g: GroupedEvent = {
      ...e,
      tokenDeltas: { ...e.tokenDeltas },
      groupedTypes: [],
      extraSol: 0,
      extraStable: 0,
    };
    let fee = e.feeSol ?? 0;
    for (const k of kids) {
      const c = events[k];
      g.groupedTypes!.push(c.type);
      g.solDelta += c.solDelta;
      for (const [sym, v] of Object.entries(c.tokenDeltas))
        g.tokenDeltas[sym] = (g.tokenDeltas[sym] ?? 0) + v;
      fee += c.feeSol ?? 0;
      g.extraSol! += c.solDelta;
      g.extraStable! += stableOf(c);
    }
    g.feeSol = fee;
    out.push(g);
  }
  return out;
}

// Δ баланса события:
// - переводы/свапы — их прямой денежный эффект;
// - выход LP — результат всего эпизода позиции: (выход + изъятия + сборы) −
//   (вход + довнесения), в исторических ценах, минус сетевые fee. Показывает,
//   насколько эффективным оказался этот кусок стратегии;
// - остальные LP-события — null (результат появится на выходе).
function computeDeltas(events: JournalEvent[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  // Эпизоды по позициям: аккумулируем потоки от open до close.
  const episode = new Map<string, { sum: number | null; hasOpen: boolean }>();
  for (const e of events) {
    const feeUsd = e.feeSol != null && e.priceUsd != null ? e.feeSol * e.priceUsd : 0;
    switch (e.type) {
      case "deposit":
        out.set(e.signature, e.valueUsd);
        break;
      case "withdraw":
        out.set(e.signature, e.valueUsd != null ? -e.valueUsd - feeUsd : null);
        break;
      case "swap":
      case "other": {
        const hasUnknown = Object.entries(e.tokenDeltas).some(
          ([sym, v]) => sym !== "USDC" && sym !== "USDT" && Math.abs(v) > 1e-9,
        );
        out.set(e.signature, hasUnknown ? null : flowUsd(e));
        break;
      }
      default: {
        // LP-событие: копим эпизод позиции.
        const key = e.position ?? "?";
        const ep = episode.get(key) ?? { sum: 0, hasOpen: false };
        const f = flowUsd(e);
        ep.sum = ep.sum == null || f == null ? null : ep.sum + f;
        if (e.type === "open") ep.hasOpen = true;
        episode.set(key, ep);
        if (e.type === "close") {
          out.set(e.signature, ep.hasOpen ? ep.sum : null);
          episode.delete(key);
        } else {
          out.set(e.signature, null);
        }
      }
    }
  }
  return out;
}

// ── Сводка для API ──────────────────────────────────────────────────────────

export function journalSummary(wallet: string): {
  events: Array<JournalEvent & { balanceDeltaUsd: number | null; balanceAfterUsd: number | null }>;
  netDepositedUsd: number | null;
  balance: BalanceSnapshot | null;
  pnlSinceStartUsd: number | null;
  changes: { d1: number | null; d7: number | null; d30: number | null };
} {
  const j = loadJournal(wallet);
  const snapshots = loadSnapshots(wallet);
  const balance = snapshots[snapshots.length - 1] ?? null;

  let netDeposited: number | null = null;
  for (const e of j.events) {
    if (e.type !== "deposit" && e.type !== "withdraw") continue;
    if (e.valueUsd == null) continue;
    netDeposited = (netDeposited ?? 0) + (e.type === "deposit" ? e.valueUsd : -e.valueUsd);
  }

  const changeSince = (sec: number): number | null => {
    if (!balance) return null;
    const target = balance.time - sec;
    const past = [...snapshots].reverse().find((s) => s.time <= target);
    return past ? balance.totalUsd - past.totalUsd : null;
  };

  const groups = groupEvents(j.events);

  // Снимок баланса портфеля после каждого шага: кумулятивные SOL и стейблы
  // (LP-потоки внутренние — общий портфель меняют только переводы, свапы и
  // комиссии; токены без цены, как ORCA, в снимок не входят) по цене шага.
  let runSol = 0;
  let runStable = 0;
  const balanceAfter = new Map<string, number | null>();
  for (const e of groups) {
    const transfer = e.type === "deposit" || e.type === "withdraw" || e.type === "swap" || e.type === "other";
    if (transfer) {
      runSol += e.solDelta;
      runStable += stableOf(e);
    } else {
      // влитые в LP-группу свапы/пыль меняют состав портфеля
      runSol += e.extraSol ?? 0;
      runStable += e.extraStable ?? 0;
    }
    runSol -= e.feeSol ?? 0;
    balanceAfter.set(
      e.signature,
      e.priceUsd != null ? runSol * e.priceUsd + runStable : null,
    );
  }

  const deltas = computeDeltas(groups);
  return {
    events: [...groups].reverse().map((e) => ({
      ...e,
      balanceDeltaUsd: deltas.get(e.signature) ?? null,
      balanceAfterUsd: balanceAfter.get(e.signature) ?? null,
    })),
    netDepositedUsd: netDeposited,
    balance,
    pnlSinceStartUsd:
      balance != null && netDeposited != null ? balance.totalUsd - netDeposited : null,
    changes: { d1: changeSince(86400), d7: changeSince(7 * 86400), d30: changeSince(30 * 86400) },
  };
}
