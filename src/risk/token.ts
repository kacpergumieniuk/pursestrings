/**
 * NEP-141 token heuristics: is this token what it claims to be, and how risky is it?
 */
import { checkAccountName } from "./account-name";
import { KNOWN, PROTECTED_SYMBOLS } from "./known";
import type { NearDataSource } from "./near-data";
import type { ScamList } from "./scam-list";
import { baitWordsIn, hasNonAscii, looksLikeUrl, stripHomoglyphs } from "./text";
import { type CheckResult, type Flag, result } from "./types";

const DAY = 86_400_000;

export interface FtMetadata {
  spec?: string;
  name?: string;
  symbol?: string;
  icon?: string | null;
  decimals?: number;
  reference?: string | null;
}

export interface TokenCheckOptions {
  data: NearDataSource;
  scamList?: ScamList;
  /** Tokens the owner trusts (e.g. the guard's token allowlist). Heuristics are skipped for them. */
  trustedTokens?: string[];
  /** Map of contract -> USD price from the NEAR Intents token list, if available. */
  intentsListed?: Map<string, { symbol: string; price: number }>;
  now?: number;
  thresholds?: Partial<TokenThresholds>;
}

export interface TokenThresholds {
  newTokenHighMs: number;
  newTokenMediumMs: number;
  recentCodeChangeMs: number;
  minHolders: number;
  top1MaxShare: number;
  top10MaxShare: number;
}

export const DEFAULT_TOKEN_THRESHOLDS: TokenThresholds = {
  newTokenHighMs: DAY,
  newTokenMediumMs: 7 * DAY,
  recentCodeChangeMs: 7 * DAY,
  minHolders: 25,
  top1MaxShare: 0.5,
  top10MaxShare: 0.9,
};

export function normalizeSymbol(symbol: string): string {
  return stripHomoglyphs(symbol)
    .toUpperCase()
    .replace(/\.E$/, "")
    .replace(/[^A-Z0-9]/g, "");
}

function fmtAge(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < DAY) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / DAY)} days`;
}

export async function checkToken(tokenId: string, opts: TokenCheckOptions): Promise<CheckResult> {
  const { data } = opts;
  const t = { ...DEFAULT_TOKEN_THRESHOLDS, ...opts.thresholds };
  const now = opts.now ?? Date.now();
  const id = tokenId.trim().toLowerCase();
  const known = KNOWN[data.network].tokens;
  const trusted = new Set([...(opts.trustedTokens ?? []).map((x) => x.toLowerCase()), ...known.map((k) => k.accountId)]);
  const facts: Record<string, unknown> = {};

  const name = checkAccountName(id, { network: data.network, trusted: [...trusted], scamList: opts.scamList });
  const flags: Flag[] = name.flags.filter((f) => f.code !== "KNOWN_ACCOUNT");
  if (name.verdict === "BLOCK" && flags.some((f) => f.code === "INVALID_ACCOUNT_ID" || f.code === "NON_ASCII_ACCOUNT")) {
    return result("nep141_token", id, flags, facts);
  }

  if (trusted.has(id)) {
    flags.push({ code: "TRUSTED_TOKEN", severity: "info", message: `${id} is a canonical or owner-trusted token` });
    return result("nep141_token", id, flags, facts);
  }

  const acct = await data.viewAccount(id);
  if (!acct.exists) {
    flags.push({ code: "TOKEN_NOT_FOUND", severity: "critical", message: `${id} does not exist on ${data.network}` });
    return result("nep141_token", id, flags, facts);
  }
  if (!acct.hasContract) {
    flags.push({ code: "NOT_A_CONTRACT", severity: "critical", message: `${id} has no contract code, so it cannot be a token` });
    return result("nep141_token", id, flags, facts);
  }

  let meta: FtMetadata;
  try {
    meta = await data.viewFunction<FtMetadata>(id, "ft_metadata");
  } catch {
    flags.push({ code: "NOT_NEP141", severity: "critical", message: `${id} does not answer ft_metadata (not a NEP-141 token)` });
    return result("nep141_token", id, flags, facts);
  }
  facts.metadata = { name: meta.name, symbol: meta.symbol, decimals: meta.decimals, spec: meta.spec, hasIcon: Boolean(meta.icon) };

  const symbol = meta.symbol ?? "";
  const tokenName = meta.name ?? "";
  const norm = normalizeSymbol(symbol);
  const protectedHit = PROTECTED_SYMBOLS.find((p) => norm === p || norm === "W" + p || norm === p + "E");
  if (protectedHit) {
    const canonical = known.filter((k) => normalizeSymbol(k.symbol) === protectedHit || normalizeSymbol(k.symbol) === "W" + protectedHit);
    flags.push({
      code: "IMPERSONATES_CANONICAL",
      severity: "critical",
      message: `uses the symbol "${symbol}" but is not the canonical ${protectedHit} contract${
        canonical.length ? ` (${canonical.map((c) => c.accountId).join(", ")})` : ""
      }`,
      evidence: { symbol, canonical: canonical.map((c) => c.accountId) },
    });
  }
  if (hasNonAscii(symbol) || hasNonAscii(tokenName)) {
    flags.push({ code: "NON_ASCII_METADATA", severity: "high", message: "symbol or name uses non-ASCII look-alike characters" });
  }
  if (looksLikeUrl(tokenName) || looksLikeUrl(symbol)) {
    flags.push({ code: "METADATA_LURE_URL", severity: "critical", message: `metadata contains a link ("${tokenName}"): typical of airdrop-scam tokens` });
  } else {
    const baits = baitWordsIn(`${tokenName} ${symbol}`);
    if (baits.length) flags.push({ code: "METADATA_LURE_WORDS", severity: "high", message: `metadata uses lure words: ${baits.join(", ")}` });
  }
  if (typeof meta.decimals !== "number" || meta.decimals > 24 || meta.decimals < 0) {
    flags.push({ code: "ODD_DECIMALS", severity: "high", message: `decimals = ${meta.decimals}` });
  }
  if (!meta.spec?.startsWith("ft-1")) {
    flags.push({ code: "NONSTANDARD_SPEC", severity: "low", message: `spec "${meta.spec}" is not ft-1.x` });
  }
  if (!meta.icon) flags.push({ code: "NO_ICON", severity: "low", message: "no icon in metadata" });

  try {
    const supply = BigInt(await data.viewFunction<string>(id, "ft_total_supply"));
    facts.totalSupply = supply.toString();
    if (supply === 0n) flags.push({ code: "ZERO_SUPPLY", severity: "medium", message: "total supply is 0" });

    const top = await data.topHolders?.(id);
    if (top && top.length && supply > 0n) {
      const share = (n: number) => Number((top.slice(0, n).reduce((a, h) => a + h.balance, 0n) * 10_000n) / supply) / 10_000;
      const top1 = share(1);
      const top10 = share(10);
      facts.top1Share = top1;
      facts.top10Share = top10;
      facts.topHoldersSeen = top.length;
      if (top1 > t.top1MaxShare) {
        flags.push({ code: "HOLDER_CONCENTRATION", severity: "high", message: `top holder (${top[0]!.account}) owns ${(top1 * 100).toFixed(1)}% of supply` });
      } else if (top10 > t.top10MaxShare) {
        flags.push({ code: "HOLDER_CONCENTRATION", severity: "medium", message: `top 10 holders own ${(top10 * 100).toFixed(1)}% of supply` });
      }
    }
  } catch {
    flags.push({ code: "NO_TOTAL_SUPPLY", severity: "medium", message: "ft_total_supply failed" });
  }

  const created = await data.createdAt?.(id);
  if (created) {
    const age = now - created;
    facts.ageMs = age;
    if (age < t.newTokenHighMs) flags.push({ code: "NEW_TOKEN", severity: "high", message: `token account is only ${fmtAge(age)} old` });
    else if (age < t.newTokenMediumMs) flags.push({ code: "NEW_TOKEN", severity: "medium", message: `token account is ${fmtAge(age)} old` });
  } else {
    flags.push({ code: "AGE_UNKNOWN", severity: "info", message: "creation time unavailable from the indexer" });
  }

  const deploys = await data.deployments?.(id);
  if (deploys && deploys.length) {
    facts.deployments = deploys.length;
    const last = deploys[0]!;
    const olderToken = created ? now - created > t.recentCodeChangeMs : deploys.length > 1;
    if (now - last < t.recentCodeChangeMs && olderToken) {
      flags.push({ code: "CODE_CHANGED_RECENTLY", severity: "high", message: `contract code was replaced ${fmtAge(now - last)} ago` });
    }
  }

  const counted = await data.holdersCount?.(id);
  // Indexers lag on brand-new tokens: never report fewer holders than we can see in the top list.
  const seen = typeof facts.topHoldersSeen === "number" ? facts.topHoldersSeen : 0;
  const holders = counted === undefined ? undefined : Math.max(counted, seen);
  if (holders !== undefined) {
    facts.holders = holders;
    if (holders < t.minHolders) flags.push({ code: "FEW_HOLDERS", severity: "medium", message: `only ${holders} holder(s)` });
  }

  const listed = opts.intentsListed?.get(id);
  if (listed) {
    facts.intentsPriceUsd = listed.price;
    flags.push({ code: "LISTED_ON_NEAR_INTENTS", severity: "info", message: `listed on NEAR Intents 1Click as ${listed.symbol}` });
  }

  return result("nep141_token", id, flags, facts);
}
