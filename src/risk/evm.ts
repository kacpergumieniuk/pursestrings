/**
 * EVM (Base) token verdicts via the separate Base token-verdict API, over HTTP.
 *
 * Configure with GUARD_EVM_VERDICT_URL, a URL template with `{chain}` and `{address}`
 * placeholders, e.g. `http://localhost:8787/v1/verdict/{address}?chain={chain}`.
 * Expected response (subset): `{ verdict: "SAFE"|"CAUTION"|"DANGER", score?, summary?, reasons?: string[] }`.
 */
import { type CheckResult, type Flag, result } from "./types";

export interface EvmVerdictOptions {
  urlTemplate?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Chains the remote engine supports. */
  supportedChains?: string[];
}

interface RemoteVerdict {
  verdict?: string;
  score?: number;
  summary?: string;
  reasons?: string[];
}

/** `nep141:base-0xabc....omft.near` -> { chain: "base", address: "0xabc..." } */
export function parseBridgedEvmAsset(assetId: string): { chain: string; address: string } | undefined {
  const m = /^nep141:([a-z]+)-(0x[0-9a-f]{40})\.(?:omft|omdep)\.near$/i.exec(assetId.trim());
  return m ? { chain: m[1]!.toLowerCase(), address: m[2]!.toLowerCase() } : undefined;
}

export async function checkEvmToken(chain: string, address: string, opts: EvmVerdictOptions = {}): Promise<CheckResult> {
  const target = `${chain}:${address}`;
  const template = opts.urlTemplate ?? process.env.GUARD_EVM_VERDICT_URL;
  const supported = opts.supportedChains ?? ["base"];
  const flags: Flag[] = [];
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    flags.push({ code: "INVALID_EVM_ADDRESS", severity: "critical", message: `${address} is not an EVM address` });
    return result("evm_token", target, flags);
  }
  if (!supported.includes(chain)) {
    flags.push({ code: "EVM_CHAIN_UNSUPPORTED", severity: "low", message: `no verdict engine configured for chain "${chain}"` });
    return result("evm_token", target, flags);
  }
  if (!template) {
    flags.push({
      code: "EVM_CHECK_SKIPPED",
      severity: "medium",
      message: "EVM token could not be verified: set GUARD_EVM_VERDICT_URL to the Base verdict API",
    });
    return result("evm_token", target, flags);
  }
  const url = template.includes("{address}")
    ? template.replaceAll("{address}", address).replaceAll("{chain}", chain)
    : `${template}${template.includes("?") ? "&" : "?"}chain=${chain}&address=${address}`;
  let body: RemoteVerdict;
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = (await res.json()) as RemoteVerdict;
  } catch (e) {
    flags.push({ code: "EVM_CHECK_FAILED", severity: "medium", message: `verdict API unavailable (${(e as Error).message})` });
    return result("evm_token", target, flags);
  }
  const why = body.reasons?.slice(0, 5).join("; ") || body.summary || "no reasons given";
  switch (body.verdict) {
    case "DANGER":
      flags.push({ code: "EVM_DANGER", severity: "critical", message: `Base verdict engine: DANGER (${why})`, evidence: { score: body.score } });
      break;
    case "CAUTION":
      flags.push({ code: "EVM_CAUTION", severity: "high", message: `Base verdict engine: CAUTION (${why})`, evidence: { score: body.score } });
      break;
    case "SAFE":
      flags.push({ code: "EVM_SAFE", severity: "info", message: `Base verdict engine: SAFE${body.summary ? ` (${body.summary})` : ""}` });
      break;
    default:
      flags.push({ code: "EVM_CHECK_FAILED", severity: "medium", message: `unexpected verdict "${body.verdict}"` });
  }
  return result("evm_token", target, flags, { remote: body });
}
