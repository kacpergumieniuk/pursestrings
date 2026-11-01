/**
 * Telegram transport (grammY). The only Telegram-specific file: it maps updates to
 * GuardBot handlers and implements ChatApi with the Bot API. Tests drive it with a fake
 * Telegram API (a grammY transformer) and `bot.handleUpdate`, so no token or network is needed.
 */
import { Bot, type Context, InlineKeyboard } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { ChatApi, ChatType, OutgoingMessage } from "./chat";

function keyboard(buttons: OutgoingMessage["buttons"]): InlineKeyboard | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  const kb = new InlineKeyboard();
  buttons.forEach((row, i) => {
    for (const b of row) kb.text(b.text, b.data);
    if (i < buttons.length - 1) kb.row();
  });
  return kb;
}

export class GrammyChatApi implements ChatApi {
  constructor(private readonly bot: Bot) {}

  async send(chatId: number, msg: OutgoingMessage): Promise<number> {
    const m = await this.bot.api.sendMessage(chatId, msg.text, {
      reply_markup: keyboard(msg.buttons),
      link_preview_options: { is_disabled: true },
    });
    return m.message_id;
  }

  async edit(chatId: number, messageId: number, msg: OutgoingMessage): Promise<void> {
    try {
      await this.bot.api.editMessageText(chatId, messageId, msg.text, {
        reply_markup: keyboard(msg.buttons) ?? { inline_keyboard: [] },
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      // Editing to identical content is harmless.
      if (!/message is not modified/i.test((e as Error).message)) throw e;
    }
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.bot.api.answerCallbackQuery(callbackId, text ? { text } : {});
  }
}

export interface GuardHandlers {
  handleMessage(m: { chatId: number; chatType: ChatType; userId: number; userName?: string; text: string }): Promise<void>;
  handleCallback(cb: { callbackId: string; chatId: number; chatType: ChatType; messageId: number; userId: number; data: string }): Promise<void>;
}

/**
 * Creates the grammY bot and wires it to `makeHandlers(chat, botUsername)`.
 * Pass `botInfo` to skip the `getMe` call (tests, or faster startup).
 */
export function createTelegramBot(
  token: string,
  makeHandlers: (chat: ChatApi, botUsername: string) => GuardHandlers,
  opts: { botInfo?: UserFromGetMe; log?: (m: string) => void } = {},
): { bot: Bot; ready: Promise<GuardHandlers> } {
  const bot = new Bot(token, opts.botInfo ? { botInfo: opts.botInfo } : {});
  const chat = new GrammyChatApi(bot);
  let handlers: GuardHandlers | undefined;
  const ready = (async () => {
    await bot.init();
    handlers = makeHandlers(chat, bot.botInfo.username);
    return handlers;
  })();

  const guard = async (ctx: Context, fn: (h: GuardHandlers) => Promise<void>) => {
    const h = handlers ?? (await ready);
    try {
      await fn(h);
    } catch (e) {
      opts.log?.(`handler error on update ${ctx.update.update_id}: ${(e as Error).message}`);
    }
  };

  bot.on("message:text", (ctx) =>
    guard(ctx, (h) =>
      h.handleMessage({
        chatId: ctx.chat.id,
        chatType: ctx.chat.type as ChatType,
        userId: ctx.from?.id ?? 0,
        userName: ctx.from?.username,
        text: ctx.message.text,
      }),
    ),
  );
  bot.on("callback_query:data", (ctx) =>
    guard(ctx, (h) =>
      h.handleCallback({
        callbackId: ctx.callbackQuery.id,
        chatId: ctx.chat?.id ?? ctx.from.id,
        chatType: (ctx.chat?.type ?? "private") as ChatType,
        messageId: ctx.callbackQuery.message?.message_id ?? 0,
        userId: ctx.from.id,
        data: ctx.callbackQuery.data,
      }),
    ),
  );
  bot.catch((err) => opts.log?.(`grammY error: ${err.message}`));
  return { bot, ready };
}

/** Bot commands shown in Telegram's menu. */
export const BOT_COMMANDS = [
  { command: "check", description: "Check an account, token, link or message: ALLOW / WARN / BLOCK" },
  { command: "pending", description: "Owner: approval requests" },
  { command: "status", description: "Owner: agent budgets and counters" },
  { command: "pause", description: "Owner: emergency stop" },
  { command: "unpause", description: "Owner: resume" },
  { command: "whoami", description: "Show your Telegram user id" },
  { command: "help", description: "How Guard works" },
];
