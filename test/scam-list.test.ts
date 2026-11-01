import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScamList } from "../src/risk";

describe("ScamList", () => {
  it("loads the bundled list, a local file and a remote URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-"));
    const path = join(dir, "list.json");
    writeFileSync(path, JSON.stringify([{ type: "account", value: "local-bad.testnet", reason: "local" }]));
    const fetchImpl = (async () => new Response(JSON.stringify({ entries: [{ type: "domain", value: "remote-bad.xyz", reason: "remote" }] }))) as typeof fetch;
    const list = await ScamList.load({ path, url: "https://lists.example/scams.json", fetchImpl });
    expect(list.match("domain", "near-airdrop-claim.xyz")?.entry.source).toBe("pursestrings-demo");
    expect(list.match("account", "x.local-bad.testnet")?.entry.reason).toBe("local");
    expect(list.match("domain", "www.remote-bad.xyz")?.entry.reason).toBe("remote");
    expect(list.match("account", "claim.drainer-123.testnet")).toBeDefined();
    expect(list.match("account", "alice.testnet")).toBeUndefined();
  });
});
