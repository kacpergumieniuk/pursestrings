import { describe, expect, it } from "vitest";
import { checkToken, FixtureNearData, ScamList } from "../src/risk";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const contract = { exists: true, hasContract: true, codeHash: "abc" };

function data(id: string, meta: Record<string, unknown>, extra: Partial<ConstructorParameters<typeof FixtureNearData>[1]> = {}) {
  return new FixtureNearData("mainnet", {
    accounts: { [id]: contract },
    views: { [`${id}:ft_metadata`]: meta, [`${id}:ft_total_supply`]: "1000000000" },
    ...extra,
  });
}
const codes = (r: { flags: { code: string }[] }) => r.flags.map((f) => f.code);

describe("checkToken", () => {
  it("trusts canonical tokens without network calls", async () => {
    const r = await checkToken("usdt.tether-token.near", { data: new FixtureNearData("mainnet"), now: NOW });
    expect(r.verdict).toBe("ALLOW");
    expect(codes(r)).toContain("TRUSTED_TOKEN");
  });

  it("blocks a fresh fake USDC with a lure link in its name", async () => {
    const id = "usdc-airdrop.near";
    const r = await checkToken(id, {
      data: data(
        id,
        { spec: "ft-1.0.0", name: "USDC - claim at usdc-bonus.xyz", symbol: "USDC", decimals: 6, icon: null },
        { createdAt: { [id]: NOW - 2 * HOUR }, holdersCount: { [id]: 3 }, topHolders: { [id]: [{ account: "dev.near", balance: 990000000n }] } },
      ),
      now: NOW,
    });
    expect(r.verdict).toBe("BLOCK");
    expect(codes(r)).toEqual(
      expect.arrayContaining(["IMPERSONATES_CANONICAL", "METADATA_LURE_URL", "NEW_TOKEN", "FEW_HOLDERS", "HOLDER_CONCENTRATION", "BRAND_BAIT_NAME"]),
    );
    expect(r.reasons.join(" ")).toContain("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  });

  it("catches homoglyph symbols", async () => {
    const id = "stable.near";
    const r = await checkToken(id, {
      data: data(id, { spec: "ft-1.0.0", name: "Tether", symbol: "USDТ", decimals: 6, icon: "data:x" }, { createdAt: { [id]: NOW - 400 * DAY } }),
      now: NOW,
    });
    expect(codes(r)).toEqual(expect.arrayContaining(["IMPERSONATES_CANONICAL", "NON_ASCII_METADATA"]));
    expect(r.verdict).toBe("BLOCK");
  });

  it("warns on new tokens and recent code changes, allows old healthy tokens", async () => {
    const id = "meme.near";
    const meta = { spec: "ft-1.0.0", name: "Meme", symbol: "MEME", decimals: 18, icon: "data:x" };
    const fresh = await checkToken(id, { data: data(id, meta, { createdAt: { [id]: NOW - 3 * DAY }, holdersCount: { [id]: 500 } }), now: NOW });
    expect(fresh.verdict).toBe("WARN");
    expect(codes(fresh)).toContain("NEW_TOKEN");

    const swapped = await checkToken(id, {
      data: data(id, meta, { createdAt: { [id]: NOW - 300 * DAY }, deployments: { [id]: [NOW - DAY, NOW - 300 * DAY] }, holdersCount: { [id]: 500 } }),
      now: NOW,
    });
    expect(codes(swapped)).toContain("CODE_CHANGED_RECENTLY");

    const healthy = await checkToken(id, {
      data: data(id, meta, {
        createdAt: { [id]: NOW - 300 * DAY },
        holdersCount: { [id]: 5000 },
        topHolders: { [id]: [{ account: "a.near", balance: 100000000n }, { account: "b.near", balance: 50000000n }] },
      }),
      now: NOW,
    });
    expect(healthy.verdict).toBe("ALLOW");
  });

  it("blocks non-tokens and missing accounts", async () => {
    const empty = new FixtureNearData("mainnet", { accounts: { "wallet.near": { exists: true, hasContract: false } } });
    expect(codes(await checkToken("wallet.near", { data: empty }))).toContain("NOT_A_CONTRACT");
    expect(codes(await checkToken("ghost.near", { data: empty }))).toContain("TOKEN_NOT_FOUND");
    const noFt = new FixtureNearData("mainnet", { accounts: { "dao.near": contract } });
    expect(codes(await checkToken("dao.near", { data: noFt }))).toContain("NOT_NEP141");
  });

  it("honors the scam list and owner-trusted tokens", async () => {
    const id = "rug.near";
    const scamList = new ScamList([{ type: "token", value: id, reason: "rug pulled" }]);
    const r = await checkToken(id, { data: data(id, { spec: "ft-1.0.0", name: "R", symbol: "R", decimals: 18, icon: "x" }), scamList, now: NOW });
    expect(r.verdict).toBe("BLOCK");
    const t = await checkToken("gusd.myco.near", { data: new FixtureNearData("mainnet"), trustedTokens: ["gusd.myco.near"] });
    expect(t.verdict).toBe("ALLOW");
  });
});
