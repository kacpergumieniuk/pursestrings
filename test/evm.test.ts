import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkEvmToken, parseBridgedEvmAsset } from "../src/risk";

const SAFE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const DANGER = "0x000000000000000000000000000000000000dead";
const CAUTION = "0x1111111111111111111111111111111111111111";

/** Mock of the Base token-verdict API (the real one lives in a separate service). */
let server: Server;
let url = "";
const seen: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req.url ?? "");
    const addr = /0x[0-9a-f]{40}/.exec(req.url ?? "")?.[0];
    const body =
      addr === SAFE
        ? { verdict: "SAFE", score: 95, summary: "canonical USDC" }
        : addr === DANGER
          ? { verdict: "DANGER", score: 5, reasons: ["owner can mint", "sell tax 90%"] }
          : addr === CAUTION
            ? { verdict: "CAUTION", score: 55, reasons: ["LP not burned"] }
            : null;
    res.writeHead(body ? 200 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "boom" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/verdict/{address}?chain={chain}`;
});
afterAll(() => server.close());

describe("checkEvmToken (HTTP to the Base verdict API)", () => {
  it("maps SAFE / CAUTION / DANGER to ALLOW / WARN / BLOCK", async () => {
    expect((await checkEvmToken("base", SAFE, { urlTemplate: url })).verdict).toBe("ALLOW");
    expect((await checkEvmToken("base", CAUTION, { urlTemplate: url })).verdict).toBe("WARN");
    const d = await checkEvmToken("base", DANGER, { urlTemplate: url });
    expect(d.verdict).toBe("BLOCK");
    expect(d.reasons[0]).toContain("owner can mint");
    expect(seen[0]).toBe(`/v1/verdict/${SAFE}?chain=base`);
  });

  it("degrades to WARN when unconfigured or failing, never to ALLOW", async () => {
    const prev = process.env.GUARD_EVM_VERDICT_URL;
    delete process.env.GUARD_EVM_VERDICT_URL;
    expect((await checkEvmToken("base", SAFE)).flags[0]?.code).toBe("EVM_CHECK_SKIPPED");
    expect((await checkEvmToken("base", SAFE)).verdict).toBe("WARN");
    if (prev) process.env.GUARD_EVM_VERDICT_URL = prev;
    const failing = await checkEvmToken("base", "0x2222222222222222222222222222222222222222", { urlTemplate: url });
    expect(failing.flags[0]?.code).toBe("EVM_CHECK_FAILED");
    expect(failing.verdict).toBe("WARN");
  });

  it("parses bridged asset ids", () => {
    expect(parseBridgedEvmAsset(`nep141:base-${SAFE}.omft.near`)).toEqual({ chain: "base", address: SAFE });
    expect(parseBridgedEvmAsset("nep141:wrap.near")).toBeUndefined();
  });
});
