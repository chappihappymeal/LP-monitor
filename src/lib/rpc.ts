import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type Rpc,
  type SolanaRpcApi,
  type RpcTransport,
} from "@solana/kit";
import { RPC_URL, RPC_URL_SECONDARY } from "../config.js";

// Публичные RPC имеют разные ограничения:
//  - api.mainnet-beta.solana.com жёстко лимитирует getTransaction;
//  - solana-rpc.publicnode.com блокирует getTokenAccountsByOwner(programId)
//    и хранит неполный исторический индекс (старые подписи/транзакции пусты).
// Поэтому getTransaction уходит на вторичный эндпоинт с фолбэком на первичный
// при пустом ответе, плюс общий пейсинг и повторы с экспоненциальной задержкой.
const HISTORY_METHODS = new Set(["getTransaction"]);

const PACING_MS = 120;
const MAX_RETRIES = 5;

export function makeRpc(): Rpc<SolanaRpcApi> {
  const primary = createDefaultRpcTransport({ url: RPC_URL });
  const secondary =
    RPC_URL_SECONDARY && RPC_URL_SECONDARY !== RPC_URL
      ? createDefaultRpcTransport({ url: RPC_URL_SECONDARY })
      : null;

  let gate: Promise<void> = Promise.resolve();
  const pace = (): Promise<void> => {
    const prev = gate;
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    return prev.then(() => {
      setTimeout(release, PACING_MS);
    });
  };

  const transport: RpcTransport = async (config) => {
    const method = (config.payload as any)?.method as string | undefined;
    const useSecondary = secondary != null && method != null && HISTORY_METHODS.has(method);
    const chosen = useSecondary ? secondary : primary;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await pace();
      try {
        const res: any = await chosen(config);
        // Вторичный узел может не хранить старую транзакцию — добираем с первичного.
        if (useSecondary && res?.result == null) {
          await pace();
          return (await primary(config)) as any;
        }
        return res;
      } catch (e: any) {
        lastErr = e;
        const status = e?.context?.statusCode;
        const retriable = status === 429 || status === 403 || (status >= 500 && status < 600);
        if (!retriable || attempt === MAX_RETRIES) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    throw lastErr;
  };

  return createSolanaRpcFromTransport(transport);
}
