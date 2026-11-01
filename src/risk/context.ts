/**
 * Checks the text that made the agent act (a chat message, an email, a web page).
 * Flags common prompt-injection and social-engineering patterns, and checks every link in it.
 */
import type { ScamList } from "./scam-list";
import { type CheckResult, type Flag, result } from "./types";
import { checkUrl, extractUrls } from "./url";

const PATTERNS: Array<{ code: string; severity: Flag["severity"]; re: RegExp; message: string }> = [
  { code: "INSTRUCTION_OVERRIDE", severity: "high", re: /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|earlier|all)\b.{0,20}\b(instructions?|rules?|polic(y|ies)|limits?)/i, message: "tries to override the agent's instructions" },
  { code: "FAKE_AUTHORITY", severity: "high", re: /\b(system|admin|administrator|developer|security team|support team|owner)\s*(message|notice|override|:)/i, message: "claims to speak for the system, admin or owner" },
  { code: "LIMIT_BYPASS", severity: "high", re: /\b(bypass|disable|skip|turn off|raise|increase)\b.{0,30}\b(guard|limit|cap|check|policy|approval|firewall)/i, message: "asks to bypass spending limits or checks" },
  { code: "URGENCY", severity: "medium", re: /\b(urgent(ly)?|immediately|right now|within \d+ ?(min|minutes|hours?)|last chance|expires?)\b/i, message: "creates time pressure" },
  { code: "DRAIN_REQUEST", severity: "high", re: /\b(send|transfer|move)\b.{0,20}\b(all|entire|whole|everything|max(imum)?)\b/i, message: "asks to move all funds" },
  { code: "SECRET_REQUEST", severity: "critical", re: /\b(seed phrase|mnemonic|private key|secret key|recovery phrase)\b/i, message: "asks for keys or a seed phrase" },
];

export function checkContext(text: string, opts: { scamList?: ScamList } = {}): CheckResult {
  const flags: Flag[] = [];
  for (const p of PATTERNS) {
    if (p.re.test(text)) flags.push({ code: p.code, severity: p.severity, message: p.message });
  }
  const urls = extractUrls(text);
  const linkResults = urls.map((u) => checkUrl(u, { scamList: opts.scamList }));
  for (const r of linkResults) {
    for (const f of r.flags) {
      if (f.severity !== "info") flags.push({ ...f, code: `LINK_${f.code}`, message: `${r.target}: ${f.message}` });
    }
  }
  const injection = flags.filter((f) => ["INSTRUCTION_OVERRIDE", "FAKE_AUTHORITY", "LIMIT_BYPASS", "DRAIN_REQUEST"].includes(f.code));
  if (injection.length >= 2) {
    flags.push({ code: "PROMPT_INJECTION_SUSPECTED", severity: "critical", message: `message matches ${injection.length} injection patterns` });
  }
  return result("context", text.length > 80 ? text.slice(0, 77) + "..." : text, flags, { urls });
}
