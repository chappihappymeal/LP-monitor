import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "./config.js";
import {
  fetchWalletPositions,
  hydratePosition,
  makeRpc,
  type HydratedContext,
  type PositionView,
} from "./lib/positions.js";
import { computePnl } from "./lib/history.js";
import { simulateRebalance } from "./lib/simulate.js";
import { aggregateCandles, ensureCandleStore, type Timeframe } from "./lib/candles.js";
import {
  adviseAlternatives,
  adviseForPosition,
  adviseNoPosition,
  buildMarketState,
} from "./lib/advice.js";
import { computeTA, suggestRange } from "./lib/ta.js";
import {
  appendFeeLog,
  fetchWalletUsd,
  getSyncState,
  journalSummary,
  saveComment,
  snapshotBalance,
  startSync,
} from "./lib/journal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const rpc = makeRpc();

// Контексты последней загрузки — чтобы симуляция не перечитывала всё заново.
const ctxCache = new Map<string, { at: number; ctx: HydratedContext; view: PositionView }>();

function isValidAddress(s: unknown): s is string {
  return typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

app.get("/api/positions", async (req, res) => {
  const wallet = req.query.wallet;
  const withPnl = req.query.pnl !== "0";
  if (!isValidAddress(wallet)) {
    res.status(400).json({ error: "Некорректный адрес кошелька" });
    return;
  }
  try {
    let market = null;
    try {
      market = await buildMarketState();
    } catch (e) {
      console.warn("market state failed:", e);
    }
    const positions = await fetchWalletPositions(rpc, wallet);
    const out = [];
    for (const pos of positions) {
      try {
        const { view, ctx } = await hydratePosition(rpc, pos);
        ctxCache.set(view.positionAddress, { at: Date.now(), ctx, view });
        let pnl = null;
        if (withPnl) {
          try {
            pnl = await computePnl(ctx, view);
          } catch (e) {
            console.warn(`pnl failed for ${view.positionAddress}:`, e);
          }
        }
        const advice = market ? adviseForPosition(view, market) : null;
        const alternatives = market ? adviseAlternatives(view, market) : null;
        out.push({ ...view, pnl, advice, alternatives });
      } catch (e) {
        console.warn(`hydrate failed for ${pos.address}:`, e);
        out.push({ positionAddress: pos.address, error: String(e) });
      }
    }
    const noPositions = market && out.filter((p: any) => !p.error).length === 0;
    const walletAdvice = noPositions ? adviseNoPosition(market!) : null;
    const walletAlternatives = noPositions ? adviseAlternatives(null, market!) : null;
    res.json({ wallet, positions: out, market, walletAdvice, walletAlternatives, fetchedAt: Date.now() });

    // Снапшот баланса для журнала: кошелёк + позиции + несобранные комиссии
    // (pending в Orca уже нетто — протокольная доля вычтена на уровне пула).
    try {
      const positionsUsd = out.reduce((s: number, p: any) => s + (p.valueUsd ?? 0), 0);
      const pendingUsd = out.reduce((s: number, p: any) => s + (p.pendingYieldUsd ?? 0), 0);
      const walletUsd = await fetchWalletUsd(rpc, wallet, market?.price ?? null);
      snapshotBalance(wallet, walletUsd, positionsUsd, pendingUsd);
    } catch (e) {
      console.warn("balance snapshot failed:", e);
    }
  } catch (e: any) {
    console.error("positions error:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/api/simulate", async (req, res) => {
  const { positionAddress, newLowerPrice, newUpperPrice, swapSlippageBps } = req.body ?? {};
  const cached = ctxCache.get(positionAddress);
  if (!cached) {
    res.status(404).json({
      error: "Позиция не загружена — сначала запросите /api/positions по кошельку",
    });
    return;
  }
  try {
    // Обновляем данные пула/позиции, если кэш старше 30 секунд.
    let { ctx, view } = cached;
    if (Date.now() - cached.at > 30_000) {
      const fresh = await hydratePosition(rpc, ctx.position);
      ctx = fresh.ctx;
      view = fresh.view;
      ctxCache.set(view.positionAddress, { at: Date.now(), ctx, view });
    }
    const result = await simulateRebalance(ctx, view, {
      newLowerPrice: Number(newLowerPrice),
      newUpperPrice: Number(newUpperPrice),
      swapSlippageBps: swapSlippageBps != null ? Number(swapSlippageBps) : undefined,
    });
    res.json(result);
  } catch (e: any) {
    console.error("simulate error:", e);
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// ── Свечи для графика в карточке позиции ────────────────────────────────────
const CANDLE_PRODUCTS = new Set(["SOL-USD", "ETH-USD", "BTC-USD"]);
const TIMEFRAMES = new Set<Timeframe>(["1h", "4h", "1d", "1w", "1M"]);
const candleProductsSeen = new Set<string>(["SOL-USD"]);

app.get("/api/candles", async (req, res) => {
  const product = String(req.query.product ?? "SOL-USD");
  const tf = String(req.query.tf ?? "1h") as Timeframe;
  if (!CANDLE_PRODUCTS.has(product) || !TIMEFRAMES.has(tf)) {
    res.status(400).json({ error: "Неизвестный product или tf" });
    return;
  }
  try {
    candleProductsSeen.add(product);
    const hourly = await ensureCandleStore(product);
    const price = hourly[hourly.length - 1].close;
    const ta = computeTA(hourly.slice(-240 * 24), price);
    res.json({
      product,
      tf,
      candles: aggregateCandles(hourly, tf).map(({ volumeUsd, ...c }) => c),
      levels: {
        price,
        supports: ta.supports,
        resistances: ta.resistances,
        suggestedRange: suggestRange(ta, price),
      },
    });
  } catch (e: any) {
    console.error("candles error:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// ── Журнал сделок ───────────────────────────────────────────────────────────
app.get("/api/journal", (req, res) => {
  const wallet = req.query.wallet;
  if (!isValidAddress(wallet)) {
    res.status(400).json({ error: "Некорректный адрес кошелька" });
    return;
  }
  try {
    const sync = startSync(rpc, wallet); // фоновый синк, ответ не ждёт
    const summary = journalSummary(wallet);
    res.json({
      wallet,
      syncing: sync.running,
      processed: sync.processed,
      syncError: sync.error,
      syncedAt: sync.finishedAt,
      ...summary,
    });
  } catch (e: any) {
    console.error("journal error:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Замер fee: pending yield и расчётный темп по открытым позициям; каждая
// запись сохраняется в data/feelog-<wallet>.json — сырьё для будущего графика.
app.get("/api/feereport", async (req, res) => {
  const wallet = req.query.wallet;
  if (!isValidAddress(wallet)) {
    res.status(400).json({ error: "Некорректный адрес кошелька" });
    return;
  }
  try {
    const positions = await fetchWalletPositions(rpc, wallet);
    let pending = 0;
    let est = 0;
    let value = 0;
    for (const pos of positions) {
      const { view } = await hydratePosition(rpc, pos);
      pending += view.pendingYieldUsd ?? 0;
      value += view.valueUsd ?? 0;
      if (view.pool?.fees24hUsd != null && view.shareOfPoolPct != null)
        est += (view.pool.fees24hUsd * view.shareOfPoolPct) / 100;
    }
    res.json(appendFeeLog(wallet, pending, est, value));
  } catch (e: any) {
    console.error("feereport error:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Лёгкий статус позиций для позиционных алертов бота: где цена внутри диапазона.
app.get("/api/rangestatus", async (req, res) => {
  const wallet = req.query.wallet;
  if (!isValidAddress(wallet)) {
    res.status(400).json({ error: "Некорректный адрес кошелька" });
    return;
  }
  try {
    const positions = await fetchWalletPositions(rpc, wallet);
    const out = [];
    for (const pos of positions) {
      const { view } = await hydratePosition(rpc, pos);
      out.push({
        positionAddress: view.positionAddress,
        pair: view.pair,
        lower: view.lowerPrice,
        upper: view.upperPrice,
        price: view.currentPrice,
        status: view.status,
      });
    }
    res.json({ positions: out, fetchedAt: Date.now() });
  } catch (e: any) {
    console.error("rangestatus error:", e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/api/journal/comment", (req, res) => {
  const { wallet, signature, comment } = req.body ?? {};
  if (!isValidAddress(wallet) || typeof signature !== "string" || typeof comment !== "string") {
    res.status(400).json({ error: "Нужны wallet, signature и comment" });
    return;
  }
  if (saveComment(wallet, signature, comment)) res.json({ ok: true });
  else res.status(404).json({ error: "Событие не найдено в журнале" });
});

// Дотяжка store фоном: при старте и раз в 15 минут (внутри — троттлинг 10 мин).
const topUpStores = (): void => {
  for (const p of candleProductsSeen)
    ensureCandleStore(p).catch((e) => console.warn(`candle store ${p}:`, e));
};
topUpStores();
setInterval(topUpStores, 15 * 60_000).unref();

app.listen(PORT, () => {
  console.log(`LP-monitor запущен: http://localhost:${PORT}`);
});
