/** String helpers for look-alike detection. */

/** Optimal-string-alignment distance (Damerau-Levenshtein with adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
    }
  }
  return d[m]![n]!;
}

/** Characters attackers swap in to fake a name. Applied after lower-casing. */
const CONFUSABLE: Array<[RegExp, string]> = [
  [/rn/g, "m"],
  [/vv/g, "w"],
  [/cl/g, "d"],
  [/0/g, "o"],
  [/[1|!]/g, "l"],
  [/i/g, "l"],
  [/3/g, "e"],
  [/4/g, "a"],
  [/5/g, "s"],
  [/7/g, "t"],
  [/8/g, "b"],
  [/9/g, "g"],
];

/** Unicode look-alikes (Cyrillic/Greek) that render like Latin letters. */
const HOMOGLYPHS: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", ɡ: "g", ո: "n",
  ν: "v", ο: "o", α: "a", ρ: "p", τ: "t", κ: "k", ι: "i", υ: "u", ϲ: "c",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", Ѕ: "S", І: "I", Ј: "J",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
};

export function stripHomoglyphs(s: string): string {
  return [...s.normalize("NFKC")].map((c) => HOMOGLYPHS[c] ?? c).join("");
}

/** Canonical "skeleton" of a name: lower-case, homoglyphs folded, confusables folded, separators removed. */
export function skeleton(s: string): string {
  let out = stripHomoglyphs(s.toLowerCase());
  for (const [re, rep] of CONFUSABLE) out = out.replace(re, rep);
  return out.replace(/[-_.\s]/g, "");
}

export function hasNonAscii(s: string): boolean {
  return /[^\x20-\x7e]/.test(s);
}

/** Words that show up in airdrop / drainer lures. */
export const BAIT_WORDS = [
  "airdrop", "claim", "giveaway", "bonus", "reward", "rewards", "free", "gift", "promo", "verify", "validate",
  "unlock", "migrate", "migration", "support", "helpdesk", "recovery", "restore", "seed", "connect", "wallet-connect",
  "walletconnect", "official", "secure", "refund", "compensation", "drop", "prize", "winner", "redeem",
];

export function baitWordsIn(s: string): string[] {
  const lower = s.toLowerCase();
  const tokens = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  return BAIT_WORDS.filter((w) => (w.includes("-") ? lower.includes(w) : tokens.has(w) || (w.length >= 6 && lower.includes(w))));
}

export function looksLikeUrl(s: string): boolean {
  return /(https?:\/\/|www\.)|\b[a-z0-9-]+\.(com|org|net|io|xyz|app|site|online|live|top|click|link|info|finance|claims?|gift)\b/i.test(s);
}

/**
 * Typo distance that avoids flagging unrelated short words (`bear` vs `near`):
 * labels under 5 characters only count insertions/deletions (`nearr`, `rnear`).
 */
export function isTypo(candidate: string, target: string, dist = editDistance(candidate, target)): boolean {
  if (dist === 0) return false;
  if (target.length < 5) return dist === 1 && candidate.length !== target.length;
  return dist <= (target.length >= 8 ? 2 : 1);
}
