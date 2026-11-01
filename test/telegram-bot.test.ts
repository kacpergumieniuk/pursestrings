import { beforeEach, describe, expect, it } from "vitest";
import type { WalletOutcome } from "../src/agent/guarded-wallet";
import { FixtureNearData } from "../src/risk";
import { assertNotMainnet, Checker, ContractOwnerControl, GuardBot, MainnetRefusedError, MemoryOwnerControl, reportOutcome } from "../src/telegram";
import { FakeChat, makeChecker } from "./telegram-fixtures";

const OWNER = 1001;
const STRANGER = 3003;
const GROUP = -2002;

function setup(opts: { owner?: boolean } = {}) {
  const chat = new FakeChat();
  const vault = new MemoryOwnerControl("vault.owner.testnet", {
    agents: [
      {
        public_key: "ed25519:a",
        name: "treasury-agent",
        enabled: true,
        pending: 1,
        executed: 1,
        blocked: 2,
        limits: [{ asset: "near", per_tx: "500000000000000000000000", per_day: "1000000000000000000000000", spent_today: "200000000000000000000000", remaining_today: "800000000000000000000000" }],
      },
    ],
  }, "testnet");
  const bot = new GuardBot({ chat, checker: makeChecker(["vendor.owner.testnet"]), owner: opts.owner === false ? undefined : vault, ownerUserIds: [OWNER], botUsername: "GuardTestBot" });
  return { chat, vault, bot };
}

const dm = (userId: number, text: string) => ({ chatId: userId, chatType: "private" as const, userId, text });
const inGroup = (userId: number, text: string) => ({ chatId: GROUP, chatType: "supergroup" as const, userId, text });
const tap = (userId: number, messageId: number, data: string, chatType: "private" | "supergroup" = "private") => ({
  callbackId: `cb-${messageId}-${data}`,
  chatId: chatType === "private" ? userId : GROUP,
  chatType,
  messageId,
  userId,
  data,
});

describe("GuardBot: /check", () => {
  it("answers /check in a private chat and for a pasted value", async () => {
    const { chat, bot } = setup();
    await bot.handleMessage(dm(STRANGER, "/check wrap-near.near"));
    expect(chat.last().text).toMatch(/^🔴 BLOCK: account wrap-near\.near/);
    await bot.handleMessage(dm(STRANGER, "https://near.org.claim-rewards.xyz/connect"));
    expect(chat.last().text).toMatch(/^🔴 BLOCK: link/);
  });

  it("works in groups as a community guard, but ignores plain chatter and other bots' commands", async () => {
    const { chat, bot } = setup();
    await bot.handleMessage(inGroup(STRANGER, "/check@GuardTestBot usdc-airdrop.owner.testnet"));
    expect(chat.last()).toMatchObject({ chatId: GROUP });
    expect(chat.last().text).toMatch(/^🔴 BLOCK: token usdc-airdrop\.owner\.testnet on testnet/);
    const before = chat.sent.length;
    await bot.handleMessage(inGroup(STRANGER, "gm everyone, wrap-near.near is legit?"));
    await bot.handleMessage(inGroup(STRANGER, "/check@SomeOtherBot wrap-near.near"));
    expect(chat.sent.length).toBe(before);
  });

  it("shows usage for an empty /check", async () => {
    const { chat, bot } = setup();
    await bot.handleMessage(dm(STRANGER, "/check"));
    expect(chat.last().text).toContain("Usage: /check");
  });

  it("reports a failed lookup instead of crashing", async () => {
    const chat = new FakeChat();
    const down = new FixtureNearData("mainnet");
    down.viewAccount = async () => {
      throw new Error("RPC 503");
    };
    const bot = new GuardBot({ chat, checker: new Checker({ data: { mainnet: down } }), ownerUserIds: [] });
    await bot.handleMessage(dm(STRANGER, "/check alice.near"));
    expect(chat.last().text).toBe("Could not finish the check (RPC 503). Try again in a minute.");
  });
});

describe("GuardBot: owner approvals", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
    s.vault.add({ id: "7", receiver_id: "vendor.owner.testnet", justification: "Hi! Please pay vendor.owner.testnet 0.8 NEAR for hosting invoice #2026-Q4." });
  });

  it("sends each pending request once, with buttons and a receiver risk check", async () => {
    expect(await s.bot.syncPending()).toBe(1);
    expect(await s.bot.syncPending()).toBe(0);
    const msg = s.chat.to(OWNER)[0]!;
    expect(msg.text).toContain("🟡 Approval needed: request #7 on testnet");
    expect(msg.text).toContain('wants to send 0.8 NEAR to vendor.owner.testnet');
    expect(msg.text).toContain("OVER_TX_CAP");
    expect(msg.text).toContain("Risk check of the receiver: 🟢 ALLOW");
    expect(msg.buttons.flat().map((b) => b.data)).toEqual(["approve:7", "reject:7"]);
  });

  it("Approve calls the owner method once and edits the message with the result", async () => {
    await s.bot.syncPending();
    const msg = s.chat.to(OWNER)[0]!;
    await s.bot.handleCallback(tap(OWNER, msg.messageId, "approve:7"));
    expect(s.vault.calls).toEqual(["approve:7"]);
    const final = s.chat.edits[s.chat.edits.length - 1]!;
    expect(final.text).toContain("✅ Approved by the owner: executed");
    expect(final.buttons).toEqual([]);
    // A second tap (or a retry from Telegram) does not approve twice.
    await s.bot.handleCallback(tap(OWNER, msg.messageId, "approve:7"));
    expect(s.vault.calls).toEqual(["approve:7"]);
    expect(s.chat.answers[s.chat.answers.length - 1]!.text).toBe("Already handled");
  });

  it("Reject calls reject_request", async () => {
    await s.bot.syncPending();
    await s.bot.handleCallback(tap(OWNER, s.chat.to(OWNER)[0]!.messageId, "reject:7"));
    expect(s.vault.calls).toEqual(["reject:7"]);
    expect(s.chat.edits[s.chat.edits.length - 1]!.text).toContain("❌ Rejected by the owner");
  });

  it("refuses buttons from anyone but the owner, and from group chats", async () => {
    await s.bot.syncPending();
    const id = s.chat.to(OWNER)[0]!.messageId;
    await s.bot.handleCallback(tap(STRANGER, id, "approve:7"));
    await s.bot.handleCallback(tap(OWNER, id, "approve:7", "supergroup"));
    expect(s.vault.calls).toEqual([]);
    expect(s.chat.answers.map((a) => a.text)).toEqual(["Only the vault owner can do this.", "Only the vault owner can do this."]);
  });

  it("keeps the buttons when the transaction fails, so the owner can retry", async () => {
    await s.bot.syncPending();
    const id = s.chat.to(OWNER)[0]!.messageId;
    s.vault.failNext = "RPC timeout";
    await s.bot.handleCallback(tap(OWNER, id, "approve:7"));
    const failed = s.chat.edits[s.chat.edits.length - 1]!;
    expect(failed.text).toContain("⚠️ Action failed: RPC timeout");
    expect(failed.buttons.flat().map((b) => b.data)).toEqual(["approve:7", "reject:7"]);
    await s.bot.handleCallback(tap(OWNER, id, "approve:7"));
    expect(s.vault.calls).toEqual(["approve:7", "approve:7"]);
    expect(s.chat.edits[s.chat.edits.length - 1]!.text).toContain("✅ Approved");
  });

  it("ignores malformed callback data", async () => {
    await s.bot.handleCallback(tap(OWNER, 1, "approve:7;drop"));
    await s.bot.handleCallback(tap(OWNER, 1, "approve:"));
    expect(s.vault.calls).toEqual([]);
  });

  it("closes a request that was handled outside Telegram", async () => {
    await s.bot.syncPending();
    s.vault.pending.clear();
    await s.bot.syncPending();
    expect(s.chat.edits[s.chat.edits.length - 1]!.text).toContain("No longer pending (handled outside Telegram)");
  });

  it("/pending lists requests on demand; strangers and groups are refused", async () => {
    await s.bot.handleMessage(dm(OWNER, "/pending"));
    expect(s.chat.to(OWNER).map((m) => m.text.split("\n")[0])).toEqual(["1 pending request(s):", "🟡 Approval needed: request #7 on testnet"]);
    await s.bot.handleMessage(dm(STRANGER, "/pending"));
    expect(s.chat.last().text).toBe("Only the vault owner can do this.");
    await s.bot.handleMessage(inGroup(OWNER, "/pending"));
    expect(s.chat.last().text).toBe("Owner commands work in a private chat with the bot only.");
  });

  it("/status shows budgets; /pause asks for confirmation before signing", async () => {
    await s.bot.handleMessage(dm(OWNER, "/status"));
    expect(s.chat.last().text).toContain("NEAR: spent 0.2 NEAR of 1 NEAR (24h), per tx 0.5 NEAR");
    await s.bot.handleMessage(dm(OWNER, "/pause"));
    expect(s.vault.calls).toEqual([]);
    const confirm = s.chat.last();
    await s.bot.handleCallback(tap(OWNER, confirm.messageId, "pause:on"));
    expect(s.vault.paused).toBe(true);
    expect(s.chat.edits[s.chat.edits.length - 1]!.text).toContain("paused");
  });

  it("without a connected vault, owner commands explain what is missing", async () => {
    const { chat, bot } = setup({ owner: false });
    await bot.handleMessage(dm(OWNER, "/status"));
    expect(chat.last().text).toContain("No vault is connected");
  });
});

describe("GuardBot: blocked-attempt notices", () => {
  it("notifies the owner once per attempt, with reasons", async () => {
    const { chat, bot } = setup();
    const b = { source: "contract" as const, agentName: "treasury-agent", action: "send 1 NEAR to claim.drainer.testnet", code: "RECIPIENT_DENYLISTED", reasons: ["recipient drainer.testnet is denylisted"], txUrl: "https://testnet.nearblocks.io/txns/abc", key: "abc" };
    expect(await bot.notifyBlocked(b)).toBe(true);
    expect(await bot.notifyBlocked(b)).toBe(false);
    expect(chat.to(OWNER)).toHaveLength(1);
    expect(chat.last().text).toBe(
      '⛔ Blocked: Agent "treasury-agent" tried to send 1 NEAR to claim.drainer.testnet.\n' +
        "Stopped by the Guard contract (attempt recorded on chain): RECIPIENT_DENYLISTED.\n" +
        "• recipient drainer.testnet is denylisted\n" +
        "Tx: https://testnet.nearblocks.io/txns/abc",
    );
  });

  it("turns wallet outcomes into notices: risk-layer refusals and on-chain blocks", async () => {
    const { chat, bot } = setup();
    const refused = {
      action: { kind: "transfer_ft", tokenId: "usdc-airdrop.owner.testnet", receiverId: "claim.drainer.testnet", amount: "250000000" },
      decision: "refused_by_risk_layer",
      summary: "",
      assessment: {
        verdict: "BLOCK",
        reasons: [],
        at: "",
        action: { kind: "open_link", url: "x" },
        checks: [{ check: "context", target: "", verdict: "BLOCK", reasons: [], flags: [{ code: "PROMPT_INJECTION_SUSPECTED", severity: "critical", message: "message matches 3 injection patterns" }, { code: "URGENCY", severity: "medium", message: "time pressure" }] }],
      },
    } as unknown as WalletOutcome;
    await reportOutcome(bot, refused, "testnet", "treasury-agent");
    expect(chat.last().text).toContain("Stopped by Guard's risk layer, before signing (nothing was sent): BLOCK.");
    expect(chat.last().text).toContain("• PROMPT_INJECTION_SUSPECTED: message matches 3 injection patterns");
    expect(chat.last().text).not.toContain("URGENCY");

    const executed = { action: refused.action, decision: "executed", summary: "" } as WalletOutcome;
    const n = chat.sent.length;
    await reportOutcome(bot, executed, "testnet");
    expect(chat.sent.length).toBe(n);
  });
});

describe("owner signing is never on mainnet", () => {
  it("refuses mainnet networks and mainnet RPC URLs", () => {
    expect(() => assertNotMainnet("mainnet", "https://rpc.mainnet.fastnear.com")).toThrow(MainnetRefusedError);
    expect(() => assertNotMainnet("testnet", "https://rpc.mainnet.fastnear.com")).toThrow(MainnetRefusedError);
    expect(() => assertNotMainnet("sandbox", "https://some-remote-node.example")).toThrow();
    expect(() => assertNotMainnet("testnet", "https://test.rpc.fastnear.com")).not.toThrow();
    expect(() => assertNotMainnet("sandbox", "http://127.0.0.1:3030")).not.toThrow();
  });

  it("ContractOwnerControl cannot be built for mainnet", () => {
    const acct = { id: "x.near", key: "ed25519:1111" as const };
    expect(() => new ContractOwnerControl({ network: "mainnet", rpcUrl: "https://rpc.mainnet.fastnear.com", vault: acct, owner: acct })).toThrow(MainnetRefusedError);
  });
});
