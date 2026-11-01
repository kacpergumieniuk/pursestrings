/**
 * What the bot may do on the owner's behalf. `ContractOwnerControl` signs with the owner's
 * full-access key through `OwnerGuard`; it refuses mainnet, so a misconfigured bot can never
 * move real funds. The key comes from local config (.guard-local, gitignored) and is never shown.
 */
import { explorerTx, type GuardResult, OwnerGuard } from "../near/guard-client";
import type { DemoState } from "../demo/setup";
import { loadState } from "../demo/setup";
import type { Network } from "../risk/types";

export interface PendingRequest {
  id: string;
  agent_key: string;
  agent_name: string;
  asset: string;
  receiver_id: string;
  amount: string;
  memo?: string | null;
  justification: string;
  /** The policy check that sent this to a human, e.g. `OVER_TX_CAP`. */
  code: string;
  created_at: string;
}

export interface AgentStatus {
  public_key: string;
  name: string;
  enabled: boolean;
  limits: Array<{ asset: string; per_tx: string; per_day: string; spent_today: string; remaining_today: string }>;
  pending: number;
  executed: number;
  blocked: number;
}

export interface VaultStatus {
  vaultId: string;
  network: Network;
  paused: boolean;
  pendingRequests: number;
  agents: AgentStatus[];
}

export interface OwnerActionResult {
  /** `executed`, `failed`, `rejected`, `paused`, `unpaused`... */
  status: string;
  code?: string;
  reason: string;
  txUrl?: string;
}

export interface OwnerControl {
  readonly network: Network;
  readonly vaultId: string;
  listPending(): Promise<PendingRequest[]>;
  approve(requestId: string): Promise<OwnerActionResult>;
  reject(requestId: string, note?: string): Promise<OwnerActionResult>;
  setPaused(paused: boolean): Promise<OwnerActionResult>;
  status(): Promise<VaultStatus>;
}

export class MainnetRefusedError extends Error {
  constructor() {
    super("The PurseStrings bot signs owner actions on testnet or a local sandbox only; mainnet is refused.");
  }
}

/** Throws unless the target is testnet or a local sandbox. */
export function assertNotMainnet(network: Network, rpcUrl: string): void {
  if (network === "mainnet" || /mainnet/i.test(rpcUrl)) throw new MainnetRefusedError();
  if (network === "sandbox" && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/.test(rpcUrl)) {
    throw new Error(`sandbox RPC must be local, got ${rpcUrl}`);
  }
}

export class ContractOwnerControl implements OwnerControl {
  readonly network: Network;
  readonly vaultId: string;
  private readonly guard: OwnerGuard;

  constructor(state: Pick<DemoState, "network" | "rpcUrl" | "vault" | "owner">) {
    assertNotMainnet(state.network, state.rpcUrl);
    this.network = state.network;
    this.vaultId = state.vault.id;
    this.guard = new OwnerGuard({
      vaultId: state.vault.id,
      rpcUrl: state.rpcUrl,
      network: state.network,
      ownerId: state.owner.id,
      ownerKey: state.owner.key,
    });
  }

  async listPending(): Promise<PendingRequest[]> {
    const raw = await this.guard.listPending();
    return raw.map((r) => ({ ...(r as unknown as PendingRequest), id: String(r.id), amount: String(r.amount), created_at: String(r.created_at) }));
  }

  async approve(requestId: string): Promise<OwnerActionResult> {
    const o = await this.guard.approve(requestId);
    const r = o.result as GuardResult;
    return { status: r.status, code: r.code, reason: r.reason, txUrl: explorerTx(this.network, o.txHash) };
  }

  async reject(requestId: string, note?: string): Promise<OwnerActionResult> {
    const o = await this.guard.reject(requestId, note);
    return { status: "rejected", reason: `request #${requestId} rejected`, txUrl: explorerTx(this.network, o.txHash) };
  }

  async setPaused(paused: boolean): Promise<OwnerActionResult> {
    const o = await this.guard.setPaused(paused);
    return { status: paused ? "paused" : "unpaused", reason: paused ? "the vault is paused: every agent action is blocked" : "the vault is active again", txUrl: explorerTx(this.network, o.txHash) };
  }

  async status(): Promise<VaultStatus> {
    const policy = (await this.guard.getPolicy()) as { paused: boolean; pending_requests: number };
    const agents = await this.guard.view<AgentStatus[]>("list_agents", {});
    return { vaultId: this.vaultId, network: this.network, paused: policy.paused, pendingRequests: policy.pending_requests, agents };
  }
}

/** The testnet owner from `npm run testnet:setup` (.guard-local/testnet.json). */
export function loadTestnetOwnerControl(): ContractOwnerControl | undefined {
  const s = loadState("testnet");
  if (!s) return undefined;
  if (s.network !== "testnet") throw new Error(".guard-local/testnet.json is not a testnet environment");
  return new ContractOwnerControl(s);
}
