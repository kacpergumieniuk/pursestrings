/**
 * Agent-side wrapper. Every action goes through two independent layers:
 *
 *  1. Off-chain risk layer (RiskEngine): BLOCK -> refuse to sign; WARN -> ask a human; ALLOW -> continue.
 *  2. On-chain Guard contract: the agent's function-call key can only call the guard, which enforces
 *     caps and allow/deny lists no matter what the off-chain layer said.
 *
 * If the contract blocks for a soft reason (over a cap, not on an allowlist), the wallet can escalate:
 * it files an on-chain approval request that only the owner can execute.
 */
import type { AgentGuard, GuardResult, TxOutcome } from "../near/guard-client";
import type { AgentAction, Assessment, RiskEngine } from "../risk/engine";

export type Decision =
  | "executed"
  | "refused_by_risk_layer"
  | "refused_by_human"
  | "blocked_on_chain"
  | "failed_on_chain"
  | "pending_owner_approval"
  | "checked_only";

export interface WalletOutcome {
  action: AgentAction;
  assessment?: Assessment;
  decision: Decision;
  onChain?: TxOutcome<GuardResult>;
  escalation?: TxOutcome<GuardResult>;
  summary: string;
}

export interface HumanApprover {
  /** Return true to let a WARN action proceed. */
  approve(assessment: Assessment): Promise<boolean>;
}

export const denyAll: HumanApprover = { approve: async () => false };
export const approveAll: HumanApprover = { approve: async () => true };

export interface GuardedWalletOptions {
  engine: RiskEngine;
  guard: AgentGuard;
  approver?: HumanApprover;
  /** Simulates a compromised agent that skips the off-chain layer; the contract still applies. */
  bypassRiskLayer?: boolean;
  /** File an owner-approval request when the contract blocks for a soft reason. */
  escalateSoftBlocks?: boolean;
  onEvent?: (e: WalletEvent) => void;
}

export type WalletEvent =
  | { type: "assessed"; assessment: Assessment }
  | { type: "risk_bypassed" }
  | { type: "human_asked"; assessment: Assessment; approved: boolean }
  | { type: "signing"; method: string }
  | { type: "on_chain"; outcome: TxOutcome<GuardResult> }
  | { type: "escalated"; outcome: TxOutcome<GuardResult> };

const SOFT_CODES = new Set(["OVER_TX_CAP", "OVER_DAILY_CAP", "ASSET_NOT_PERMITTED", "RECIPIENT_NOT_ALLOWLISTED", "TOKEN_NOT_ALLOWLISTED"]);

export class GuardedWallet {
  readonly payees = new Set<string>();
  constructor(private readonly opts: GuardedWalletOptions) {}

  private emit(e: WalletEvent) {
    this.opts.onEvent?.(e);
  }

  async execute(action: AgentAction, context?: { sourceText?: string; justification?: string }): Promise<WalletOutcome> {
    let assessment: Assessment | undefined;
    if (this.opts.bypassRiskLayer) {
      this.emit({ type: "risk_bypassed" });
    } else {
      assessment = await this.opts.engine.assess(action, context);
      this.emit({ type: "assessed", assessment });
      if (assessment.verdict === "BLOCK") {
        return { action, assessment, decision: "refused_by_risk_layer", summary: "refused to sign: risk layer returned BLOCK" };
      }
      if (assessment.verdict === "WARN") {
        const ok = await (this.opts.approver ?? denyAll).approve(assessment);
        this.emit({ type: "human_asked", assessment, approved: ok });
        if (!ok) return { action, assessment, decision: "refused_by_human", summary: "refused: a human declined the WARN" };
      }
    }

    let onChain: TxOutcome<GuardResult>;
    let asset: string;
    let receiver: string;
    let amount: string;
    switch (action.kind) {
      case "transfer_near":
        this.emit({ type: "signing", method: "agent_transfer_near" });
        onChain = await this.opts.guard.transferNear(action.receiverId, action.amount, action.memo);
        [asset, receiver, amount] = ["near", action.receiverId, action.amount];
        break;
      case "transfer_ft":
        this.emit({ type: "signing", method: "agent_transfer_ft" });
        onChain = await this.opts.guard.transferFt(action.tokenId, action.receiverId, action.amount, action.memo);
        [asset, receiver, amount] = [action.tokenId, action.receiverId, action.amount];
        break;
      case "swap":
      case "open_link":
        return { action, assessment, decision: "checked_only", summary: "checked only (no on-chain execution for this action type)" };
    }
    this.emit({ type: "on_chain", outcome: onChain });

    const r = onChain.result;
    if (r.status === "executed") {
      this.payees.add(receiver);
      return { action, assessment, decision: "executed", onChain, summary: r.reason };
    }
    if (r.status === "failed") return { action, assessment, decision: "failed_on_chain", onChain, summary: r.reason };

    if (r.status === "blocked" && SOFT_CODES.has(r.code) && this.opts.escalateSoftBlocks) {
      const justification = context?.justification ?? `agent request: ${context?.sourceText?.slice(0, 200) ?? action.kind}`;
      const escalation = await this.opts.guard.requestApproval(asset, receiver, amount, justification);
      this.emit({ type: "escalated", outcome: escalation });
      if (escalation.result.status === "pending_approval") {
        return {
          action,
          assessment,
          decision: "pending_owner_approval",
          onChain,
          escalation,
          summary: `blocked on chain (${r.code}); approval request ${escalation.result.request_id} filed for the owner`,
        };
      }
    }
    return { action, assessment, decision: "blocked_on_chain", onChain, summary: `${r.code}: ${r.reason}` };
  }
}
