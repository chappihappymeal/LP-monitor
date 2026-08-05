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
import { fetchHourlyCandles, realizedVolDaily } from "./lib/candles.js";
import { adviseForPosition, adviseNoPosition, buildMarketState } from "./lib/advice.js";

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
        out.push({ ...view, pnl, advice });
      } catch (e) {
        console.warn(`hydrate failed for ${pos.address}:`, e);
        out.push({ positionAddress: pos.address, error: String(e) });
      }
    }
    const walletAdvice =
      market && out.filter((p: any) => !p.error).length === 0 ? adviseNoPosition(market) : null;
    res.json({ wallet, positions: out, market, walletAdvice, fetchedAt: Date.now() });
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

// ── Вкладка «Рынок»: волатильность и вердикт бота ───────────────────────────
// Пороги и ширина — те же env-переменные и дефолты, что в bot.ts.
const VOL_PAUSE = Number(process.env.VOL_PAUSE ?? 5); // %/день — пауза
const VOL_RESUME = Number(process.env.VOL_RESUME ?? 4); // %/день — можно заходить
const WIDTH_PCT = Number(process.env.WIDTH_PCT ?? 12);
const MARKET_STUBS = ["ETH", "BTC", "ORCA", "JUP"];

let marketCache: { at: number; data: unknown } | null = null;

app.get("/api/market", async (_req, res) => {
  if (marketCache && Date.now() - marketCache.at < 10 * 60_000) {
    res.json(marketCache.data);
    return;
  }
  let sol: Record<string, unknown>;
  try {
    const candles = await fetchHourlyCandles("SOL-USD", 7);
    const last = candles.length - 1;
    const closeAgo = (h: number) => candles[Math.max(0, last - h)].close;
    const changePct = (h: number) => (candles[last].close / closeAgo(h) - 1) * 100;
    const volPct = (h: number) => realizedVolDaily(candles, last, h) * 100;
    const vol48 = volPct(48);
    sol = {
      symbol: "SOL",
      filled: true,
      product: "SOL-USD",
      price: candles[last].close,
      change24hPct: changePct(24),
      change7dPct: changePct(24 * 7),
      vol24hPct: volPct(24),
      vol48hPct: vol48,
      vol7dPct: volPct(24 * 7),
      verdict: vol48 > VOL_PAUSE ? "storm" : vol48 < VOL_RESUME ? "ok" : "cooldown",
      recommendedRangePct: WIDTH_PCT,
      volPausePct: VOL_PAUSE,
      volResumePct: VOL_RESUME,
    };
  } catch (e: any) {
    console.error("market error:", e);
    sol = { symbol: "SOL", filled: true, error: e?.message ?? String(e) };
  }
  const data = {
    fetchedAt: Date.now(),
    coins: [sol, ...MARKET_STUBS.map((symbol) => ({ symbol, filled: false }))],
  };
  if (!("error" in sol)) marketCache = { at: Date.now(), data };
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`LP-monitor запущен: http://localhost:${PORT}`);
});
