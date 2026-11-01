/**
 * Keeps the owner informed without relying on the agent process:
 *  - pending approval requests come from the contract's `list_pending` view;
 *  - blocked attempts come from the vault's recent transactions (FastNEAR transactions API)
 *    and the `transfer_blocked` events in their logs (NEAR RPC `tx`).
 * Blocks by the off-chain risk layer never reach the chain; the agent host reports those
 * directly with `GuardBot.notifyBlocked` (see `bridge.ts`).
 */
import { explorerTx } from "../near/guard-client";
import type { Network } from "../risk/types";
import { type BlockedAttempt, describeAmount, type GuardBot } from "./bot";

export interface BlockedEventSource {
  poll(): Promise<BlockedAttempt[]>;
}

export const FASTNEAR_TX_API: Partial<Record<Network, string>> = {
  mainnet: "https://tx.main.fastnear.com",
  testnet: "https://tx.test.fastnear.com",
};

interface TransferBlockedEvent {
  agent: string;
  asset: string;
  receiver_id: string;
  amount: string;
  code: string;
  reason: string;
}

/** Parses PurseStrings' NEP-297 `transfer_blocked` events out of transaction logs. */
export function blockedEventsFromLogs(logs: string[]): TransferBlockedEvent[] {
  const out: TransferBlockedEvent[] = [];
  for (const l of logs) {
    if (!l.startsWith("EVENT_JSON:")) continue;
    try {
      const e = JSON.parse(l.slice("EVENT_JSON:".length)) as { standard?: string; event?: string; data?: unknown };
      if (e.standard !== "nearguard" || e.event !== "transfer_blocked") continue;
      const d = (Array.isArray(e.data) ? e.data[0] : e.data) as TransferBlockedEvent;
      if (d && typeof d.code === "string") out.push(d);
    } catch {
      // not JSON: ignore
    }
  }
  return out;
}

export interface FastNearBlockedSourceOptions {
  vaultId: string;
  network: Network;
  rpcUrl: string;
  txApiUrl?: string;
  fetchImpl?: typeof fetch;
  /** Agent public key -> display name. */
  agentNames?: () => Promise<Map<string, string>>;
}

export class FastNearBlockedSource implements BlockedEventSource {
  private readonly seen = new Set<string>();
  private primed = false;
  private readonly fetchImpl: typeof fetch;
  private readonly txApi: string;

  constructor(private readonly opts: FastNearBlockedSourceOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    const api = opts.txApiUrl ?? FASTNEAR_TX_API[opts.network];
    if (!api) throw new Error(`no transactions API for ${opts.network}`);
    this.txApi = api;
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** The first call only records what is already there, so history is not replayed. */
  async poll(): Promise<BlockedAttempt[]> {
    const r = await this.post<{ account_txs?: Array<{ transaction_hash: string; is_signer?: boolean; tx_block_height?: number }> }>(
      `${this.txApi}/v0/account`,
      { account_id: this.opts.vaultId },
    );
    // Agents sign as the vault (function-call key), so their transactions have the vault as signer.
    const txs = (r.account_txs ?? []).filter((t) => t.is_signer).sort((a, b) => (a.tx_block_height ?? 0) - (b.tx_block_height ?? 0));
    const fresh = txs.filter((t) => !this.seen.has(t.transaction_hash));
    for (const t of fresh) this.seen.add(t.transaction_hash);
    if (!this.primed) {
      this.primed = true;
      return [];
    }
    if (fresh.length === 0) return [];
    const names = (await this.opts.agentNames?.()) ?? new Map<string, string>();
    const out: BlockedAttempt[] = [];
    for (const t of fresh) {
      const logs = await this.logsOf(t.transaction_hash);
      for (const e of blockedEventsFromLogs(logs)) {
        out.push({
          source: "contract",
          agentName: names.get(e.agent) ?? `${e.agent.slice(0, 16)}…`,
          action: `send ${describeAmount(e.asset, e.amount)} to ${e.receiver_id}`,
          code: e.code,
          reasons: [e.reason],
          txUrl: explorerTx(this.opts.network, t.transaction_hash),
          key: t.transaction_hash,
        });
      }
    }
    return out;
  }

  private async logsOf(hash: string): Promise<string[]> {
    const r = await this.post<{
      result?: { transaction_outcome?: { outcome: { logs: string[] } }; receipts_outcome?: Array<{ outcome: { logs: string[] } }> };
      error?: unknown;
    }>(this.opts.rpcUrl, { jsonrpc: "2.0", id: "guard-bot", method: "tx", params: { tx_hash: hash, sender_account_id: this.opts.vaultId, wait_until: "FINAL" } });
    if (!r.result) return [];
    return [...(r.result.transaction_outcome?.outcome.logs ?? []), ...(r.result.receipts_outcome ?? []).flatMap((x) => x.outcome.logs)];
  }
}

export interface VaultWatcherOptions {
  bot: GuardBot;
  blocked?: BlockedEventSource;
  intervalMs?: number;
  log?: (m: string) => void;
}

export class VaultWatcher {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly opts: VaultWatcherOptions) {}

  /** One polling round. Errors are logged, never thrown, so one bad RPC response does not stop the bot. */
  async tick(): Promise<{ pending: number; blocked: number }> {
    if (this.running) return { pending: 0, blocked: 0 };
    this.running = true;
    let pending = 0;
    let blocked = 0;
    try {
      try {
        pending = await this.opts.bot.syncPending();
      } catch (e) {
        this.opts.log?.(`pending poll failed: ${(e as Error).message}`);
      }
      if (this.opts.blocked) {
        try {
          for (const b of await this.opts.blocked.poll()) if (await this.opts.bot.notifyBlocked(b)) blocked++;
        } catch (e) {
          this.opts.log?.(`blocked poll failed: ${(e as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
    return { pending, blocked };
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 15_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
