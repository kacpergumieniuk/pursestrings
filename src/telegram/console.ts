/**
 * ConsoleChat: a ChatApi that renders the conversation in the terminal, so the bot can be
 * demoed and tried without a Telegram token. Buttons are numbered; `press()` simulates a tap.
 */
import type { Button, ChatApi, OutgoingMessage } from "./chat";

const useColor = () => (process.stdout.isTTY || process.env.FORCE_COLOR === "1") && !process.env.NO_COLOR;

/**
 * Invisible terminal markers (OSC 1337, ignored by terminals) that carry each chat event as JSON,
 * so a recording of the terminal can also drive a phone-style chat view (docs/video/viewer.html).
 */
export function oscEvent(e: Record<string, unknown>): string {
  return `\x1b]1337;GuardChat=${Buffer.from(JSON.stringify(e)).toString("base64")}\x07`;
}
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
  /** Emit OSC chat-event markers around each bubble (for recordings). */
  osc?: boolean;
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

  private render(m: ConsoleMessage, label: string, previous?: string) {
    const inner = this.width - 4;
    const head = `${this.opts.botName ?? "Guard bot"} → ${this.chatName(m.chatId)}`;
    const lines: string[] = [];
    lines.push(`  ${tgBlue("╭─")} ${tgBlue(head)} ${dim(label)}`);
    let body = m.text.split("\n");
    if (previous !== undefined) {
      // Edits: show only what changed after the unchanged leading lines.
      const old = previous.split("\n");
      let same = 0;
      while (same < body.length && same < old.length && body[same] === old[same]) same++;
      if (same > 1) {
        lines.push(`  ${tgBlue("│")} ${dim(`… ${same} unchanged line(s)`)}`);
        body = body.slice(same).filter((l, i) => i > 0 || l !== "");
      }
    }
    for (const raw of body) {
      for (const l of wrap(raw, inner)) lines.push(`  ${tgBlue("│")} ${l}`);
    }
    if (m.buttons.length) {
      let n = 0;
      const row = m.buttons.map((r) => r.map((b) => bold(`[${++n}] ${b.text}`)).join("   ")).join("   ");
      lines.push(`  ${tgBlue("│")} ${row}`);
    }
    lines.push(`  ${tgBlue("╰─")}`);
    this.emit(lines.join("\n") + "\n", { type: previous === undefined ? "send" : "edit", chatId: m.chatId, chat: this.chatName(m.chatId), messageId: m.messageId, text: m.text, buttons: m.buttons });
  }

  private emit(rendered: string, event: Record<string, unknown>) {
    if (!this.opts.osc) return this.write(rendered);
    this.write(oscEvent(event) + oscEvent({ type: "bubble_start" }) + rendered + oscEvent({ type: "bubble_end" }));
  }

  /** Records a simulated button tap (for recordings). */
  showTap(m: ConsoleMessage, button: Button) {
    this.emit(`  ${dim(`(owner taps "${button.text}")`)}\n`, { type: "tap", chatId: m.chatId, messageId: m.messageId, data: button.data, text: button.text });
  }

  /** Prints what a user typed, as a chat bubble. */
  showUser(chatId: number, userName: string, text: string) {
    const out = [`  ${grey("╭─")} ${blue(userName)} ${grey("in " + this.chatName(chatId))}`];
    for (const l of text.split("\n")) for (const w of wrap(l, this.width - 4)) out.push(`  ${grey("│")} ${w}`);
    out.push(`  ${grey("╰─")}`);
    this.emit(out.join("\n") + "\n", { type: "user", chatId, chat: this.chatName(chatId), user: userName, text });
  }

  async send(chatId: number, msg: OutgoingMessage): Promise<number> {
    const m: ConsoleMessage = { chatId, messageId: this.nextId++, text: msg.text, buttons: msg.buttons ?? [] };
    this.messages.set(m.messageId, m);
    this.render(m, `msg ${m.messageId}`);
    return m.messageId;
  }

  async edit(chatId: number, messageId: number, msg: OutgoingMessage): Promise<void> {
    const m: ConsoleMessage = { chatId, messageId, text: msg.text, buttons: msg.buttons ?? [] };
    const previous = this.messages.get(messageId)?.text;
    this.messages.set(messageId, m);
    this.render(m, `msg ${messageId} (edited)`, previous);
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    this.callbacks.push({ callbackId, text });
    if (text) this.emit(`  ${dim(`(toast: ${text})`)}\n`, { type: "toast", text });
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
