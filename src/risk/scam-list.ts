/**
 * Configurable known-scam list: accounts, tokens and domains, exact or regex.
 * Sources (merged): data/scam-list.json, GUARD_SCAM_LIST_PATH, GUARD_SCAM_LIST_URL,
 * plus entries pulled from a guard contract's on-chain denylist.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type ScamEntryType = "account" | "token" | "domain";

export interface ScamEntry {
  type: ScamEntryType;
  /** Exact value (account id or domain). Domains also match their subdomains. */
  value?: string;
  /** Regex alternative to `value`. */
  pattern?: string;
  reason: string;
  source?: string;
  evidence?: string;
}

export interface ScamMatch {
  entry: ScamEntry;
  matched: string;
}

export class ScamList {
  private compiled: Array<{ entry: ScamEntry; re?: RegExp }> = [];

  constructor(entries: ScamEntry[] = []) {
    this.add(entries);
  }

  add(entries: ScamEntry[]): this {
    for (const entry of entries) {
      if (!entry.value && !entry.pattern) continue;
      this.compiled.push({ entry, re: entry.pattern ? new RegExp(entry.pattern, "i") : undefined });
    }
    return this;
  }

  get size(): number {
    return this.compiled.length;
  }

  /** Accounts also match through a denylisted parent (`x.bad.near` matches `bad.near`). */
  match(type: ScamEntryType, value: string): ScamMatch | undefined {
    const v = value.toLowerCase();
    for (const { entry, re } of this.compiled) {
      const sameType = entry.type === type || (type !== "domain" && entry.type !== "domain");
      if (!sameType) continue;
      if (re && re.test(v)) return { entry, matched: v };
      if (entry.value) {
        const e = entry.value.toLowerCase();
        if (v === e || v.endsWith("." + e)) return { entry, matched: e };
      }
    }
    return undefined;
  }

  static async load(opts: { path?: string; url?: string; fetchImpl?: typeof fetch; includeDefault?: boolean } = {}): Promise<ScamList> {
    const list = new ScamList();
    if (opts.includeDefault !== false) {
      const p = fileURLToPath(new URL("../../data/scam-list.json", import.meta.url));
      list.add(parseList(await readFile(p, "utf8")));
    }
    const path = opts.path ?? process.env.GUARD_SCAM_LIST_PATH;
    if (path) list.add(parseList(await readFile(path, "utf8")));
    const url = opts.url ?? process.env.GUARD_SCAM_LIST_URL;
    if (url) {
      const res = await (opts.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`scam list ${url}: HTTP ${res.status}`);
      list.add(parseList(await res.text()));
    }
    return list;
  }
}

export function parseList(text: string): ScamEntry[] {
  const json = JSON.parse(text) as { entries?: ScamEntry[] } | ScamEntry[];
  const entries = Array.isArray(json) ? json : (json.entries ?? []);
  return entries.filter((e) => e && (e.type === "account" || e.type === "token" || e.type === "domain"));
}
