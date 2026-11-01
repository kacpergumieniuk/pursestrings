import { describe, expect, it } from "vitest";
import { checkUrl, extractUrls, ScamList } from "../src/risk";

const codes = (u: string, scamList?: ScamList) => checkUrl(u, { scamList }).flags.map((f) => f.code);

describe("checkUrl", () => {
  it("allows official domains and subdomains", () => {
    expect(checkUrl("https://near.org/blog").verdict).toBe("ALLOW");
    expect(checkUrl("https://docs.near.org").verdict).toBe("ALLOW");
    expect(checkUrl("https://app.rhea.finance/swap").verdict).toBe("ALLOW");
  });

  it("blocks credentials-in-URL host hiding", () => {
    expect(codes("https://near.org@evil.example/claim")).toContain("CREDENTIALS_IN_URL");
    expect(checkUrl("https://near.org@evil.example/claim").verdict).toBe("BLOCK");
  });

  it("blocks official domains embedded in another domain", () => {
    expect(codes("https://near.org.claim-rewards.xyz")).toContain("OFFICIAL_DOMAIN_EMBEDDED");
    expect(checkUrl("https://near.org.claim-rewards.xyz").verdict).toBe("BLOCK");
  });

  it("blocks look-alike domains but not unrelated words", () => {
    expect(codes("https://nearr.org")).toContain("LOOKALIKE_DOMAIN");
    expect(codes("https://rhea.flnance")).not.toContain("OFFICIAL_DOMAIN");
    expect(codes("https://meteorwalet.app")).toContain("LOOKALIKE_DOMAIN");
    expect(codes("https://bear.org")).not.toContain("LOOKALIKE_DOMAIN");
  });

  it("flags punycode, IP hosts, shorteners, http and dangerous schemes", () => {
    expect(codes("https://xn--nar-5cd.org")).toContain("PUNYCODE_DOMAIN");
    expect(codes("http://192.168.1.10/wallet")).toContain("IP_HOST");
    expect(codes("https://bit.ly/abc")).toContain("URL_SHORTENER");
    expect(codes("http://example.com")).toContain("NOT_HTTPS");
    expect(checkUrl("javascript:alert(1)").verdict).toBe("BLOCK");
  });

  it("warns on brand + lure links and blocks seed requests", () => {
    expect(codes("https://near-airdrop.live/claim")).toContain("BRAND_BAIT_LINK");
    expect(checkUrl("https://near-airdrop.live/claim").verdict).toBe("WARN");
    expect(checkUrl("https://example.com/restore?seed=word1+word2").verdict).toBe("BLOCK");
  });

  it("uses the scam list for domains and subdomains", () => {
    const s = new ScamList([{ type: "domain", value: "near-airdrop-claim.xyz", reason: "drainer" }]);
    expect(checkUrl("https://app.near-airdrop-claim.xyz/x", { scamList: s }).verdict).toBe("BLOCK");
  });

  it("extracts URLs from free text", () => {
    expect(extractUrls("go to https://near.org/x, or near-airdrop-claim.xyz/claim now.")).toEqual([
      "https://near.org/x",
      "near-airdrop-claim.xyz/claim",
    ]);
  });
});
