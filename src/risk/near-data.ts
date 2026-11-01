/**
 * Read-only NEAR data used by the risk checks.
 *
 * Sources (all free, no API key):
 *  - NEAR JSON-RPC (FastNEAR public endpoints): account state, contract code hash, view calls.
 *  - NearBlocks API: account creation time, contract deployments, FT holder count.
 *  - FastNEAR API: top FT holders (for supply concentration).
 *
 * Every indexer lookup is optional: on errors or rate limits it returns `undefined`
 * and the check records "unknown" instead of failing.
 */
import type { Network } from "./types";

export interface AccountInfo {
  exists: boolean;
  hasContract: boolean;
  codeHash?: string;
  amount?: string;
  storageUsage?: number;
}

export interface Holder {
  account: string;
  balance: bigint;
}

export interface NearDataSource {
  readonly network: Network;
  viewAccount(accountId: string): Promise<AccountInfo>;
  viewFunction<T = unknown>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T>;
  /** Account creation time (unix ms). */
  createdAt?(accountId: string): Promise<number | undefined>;
  /** Contract deployments, newest first (unix ms). */
  deployments?(accountId: string): Promise<number[] | undefined>;
  holdersCount?(tokenId: string): Promise<number | undefined>;
  topHolders?(tokenId: string): Promise<Holder[] | undefined>;
}

const EMPTY_CODE_HASH = "11111111111111111111111111111111";

export const ENDPOINTS: Record<Network, { rpc: string; nearblocks?: string; fastnear?: string }> = {
  mainnet: { rpc: "https://rpc.mainnet.fastnear.com", nearblocks: "https://api.nearblocks.io", fastnear: "https://api.fastnear.com" },
  testnet: { rpc: "https://test.rpc.fastnear.com", nearblocks: "https://api-testnet.nearblocks.io", fastnear: "https://test.api.fastnear.com" },
  sandbox: { rpc: "http://127.0.0.1:3030" },
};

export class RpcError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface LiveNearDataOptions {
  network: Network;
  rpcUrl?: string;
  nearblocksUrl?: string | null;
  fastnearUrl?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class LiveNearData implements NearDataSource {
  readonly network: Network;
  private readonly rpcUrl: string;
  private readonly nearblocks?: string;
  private readonly fastnear?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: LiveNearDataOptions) {
    this.network = opts.network;
    const ep = ENDPOINTS[opts.network];
    this.rpcUrl = opts.rpcUrl ?? process.env.GUARD_RPC_URL ?? ep.rpc;
    this.nearblocks = opts.nearblocksUrl === null ? undefined : (opts.nearblocksUrl ?? ep.nearblocks);
    this.fastnear = opts.fastnearUrl === null ? undefined : (opts.fastnearUrl ?? ep.fastnear);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const res = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "guard", method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new RpcError(`RPC HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T & { error?: string }; error?: { cause?: { name?: string }; message?: string; data?: unknown } };
    if (body.error) throw new RpcError(body.error.cause?.name ?? body.error.message ?? "RPC error", body.error);
    if (body.result && typeof body.result === "object" && "error" in body.result && body.result.error) {
      throw new RpcError(String(body.result.error));
    }
    return body.result as T;
  }

  async viewAccount(accountId: string): Promise<AccountInfo> {
    try {
      const r = await this.rpc<{ amount: string; code_hash: string; storage_usage: number }>("query", {
        request_type: "view_account",
        finality: "final",
        account_id: accountId,
      });
      return {
        exists: true,
        hasContract: r.code_hash !== EMPTY_CODE_HASH,
        codeHash: r.code_hash,
        amount: r.amount,
        storageUsage: r.storage_usage,
      };
    } catch (e) {
      if (e instanceof RpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(e.message + JSON.stringify(e.cause ?? ""))) {
        return { exists: false, hasContract: false };
      }
      throw e;
    }
  }

  async viewFunction<T = unknown>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.rpc<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
  }

  private async getJson<T>(url: string): Promise<T | undefined> {
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: "application/json" } });
      if (!res.ok) return undefined;
      return (await res.json()) as T;
    } catch {
      return undefined;
    }
  }

  async createdAt(accountId: string): Promise<number | undefined> {
    if (!this.nearblocks) return undefined;
    const r = await this.getJson<{ account?: Array<{ created?: { block_timestamp?: number | string | null } }> }>(
      `${this.nearblocks}/v1/account/${encodeURIComponent(accountId)}`,
    );
    const ts = r?.account?.[0]?.created?.block_timestamp;
    return ts ? Math.floor(Number(ts) / 1e6) : undefined;
  }

  async deployments(accountId: string): Promise<number[] | undefined> {
    if (!this.nearblocks) return undefined;
    const r = await this.getJson<{ deployments?: Array<{ block_timestamp: string | number }> }>(
      `${this.nearblocks}/v1/account/${encodeURIComponent(accountId)}/contract/deployments`,
    );
    if (!r?.deployments) return undefined;
    return r.deployments.map((d) => Math.floor(Number(d.block_timestamp) / 1e6)).sort((a, b) => b - a);
  }

  async holdersCount(tokenId: string): Promise<number | undefined> {
    if (!this.nearblocks) return undefined;
    const r = await this.getJson<{ holders?: Array<{ count: string | number }> }>(
      `${this.nearblocks}/v1/fts/${encodeURIComponent(tokenId)}/holders/count`,
    );
    const c = r?.holders?.[0]?.count;
    return c === undefined ? undefined : Number(c);
  }

  async topHolders(tokenId: string): Promise<Holder[] | undefined> {
    if (!this.fastnear) return undefined;
    const r = await this.getJson<{ accounts?: Array<{ account_id: string; balance: string }> }>(
      `${this.fastnear}/v1/ft/${encodeURIComponent(tokenId)}/top`,
    );
    return r?.accounts?.map((a) => ({ account: a.account_id, balance: BigInt(a.balance) }));
  }
}

/** In-memory data source for tests and offline demos. */
export class FixtureNearData implements NearDataSource {
  constructor(
    readonly network: Network,
    private readonly fixtures: {
      accounts?: Record<string, AccountInfo>;
      views?: Record<string, unknown>;
      createdAt?: Record<string, number>;
      deployments?: Record<string, number[]>;
      holdersCount?: Record<string, number>;
      topHolders?: Record<string, Holder[]>;
    } = {},
  ) {}

  async viewAccount(id: string): Promise<AccountInfo> {
    return this.fixtures.accounts?.[id] ?? { exists: false, hasContract: false };
  }
  async viewFunction<T>(id: string, method: string): Promise<T> {
    const key = `${id}:${method}`;
    if (!this.fixtures.views || !(key in this.fixtures.views)) throw new RpcError(`MethodNotFound ${key}`);
    return this.fixtures.views[key] as T;
  }
  async createdAt(id: string) {
    return this.fixtures.createdAt?.[id];
  }
  async deployments(id: string) {
    return this.fixtures.deployments?.[id];
  }
  async holdersCount(id: string) {
    return this.fixtures.holdersCount?.[id];
  }
  async topHolders(id: string) {
    return this.fixtures.topHolders?.[id];
  }
}
