import { describe, expect, it } from "vitest";
import { checkCounterparty, FixtureNearData } from "../src/risk";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const DAY = 86_400_000;
const codes = (r: { flags: { code: string }[] }) => r.flags.map((f) => f.code);

describe("checkCounterparty", () => {
  const data = new FixtureNearData("testnet", {
    accounts: {
      "alice.testnet": { exists: true, hasContract: false },
      "fresh.testnet": { exists: true, hasContract: false },
      "vault-x.testnet": { exists: true, hasContract: true },
    },
    createdAt: { "alice.testnet": NOW - 400 * DAY, "fresh.testnet": NOW - 3_600_000, "vault-x.testnet": NOW - 90 * DAY },
    deployments: { "vault-x.testnet": [NOW - DAY, NOW - 90 * DAY] },
  });

  it("allows an established account", async () => {
    const r = await checkCounterparty("alice.testnet", { data, now: NOW });
    expect(r.verdict).toBe("ALLOW");
  });

  it("warns on missing named accounts, new accounts and swapped contracts", async () => {
    expect(codes(await checkCounterparty("ghost.testnet", { data, now: NOW }))).toContain("ACCOUNT_NOT_FOUND");
    expect((await checkCounterparty("ghost.testnet", { data, now: NOW })).verdict).toBe("WARN");
    expect(codes(await checkCounterparty("fresh.testnet", { data, now: NOW }))).toContain("NEW_ACCOUNT");
    expect(codes(await checkCounterparty("vault-x.testnet", { data, now: NOW }))).toContain("CODE_CHANGED_RECENTLY");
  });

  it("notes first payments when a ledger is provided", async () => {
    const r = await checkCounterparty("alice.testnet", { data, now: NOW, priorPayees: new Set(["bob.testnet"]) });
    expect(codes(r)).toContain("FIRST_PAYMENT");
    expect(r.verdict).toBe("ALLOW");
  });

  it("blocks look-alikes of trusted payees", async () => {
    const r = await checkCounterparty("payro1l.myco.testnet", { data, now: NOW, trustedAccounts: ["payroll.myco.testnet"] });
    expect(r.verdict).toBe("BLOCK");
  });
});
