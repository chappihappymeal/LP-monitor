import fs from "node:fs";
import path from "node:path";

export interface Candle {
  time: number; // unix seconds, начало часа
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number; // объём за час в USD
}

const CACHE_DIR = ".cache";

// Coinbase Exchange: до 300 свечей за запрос, пагинация по start/end.
export async function fetchHourlyCandles(
  product: string,
  days: number,
  ttlMs = 6 * 3600_000,
): Promise<Candle[]> {
  const cacheFile = path.join(CACHE_DIR, `${product}-1h-${days}d.json`);
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (Date.now() - cached.fetchedAt < ttlMs) return cached.candles;
  }

  const end = Math.floor(Date.now() / 1000 / 3600) * 3600;
  const start = end - days * 86400;
  const out: Candle[] = [];
  for (let t = start; t < end; t += 300 * 3600) {
    const chunkEnd = Math.min(t + 300 * 3600, end);
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${new Date(t * 1000).toISOString()}&end=${new Date(chunkEnd * 1000).toISOString()}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "lp-monitor" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Coinbase ${res.status}: ${await res.text()}`);
    const rows: number[][] = await res.json();
    // формат: [time, low, high, open, close, volume(base)]
    for (const [time, low, high, open, close, vol] of rows) {
      out.push({ time, open, high, low, close, volumeUsd: vol * close });
    }
    await new Promise((r) => setTimeout(r, 350)); // rate limit
  }
  out.sort((a, b) => a.time - b.time);
  // Дедупликация на стыках чанков
  const dedup = out.filter((c, i) => i === 0 || c.time !== out[i - 1].time);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), candles: dedup }));
  return dedup;
}

// Реализованная волатильность (доля/день) по часовым доходностям за окно.
export function realizedVolDaily(candles: Candle[], endIdx: number, hours: number): number {
  const from = Math.max(1, endIdx - hours + 1);
  let sum = 0;
  let n = 0;
  for (let i = from; i <= endIdx; i++) {
    const r = Math.log(candles[i].close / candles[i - 1].close);
    sum += r * r;
    n++;
  }
  if (n === 0) return 0;
  return Math.sqrt((sum / n) * 24);
}
