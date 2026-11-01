/** Console output for the demo. Plain ANSI, no dependencies. */
import type { WalletEvent, WalletOutcome } from "../agent/guarded-wallet";
import { explorerTx } from "../near/guard-client";
import type { AgentAction, Assessment } from "../risk/engine";
import type { Network, Verdict } from "../risk/types";

const useColor = (process.stdout.isTTY || process.env.FORCE_COLOR === "1") && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = c(1);
export const dim = c(2);
export const red = c(31);
export const green = c(32);
export const yellow = c(33);
export const cyan = c(36);

export function verdictTag(v: Verdict | string): string {
  if (v === "ALLOW" || v === "executed" || v === "allowed") return green(bold(` ${v} `));
  if (v === "WARN" || v === "pending_approval") return yellow(bold(` ${v} `));
  return red(bold(` ${v} `));
}

export function fmtAmount(raw: string, decimals: number): string {
  const s = raw.padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function describeAction(a: AgentAction): string {
  switch (a.kind) {
    case "transfer_near":
      return `transfer ${fmtAmount(a.amount, 24)} NEAR -> ${a.receiverId}`;
    case "transfer_ft":
      return `transfer ${a.amount} units of token ${a.tokenId} -> ${a.receiverId}`;
    case "swap":
      return `swap ${a.amount} ${a.originAsset} -> ${a.destinationAsset} (NEAR Intents 1Click, dry run)`;
    case "open_link":
      return `open ${a.url}`;
  }
}

export function printAssessment(a: Assessment): void {
  console.log(`  ${bold("risk layer")} ${verdictTag(a.verdict)}`);
  for (const check of a.checks) {
    const shown = check.flags.filter((f) => f.severity !== "info" || check.flags.length <= 2);
    console.log(`    ${dim("-")} ${check.check} ${dim(check.target)} ${verdictTag(check.verdict)}`);
    for (const f of shown.slice(0, 6)) {
      const sev = f.severity === "critical" || f.severity === "high" ? red(f.severity) : f.severity === "medium" ? yellow(f.severity) : dim(f.severity);
      console.log(`        ${sev} ${f.code}: ${f.message}`);
    }
  }
}

export function eventPrinter(network: Network) {
  return (e: WalletEvent) => {
    switch (e.type) {
      case "assessed":
        printAssessment(e.assessment);
        break;
      case "risk_bypassed":
        console.log(`  ${yellow("risk layer BYPASSED")} ${dim("(simulating a compromised agent: only the contract stands in the way)")}`);
        break;
      case "human_asked":
        console.log(`  ${bold("human approval")} ${e.approved ? green("approved") : red("declined")}`);
        break;
      case "signing":
        console.log(`  ${bold("signing")} ${e.method} ${dim("with the agent's function-call key on the vault")}`);
        break;
      case "on_chain":
      case "escalated": {
        const r = e.outcome.result;
        const label = e.type === "escalated" ? "escalation" : "guard contract";
        console.log(`  ${bold(label)} ${verdictTag(r.status)} ${r.code}: ${r.reason}`);
        console.log(`    ${dim("tx")} ${cyan(explorerTx(network, e.outcome.txHash))}`);
        for (const ev of e.outcome.events) {
          const d = (ev.data ?? {}) as Record<string, unknown>;
          const brief = ["code", "success", "request_id"].filter((k) => k in d).map((k) => `${k}=${String(d[k])}`).join(" ");
          console.log(`    ${dim("event")} ${ev.event} ${dim(brief)}`);
        }
        break;
      }
    }
  };
}

export function printOutcome(o: WalletOutcome): void {
  const color = o.decision === "executed" ? green : o.decision === "pending_owner_approval" ? yellow : red;
  console.log(`  ${bold("=>")} ${color(bold(o.decision))}: ${o.summary}`);
}
