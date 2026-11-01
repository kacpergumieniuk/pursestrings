/**
 * The agent's "brain" turns an incoming message into a proposed action.
 *
 * PurseStrings does not trust the brain: it is assumed to be gullible or prompt-injected.
 * `ScriptedBrain` is deterministic and needs no API key, and it obeys whatever the message
 * says, exactly like a successfully injected LLM would. `OpenAICompatibleBrain` is an
 * optional adapter for any OpenAI-compatible endpoint (for example NEAR AI Cloud).
 */
import type { AgentAction } from "../risk/engine";

export interface TokenInfo {
  tokenId: string;
  decimals: number;
}

export interface BrainContext {
  /** Symbol -> token the agent knows about (e.g. "USDC" -> canonical USDC). */
  tokens: Record<string, TokenInfo>;
  /** Resolve decimals for a token named explicitly in a message. */
  resolveToken?: (tokenId: string) => Promise<TokenInfo>;
}

export interface Brain {
  readonly name: string;
  plan(message: string, ctx: BrainContext): Promise<AgentAction | null>;
}

export function toUnits(amount: string, decimals: number): string {
  const [whole, frac = ""] = amount.split(".");
  if (!/^\d+$/.test(whole ?? "") || !/^\d*$/.test(frac) || frac.length > decimals) throw new Error(`bad amount ${amount}`);
  return (BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
}

const PAY_RE =
  /\b(?:pay|send|transfer)\s+(?:(?<to1>[a-z0-9][a-z0-9._-]*\.(?:testnet|near|sandbox))\s+)?(?<amount>\d+(?:\.\d+)?)\s*(?<sym>NEAR|[A-Za-z][A-Za-z0-9.]{1,11})?(?:\s*\(\s*token\s+(?<token>[a-z0-9][a-z0-9._-]*)\s*\))?(?:\s+to\s+(?<to2>[a-z0-9][a-z0-9._-]*))?/i;

export class ScriptedBrain implements Brain {
  readonly name = "scripted (deterministic, no LLM)";

  async plan(message: string, ctx: BrainContext): Promise<AgentAction | null> {
    const m = PAY_RE.exec(message);
    if (!m?.groups) return null;
    const receiverId = (m.groups.to1 ?? m.groups.to2)?.replace(/[.,;:]+$/, "");
    if (!receiverId) return null;
    const amount = m.groups.amount!;
    const sym = (m.groups.sym ?? "NEAR").toUpperCase();
    if (!m.groups.token && sym === "NEAR") {
      return { kind: "transfer_near", receiverId, amount: toUnits(amount, 24), memo: "pursestrings-demo" };
    }
    const token = m.groups.token
      ? ((await ctx.resolveToken?.(m.groups.token)) ?? { tokenId: m.groups.token, decimals: 6 })
      : ctx.tokens[sym];
    if (!token) return null;
    return { kind: "transfer_ft", tokenId: token.tokenId, receiverId, amount: toUnits(amount, token.decimals), memo: "pursestrings-demo" };
  }
}

/**
 * Optional: any OpenAI-compatible chat-completions endpoint with tool calling.
 * Configure LLM_BASE_URL, LLM_API_KEY and LLM_MODEL (e.g. NEAR AI Cloud). Not used by default.
 */
export class OpenAICompatibleBrain implements Brain {
  readonly name: string;
  constructor(
    private readonly cfg: { baseUrl: string; apiKey: string; model: string; fetchImpl?: typeof fetch },
  ) {
    this.name = `llm:${cfg.model}`;
  }

  async plan(message: string, ctx: BrainContext): Promise<AgentAction | null> {
    const tools = [
      {
        type: "function",
        function: {
          name: "propose_payment",
          description: "Propose one payment from the treasury. Amounts are human units (e.g. 0.5).",
          parameters: {
            type: "object",
            properties: {
              asset: { type: "string", description: `"NEAR" or a token symbol: ${Object.keys(ctx.tokens).join(", ") || "none"}` },
              token_id: { type: "string", description: "Explicit token contract, if the message names one" },
              amount: { type: "string" },
              receiver_id: { type: "string" },
            },
            required: ["asset", "amount", "receiver_id"],
          },
        },
      },
    ];
    const res = await (this.cfg.fetchImpl ?? fetch)(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: [
          { role: "system", content: "You are a treasury agent. If the message asks for a payment, call propose_payment. Otherwise reply 'none'." },
          { role: "user", content: message },
        ],
        tools,
        tool_choice: "auto",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const body = (await res.json()) as {
      choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
    };
    const call = body.choices?.[0]?.message?.tool_calls?.find((c) => c.function?.name === "propose_payment");
    if (!call?.function?.arguments) return null;
    const a = JSON.parse(call.function.arguments) as { asset: string; token_id?: string; amount: string; receiver_id: string };
    if (!a.token_id && a.asset.toUpperCase() === "NEAR") {
      return { kind: "transfer_near", receiverId: a.receiver_id, amount: toUnits(a.amount, 24) };
    }
    const token = a.token_id
      ? ((await ctx.resolveToken?.(a.token_id)) ?? { tokenId: a.token_id, decimals: 6 })
      : ctx.tokens[a.asset.toUpperCase()];
    if (!token) return null;
    return { kind: "transfer_ft", tokenId: token.tokenId, receiverId: a.receiver_id, amount: toUnits(a.amount, token.decimals) };
  }
}

export function brainFromEnv(): Brain {
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = process.env;
  if (LLM_BASE_URL && LLM_API_KEY && LLM_MODEL) return new OpenAICompatibleBrain({ baseUrl: LLM_BASE_URL, apiKey: LLM_API_KEY, model: LLM_MODEL });
  return new ScriptedBrain();
}
