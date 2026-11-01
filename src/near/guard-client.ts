/**
 * Thin client for the Guard contract (near-api-js v7).
 *
 * - `AgentGuard` signs with the agent's function-call key on the vault account.
 *   It can only call `agent_transfer_near`, `agent_transfer_ft` and `agent_request_approval`.
 * - `OwnerGuard` signs as the owner account (full-access key) and attaches the
 *   1 yoctoNEAR the contract requires on admin methods.
 */
import { Account, getTransactionLastResult, JsonRpcProvider, type KeyPairString, teraToGas } from "near-api-js";
import type { Network } from "../risk/types";

export const ONE_YOCTO = 1n;

export interface GuardResult {
  status: "allowed" | "executed" | "failed" | "blocked" | "pending_approval";
  code: string;
  reason: string;
  request_id: string | null;
}

export interface TxOutcome<T> {
  result: T;
  txHash: string;
  logs: string[];
  events: Array<{ event: string; data: unknown }>;
}

export interface AssetLimit {
  asset: string;
  per_tx: string;
  per_day: string;
}

export function explorerTx(network: Network, hash: string): string {
  if (network === "mainnet") return `https://nearblocks.io/txns/${hash}`;
  if (network === "testnet") return `https://testnet.nearblocks.io/txns/${hash}`;
  return `(local sandbox tx ${hash})`;
}

export function explorerAccount(network: Network, id: string): string {
  if (network === "mainnet") return `https://nearblocks.io/address/${id}`;
  if (network === "testnet") return `https://testnet.nearblocks.io/address/${id}`;
  return `(local sandbox account ${id})`;
}

type Outcome = Awaited<ReturnType<Account["callFunctionRaw"]>>;

function collect<T>(outcome: Outcome): TxOutcome<T> {
  const o = outcome as unknown as {
    transaction: { hash: string };
    transaction_outcome: { outcome: { logs: string[] } };
    receipts_outcome: Array<{ outcome: { logs: string[] } }>;
  };
  const logs = [...o.transaction_outcome.outcome.logs, ...o.receipts_outcome.flatMap((r) => r.outcome.logs)];
  const events = logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)) as { standard: string; event: string; data: unknown })
    .filter((e) => e.standard === "nearguard")
    .map((e) => ({ event: e.event, data: Array.isArray(e.data) ? e.data[0] : e.data }));
  return { result: getTransactionLastResult(outcome) as T, txHash: o.transaction.hash, logs, events };
}

export class GuardViews {
  readonly provider: JsonRpcProvider;
  constructor(
    readonly vaultId: string,
    rpcUrl: string,
    readonly network: Network,
  ) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.provider.callFunction({ contractId: this.vaultId, method, args }) as Promise<T>;
  }
  getPolicy() {
    return this.view<Record<string, unknown>>("get_policy");
  }
  getAgent(publicKey: string) {
    return this.view<Record<string, unknown> | null>("get_agent", { public_key: publicKey });
  }
  preflight(publicKey: string, asset: string, receiverId: string, amount: string) {
    return this.view<GuardResult>("preflight", { public_key: publicKey, asset, receiver_id: receiverId, amount });
  }
  listPending() {
    return this.view<Array<Record<string, unknown>>>("list_pending", {});
  }
  listDenied(kind: "recipient" | "token") {
    return this.view<Array<{ account_id: string; entry: { reason: string; evidence?: string } }>>("list_denied", { kind });
  }
}

export class AgentGuard extends GuardViews {
  private readonly account: Account;
  readonly publicKey: string;

  constructor(opts: { vaultId: string; rpcUrl: string; network: Network; agentKey: KeyPairString; publicKey: string }) {
    super(opts.vaultId, opts.rpcUrl, opts.network);
    // The agent signs *as the vault account* with its function-call key.
    this.account = new Account(opts.vaultId, this.provider, opts.agentKey);
    this.publicKey = opts.publicKey;
  }

  private async call(method: string, args: Record<string, unknown>): Promise<TxOutcome<GuardResult>> {
    const outcome = await this.account.callFunctionRaw({
      contractId: this.vaultId,
      methodName: method,
      args,
      gas: teraToGas("100"),
      waitUntil: "FINAL",
    });
    return collect<GuardResult>(outcome);
  }

  transferNear(receiverId: string, amountYocto: string, memo?: string) {
    return this.call("agent_transfer_near", { receiver_id: receiverId, amount: amountYocto, memo: memo ?? null });
  }
  transferFt(tokenId: string, receiverId: string, amount: string, memo?: string) {
    return this.call("agent_transfer_ft", { token_id: tokenId, receiver_id: receiverId, amount, memo: memo ?? null });
  }
  requestApproval(asset: string, receiverId: string, amount: string, justification: string, memo?: string) {
    return this.call("agent_request_approval", { asset, receiver_id: receiverId, amount, memo: memo ?? null, justification });
  }
}

export class OwnerGuard extends GuardViews {
  readonly account: Account;

  constructor(opts: { vaultId: string; rpcUrl: string; network: Network; ownerId: string; ownerKey: KeyPairString }) {
    super(opts.vaultId, opts.rpcUrl, opts.network);
    this.account = new Account(opts.ownerId, this.provider, opts.ownerKey);
  }

  async admin<T = unknown>(method: string, args: Record<string, unknown>, deposit: bigint = ONE_YOCTO): Promise<TxOutcome<T>> {
    const outcome = await this.account.callFunctionRaw({
      contractId: this.vaultId,
      methodName: method,
      args,
      deposit,
      gas: teraToGas("100"),
      waitUntil: "FINAL",
    });
    return collect<T>(outcome);
  }

  addAgent(publicKey: string, name: string, limits: AssetLimit[], keyAllowanceYocto?: string) {
    return this.admin("add_agent", { public_key: publicKey, name, limits, key_allowance: keyAllowanceYocto ?? null });
  }
  allow(kind: "recipient" | "token", accountIds: string[]) {
    return this.admin("allow", { kind, account_ids: accountIds });
  }
  setListMode(kind: "recipient" | "token", mode: "open" | "allowlist_only") {
    return this.admin("set_list_mode", { kind, mode });
  }
  /** Reporting takes no deposit so reporter bots with function-call keys can use it too. */
  report(kind: "recipient" | "token", accountId: string, reason: string, evidence?: string) {
    return this.admin("report", { kind, account_id: accountId, reason, evidence: evidence ?? null }, 0n);
  }
  approve(requestId: string) {
    return this.admin<GuardResult>("approve_request", { request_id: requestId });
  }
  reject(requestId: string, note?: string) {
    return this.admin("reject_request", { request_id: requestId, note: note ?? null });
  }
  setPaused(paused: boolean) {
    return this.admin("set_paused", { paused });
  }
}
