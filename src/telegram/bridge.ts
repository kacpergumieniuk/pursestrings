/**
 * Connects an agent's GuardedWallet to the bot: every refused action becomes an owner notice.
 * Risk-layer refusals exist only here (the agent never signed, so nothing is on chain).
 */
import type { WalletOutcome } from "../agent/guarded-wallet";
import { explorerTx } from "../near/guard-client";
import type { AgentAction } from "../risk/engine";
import type { Network } from "../risk/types";
import { type BlockedAttempt, describeAmount, type GuardBot } from "./bot";

export function describeAgentAction(a: AgentAction): string {
  switch (a.kind) {
    case "transfer_near":
      return `send ${describeAmount("near", a.amount)} to ${a.receiverId}`;
    case "transfer_ft":
      return `send ${describeAmount(a.tokenId, a.amount)} to ${a.receiverId}`;
    case "swap":
      return `swap ${a.originAsset} for ${a.destinationAsset} via NEAR Intents`;
    case "open_link":
      return `open ${a.url}`;
  }
}

/** The owner notice for an outcome, or undefined when there is nothing to report. */
export function blockedNotice(o: WalletOutcome, network: Network, agentName?: string): BlockedAttempt | undefined {
  if (o.decision === "refused_by_risk_layer" && o.assessment) {
    const flags = o.assessment.checks
      .flatMap((c) => c.flags)
      .filter((f) => f.severity === "critical" || f.severity === "high")
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
    return {
      source: "risk_layer",
      agentName,
      action: describeAgentAction(o.action),
      code: o.assessment.verdict,
      reasons: flags.map((f) => `${f.code}: ${f.message}`),
    };
  }
  if (o.decision === "blocked_on_chain" && o.onChain) {
    const r = o.onChain.result;
    return {
      source: "contract",
      agentName,
      action: describeAgentAction(o.action),
      code: r.code,
      reasons: [r.reason],
      txUrl: explorerTx(network, o.onChain.txHash),
      key: o.onChain.txHash,
    };
  }
  return undefined;
}

/** Reports an outcome to the owner: blocked attempts as notices, escalations as approval requests. */
export async function reportOutcome(bot: GuardBot, o: WalletOutcome, network: Network, agentName?: string): Promise<void> {
  const notice = blockedNotice(o, network, agentName);
  if (notice) await bot.notifyBlocked(notice);
  if (o.decision === "pending_owner_approval") await bot.syncPending();
}
