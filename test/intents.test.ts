import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkIntentsQuote, type SwapRequest } from "../src/risk";

const tokens = JSON.parse(readFileSync(new URL("./fixtures/oneclick-tokens.json", import.meta.url), "utf8"));
/** A real dry-run quote recorded from 1click.chaindefuser.com on 2026-11-01 (signature included). */
const realQuote = JSON.parse(readFileSync(new URL("./fixtures/oneclick-quote.json", import.meta.url), "utf8"));

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const req: SwapRequest = {
  originAsset: "nep141:wrap.near",
  destinationAsset: USDC,
  amount: "1000000000000000000000000",
  recipient: "intents.near",
  refundTo: "intents.near",
  slippageBps: 100,
};

/** Fake 1Click: serves the token list and returns `quote(body)` for /v0/quote. */
function oneClick(quote: (body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/v0/tokens")) return new Response(JSON.stringify(tokens));
    if (u.endsWith("/v0/quote")) {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      const r = quote(body);
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function echoQuote(body: Record<string, unknown>, over: { amountOut?: string; amountOutUsd?: string; appFee?: number } = {}) {
  return {
    json: {
      quote: {
        amountIn: body.amount,
        amountInUsd: "4.40",
        amountOut: over.amountOut ?? "4390000",
        amountOutUsd: over.amountOutUsd ?? "4.39",
        minAmountOut: "4346000",
        timeEstimate: 20,
      },
      quoteRequest: { ...body, appFees: [{ recipient: "x", fee: over.appFee ?? 20 }] },
      signature: "ed25519:test",
      timestamp: new Date().toISOString(),
    },
  };
}

// Distinct base URLs keep the module-level token cache from leaking between tests.
let n = 0;
const base = () => `https://1click.test${n++}`;

describe("checkIntentsQuote", () => {
  it("always requests a dry run and allows a fair, signed quote", async () => {
    const { fetchImpl, calls } = oneClick((b) => echoQuote(b));
    const r = await checkIntentsQuote(req, { fetchImpl, baseUrl: base(), verifySignature: () => true });
    expect(calls[0]?.dry).toBe(true);
    expect(r.verdict).toBe("ALLOW");
    expect(r.data?.lossPct).toBeLessThan(1);
  });

  it("verifies a real 1Click signature and rejects a tampered one", async () => {
    const ok = oneClick(() => ({ json: realQuote }));
    const r = await checkIntentsQuote({ ...req }, { fetchImpl: ok.fetchImpl, baseUrl: base() });
    expect(r.data?.signatureValid).toBe(true);
    // The deadline in the recorded request differs from ours, which is fine: only the
    // economic fields are compared. Now tamper with the output amount:
    const tampered = structuredClone(realQuote);
    tampered.quote.amountOut = "9999999";
    const bad = oneClick(() => ({ json: tampered }));
    const r2 = await checkIntentsQuote(req, { fetchImpl: bad.fetchImpl, baseUrl: base() });
    expect(r2.flags.map((f) => f.code)).toContain("INVALID_QUOTE_SIGNATURE");
    expect(r2.verdict).toBe("BLOCK");
  });

  it("blocks a quote that changes the recipient", async () => {
    const { fetchImpl } = oneClick((b) => echoQuote({ ...b, recipient: "attacker.near" }));
    const r = await checkIntentsQuote(req, { fetchImpl, baseUrl: base(), verifySignature: () => true });
    expect(r.flags.map((f) => f.code)).toContain("QUOTE_MISMATCH");
    expect(r.verdict).toBe("BLOCK");
  });

  it("warns and blocks on value loss and price deviation", async () => {
    const warn = oneClick((b) => echoQuote(b, { amountOut: "4200000", amountOutUsd: "4.20" }));
    const r = await checkIntentsQuote(req, { fetchImpl: warn.fetchImpl, baseUrl: base(), verifySignature: () => true });
    expect(r.verdict).toBe("WARN");
    expect(r.flags.map((f) => f.code)).toContain("HIGH_LOSS");

    const block = oneClick((b) => echoQuote(b, { amountOut: "2000000", amountOutUsd: "2.00" }));
    const r2 = await checkIntentsQuote(req, { fetchImpl: block.fetchImpl, baseUrl: base(), verifySignature: () => true });
    expect(r2.verdict).toBe("BLOCK");
    expect(r2.flags.map((f) => f.code)).toEqual(expect.arrayContaining(["HIGH_LOSS", "PRICE_DEVIATION"]));
  });

  it("flags excessive slippage and fees", async () => {
    const { fetchImpl } = oneClick((b) => echoQuote(b, { appFee: 300 }));
    const r = await checkIntentsQuote({ ...req, slippageBps: 300 }, { fetchImpl, baseUrl: base(), verifySignature: () => true });
    expect(r.flags.map((f) => f.code)).toEqual(expect.arrayContaining(["SLIPPAGE_TOO_HIGH", "FEES_TOO_HIGH"]));
    const r2 = await checkIntentsQuote({ ...req, slippageBps: 5000 }, { fetchImpl, baseUrl: base(), verifySignature: () => true });
    expect(r2.verdict).toBe("BLOCK");
  });

  it("blocks unsupported assets and warns when 1Click refuses to quote", async () => {
    const { fetchImpl } = oneClick(() => ({ status: 400, json: { message: "recipient is not valid" } }));
    const r = await checkIntentsQuote({ ...req, destinationAsset: "nep141:scam.near" }, { fetchImpl, baseUrl: base() });
    expect(r.flags.map((f) => f.code)).toContain("UNSUPPORTED_ASSET");
    expect(r.verdict).toBe("BLOCK");
    const r2 = await checkIntentsQuote(req, { fetchImpl, baseUrl: base() });
    expect(r2.flags[0]?.code).toBe("QUOTE_UNAVAILABLE");
    expect(r2.verdict).toBe("WARN");
  });

  it("rejects non-dry quotes that carry a deposit address", async () => {
    const { fetchImpl } = oneClick((b) => {
      const q = echoQuote(b);
      (q.json.quote as Record<string, unknown>).depositAddress = "deposit.near";
      return q;
    });
    const r = await checkIntentsQuote(req, { fetchImpl, baseUrl: base(), verifySignature: () => true });
    expect(r.flags.map((f) => f.code)).toContain("NOT_A_DRY_RUN");
  });
});
