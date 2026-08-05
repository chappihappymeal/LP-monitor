/**
 * Автоматический ребалансировщик LP-позиции Orca Whirlpools.
 *
 * Стратегия (по итогам бэктеста на годе реальной истории SOL):
 *  - держим симметричный диапазон ±WIDTH_PCT (по умолчанию 5%);
 *  - при выходе цены за границу — ребаланс вокруг текущей цены;
 *  - при реализованной воле (48ч) выше VOL_PAUSE — закрываемся и ждём,
 *    пока вола не опустится ниже VOL_RESUME (защита от шторма);
 *  - лимиты безопасности: максимум действий в сутки, минимальный интервал,
 *    потолок издержек на один ребаланс.
 *
 * Режимы:
 *  DRY-RUN (по умолчанию): только рекомендации в консоль и bot-log.jsonl.
 *  LIVE=1 + SOLANA_KEYPAIR=/путь/к/id.json: реальное исполнение транзакций.
 *
 * Запуск: npm run bot -- <адрес-кошелька>   (в dry-run)
 *         LIVE=1 SOLANA_KEYPAIR=~/.config/solana/id.json npm run bot
 */
import fs from "node:fs";
import {
  fetchWalletPositions,
  hydratePosition,
  makeRpc,
  uiAmount,
  type PositionView,
} from "./lib/positions.js";
import { simulateRebalance } from "./lib/simulate.js";
import { fetchHourlyCandles, realizedVolDaily } from "./lib/candles.js";
import { fetchPoolDoc } from "./lib/orcaApi.js";
import { RPC_URL } from "./config.js";

const POOL = process.env.POOL ?? "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"; // SOL/USDC 0.04%
const CEX_PRODUCT = process.env.CEX_PRODUCT ?? "SOL-USD";
const WIDTH_PCT = Number(process.env.WIDTH_PCT ?? 5);
const VOL_PAUSE = Number(process.env.VOL_PAUSE ?? 5); // %/день — закрыться
const VOL_RESUME = Number(process.env.VOL_RESUME ?? 4); // %/день — можно заходить
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN ?? 5);
const EDGE_BUFFER_PCT = Number(process.env.EDGE_BUFFER_PCT ?? 0); // ребаланс заранее, за N% до границы
const MAX_ACTIONS_PER_DAY = Number(process.env.MAX_ACTIONS_PER_DAY ?? 8);
const MIN_ACTION_GAP_MIN = Number(process.env.MIN_ACTION_GAP_MIN ?? 30);
const MAX_COST_USD = Number(process.env.MAX_COST_USD ?? 2);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 100);
const LIVE = process.env.LIVE === "1";
const LOG_FILE = "bot-log.jsonl";

const log = (event: string, data: Record<string, unknown> = {}): void => {
  const entry = { ts: new Date().toISOString(), event, ...data };
  console.log(`[${entry.ts}] ${event}`, JSON.stringify(data));
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
};

const actionTimes: number[] = [];
const canAct = (): string | null => {
  const now = Date.now();
  const dayAgo = now - 86400_000;
  while (actionTimes.length && actionTimes[0] < dayAgo) actionTimes.shift();
  if (actionTimes.length >= MAX_ACTIONS_PER_DAY)
    return `лимит ${MAX_ACTIONS_PER_DAY} действий/сутки исчерпан`;
  if (actionTimes.length && now - actionTimes[actionTimes.length - 1] < MIN_ACTION_GAP_MIN * 60_000)
    return `меньше ${MIN_ACTION_GAP_MIN} мин с прошлого действия`;
  return null;
};

// ── Live-исполнение через официальные actions SDK ───────────────────────────
let walletAddress = process.argv.slice(2).find((a) => !a.startsWith("-"));
let orca: typeof import("@orca-so/whirlpools") | null = null;

async function setupLive(): Promise<void> {
  const kpPath = process.env.SOLANA_KEYPAIR;
  if (!kpPath) throw new Error("LIVE=1 требует SOLANA_KEYPAIR=/путь/к/id.json");
  orca = await import("@orca-so/whirlpools");
  const { setRpc, setPriorityFeeSetting } = await import("@orca-so/tx-sender");
  await setRpc(RPC_URL);
  setPriorityFeeSetting({ type: "dynamic", maxCapLamports: 1_000_000n });
  orca.setDefaultSlippageToleranceBps(SLIPPAGE_BPS);
  const bytes = new Uint8Array(JSON.parse(fs.readFileSync(kpPath.replace(/^~/, process.env.HOME ?? ""), "utf8")));
  const signer = await orca.setPayerFromBytes(bytes.slice(0, 64));
  orca.setDefaultFunder(signer);
  walletAddress = signer.address;
  log("live_init", { wallet: walletAddress });
}

async function executeRebalance(
  view: PositionView,
  newLower: number,
  newUpper: number,
): Promise<void> {
  if (!orca) throw new Error("live не инициализирован");
  const { address } = await import("@solana/kit");
  const { fetchWhirlpool } = await import("@orca-so/whirlpools-client");
  const { sqrtPriceToPrice, increaseLiquidityQuote, priceToTickIndex, tickIndexToPrice } =
    await import("@orca-so/whirlpools-core");
  const rpc = makeRpc();

  // 1. Закрыть позицию (harvest входит в closePosition)
  const close = await orca.closePosition(address(view.positionMint));
  const closeSig = await close.callback();
  log("tx_close", { signature: closeSig, position: view.positionAddress });

  // 2. Балансы после закрытия
  const pool = (await fetchWhirlpool(rpc, address(view.whirlpool))).data;
  const decA = view.tokenA.decimals;
  const decB = view.tokenB.decimals;
  const price = sqrtPriceToPrice(pool.sqrtPrice, decA, decB);
  const balance = async (mint: string, dec: number): Promise<number> => {
    if (mint === "So11111111111111111111111111111111111111112") {
      const lam = await rpc.getBalance(address(walletAddress!)).send();
      return Math.max(0, Number(lam.value) / 1e9 - 0.05); // резерв на комиссии
    }
    const res = await rpc
      .getTokenAccountsByOwner(address(walletAddress!), { mint: address(mint) }, { encoding: "jsonParsed" })
      .send();
    let s = 0;
    for (const a of res.value) s += Number(a.account.data.parsed.info.tokenAmount.amount);
    return s / 10 ** dec;
  };
  let balA = await balance(view.tokenA.mint, decA);
  let balB = await balance(view.tokenB.mint, decB);

  // 3. Свап к соотношению нового диапазона
  const spacing = pool.tickSpacing;
  const snap = (p: number, mode: "floor" | "ceil"): number => {
    const t = priceToTickIndex(p, decA, decB) / spacing;
    return (mode === "floor" ? Math.floor(t) : Math.ceil(t)) * spacing;
  };
  const lowerTick = snap(newLower, "floor");
  const upperTick = snap(newUpper, "ceil");
  const unit = increaseLiquidityQuote(10n ** 12n, 0, pool.sqrtPrice, lowerTick, upperTick);
  const unitA = uiAmount(unit.tokenEstA, decA);
  const unitB = uiAmount(unit.tokenEstB, decB);
  const unitValB = unitA * price + unitB;
  const totalB = balA * price + balB;
  const targetA = (unitA * (totalB / unitValB));
  const deltaA = targetA - balA; // >0 купить A, <0 продать A
  const deltaValueB = Math.abs(deltaA) * price;
  if (deltaValueB > 1) {
    const swapRes =
      deltaA < 0
        ? await orca.swap(
            { inputAmount: BigInt(Math.floor(-deltaA * 10 ** decA)), mint: address(view.tokenA.mint) },
            address(view.whirlpool),
          )
        : await orca.swap(
            { inputAmount: BigInt(Math.floor(deltaValueB * 10 ** decB)), mint: address(view.tokenB.mint) },
            address(view.whirlpool),
          );
    const swapSig = await swapRes.callback();
    log("tx_swap", { signature: swapSig, deltaA, valueUsd: deltaValueB });
    balA = await balance(view.tokenA.mint, decA);
    balB = await balance(view.tokenB.mint, decB);
  }

  // 4. Открыть новую позицию: отдаём оба баланса с запасом 0.5% на слиппедж,
  // SDK сам возьмёт максимум ликвидности в пределах лимитов.
  const lowerPrice = tickIndexToPrice(lowerTick, decA, decB);
  const upperPrice = tickIndexToPrice(upperTick, decA, decB);
  const open = await orca.openConcentratedPosition(
    address(view.whirlpool),
    {
      tokenMaxA: BigInt(Math.floor(balA * 0.995 * 10 ** decA)),
      tokenMaxB: BigInt(Math.floor(balB * 0.995 * 10 ** decB)),
    },
    lowerPrice,
    upperPrice,
  );
  const openSig = await open.callback();
  log("tx_open", { signature: openSig, lowerPrice, upperPrice, positionMint: open.positionMint });
}

// ── Основной цикл ───────────────────────────────────────────────────────────
async function tick(): Promise<void> {
  const rpc = makeRpc();
  const candles = await fetchHourlyCandles(CEX_PRODUCT, 8, 30 * 60_000);
  const vol = realizedVolDaily(candles, candles.length - 1, 48) * 100; // %/день
  const doc = await fetchPoolDoc(POOL);
  const price = doc?.price ?? candles[candles.length - 1].close;

  const positions = await fetchWalletPositions(rpc, walletAddress!);
  const inPool = [];
  for (const p of positions) {
    if (p.data.whirlpool === POOL) {
      const { view, ctx } = await hydratePosition(rpc, p);
      inPool.push({ view, ctx });
    }
  }

  if (inPool.length === 0) {
    if (vol >= VOL_RESUME) {
      log("wait", { reason: "нет позиции, вола высокая", volPct: +vol.toFixed(2) });
      return;
    }
    const lo = price * (1 - WIDTH_PCT / 100);
    const hi = price * (1 + WIDTH_PCT / 100);
    log("recommend_open", {
      volPct: +vol.toFixed(2),
      price,
      range: [lo, hi],
      note: LIVE
        ? "открытие новой позиции выполняй вручную или доработай executeOpen — бот открывает только после своего же закрытия"
        : "dry-run: открой позицию в этом диапазоне",
    });
    return;
  }

  for (const { view, ctx } of inPool) {
    const w = WIDTH_PCT / 100;
    const buffer = (view.upperPrice - view.lowerPrice) * (EDGE_BUFFER_PCT / 100);
    const out =
      view.currentPrice <= view.lowerPrice + buffer ||
      view.currentPrice >= view.upperPrice - buffer;
    const storm = vol >= VOL_PAUSE;

    if (!out && !storm) {
      log("ok", {
        position: view.positionAddress,
        price: +view.currentPrice.toFixed(4),
        range: [+view.lowerPrice.toFixed(4), +view.upperPrice.toFixed(4)],
        volPct: +vol.toFixed(2),
        pendingYieldUsd: view.pendingYieldUsd,
      });
      continue;
    }

    const gateMsg = canAct();
    if (gateMsg) {
      log("skip", { position: view.positionAddress, reason: gateMsg });
      continue;
    }

    if (storm) {
      log(LIVE ? "action_close_storm" : "recommend_close_storm", {
        position: view.positionAddress,
        volPct: +vol.toFixed(2),
        threshold: VOL_PAUSE,
      });
      if (LIVE && orca) {
        const { address } = await import("@solana/kit");
        const close = await orca.closePosition(address(view.positionMint));
        const sig = await close.callback();
        actionTimes.push(Date.now());
        log("tx_close", { signature: sig, reason: "storm" });
      }
      continue;
    }

    // Выход за диапазон → ребаланс вокруг текущей цены
    const newLower = view.currentPrice * (1 - w);
    const newUpper = view.currentPrice * (1 + w);
    const sim = await simulateRebalance(ctx, view, {
      newLowerPrice: newLower,
      newUpperPrice: newUpper,
      swapSlippageBps: SLIPPAGE_BPS,
    });
    const cost = sim.costs.totalUsd ?? Infinity;
    if (cost > MAX_COST_USD) {
      log("skip", {
        position: view.positionAddress,
        reason: `издержки $${cost.toFixed(2)} > лимита $${MAX_COST_USD}`,
      });
      continue;
    }
    log(LIVE ? "action_rebalance" : "recommend_rebalance", {
      position: view.positionAddress,
      price: +view.currentPrice.toFixed(4),
      oldRange: [+view.lowerPrice.toFixed(4), +view.upperPrice.toFixed(4)],
      newRange: [+sim.input.lowerPrice.toFixed(4), +sim.input.upperPrice.toFixed(4)],
      costUsd: +cost.toFixed(4),
      swap: sim.swap.direction === "none" ? null : `${sim.swap.amountIn.toFixed(6)} ${sim.swap.amountInSymbol}`,
      volPct: +vol.toFixed(2),
    });
    if (LIVE) {
      actionTimes.push(Date.now());
      await executeRebalance(view, newLower, newUpper);
    }
  }
}

// ── Запуск ──────────────────────────────────────────────────────────────────
if (LIVE) {
  await setupLive();
} else if (!walletAddress) {
  console.error("Использование: npm run bot -- <адрес-кошелька>  (dry-run)");
  console.error("Live-режим:   LIVE=1 SOLANA_KEYPAIR=~/.config/solana/id.json npm run bot");
  process.exit(1);
}

log("start", {
  mode: LIVE ? "LIVE" : "dry-run",
  wallet: walletAddress,
  pool: POOL,
  widthPct: WIDTH_PCT,
  volPause: VOL_PAUSE,
  volResume: VOL_RESUME,
  intervalMin: INTERVAL_MIN,
});

for (;;) {
  try {
    await tick();
  } catch (e) {
    log("error", { message: String(e) });
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MIN * 60_000));
}
