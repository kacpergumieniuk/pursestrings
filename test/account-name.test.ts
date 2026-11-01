import { describe, expect, it } from "vitest";
import { checkAccountName, ScamList } from "../src/risk";

const mainnet = (id: string, trusted?: string[]) => checkAccountName(id, { network: "mainnet", trusted });
const codes = (r: { flags: { code: string }[] }) => r.flags.map((f) => f.code);

describe("checkAccountName", () => {
  it("allows canonical accounts and implicit accounts", () => {
    expect(mainnet("wrap.near").verdict).toBe("ALLOW");
    expect(mainnet("usdt.tether-token.near").verdict).toBe("ALLOW");
    expect(mainnet("a".repeat(64)).verdict).toBe("ALLOW");
    expect(mainnet("alice.near").verdict).toBe("ALLOW");
  });

  it("blocks confusable look-alikes of known accounts", () => {
    const r = mainnet("wrap-near.near"); // flattened `wrap.near`
    expect(r.verdict).toBe("BLOCK");
    expect(codes(r)).toContain("LOOKALIKE_ACCOUNT");
    const r2 = mainnet("usdt.tether-t0ken.near");
    expect(r2.verdict).toBe("BLOCK");
    expect(codes(r2)).toContain("LOOKALIKE_ACCOUNT");
    expect(mainnet("intents.rnear.near").verdict).not.toBe("ALLOW");
  });

  it("blocks prefix impersonation (wrap.near.<attacker>.near)", () => {
    const r = mainnet("wrap.near.evil.near");
    expect(r.verdict).toBe("BLOCK");
    expect(codes(r)).toContain("PREFIX_IMPERSONATION");
  });

  it("warns on typosquats but not on unrelated short words", () => {
    expect(codes(mainnet("tether-tokn.near"))).toContain("TYPOSQUAT");
    expect(mainnet("tether-tokn.near").verdict).toBe("WARN");
    expect(codes(mainnet("wrapp.near"))).toContain("TYPOSQUAT");
    expect(codes(mainnet("trap.near"))).not.toContain("TYPOSQUAT");
  });

  it("flags brand + lure words", () => {
    const r = mainnet("usdc-airdrop.near");
    expect(codes(r)).toContain("BRAND_BAIT_NAME");
    expect(r.verdict).toBe("WARN");
    expect(codes(mainnet("free-claim.near"))).toContain("BAIT_WORDS_IN_NAME");
  });

  it("rejects invalid and non-ASCII ids", () => {
    expect(codes(mainnet("Wrap.near"))).toContain("INVALID_ACCOUNT_ID");
    expect(codes(mainnet("wrаp.near"))).toContain("NON_ASCII_ACCOUNT"); // Cyrillic а
    expect(mainnet("wrаp.near").verdict).toBe("BLOCK");
  });

  it("uses the scam list, including sub-accounts", () => {
    const scamList = new ScamList([{ type: "account", value: "drainer.near", reason: "test" }]);
    const r = checkAccountName("claim.drainer.near", { network: "mainnet", scamList });
    expect(r.verdict).toBe("BLOCK");
    expect(codes(r)).toContain("KNOWN_SCAM");
  });

  it("treats owner-trusted accounts as known", () => {
    expect(mainnet("payroll.myco.near", ["payroll.myco.near"]).flags[0]?.code).toBe("KNOWN_ACCOUNT");
  });
});
