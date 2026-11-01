/**
 * Link checks for URLs an agent is asked to open or that appear next to a payment request.
 * Pure function: no network access.
 */
import { BRAND_WORDS, OFFICIAL_DOMAINS, RISKY_TLDS, URL_SHORTENERS } from "./known";
import type { ScamList } from "./scam-list";
import { baitWordsIn, editDistance, isTypo, skeleton } from "./text";
import { type CheckResult, type Flag, result } from "./types";

export interface UrlOptions {
  officialDomains?: string[];
  scamList?: ScamList;
}

function registrable(host: string): string {
  const parts = host.split(".");
  return parts.slice(-2).join(".");
}

function isUnder(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

export function checkUrl(raw: string, opts: UrlOptions = {}): CheckResult {
  const flags: Flag[] = [];
  const input = raw.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
  } catch {
    flags.push({ code: "MALFORMED_URL", severity: "high", message: "cannot be parsed as a URL" });
    return result("url", input, flags);
  }
  const official = opts.officialDomains ?? OFFICIAL_DOMAINS;

  if (["javascript:", "data:", "file:", "vbscript:"].includes(url.protocol)) {
    flags.push({ code: "DANGEROUS_SCHEME", severity: "critical", message: `${url.protocol} links can run code or hide content` });
    return result("url", input, flags);
  }
  if (url.protocol !== "https:") {
    flags.push({ code: "NOT_HTTPS", severity: "medium", message: `uses ${url.protocol.replace(":", "")} instead of https` });
  }
  if (url.username || url.password) {
    flags.push({
      code: "CREDENTIALS_IN_URL",
      severity: "critical",
      message: `text before "@" ("${url.username}") hides the real host ${url.hostname}`,
    });
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) {
    flags.push({ code: "IP_HOST", severity: "high", message: "points to a raw IP address instead of a domain" });
  }
  if (host.split(".").some((l) => l.startsWith("xn--"))) {
    flags.push({ code: "PUNYCODE_DOMAIN", severity: "high", message: `internationalized domain (${host}) can imitate Latin letters` });
  }

  const scam = opts.scamList?.match("domain", host);
  if (scam) {
    flags.push({ code: "KNOWN_SCAM_DOMAIN", severity: "critical", message: `${scam.matched} is on the known-scam list: ${scam.entry.reason}` });
  }

  const officialHit = official.find((d) => isUnder(host, d));
  if (officialHit) {
    flags.push({ code: "OFFICIAL_DOMAIN", severity: "info", message: `${host} belongs to ${officialHit}` });
    return result("url", input, flags, { host });
  }

  if (URL_SHORTENERS.some((d) => isUnder(host, d))) {
    flags.push({ code: "URL_SHORTENER", severity: "medium", message: "shortened link hides the destination" });
  }

  // An official domain used as a sub-domain label of something else: near.org.claim-now.xyz
  const distinctive = official.filter((d) => d.split(".")[0]!.length >= 4);
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const embedded = distinctive.find((d) => {
    const dotted = new RegExp(`(^|\\.)${esc(d)}\\.`);
    const dashed = new RegExp(`(^|[.-])${esc(d.replace(/\./g, "-"))}($|[.-])`);
    return dotted.test(host) || dashed.test(host);
  });
  if (embedded) {
    flags.push({
      code: "OFFICIAL_DOMAIN_EMBEDDED",
      severity: "critical",
      message: `contains "${embedded}" but the real domain is ${registrable(host)}`,
      evidence: { imitates: embedded },
    });
  }

  // Look-alike of an official registrable domain: nearr.org, rnear.org, near-org.com, neаr.org
  const reg = registrable(host);
  const regLabel = reg.split(".")[0]!;
  for (const d of official) {
    const dLabel = d.split(".")[0]!;
    if (dLabel.length < 3 || reg === d) continue;
    const sameSkeleton = skeleton(regLabel) === skeleton(dLabel) && regLabel !== dLabel;
    const dist = editDistance(regLabel, dLabel);
    if (sameSkeleton || isTypo(regLabel, dLabel, dist)) {
      flags.push({
        code: "LOOKALIKE_DOMAIN",
        severity: "critical",
        message: `${reg} imitates ${d}`,
        evidence: { imitates: d, distance: dist },
      });
      break;
    }
  }

  const tld = host.split(".").pop() ?? "";
  if (RISKY_TLDS.includes(tld)) {
    flags.push({ code: "RISKY_TLD", severity: "low", message: `.${tld} is over-represented in phishing` });
  }

  const text = `${host} ${decodeURIComponent(url.pathname)} ${url.search}`;
  const baits = baitWordsIn(text);
  const brands = BRAND_WORDS.filter((b) => host.split(/[^a-z0-9]+/).includes(b));
  if (baits.length && brands.length) {
    flags.push({
      code: "BRAND_BAIT_LINK",
      severity: "high",
      message: `non-official domain uses brand [${brands.join(", ")}] with lure word(s) [${baits.join(", ")}]`,
    });
  } else if (baits.length) {
    flags.push({ code: "BAIT_WORDS", severity: "low", message: `lure word(s): ${baits.join(", ")}` });
  } else if (brands.length) {
    flags.push({ code: "BRAND_ON_UNOFFICIAL_DOMAIN", severity: "medium", message: `uses brand word(s) [${brands.join(", ")}] on an unofficial domain` });
  }

  // Seed phrase / private key bait in the query string.
  if (/(seed|mnemonic|private[-_]?key|secret)/i.test(url.search + url.hash)) {
    flags.push({ code: "SECRET_REQUEST", severity: "critical", message: "link asks for a seed phrase or private key" });
  }

  return result("url", input, flags, { host, registrable: reg });
}

/** Extract URLs from free text (messages the agent reads). */
export function extractUrls(text: string): string[] {
  const re = /\b((?:https?:\/\/|www\.)[^\s<>"')\]]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|xyz|app|site|online|live|top|click|link|info|finance|ai|gg|me|co)(?:\/[^\s<>"')\]]*)?)/gi;
  return [...new Set((text.match(re) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))];
}
