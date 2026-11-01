/**
 * MemoryOwnerControl: an in-memory stand-in for the vault, for unit tests and the offline
 * console. It is clearly a simulation: nothing is signed, and results say so.
 */
import type { Network } from "../risk/types";
import type { OwnerActionResult, OwnerControl, PendingRequest, VaultStatus } from "./owner";

export class MemoryOwnerControl implements OwnerControl {
  paused = false;
  readonly pending = new Map<string, PendingRequest>();
  readonly calls: string[] = [];
  /** Make the next owner action throw this message (to test error paths). */
  failNext?: string;

  constructor(
    readonly vaultId = "vault.simulated",
    private readonly status_: Omit<VaultStatus, "vaultId" | "network" | "paused" | "pendingRequests"> = { agents: [] },
    readonly network: Network = "sandbox",
  ) {}

  add(p: Partial<PendingRequest> & { id: string }): PendingRequest {
    const req: PendingRequest = {
      agent_key: "ed25519:simulated",
      agent_name: "treasury-agent",
      asset: "near",
      receiver_id: "vendor.simulated",
      amount: "800000000000000000000000",
      justification: "invoice",
      code: "OVER_TX_CAP",
      created_at: "0",
      memo: null,
      ...p,
    };
    this.pending.set(req.id, req);
    return req;
  }

  private maybeFail() {
    if (this.failNext) {
      const m = this.failNext;
      this.failNext = undefined;
      throw new Error(m);
    }
  }

  async listPending(): Promise<PendingRequest[]> {
    return [...this.pending.values()];
  }

  async approve(id: string): Promise<OwnerActionResult> {
    this.calls.push(`approve:${id}`);
    this.maybeFail();
    const p = this.pending.get(id);
    if (!p) throw new Error("Smart contract panicked: unknown request");
    this.pending.delete(id);
    return { status: "executed", code: "OK", reason: `(simulated) sent to ${p.receiver_id}` };
  }

  async reject(id: string): Promise<OwnerActionResult> {
    this.calls.push(`reject:${id}`);
    this.maybeFail();
    if (!this.pending.delete(id)) throw new Error("Smart contract panicked: unknown request");
    return { status: "rejected", reason: `(simulated) request #${id} rejected` };
  }

  async setPaused(paused: boolean): Promise<OwnerActionResult> {
    this.calls.push(`pause:${paused}`);
    this.maybeFail();
    this.paused = paused;
    return { status: paused ? "paused" : "unpaused", reason: paused ? "(simulated) the vault is paused" : "(simulated) the vault is active again" };
  }

  async status(): Promise<VaultStatus> {
    return { vaultId: this.vaultId, network: this.network, paused: this.paused, pendingRequests: this.pending.size, ...this.status_ };
  }
}
