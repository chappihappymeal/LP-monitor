import { fetchWalletPositions, hydratePosition, makeRpc } from "./lib/positions.js";
import { computePnl } from "./lib/history.js";
import { simulateRebalance } from "./lib/simulate.js";

const [wallet, cmd, ...rest] = process.argv.slice(2);

if (!wallet) {
  console.log(`Использование:
  npm run cli -- <адрес-кошелька>                         обзор позиций
  npm run cli -- <адрес-кошелька> sim <нижняя> <верхняя>  симуляция ребаланса (для каждой позиции)`);
  process.exit(1);
}

const usd = (v: number | null | undefined, digits = 2): string =>
  v == null ? "н/д" : `$${v.toFixed(digits)}`;
const num = (v: number, digits = 6): string => v.toFixed(digits).replace(/\.?0+$/, "");

const rpc = makeRpc();
const positions = await fetchWalletPositions(rpc, wallet);
if (positions.length === 0) {
  console.log("Позиций Orca Whirlpools на этом кошельке не найдено.");
  process.exit(0);
}
console.log(`Найдено позиций: ${positions.length}\n`);

for (const pos of positions) {
  const { view, ctx } = await hydratePosition(rpc, pos);
  const statusRu =
    view.status === "priceInRange"
      ? "в диапазоне ✅"
      : view.status === "priceBelowRange"
        ? "цена НИЖЕ диапазона ⚠️"
        : "цена ВЫШЕ диапазона ⚠️";
  console.log(`═══ ${view.pair} (${view.feeRatePct}%) — ${statusRu}`);
  console.log(`    Позиция: ${view.positionAddress}`);
  console.log(
    `    Диапазон: ${num(view.lowerPrice, 4)} — ${num(view.upperPrice, 4)}, текущая цена: ${num(view.currentPrice, 4)}`,
  );
  console.log(
    `    Состав: ${num(view.tokenA.uiAmount)} ${view.tokenA.symbol} + ${num(view.tokenB.uiAmount)} ${view.tokenB.symbol} = ${usd(view.valueUsd)}`,
  );
  console.log(
    `    Pending yield: ${usd(view.pendingYieldUsd, 4)} (комиссии: ${num(view.pendingFees.tokenA.uiAmount)} ${view.tokenA.symbol} + ${num(view.pendingFees.tokenB.uiAmount)} ${view.tokenB.symbol}${view.pendingRewards.length ? ` + реварды: ${view.pendingRewards.map((r) => `${num(r.uiAmount)} ${r.symbol}`).join(", ")}` : ""})`,
  );
  if (view.pool) {
    console.log(
      `    Пул: TVL ${usd(view.pool.tvlUsd, 0)}, объём 24ч ${usd(view.pool.volume24hUsd, 0)}, комиссии 24ч ${usd(view.pool.fees24hUsd, 0)}; APR позиции ≈ ${view.pool.positionFeeAprPct == null ? "н/д" : view.pool.positionFeeAprPct.toFixed(1) + "%"}`,
    );
  }
  try {
    const pnl = await computePnl(ctx, view);
    if (pnl.depositedValueUsd != null) {
      console.log(
        `    Вложено: ${usd(pnl.depositedValueUsd)} (${pnl.ageDays?.toFixed(1)} дн. назад), собрано дохода: ${usd(pnl.collectedYieldUsd)}, сетевые комиссии: ${pnl.txFeesSol.toFixed(5)} SOL`,
      );
      console.log(
        `    PnL: ${usd(pnl.totalPnlUsd)} всего | ${usd(pnl.vsHodlUsd)} против HODL | реализованная доходность ≈ ${pnl.realizedAprPct == null ? "н/д" : pnl.realizedAprPct.toFixed(1) + "% годовых"}`,
      );
    }
    if (pnl.note) console.log(`    ⓘ ${pnl.note}`);
  } catch (e) {
    console.log(`    ⓘ PnL не рассчитан: ${e}`);
  }

  if (cmd === "sim") {
    const [lo, hi] = rest.map(Number);
    if (lo > 0 && hi > lo) {
      const sim = await simulateRebalance(ctx, view, { newLowerPrice: lo, newUpperPrice: hi });
      console.log(`    ── Симуляция ребаланса в ${num(sim.input.lowerPrice, 4)} — ${num(sim.input.upperPrice, 4)}:`);
      console.log(
        `       Свап: ${sim.swap.direction === "none" ? "не нужен" : `${num(sim.swap.amountIn)} ${sim.swap.amountInSymbol} (${usd(sim.swap.valueUsd)})`}`,
      );
      console.log(
        `       Издержки: свап ${usd(sim.costs.swapFeeUsd, 4)} + сдвиг цены ${usd(sim.costs.priceImpactUsd, 4)} + сеть ${usd(sim.costs.networkFeeUsd, 4)} = ${usd(sim.costs.totalUsd, 4)}`,
      );
      console.log(
        `       Новая позиция: ${num(sim.next.amountA)} ${view.tokenA.symbol} + ${num(sim.next.amountB)} ${view.tokenB.symbol} = ${usd(sim.next.valueUsd)}; APR ≈ ${sim.next.aprPct == null ? "н/д" : sim.next.aprPct.toFixed(1) + "%"}`,
      );
      console.log(
        `       Доход/день: ${usd(sim.current.dailyFeesUsd, 4)} → ${usd(sim.next.dailyFeesUsd, 4)}; окупаемость издержек: ${sim.outcome.breakEvenDays == null ? "—" : sim.outcome.breakEvenDays.toFixed(1) + " дн."}`,
      );
      for (const n of sim.outcome.note) console.log(`       ⓘ ${n}`);
    } else {
      console.log("    sim: укажите корректные границы, например: sim 60 90");
    }
  }
  console.log();
}
