/**
 * GuardBot: the chat front end of Guard, independent of Telegram itself.
 *
 *  - Anyone, in a private chat or a group: `/check <account|token|link|text>` -> ALLOW / WARN / BLOCK with reasons.
 *    In a private chat, a pasted value without a command is checked too.
 *  - The owner (Telegram user ids in `ownerUserIds`, private chat only):
 *      * gets each pending approval request with Approve / Reject buttons, plus a risk check of the receiver;
 *      * gets a notice for every blocked attempt, with the reasons;
 *      * `/pending`, `/status`, `/pause`, `/unpause`.
 *  Owner actions are signed by `OwnerControl` (testnet or a local sandbox only).
 */
import { fmtAmount } from "../demo/print";
import type { Network } from "../risk/types";
import { type ChatApi, type IncomingCallback, type IncomingMessage, type OutgoingMessage, parseCommand } from "./chat";
import { CHECK_USAGE, type Checker, formatCheckReport, parseCheckArgs, VERDICT_ICON } from "./check";
import type { OwnerActionResult, OwnerControl, PendingRequest, VaultStatus } from "./owner";

export interface BlockedAttempt {
  /** `risk_layer`: refused before signing (nothing on chain). `contract`: refused on chain and recorded. */
  source: "risk_layer" | "contract";
  agentName?: string;
  /** What the agent tried, e.g. `send 0.8 NEAR to vendor.testnet`. */
  action: string;
  code?: string;
  reasons: string[];
  txUrl?: string;
  /** Used to avoid double notices (e.g. the tx hash). */
  key?: string;
}

export interface GuardBotOptions {
  chat: ChatApi;
  checker: Checker;
  owner?: OwnerControl;
  /** Telegram user ids allowed to approve, reject and pause. Their private chat receives notices. */
  ownerUserIds: number[];
  botUsername?: string;
  /** Network for `/check` values that do not name one (default mainnet). */
  defaultNetwork?: Network;
  /** Run a risk check on the receiver of each pending request before showing it (default true). */
  precheckReceivers?: boolean;
  log?: (msg: string) => void;
}

interface Tracked {
  request: PendingRequest;
  text: string;
  messages: Array<{ chatId: number; messageId: number }>;
}

const HELP =
  "Guard checks NEAR accounts, tokens and links before you or your agent pays.\n" +
  "/check <account | token | link | text>: ALLOW, WARN or BLOCK with reasons. Works in groups too.\n" +
  "In this private chat you can also just paste the account, token or link.\n" +
  "/whoami: your Telegram user id";
const OWNER_HELP =
  "\nOwner commands (private chat):\n" +
  "/pending: approval requests with Approve / Reject buttons\n" +
  "/status: agent budgets and counters\n" +
  "/pause, /unpause: emergency stop for every agent";

export function describeAmount(asset: string, amount: string): string {
  return asset === "near" ? `${fmtAmount(amount, 24)} NEAR` : `${amount} units of token ${asset}`;
}

function oneLine(s: string, max = 240): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export class GuardBot {
  private readonly tracked = new Map<string, Tracked>();
  private readonly resolved = new Set<string>();
  private readonly busy = new Set<string>();
  private readonly blockedSeen = new Set<string>();

  constructor(private readonly opts: GuardBotOptions) {}

  private log(m: string) {
    this.opts.log?.(m);
  }

  get ownerChats(): number[] {
    return this.opts.ownerUserIds;
  }

  isOwner(userId: number): boolean {
    return this.opts.ownerUserIds.includes(userId);
  }

  private async reply(chatId: number, text: string, buttons?: OutgoingMessage["buttons"]): Promise<number> {
    return this.opts.chat.send(chatId, { text, buttons });
  }

  // ------------------------------------------------------------------ messages

  async handleMessage(m: IncomingMessage): Promise<void> {
    const cmd = parseCommand(m.text, this.opts.botUsername);
    const isPrivate = m.chatType === "private";
    if (!cmd) {
      // Groups: only explicit commands. Private chat: treat a pasted value as /check.
      if (isPrivate && m.text.trim()) await this.check(m, m.text);
      return;
    }
    switch (cmd.command) {
      case "start":
      case "help":
        await this.reply(m.chatId, HELP + (isPrivate && this.isOwner(m.userId) ? OWNER_HELP : ""));
        return;
      case "check":
        await this.check(m, cmd.args);
        return;
      case "whoami":
        await this.reply(
          m.chatId,
          `Your Telegram user id is ${m.userId}.` + (this.isOwner(m.userId) ? " You are an owner of this Guard." : " Owners set TELEGRAM_OWNER_IDS to their id to receive approvals."),
        );
        return;
      case "pending":
      case "status":
      case "pause":
      case "unpause":
        if (!(await this.ownerGate(m))) return;
        if (cmd.command === "pending") await this.showPending(m.chatId);
        else if (cmd.command === "status") await this.reply(m.chatId, formatStatus(await this.opts.owner!.status()));
        else await this.askPause(m.chatId, cmd.command === "pause");
        return;
      default:
        if (isPrivate) await this.reply(m.chatId, `Unknown command /${cmd.command}.\n${HELP}`);
    }
  }

  private async ownerGate(m: IncomingMessage): Promise<boolean> {
    if (!this.isOwner(m.userId)) {
      this.log(`refused owner command from user ${m.userId}`);
      await this.reply(m.chatId, "Only the vault owner can do this.");
      return false;
    }
    if (m.chatType !== "private") {
      await this.reply(m.chatId, "Owner commands work in a private chat with the bot only.");
      return false;
    }
    if (!this.opts.owner) {
      await this.reply(m.chatId, "No vault is connected (run `npm run testnet:setup` first).");
      return false;
    }
    return true;
  }

  private async check(m: IncomingMessage, args: string): Promise<void> {
    const target = parseCheckArgs(args, this.opts.defaultNetwork ?? "mainnet");
    if ("error" in target) {
      await this.reply(m.chatId, target.error);
      return;
    }
    try {
      const report = await this.opts.checker.run(target);
      await this.reply(m.chatId, formatCheckReport(report));
    } catch (e) {
      this.log(`check failed: ${(e as Error).message}`);
      await this.reply(m.chatId, `Could not finish the check (${oneLine((e as Error).message, 120)}). Try again in a minute.`);
    }
  }

  // ------------------------------------------------------------------ owner notifications

  /** Sends every pending request the owner has not seen yet, and closes ones handled elsewhere. */
  async syncPending(): Promise<number> {
    if (!this.opts.owner) return 0;
    const pending = await this.opts.owner.listPending();
    let added = 0;
    for (const p of pending) if (await this.notifyPending(p)) added++;
    const ids = new Set(pending.map((p) => p.id));
    for (const [id, t] of this.tracked) {
      if (!ids.has(id) && !this.busy.has(id) && !this.resolved.has(id)) {
        this.resolved.add(id);
        await this.editAll(t, `${t.text}\n\nNo longer pending (handled outside Telegram).`);
      }
    }
    return added;
  }

  /** Shows a pending request to every owner chat. Returns false if it was already shown. */
  async notifyPending(p: PendingRequest, force = false): Promise<boolean> {
    if (this.resolved.has(p.id)) return false;
    const existing = this.tracked.get(p.id);
    if (existing && !force) return false;
    const text = existing?.text ?? (await this.pendingText(p));
    const t: Tracked = existing ?? { request: p, text, messages: [] };
    for (const chatId of this.ownerChats) {
      const messageId = await this.reply(chatId, text, approvalButtons(p.id));
      t.messages.push({ chatId, messageId });
    }
    this.tracked.set(p.id, t);
    return true;
  }

  private async pendingText(p: PendingRequest): Promise<string> {
    const network = this.opts.owner?.network ?? "testnet";
    const lines = [
      `🟡 Approval needed: request #${p.id} on ${network}`,
      `Agent "${p.agent_name}" wants to send ${describeAmount(p.asset, p.amount)} to ${p.receiver_id}.`,
      `Stopped by the Guard contract: ${p.code}.`,
      `Agent's justification (untrusted text): "${oneLine(p.justification)}"`,
    ];
    if (this.opts.precheckReceivers !== false) {
      try {
        const r = await this.opts.checker.run({ value: p.receiver_id, network });
        const top = r.checks.flatMap((c) => c.reasons).find((x) => !x.startsWith("no risk signals"));
        lines.push(`Risk check of the receiver: ${VERDICT_ICON[r.verdict]} ${r.verdict}${top ? `, ${top}` : ""}`);
      } catch {
        lines.push("Risk check of the receiver: unavailable");
      }
    }
    if (this.opts.owner) lines.push(`Vault: ${this.opts.owner.vaultId}`);
    return lines.join("\n");
  }

  async notifyBlocked(b: BlockedAttempt): Promise<boolean> {
    const key = b.key ?? b.txUrl;
    if (key) {
      if (this.blockedSeen.has(key)) return false;
      this.blockedSeen.add(key);
    }
    const who = b.agentName ? `Agent "${b.agentName}"` : "An agent";
    const by = b.source === "risk_layer" ? "Guard's risk layer, before signing (nothing was sent)" : "the Guard contract (attempt recorded on chain)";
    const lines = [`⛔ Blocked: ${who} tried to ${b.action}.`, `Stopped by ${by}${b.code ? `: ${b.code}` : ""}.`];
    for (const r of b.reasons.slice(0, 5)) lines.push(`• ${oneLine(r, 200)}`);
    if (b.txUrl) lines.push(`Tx: ${b.txUrl}`);
    for (const chatId of this.ownerChats) await this.reply(chatId, lines.join("\n"));
    return true;
  }

  private async showPending(chatId: number) {
    const pending = await this.opts.owner!.listPending();
    if (pending.length === 0) {
      await this.reply(chatId, "No pending approval requests.");
      return;
    }
    await this.reply(chatId, `${pending.length} pending request(s):`);
    for (const p of pending) {
      const known = this.tracked.get(p.id);
      const text = known?.text ?? (await this.pendingText(p));
      const messageId = await this.reply(chatId, text, approvalButtons(p.id));
      const t = known ?? { request: p, text, messages: [] };
      t.messages.push({ chatId, messageId });
      this.tracked.set(p.id, t);
    }
  }

  private async askPause(chatId: number, pause: boolean) {
    await this.reply(
      chatId,
      pause
        ? `Pause the vault ${this.opts.owner!.vaultId}? Every agent transfer will be blocked until you unpause.`
        : `Unpause the vault ${this.opts.owner!.vaultId}? Agents can spend again within their caps.`,
      [[{ text: pause ? "⏸ Pause vault" : "▶️ Unpause vault", data: pause ? "pause:on" : "pause:off" }, { text: "Cancel", data: "cancel" }]],
    );
  }

  // ------------------------------------------------------------------ buttons

  async handleCallback(cb: IncomingCallback): Promise<void> {
    if (!this.isOwner(cb.userId) || cb.chatType !== "private") {
      this.log(`refused button ${cb.data} from user ${cb.userId}`);
      await this.opts.chat.answerCallback(cb.callbackId, "Only the vault owner can do this.");
      return;
    }
    if (!this.opts.owner) {
      await this.opts.chat.answerCallback(cb.callbackId, "No vault is connected.");
      return;
    }
    const [action, arg = ""] = cb.data.split(":");
    if (action === "cancel") {
      await this.opts.chat.answerCallback(cb.callbackId, "Cancelled");
      await this.opts.chat.edit(cb.chatId, cb.messageId, { text: "Cancelled." });
      return;
    }
    if (action === "pause") {
      await this.opts.chat.answerCallback(cb.callbackId, "Sending…");
      const r = await this.safely(() => this.opts.owner!.setPaused(arg === "on"));
      await this.opts.chat.edit(cb.chatId, cb.messageId, { text: resultLine(r) });
      return;
    }
    if ((action === "approve" || action === "reject") && /^\d+$/.test(arg)) {
      await this.decide(cb, action, arg);
      return;
    }
    await this.opts.chat.answerCallback(cb.callbackId, "Unknown button");
  }

  private async decide(cb: IncomingCallback, action: "approve" | "reject", id: string) {
    if (this.busy.has(id) || this.resolved.has(id)) {
      await this.opts.chat.answerCallback(cb.callbackId, "Already handled");
      return;
    }
    this.busy.add(id);
    const t = this.tracked.get(id) ?? { request: undefined, text: `Request #${id}`, messages: [{ chatId: cb.chatId, messageId: cb.messageId }] };
    if (!t.messages.some((x) => x.chatId === cb.chatId && x.messageId === cb.messageId)) t.messages.push({ chatId: cb.chatId, messageId: cb.messageId });
    try {
      const network = this.opts.owner!.network;
      await this.opts.chat.answerCallback(cb.callbackId, action === "approve" ? "Approving…" : "Rejecting…");
      await this.editAll(t, `${t.text}\n\n⏳ ${action === "approve" ? "Approving" : "Rejecting"}: signing with the owner key on ${network}…`);
      const r = await this.safely(() => (action === "approve" ? this.opts.owner!.approve(id) : this.opts.owner!.reject(id, "rejected via Telegram")));
      if (r.status === "error") {
        await this.editAll(t, `${t.text}\n\n⚠️ ${resultLine(r)}`, approvalButtons(id));
        return;
      }
      this.resolved.add(id);
      const head = action === "approve" ? `✅ Approved by the owner: ${r.status}` : "❌ Rejected by the owner";
      await this.editAll(t, `${t.text}\n\n${head}. ${r.reason}${r.txUrl ? `\nTx: ${r.txUrl}` : ""}`);
      this.log(`request #${id} ${action}d: ${r.status}`);
    } finally {
      this.busy.delete(id);
    }
  }

  private async safely(fn: () => Promise<OwnerActionResult>): Promise<OwnerActionResult> {
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error).message;
      this.log(`owner action failed: ${msg}`);
      return { status: "error", reason: `failed: ${oneLine(msg, 200)}` };
    }
  }

  private async editAll(t: Pick<Tracked, "messages">, text: string, buttons?: OutgoingMessage["buttons"]) {
    for (const m of t.messages) {
      try {
        await this.opts.chat.edit(m.chatId, m.messageId, { text, buttons });
      } catch (e) {
        this.log(`edit failed: ${(e as Error).message}`);
      }
    }
  }
}

function approvalButtons(id: string): OutgoingMessage["buttons"] {
  return [[{ text: "✅ Approve", data: `approve:${id}` }, { text: "❌ Reject", data: `reject:${id}` }]];
}

function resultLine(r: OwnerActionResult): string {
  return `${r.status === "error" ? "Action " : ""}${r.reason}${r.txUrl ? `\nTx: ${r.txUrl}` : ""}`;
}

export function formatStatus(s: VaultStatus): string {
  const lines = [`Vault ${s.vaultId} on ${s.network}: ${s.paused ? "⏸ PAUSED" : "active"}, ${s.pendingRequests} pending request(s)`];
  for (const a of s.agents) {
    lines.push(`Agent "${a.name}"${a.enabled ? "" : " (disabled)"}: executed ${a.executed}, blocked ${a.blocked}, pending ${a.pending}`);
    for (const l of a.limits) {
      lines.push(
        `  ${l.asset === "near" ? "NEAR" : l.asset}: spent ${describeAmount(l.asset, l.spent_today)} of ${describeAmount(l.asset, l.per_day)} (24h), per tx ${describeAmount(l.asset, l.per_tx)}`,
      );
    }
  }
  return lines.join("\n");
}

export { CHECK_USAGE };
