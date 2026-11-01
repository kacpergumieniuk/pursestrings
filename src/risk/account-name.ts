/**
 * Look-alike / typosquat detection for NEAR account ids.
 * Pure function: no network access.
 */
import { BRAND_WORDS, KNOWN } from "./known";
import type { ScamList } from "./scam-list";
import { baitWordsIn, editDistance, hasNonAscii, isTypo, skeleton } from "./text";
import { type CheckResult, type Flag, type Network, result } from "./types";

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export interface AccountNameOptions {
  network: Network;
  /** Extra trusted accounts (e.g. your allowlisted tokens and payees). */
  trusted?: string[];
  scamList?: ScamList;
}

export function isImplicitAccount(id: string): boolean {
  return /^[0-9a-f]{64}$/.test(id) || /^0x[0-9a-f]{40}$/.test(id);
}

/** Top-level suffix for the network (`near`, `testnet`, ...). */
function rootOf(network: Network): string {
  return network === "mainnet" ? "near" : network;
}

/** The label that identifies the owner: `usdt.tether-token.near` -> `tether-token`; `wrap.near` -> `wrap`. */
function ownerLabel(id: string, network: Network): string {
  const parts = id.split(".");
  if (parts.length >= 2 && parts[parts.length - 1] === rootOf(network)) return parts[parts.length - 2]!;
  return parts[parts.length - 1]!;
}

export function knownAccounts(network: Network, trusted: string[] = []): string[] {
  const k = KNOWN[network];
  return [...new Set([...k.accounts, ...k.tokens.map((t) => t.accountId), ...trusted].map((a) => a.toLowerCase()))];
}

export function checkAccountName(rawId: string, opts: AccountNameOptions): CheckResult {
  const id = rawId.trim();
  const flags: Flag[] = [];
  const known = knownAccounts(opts.network, opts.trusted);
  const lower = id.toLowerCase();

  if (hasNonAscii(id)) {
    flags.push({ code: "NON_ASCII_ACCOUNT", severity: "critical", message: `"${id}" contains non-ASCII characters; NEAR account ids cannot, so this is a spoofed name` });
    return result("account_name", id, flags);
  }
  if (id !== lower || !ACCOUNT_RE.test(id) || id.length < 2 || id.length > 64) {
    flags.push({ code: "INVALID_ACCOUNT_ID", severity: "critical", message: `"${id}" is not a valid NEAR account id` });
    return result("account_name", id, flags);
  }

  const scam = opts.scamList?.match("account", id);
  if (scam) {
    flags.push({
      code: "KNOWN_SCAM",
      severity: "critical",
      message: `matches known-scam entry ${scam.matched}: ${scam.entry.reason}`,
      evidence: { source: scam.entry.source, evidence: scam.entry.evidence },
    });
  }

  if (known.includes(lower)) {
    flags.push({ code: "KNOWN_ACCOUNT", severity: "info", message: `${id} is a known canonical account` });
    return result("account_name", id, flags);
  }
  if (isImplicitAccount(id)) {
    flags.push({ code: "IMPLICIT_ACCOUNT", severity: "info", message: "implicit (key-derived) account: no name to imitate" });
    return result("account_name", id, flags);
  }

  // 1. Prefix impersonation: `wrap.near.evil.near` starts with a known account but is owned by `evil.near`.
  for (const k of known) {
    if (lower.startsWith(k + ".") && !lower.endsWith("." + k)) {
      flags.push({
        code: "PREFIX_IMPERSONATION",
        severity: "critical",
        message: `starts with the known account "${k}" but is a different account controlled by "${lower.slice(k.length + 1)}"`,
        evidence: { imitates: k },
      });
      break;
    }
  }

  // 2. Same skeleton as a known account (confusable characters or separators changed).
  // Also compares the owner label alone, which catches flattened names: `wrap-near.near` vs `wrap.near`.
  const sk = skeleton(lower);
  const labelSk = skeleton(ownerLabel(lower, opts.network));
  const skMatch = known.find((k) => skeleton(k) === sk || (k.includes(".") && skeleton(k) === labelSk));
  if (skMatch) {
    flags.push({
      code: "LOOKALIKE_ACCOUNT",
      severity: "critical",
      message: `looks like "${skMatch}" (only separators or confusable characters differ)`,
      evidence: { imitates: skMatch },
    });
  }

  // 3. Typosquat on the owner label: one or two edits away from a known owner label.
  if (!skMatch) {
    const label = ownerLabel(lower, opts.network);
    for (const k of known) {
      const kl = ownerLabel(k, opts.network);
      if (kl.length < 4 || label === kl) continue;
      const dist = editDistance(label, kl);
      if (isTypo(label, kl, dist)) {
        flags.push({
          code: "TYPOSQUAT",
          severity: "high",
          message: `owner label "${label}" is ${dist} edit(s) away from "${kl}" (${k})`,
          evidence: { imitates: k, distance: dist },
        });
        break;
      }
      // Known label embedded with extra words: `wrap-near-claim`, `tether-token-support`.
      if (kl.length >= 5 && label.includes(kl) && label !== kl) {
        flags.push({
          code: "EMBEDS_KNOWN_NAME",
          severity: "medium",
          message: `owner label "${label}" embeds the known name "${kl}" (${k})`,
          evidence: { imitates: k },
        });
        break;
      }
    }
  }

  // 4. Brand + bait words in the name (`usdc-airdrop`, `near-support`).
  const nameOnly = lower.replace(new RegExp(`\\.${rootOf(opts.network)}$`), "");
  const baits = baitWordsIn(nameOnly);
  const brands = BRAND_WORDS.filter((b) => nameOnly.split(/[^a-z0-9]+/).includes(b));
  if (baits.length > 0 && brands.length > 0) {
    flags.push({
      code: "BRAND_BAIT_NAME",
      severity: "high",
      message: `name combines brand word(s) [${brands.join(", ")}] with lure word(s) [${baits.join(", ")}]`,
    });
  } else if (baits.length > 0) {
    flags.push({ code: "BAIT_WORDS_IN_NAME", severity: "medium", message: `name contains lure word(s): ${baits.join(", ")}` });
  }

  return result("account_name", id, flags);
}
