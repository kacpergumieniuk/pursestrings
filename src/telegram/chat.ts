/**
 * The minimal chat surface Guard's bot needs. Telegram (grammY), the terminal console and the
 * unit tests each implement `ChatApi`, so every handler runs the same way with or without a token.
 * Messages are plain text (no parse mode), so user input can never inject markup.
 */

export type ChatType = "private" | "group" | "supergroup" | "channel";

export interface Button {
  text: string;
  /** Callback payload, at most 64 bytes (Telegram limit). */
  data: string;
}

export interface OutgoingMessage {
  text: string;
  /** Inline keyboard rows. An empty array or `undefined` removes any keyboard on edit. */
  buttons?: Button[][];
}

export interface ChatApi {
  /** Sends a message and returns its id. */
  send(chatId: number, msg: OutgoingMessage): Promise<number>;
  edit(chatId: number, messageId: number, msg: OutgoingMessage): Promise<void>;
  /** Acknowledges a button press (Telegram shows `text` as a small toast). */
  answerCallback(callbackId: string, text?: string): Promise<void>;
}

export interface IncomingMessage {
  chatId: number;
  chatType: ChatType;
  userId: number;
  userName?: string;
  text: string;
}

export interface IncomingCallback {
  callbackId: string;
  chatId: number;
  chatType: ChatType;
  messageId: number;
  userId: number;
  data: string;
}

/** Splits `/cmd@BotName arg1 arg2` into `{ command: "cmd", args: "arg1 arg2" }`. */
export function parseCommand(text: string, botUsername?: string): { command: string; args: string } | undefined {
  const m = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return undefined;
  const [, command, target, args] = m;
  // In groups, `/check@OtherBot` is addressed to another bot.
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return undefined;
  return { command: command!.toLowerCase(), args: (args ?? "").trim() };
}
