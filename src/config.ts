export const RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

// Вторичный эндпоинт для тяжёлых исторических методов (getTransaction и т.п.).
// Если задан свой быстрый SOLANA_RPC_URL (Helius/Triton/QuickNode), вторичный
// можно отключить: SOLANA_RPC_URL_SECONDARY="" (пустая строка).
export const RPC_URL_SECONDARY =
  process.env.SOLANA_RPC_URL_SECONDARY ??
  (process.env.SOLANA_RPC_URL ? "" : "https://solana-rpc.publicnode.com");

export const ORCA_API = "https://api.orca.so/v2/solana";

export const PORT = Number(process.env.PORT ?? 3000);

// Стейблкоины: если один из токенов пары — стейбл, цену пары можно
// использовать как историческую USD-цену второго токена.
export const STABLE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX", // USDH
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD (mainnet)
]);

export const SOL_MINT = "So11111111111111111111111111111111111111112";

// Оценка сетевых издержек ребаланса (close + swap + open), в SOL.
// Рента позиционного NFT в основном возвращается при закрытии, поэтому
// считаем только невозвратные комиссии за подписи + приоритетные сборы.
export const REBALANCE_TX_COST_SOL = 0.0015;

// Максимум транзакций истории позиции, которые разбираем для расчёта PnL.
export const MAX_HISTORY_TX = 40;
