/** Shared types for every risk check. */

export type Verdict = "ALLOW" | "WARN" | "BLOCK";
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type Network = "mainnet" | "testnet" | "sandbox";

export interface Flag {
  /** Stable machine-readable code, e.g. `LOOKALIKE_ACCOUNT`. */
  code: string;
  severity: Severity;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface CheckResult {
  check: string;
  target: string;
  verdict: Verdict;
  flags: Flag[];
  /** Human-readable reasons behind the verdict (WARN/BLOCK flags first). */
  reasons: string[];
  /** Raw facts gathered by the check (for logs and the demo). */
  data?: Record<string, unknown>;
}

const RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const VRANK: Record<Verdict, number> = { ALLOW: 0, WARN: 1, BLOCK: 2 };

/**
 * Default mapping: any `critical` flag blocks, `medium`/`high` warn (a human decides),
 * `low`/`info` are informational.
 */
export interface VerdictPolicy {
  blockAt: Severity;
  warnAt: Severity;
}
export const DEFAULT_POLICY: VerdictPolicy = { blockAt: "critical", warnAt: "medium" };

export function severityAtLeast(s: Severity, min: Severity): boolean {
  return RANK[s] >= RANK[min];
}

export function verdictFromFlags(flags: Flag[], policy: VerdictPolicy = DEFAULT_POLICY): Verdict {
  if (flags.some((f) => severityAtLeast(f.severity, policy.blockAt))) return "BLOCK";
  if (flags.some((f) => severityAtLeast(f.severity, policy.warnAt))) return "WARN";
  return "ALLOW";
}

export function maxVerdict(vs: Verdict[]): Verdict {
  return vs.reduce<Verdict>((a, b) => (VRANK[b] > VRANK[a] ? b : a), "ALLOW");
}

export function result(
  check: string,
  target: string,
  flags: Flag[],
  data?: Record<string, unknown>,
  policy: VerdictPolicy = DEFAULT_POLICY,
): CheckResult {
  const sorted = [...flags].sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const verdict = verdictFromFlags(sorted, policy);
  const reasons = sorted
    .filter((f) => severityAtLeast(f.severity, policy.warnAt))
    .map((f) => `${f.code}: ${f.message}`);
  if (reasons.length === 0) reasons.push("no risk signals above the warning threshold");
  return { check, target, verdict, flags: sorted, reasons, data };
}
