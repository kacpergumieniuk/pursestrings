/**
 * RiskEngine: one call per agent action, returns ALLOW / WARN / BLOCK with reasons.
 *
 *   transfer_near  -> counterparty
 *   transfer_ft    -> nep141_token + counterparty
 *   swap           -> intents_quote (dry run) + destination token (NEP-141 or EVM via the Base API)
 *   open_link      -> url
 * plus `context` on the message that triggered the action, when provided.
 */
import { checkContext } from "./context";
import { checkCounterparty } from "./counterparty";
import { checkEvmToken, type EvmVerdictOptions, parseBridgedEvmAsset } from "./evm";
import { checkIntentsQuote, fetchOneClickTokens, type IntentsOptions, nearListings, type SwapRequest } from "./intents";
import type { NearDataSource } from "./near-data";
import { ScamList } from "./scam-list";
import { checkToken, type TokenThresholds } from "./token";
import { type CheckResult, maxVerdict, type Verdict } from "./types";
import { checkUrl } from "./url";

export type AgentAction =
  | { kind: "transfer_near"; receiverId: string; amount: string; memo?: string }
  | { kind: "transfer_ft"; tokenId: string; receiverId: string; amount: string; memo?: string }
  | ({ kind: "swap" } & SwapRequest)
  | { kind: "open_link"; url: string };

export interface Assessment {
  action: AgentAction;
  verdict: Verdict;
  reasons: string[];
  checks: CheckResult[];
  at: string;
}

export interface RiskEngineOptions {
  data: NearDataSource;
  scamList?: ScamList;
  trustedTokens?: string[];
  trustedAccounts?: string[];
  priorPayees?: Set<string>;
  intents?: IntentsOptions;
  evm?: EvmVerdictOptions;
  tokenThresholds?: Partial<TokenThresholds>;
  /** Look up NEAR Intents listings to enrich token checks (network call). Default: mainnet only. */
  useIntentsListings?: boolean;
  now?: () => number;
}

export class RiskEngine {
  readonly scamList: ScamList;
  constructor(private readonly opts: RiskEngineOptions) {
    this.scamList = opts.scamList ?? new ScamList();
  }

  private async listings() {
    const use = this.opts.useIntentsListings ?? this.opts.data.network === "mainnet";
    if (!use) return undefined;
    try {
      return nearListings(await fetchOneClickTokens(this.opts.intents));
    } catch {
      return undefined;
    }
  }

  async checkToken(tokenId: string): Promise<CheckResult> {
    return checkToken(tokenId, {
      data: this.opts.data,
      scamList: this.scamList,
      trustedTokens: this.opts.trustedTokens,
      intentsListed: await this.listings(),
      thresholds: this.opts.tokenThresholds,
      now: this.opts.now?.(),
    });
  }

  async checkReceiver(receiverId: string): Promise<CheckResult> {
    return checkCounterparty(receiverId, {
      data: this.opts.data,
      scamList: this.scamList,
      trustedAccounts: this.opts.trustedAccounts,
      priorPayees: this.opts.priorPayees,
      now: this.opts.now?.(),
    });
  }

  async assess(action: AgentAction, context?: { sourceText?: string }): Promise<Assessment> {
    const checks: CheckResult[] = [];
    if (context?.sourceText) checks.push(checkContext(context.sourceText, { scamList: this.scamList }));

    switch (action.kind) {
      case "transfer_near":
        checks.push(await this.checkReceiver(action.receiverId));
        break;
      case "transfer_ft":
        checks.push(await this.checkToken(action.tokenId));
        checks.push(await this.checkReceiver(action.receiverId));
        break;
      case "swap": {
        checks.push(await checkIntentsQuote(action, this.opts.intents));
        const evm = parseBridgedEvmAsset(action.destinationAsset);
        if (evm) {
          checks.push(await checkEvmToken(evm.chain, evm.address, this.opts.evm));
        } else if (action.destinationAsset.startsWith("nep141:") && this.opts.data.network === "mainnet") {
          const contract = action.destinationAsset.slice("nep141:".length);
          if (!/\.(omft|omdep)\.near$/.test(contract)) checks.push(await this.checkToken(contract));
        }
        break;
      }
      case "open_link":
        checks.push(checkUrl(action.url, { scamList: this.scamList }));
        break;
    }

    const verdict = maxVerdict(checks.map((c) => c.verdict));
    const reasons = checks
      .filter((c) => c.verdict !== "ALLOW")
      .flatMap((c) => c.reasons.map((r) => `[${c.check}] ${r}`));
    if (reasons.length === 0) reasons.push("all checks passed");
    return { action, verdict, reasons, checks, at: new Date(this.opts.now?.() ?? Date.now()).toISOString() };
  }
}
