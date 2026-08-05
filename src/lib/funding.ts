import fs from "node:fs";
import path from "node:path";

// Почасовые ставки фандинга перпа (Hyperliquid). Положительный фандинг:
// лонги платят шортам — шорт-хедж ПОЛУЧАЕТ ставку с нотионала.
export interface FundingPoint {
  time: number; // unix seconds
  rate: number; // ставка за час (доля нотионала)
}

const CACHE_DIR = ".cache";

export async function fetchFundingHistory(
  coin: string,
  days: number,
): Promise<FundingPoint[]> {
  const cacheFile = path.join(CACHE_DIR, `funding-${coin}-${days}d.json`);
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (Date.now() - cached.fetchedAt < 6 * 3600_000) return cached.points;
  }

  const out: FundingPoint[] = [];
  let start = Date.now() - days * 86400_000;
  const until = Date.now();
  while (start < until) {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fundingHistory", coin, startTime: start }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Hyperliquid ${res.status}`);
    const rows: Array<{ time: number; fundingRate: string }> = await res.json();
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({ time: Math.floor(r.time / 1000), rate: Number(r.fundingRate) });
    }
    const lastTime = rows[rows.length - 1].time;
    if (lastTime <= start) break;
    start = lastTime + 1;
    await new Promise((r) => setTimeout(r, 300));
  }
  const dedup = out.filter((p, i) => i === 0 || p.time !== out[i - 1].time);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), points: dedup }));
  return dedup;
}

// Индексация ставок по часу для быстрого доступа из бэктеста.
export function fundingByHour(points: FundingPoint[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of points) m.set(Math.floor(p.time / 3600) * 3600, p.rate);
  return m;
}
