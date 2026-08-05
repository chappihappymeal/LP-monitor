import { fetchHourlyCandles, realizedVolDaily, type Candle } from "./candles.js";
import type { PositionView } from "./positions.js";

// Рыночный контекст для советника: вола, тренд, просадка от 30-дн максимума.
export interface MarketState {
  price: number;
  vol48hPct: number; // реализованная вола, %/день
  trend72hPct: number; // изменение цены за 72ч, %
  drawdownFrom30dHighPct: number; // насколько ниже 30-дн максимума, %
  high30d: number;
  regime: "risk-off" | "storm" | "trend-up" | "calm" | "normal";
}

export interface Advice {
  action: string; // что сделать
  gives: string; // что это даст
  costUsd: number | null; // сколько будет стоить
  urgency: "high" | "medium" | "low";
}

// Пороги — из бэктестов на годе реальной истории (см. backtest-guard/history).
const RISK_OFF_PCT = 8; // просадка от 30-дн максимума → выход
const RISK_ON_PCT = 4; // возврат к этой просадке → можно заходить
const STORM_VOL = 5; // %/день
const CALM_VOL = 1.6; // ниже — узкие диапазоны в плюс
const TREND_UP = 5; // рост за 72ч сильнее → LP отстаёт от HODL

export async function buildMarketState(product = "SOL-USD"): Promise<MarketState> {
  const candles = await fetchHourlyCandles(product, 31, 30 * 60_000);
  const last = candles[candles.length - 1];
  const vol = realizedVolDaily(candles, candles.length - 1, 48) * 100;
  const trendIdx = Math.max(0, candles.length - 73);
  const trend = (last.close / candles[trendIdx].close - 1) * 100;
  const high30d = Math.max(...candles.slice(-720).map((c: Candle) => c.high));
  const dd = (1 - last.close / high30d) * 100;

  let regime: MarketState["regime"] = "normal";
  if (dd >= RISK_OFF_PCT) regime = "risk-off";
  else if (vol >= STORM_VOL) regime = "storm";
  else if (trend >= TREND_UP) regime = "trend-up";
  else if (vol <= CALM_VOL) regime = "calm";

  return {
    price: last.close,
    vol48hPct: vol,
    trend72hPct: trend,
    drawdownFrom30dHighPct: dd,
    high30d,
    regime,
  };
}

// Гамма-издержки позиции (LVR), $/день: V·σ²/(4·k(w)), где k — фактор ширины.
function lvrPerDay(valueUsd: number, volDailyPct: number, lowerPrice: number, upperPrice: number, price: number): number {
  const wl = Math.max(0.001, 1 - lowerPrice / price);
  const wu = Math.max(0.001, upperPrice / price - 1);
  const k = 2 - 1 / Math.sqrt(1 + wu) - Math.sqrt(1 - Math.min(wl, 0.99));
  const sigma = volDailyPct / 100;
  return (valueUsd * sigma * sigma) / (4 * k);
}

const usd = (v: number, d = 2): string => `$${v.toFixed(d)}`;

export function adviseForPosition(view: PositionView, m: MarketState): Advice {
  const value = view.valueUsd ?? 0;
  const feeRate = view.feeRatePct / 100;
  // Издержки полного выхода: закрытие + свап SOL-половины в USDC.
  const exitCost = 0.25 * value * feeRate + 0.12 + 0.5 * value * 0.0005;
  // Издержки ребаланса: свап ~половины + сеть.
  const rebalCost = 0.5 * value * feeRate + 0.15;
  const dailyFees = view.pool?.fees24hUsd != null && view.shareOfPoolPct != null
    ? view.pool.fees24hUsd * (view.shareOfPoolPct / 100)
    : null;
  const lvr = lvrPerDay(value, m.vol48hPct, view.lowerPrice, view.upperPrice, view.currentPrice);
  const carry = dailyFees != null ? dailyFees - lvr : null;
  const carryTxt =
    carry != null
      ? `carry ≈ ${carry >= 0 ? "+" : "−"}${usd(Math.abs(carry), 2)}/день (комиссии ${usd(dailyFees!, 2)} − гамма-издержки ${usd(lvr, 2)})`
      : "carry не рассчитан";

  if (m.regime === "risk-off") {
    return {
      action: `Закрыть позицию и выйти в USDC: цена на ${m.drawdownFrom30dHighPct.toFixed(1)}% ниже 30-дн максимума (порог ${RISK_OFF_PCT}%)`,
      gives: `Защита от продолжения падения — на годовой истории этот сигнал сокращал убыток с −$116 до −$22 на $320. Пере-вход: просадка от максимума < ${RISK_ON_PCT}%`,
      costUsd: exitCost,
      urgency: "high",
    };
  }
  if (m.regime === "storm") {
    return {
      action: `Закрыться или не заходить: вола ${m.vol48hPct.toFixed(1)}%/день выше штормового порога ${STORM_VOL}%`,
      gives: `При такой воле гамма-издержки (~${usd(lvr, 2)}/день) кратно превышают комиссии — LP гарантированно сжигает деньги`,
      costUsd: exitCost,
      urgency: "high",
    };
  }

  const out = view.status !== "priceInRange";
  if (out) {
    if (m.regime === "trend-up") {
      return {
        action: `Цена вне диапазона (тренд +${m.trend72hPct.toFixed(1)}% за 72ч). НЕ спешить с ребалансом — дождаться затухания тренда`,
        gives: `Ребаланс в растущем тренде продаёт SOL на каждом шаге: в зеркальном бычьем годе это стоило LP −$27 при +$200 у простого удержания. Вне диапазона ты сейчас 100% в ${view.currentPrice <= view.lowerPrice ? view.tokenA.symbol : view.tokenB.symbol} — в росте это ок`,
        costUsd: 0,
        urgency: "low",
      };
    }
    return {
      action: `Ребаланс: вернуть диапазон ±12% вокруг цены ${m.price.toFixed(2)} — позиция вне диапазона и не зарабатывает`,
      gives: dailyFees != null ? `Возврат комиссий ≈ ${usd(dailyFees, 2)}/день; ${carryTxt}` : "Возврат комиссионного дохода",
      costUsd: rebalCost,
      urgency: "medium",
    };
  }

  if (m.regime === "calm" && carry != null && carry > 0) {
    const narrowGain = dailyFees != null ? dailyFees * 1.3 : 0; // ±12→±5 даёт ~2.3x комиссий, LVR тоже растёт — оценка чистыми ~+130%
    return {
      action: `Держать; вола ${m.vol48hPct.toFixed(1)}%/день — штиль. Можно сузить до ±5% для увеличения carry`,
      gives: `Сейчас ${carryTxt}. Сужение до ±5% ≈ +${usd(narrowGain, 2)}/день чистыми, но потребует ребаланса при движении ±5% и вернёт риск при росте волы`,
      costUsd: rebalCost,
      urgency: "low",
    };
  }
  if (m.regime === "trend-up") {
    return {
      action: `Ничего не делать. Тренд +${m.trend72hPct.toFixed(1)}%/72ч — LP в тренде отстаёт от удержания, но позиция в диапазоне и собирает комиссии`,
      gives: carryTxt,
      costUsd: 0,
      urgency: "low",
    };
  }
  return {
    action: "Ничего не делать — позиция в диапазоне, режим нормальный",
    gives: `${carryTxt}. Любое действие сейчас стоит дороже, чем даст`,
    costUsd: 0,
    urgency: "low",
  };
}

// Совет для кошелька без позиций в отслеживаемом пуле.
export function adviseNoPosition(m: MarketState): Advice {
  if (m.regime === "risk-off") {
    return {
      action: `Не заходить: risk-off (цена −${m.drawdownFrom30dHighPct.toFixed(1)}% от 30-дн максимума). Ждать возврата к −${RISK_ON_PCT}%`,
      gives: "На истории вход в падении — главный источник убытка LP",
      costUsd: null,
      urgency: "medium",
    };
  }
  if (m.regime === "storm") {
    return {
      action: `Не заходить: вола ${m.vol48hPct.toFixed(1)}%/день (шторм)`,
      gives: "Гамма-издержки кратно превышают комиссии",
      costUsd: null,
      urgency: "medium",
    };
  }
  if (m.regime === "calm") {
    return {
      action: `Можно заходить: вола ${m.vol48hPct.toFixed(1)}%/день — штиль. Диапазон ±5–12% вокруг ${m.price.toFixed(2)}`,
      gives: "В штиль carry узких диапазонов положительный (см. backtest:history)",
      costUsd: null,
      urgency: "low",
    };
  }
  return {
    action: `Нейтрально: вола ${m.vol48hPct.toFixed(1)}%/день, тренд ${m.trend72hPct >= 0 ? "+" : ""}${m.trend72hPct.toFixed(1)}%/72ч. Если заходить — широкий диапазон ±12%`,
    gives: "Carry около нуля: LP ≈ HODL, решает дальнейший режим",
    costUsd: null,
    urgency: "low",
  };
}
