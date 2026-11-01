/**
 * The real grammY wiring, driven by fake Telegram updates. A grammY transformer stands in for
 * the Telegram Bot API: it records every call and returns canned results, so no token or network
 * is used.
 */
import { describe, expect, it } from "vitest";
import { GuardBot, MemoryOwnerControl } from "../src/telegram";
import { createTelegramBot } from "../src/telegram/grammy";
import { makeChecker } from "./telegram-fixtures";

const OWNER = 1001;
const botInfo = {
  id: 42,
  is_bot: true as const,
  first_name: "PurseStrings",
  username: "GuardTestBot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

function fakeTelegram() {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  let nextMessageId = 500;
  const transformer = async (_prev: unknown, method: string, payload: unknown) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: p });
    if (method === "sendMessage") {
      return { ok: true, result: { message_id: ++nextMessageId, date: 0, chat: { id: p.chat_id, type: "private" }, text: p.text } };
    }
    return { ok: true, result: true };
  };
  return { calls, transformer };
}

let updateId = 1;
const message = (chat: { id: number; type: string; title?: string }, fromId: number, text: string) => ({
  update_id: updateId++,
  message: {
    message_id: updateId,
    date: 0,
    chat,
    from: { id: fromId, is_bot: false, first_name: "u" },
    text,
    ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}),
  },
});
const callback = (fromId: number, messageId: number, data: string) => ({
  update_id: updateId++,
  callback_query: {
    id: `cb${updateId}`,
    chat_instance: "x",
    from: { id: fromId, is_bot: false, first_name: "u" },
    message: { message_id: messageId, date: 0, chat: { id: fromId, type: "private" } },
    data,
  },
});

async function setup() {
  const tg = fakeTelegram();
  const vault = new MemoryOwnerControl("vault.owner.testnet", { agents: [] }, "testnet");
  vault.add({ id: "3", receiver_id: "vendor.owner.testnet" });
  let guard: GuardBot | undefined;
  const { bot, ready } = createTelegramBot("000:fake-token-not-used", (chat, username) => {
    guard = new GuardBot({ chat, checker: makeChecker(["vendor.owner.testnet"]), owner: vault, ownerUserIds: [OWNER], botUsername: username });
    return guard;
  }, { botInfo });
  bot.api.config.use(tg.transformer as never);
  await ready;
  return { tg, vault, bot, guard: guard! };
}

describe("Telegram transport (grammY + fake Bot API)", () => {
  it("replies to /check in a group with a plain-text verdict", async () => {
    const { tg, bot } = await setup();
    await bot.handleUpdate(message({ id: -100, type: "supergroup", title: "NEAR builders" }, 7, "/check@GuardTestBot wrap-near.near") as never);
    const send = tg.calls.find((c) => c.method === "sendMessage")!;
    expect(send.payload.chat_id).toBe(-100);
    expect(String(send.payload.text)).toMatch(/^🔴 BLOCK: account wrap-near\.near/);
    expect(send.payload.parse_mode).toBeUndefined();
  });

  it("sends approval requests with an inline keyboard and approves on a button tap", async () => {
    const { tg, bot, guard, vault } = await setup();
    await guard.syncPending();
    const send = tg.calls.find((c) => c.method === "sendMessage")!;
    expect(send.payload.chat_id).toBe(OWNER);
    expect(send.payload.reply_markup).toEqual({
      inline_keyboard: [[{ text: "✅ Approve", callback_data: "approve:3" }, { text: "❌ Reject", callback_data: "reject:3" }]],
    });
    await bot.handleUpdate(callback(OWNER, 501, "approve:3") as never);
    expect(vault.calls).toEqual(["approve:3"]);
    const methods = tg.calls.map((c) => c.method);
    expect(methods).toContain("answerCallbackQuery");
    const lastEdit = tg.calls.filter((c) => c.method === "editMessageText").pop()!;
    expect(lastEdit.payload).toMatchObject({ chat_id: OWNER, message_id: 501, reply_markup: { inline_keyboard: [] } });
    expect(String(lastEdit.payload.text)).toContain("✅ Approved by the owner");
  });

  it("does not let another user approve through the button", async () => {
    const { tg, bot, vault } = await setup();
    await bot.handleUpdate(callback(999, 501, "approve:3") as never);
    expect(vault.calls).toEqual([]);
    const ans = tg.calls.find((c) => c.method === "answerCallbackQuery")!;
    expect(ans.payload.text).toBe("Only the vault owner can do this.");
  });
});
