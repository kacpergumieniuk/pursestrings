/**
 * NEAR Intents 1Click quote sanity checks. Quotes are always requested with `dry: true`,
 * so nothing is executed and no deposit address is issued.
 *
 * Checks: requested slippage, quote signature (official SDK), that the quote echoes
 * exactly what we asked for (recipient, refund address, assets, amount), USD loss
 * between input and output, deviation from the 1Click token price list, fees.
 */
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { type CheckResult, type Flag, result } from "./types";

export const ONE_CLICK_URL = "https://1click.chaindefuser.com";

export interface SwapRequest {
  originAsset: string;
  destinationAsset: string;
  /** Smallest units of the origin asset. */
  amount: string;
  recipient: string;
  refundTo: string;
  slippageBps?: number;
  recipientType?: "DESTINATION_CHAIN" | "INTENTS";
  refundType?: "ORIGIN_CHAIN" | "INTENTS";
  depositType?: "ORIGIN_CHAIN" | "INTENTS";
}

export interface IntentsLimits {
  maxSlippageBps: number;
  warnLossPct: number;
  blockLossPct: number;
  maxPriceDeviationPct: number;
  maxFeeBps: number;
}

export const DEFAULT_INTENTS_LIMITS: IntentsLimits = {
  maxSlippageBps: 100,
  warnLossPct: 3,
  blockLossPct: 10,
  maxPriceDeviationPct: 5,
  maxFeeBps: 50,
};

export interface IntentsOptions {
  baseUrl?: string;
  jwt?: string;
  fetchImpl?: typeof fetch;
  limits?: Partial<IntentsLimits>;
  /** Override for tests. */
  verifySignature?: (quoteResponse: unknown) => boolean;
  now?: number;
}

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  contractAddress?: string | null;
}

interface QuoteResponse {
  quote?: {
    amountIn: string;
    amountInUsd?: string;
    amountOut: string;
    amountOutUsd?: string;
    minAmountOut?: string;
    timeEstimate?: number;
    depositAddress?: string;
  };
  quoteRequest?: Record<string, unknown> & { appFees?: Array<{ recipient: string; fee: number }> };
  signature?: string;
  timestamp?: string;
  message?: string;
}

let tokenCache: { at: number; url: string; tokens: OneClickToken[] } | undefined;

export async function fetchOneClickTokens(opts: IntentsOptions = {}): Promise<OneClickToken[]> {
  const base = opts.baseUrl ?? ONE_CLICK_URL;
  if (tokenCache && tokenCache.url === base && Date.now() - tokenCache.at < 60_000) return tokenCache.tokens;
  const res = await (opts.fetchImpl ?? fetch)(`${base}/v0/tokens`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`1Click /v0/tokens HTTP ${res.status}`);
  const tokens = (await res.json()) as OneClickToken[];
  tokenCache = { at: Date.now(), url: base, tokens };
  return tokens;
}

/** Map NEAR contract -> {symbol, price} for tokens listed on NEAR Intents. */
export function nearListings(tokens: OneClickToken[]): Map<string, { symbol: string; price: number }> {
  const m = new Map<string, { symbol: string; price: number }>();
  for (const t of tokens) {
    if (t.blockchain === "near" && t.contractAddress) m.set(t.contractAddress.toLowerCase(), { symbol: t.symbol, price: t.price });
  }
  return m;
}

function units(amount: string, decimals: number): number {
  return Number(BigInt(amount)) / 10 ** decimals;
}

export async function checkIntentsQuote(req: SwapRequest, opts: IntentsOptions = {}): Promise<CheckResult> {
  const lim = { ...DEFAULT_INTENTS_LIMITS, ...opts.limits };
  const base = opts.baseUrl ?? ONE_CLICK_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const target = `${req.originAsset} -> ${req.destinationAsset}`;
  const flags: Flag[] = [];
  const facts: Record<string, unknown> = {};
  const slippage = req.slippageBps ?? 100;

  if (slippage > lim.maxSlippageBps * 5) {
    flags.push({ code: "SLIPPAGE_EXTREME", severity: "critical", message: `slippage tolerance ${slippage / 100}% lets a solver keep most of the trade` });
  } else if (slippage > lim.maxSlippageBps) {
    flags.push({ code: "SLIPPAGE_TOO_HIGH", severity: "high", message: `slippage tolerance ${slippage / 100}% > policy ${lim.maxSlippageBps / 100}%` });
  }

  let tokens: OneClickToken[];
  try {
    tokens = await fetchOneClickTokens({ ...opts, baseUrl: base });
  } catch (e) {
    flags.push({ code: "TOKEN_LIST_UNAVAILABLE", severity: "high", message: (e as Error).message });
    return result("intents_quote", target, flags, facts);
  }
  const origin = tokens.find((t) => t.assetId === req.originAsset);
  const dest = tokens.find((t) => t.assetId === req.destinationAsset);
  if (!origin || !dest) {
    flags.push({
      code: "UNSUPPORTED_ASSET",
      severity: "critical",
      message: `${!origin ? req.originAsset : req.destinationAsset} is not in the 1Click token list`,
    });
    return result("intents_quote", target, flags, facts);
  }
  if (!dest.price) flags.push({ code: "NO_PRICE", severity: "high", message: `${dest.symbol} has no price on 1Click (illiquid or delisted)` });

  const deadline = new Date((opts.now ?? Date.now()) + 10 * 60_000).toISOString();
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: slippage,
    originAsset: req.originAsset,
    depositType: req.depositType ?? "ORIGIN_CHAIN",
    destinationAsset: req.destinationAsset,
    amount: req.amount,
    recipient: req.recipient,
    recipientType: req.recipientType ?? "DESTINATION_CHAIN",
    refundTo: req.refundTo,
    refundType: req.refundType ?? "ORIGIN_CHAIN",
    deadline,
  };
  let q: QuoteResponse;
  try {
    const res = await fetchImpl(`${base}/v0/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.jwt ? { authorization: `Bearer ${opts.jwt}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    q = (await res.json()) as QuoteResponse;
    if (!res.ok || !q.quote) {
      flags.push({
        code: "QUOTE_UNAVAILABLE",
        severity: "high",
        message: `1Click refused the dry-run quote (HTTP ${res.status}${q.message ? `: ${q.message}` : ""}); check the recipient and assets`,
      });
      return result("intents_quote", target, flags, facts);
    }
  } catch (e) {
    flags.push({ code: "QUOTE_UNAVAILABLE", severity: "high", message: `1Click quote failed: ${(e as Error).message}` });
    return result("intents_quote", target, flags, facts);
  }

  const verify = opts.verifySignature ?? ((r: unknown) => verifyQuoteSignature(r as never));
  let sigOk = false;
  try {
    sigOk = verify(q);
  } catch {
    sigOk = false;
  }
  facts.signatureValid = sigOk;
  if (!sigOk) flags.push({ code: "INVALID_QUOTE_SIGNATURE", severity: "critical", message: "quote signature does not verify: payload was not produced by 1Click or was altered" });

  const echo = q.quoteRequest ?? {};
  const mismatches = (["originAsset", "destinationAsset", "amount", "recipient", "refundTo"] as const).filter(
    (k) => String(echo[k] ?? "") !== String(body[k]),
  );
  if (echo.dry !== true) mismatches.push("dry" as never);
  if (mismatches.length) {
    flags.push({ code: "QUOTE_MISMATCH", severity: "critical", message: `quote does not match the request: ${mismatches.join(", ")}` });
  }

  const quote = q.quote;
  const inUnits = units(quote.amountIn, origin.decimals);
  const outUnits = units(quote.amountOut, dest.decimals);
  const inUsd = Number(quote.amountInUsd ?? inUnits * origin.price);
  const outUsd = Number(quote.amountOutUsd ?? outUnits * dest.price);
  Object.assign(facts, {
    amountIn: `${inUnits} ${origin.symbol}`,
    amountOut: `${outUnits} ${dest.symbol}`,
    minAmountOut: quote.minAmountOut ? `${units(quote.minAmountOut, dest.decimals)} ${dest.symbol}` : undefined,
    amountInUsd: inUsd,
    amountOutUsd: outUsd,
    timeEstimateSec: quote.timeEstimate,
    dry: echo.dry,
  });

  if (inUsd > 0) {
    const lossPct = ((inUsd - outUsd) / inUsd) * 100;
    facts.lossPct = Number(lossPct.toFixed(3));
    if (lossPct >= lim.blockLossPct) {
      flags.push({ code: "HIGH_LOSS", severity: "critical", message: `you would lose ${lossPct.toFixed(1)}% in USD terms ($${inUsd.toFixed(2)} -> $${outUsd.toFixed(2)})` });
    } else if (lossPct >= lim.warnLossPct) {
      flags.push({ code: "HIGH_LOSS", severity: "high", message: `you would lose ${lossPct.toFixed(1)}% in USD terms` });
    }
  }

  if (origin.price > 0 && dest.price > 0) {
    const expectedOut = (inUnits * origin.price) / dest.price;
    const devPct = ((expectedOut - outUnits) / expectedOut) * 100;
    facts.priceDeviationPct = Number(devPct.toFixed(3));
    if (devPct > lim.maxPriceDeviationPct) {
      flags.push({
        code: "PRICE_DEVIATION",
        severity: "high",
        message: `quote pays ${devPct.toFixed(1)}% less than the 1Click reference prices imply`,
      });
    }
  }

  const feeBps = (echo.appFees ?? []).reduce((a, f) => a + Number(f.fee || 0), 0);
  facts.appFeeBps = feeBps;
  if (feeBps > lim.maxFeeBps) {
    flags.push({ code: "FEES_TOO_HIGH", severity: "high", message: `app fees total ${feeBps / 100}%` });
  } else if (feeBps > 0) {
    flags.push({ code: "APP_FEE", severity: "info", message: `app fee ${feeBps / 100}% (1Click charges unauthenticated quotes; see Q-006)` });
  }

  if (quote.depositAddress) {
    flags.push({ code: "NOT_A_DRY_RUN", severity: "critical", message: "quote carries a deposit address; PurseStrings only accepts dry-run quotes here" });
  }
  if ((quote.timeEstimate ?? 0) > 3600) {
    flags.push({ code: "SLOW_SETTLEMENT", severity: "low", message: `estimated ${Math.round((quote.timeEstimate ?? 0) / 60)} min to settle` });
  }
  return result("intents_quote", target, flags, facts);
}
