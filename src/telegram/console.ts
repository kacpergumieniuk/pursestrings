/**
 * ConsoleChat: a ChatApi that renders the conversation in the terminal, so the bot can be
 * demoed and tried without a Telegram token. Buttons are numbered; `press()` simulates a tap.
 */
import type { Button, ChatApi, OutgoingMessage } from "./chat";

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR || process.env.FORCE_COLOR === "1";
const paint = (code: string) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2");
const bold = paint("1");
const blue = paint("38;5;39");
const grey = paint("38;5;245");
const tgBlue = paint("1;38;5;39");

export interface ConsoleMessage {
  chatId: number;
  messageId: number;
  text: string;
  buttons: Button[][];
}

export interface ConsoleChatOptions {
  /** Display names per chat id, e.g. { 1001: "owner (private chat)", -2002: "NEAR builders (group)" }. */
  chatNames?: Record<number, string>;
  write?: (s: string) => void;
  width?: number;
  botName?: string;
}

export class ConsoleChat implements ChatApi {
  readonly messages = new Map<number, ConsoleMessage>();
  readonly callbacks: Array<{ callbackId: string; text?: string }> = [];
  private nextId = 1;
  private readonly write: (s: string) => void;
  private readonly width: number;

  constructor(private readonly opts: ConsoleChatOptions = {}) {
    this.write = opts.write ?? ((s) => process.stdout.write(s));
    this.width = opts.width ?? Math.min(process.stdout.columns || 90, 90);
  }

  private chatName(chatId: number) {
    return this.opts.chatNames?.[chatId] ?? `chat ${chatId}`;
  }

  private render(m: ConsoleMessage, label: string) {
    const inner = this.width - 4;
    const head = `${this.opts.botName ?? "Guard bot"} → ${this.chatName(m.chatId)}`;
    const lines: string[] = [];
    lines.push(`  ${tgBlue("╭─")} ${tgBlue(head)} ${dim(label)}`);
    for (const raw of m.text.split("\n")) {
      for (const l of wrap(raw, inner)) lines.push(`  ${tgBlue("│")} ${l}`);
    }
    if (m.buttons.length) {
      let n = 0;
      const row = m.buttons.map((r) => r.map((b) => bold(`[${++n}] ${b.text}`)).join("   ")).join("   ");
      lines.push(`  ${tgBlue("│")} ${row}`);
    }
    lines.push(`  ${tgBlue("╰─")}`);
    this.write(lines.join("\n") + "\n");
  }

  /** Prints what a user typed, as a chat bubble. */
  showUser(chatId: number, userName: string, text: string) {
    this.write(`  ${grey("╭─")} ${blue(userName)} ${grey("in " + this.chatName(chatId))}\n`);
    for (const l of text.split("\n")) for (const w of wrap(l, this.width - 4)) this.write(`  ${grey("│")} ${w}\n`);
    this.write(`  ${grey("╰─")}\n`);
  }

  async send(chatId: number, msg: OutgoingMessage): Promise<number> {
    const m: ConsoleMessage = { chatId, messageId: this.nextId++, text: msg.text, buttons: msg.buttons ?? [] };
    this.messages.set(m.messageId, m);
    this.render(m, `msg ${m.messageId}`);
    return m.messageId;
  }

  async edit(chatId: number, messageId: number, msg: OutgoingMessage): Promise<void> {
    const m: ConsoleMessage = { chatId, messageId, text: msg.text, buttons: msg.buttons ?? [] };
    this.messages.set(messageId, m);
    this.render(m, `msg ${messageId} (edited)`);
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    this.callbacks.push({ callbackId, text });
    if (text) this.write(`  ${dim(`(toast: ${text})`)}\n`);
  }

  /** The most recent message with buttons, optionally in one chat. */
  lastWithButtons(chatId?: number): ConsoleMessage | undefined {
    return [...this.messages.values()].reverse().find((m) => m.buttons.length > 0 && (chatId === undefined || m.chatId === chatId));
  }

  /** Button number `n` (1-based, row-major) of a message. */
  button(m: ConsoleMessage, n: number): Button | undefined {
    return m.buttons.flat()[n - 1];
  }
}

function wrap(s: string, width: number): string[] {
  if (s.length <= width) return [s];
  const out: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = "";
    }
    if (word.length > width) {
      if (line) out.push(line);
      for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
      line = "";
      continue;
    }
    line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}
