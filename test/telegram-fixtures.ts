/** Shared fixtures for the Telegram tests: offline NEAR data and a recording fake chat. */
import { FixtureNearData, ScamList } from "../src/risk";
import { type Button, type ChatApi, Checker, type OutgoingMessage } from "../src/telegram";

export const NOW = Date.parse("2026-11-01T12:00:00Z");
const DAY = 86_400_000;

export const mainnetData = new FixtureNearData("mainnet", {
  accounts: {
    "wrap.near": { exists: true, hasContract: true },
    "alice.near": { exists: true, hasContract: false },
  },
  views: {
    "wrap.near:ft_metadata": { spec: "ft-1.0.0", name: "Wrapped NEAR fungible token", symbol: "wNEAR", decimals: 24, icon: "data:image/svg+xml,x" },
    "wrap.near:ft_total_supply": "1000000000000000000000000000000",
  },
  createdAt: { "wrap.near": NOW - 1500 * DAY, "alice.near": NOW - 900 * DAY },
});

export const testnetData = new FixtureNearData("testnet", {
  accounts: {
    "usdc-airdrop.owner.testnet": { exists: true, hasContract: true },
    "vendor.owner.testnet": { exists: true, hasContract: false },
  },
  views: {
    "usdc-airdrop.owner.testnet:ft_metadata": { spec: "ft-1.0.0", name: "USD Coin - claim your bonus at near-airdrop-claim.xyz", symbol: "USDC", decimals: 6 },
    "usdc-airdrop.owner.testnet:ft_total_supply": "1000000000000",
  },
  createdAt: { "usdc-airdrop.owner.testnet": NOW - 600_000, "vendor.owner.testnet": NOW - 30 * DAY },
});

export function makeChecker(trustedAccounts: string[] = []) {
  return new Checker({
    data: { mainnet: mainnetData, testnet: testnetData },
    scamList: new ScamList([{ type: "domain", value: "near-airdrop-claim.xyz", reason: "test drainer page" }]),
    trustedAccounts,
    now: () => NOW,
  });
}

export interface Sent {
  chatId: number;
  messageId: number;
  text: string;
  buttons: Button[][];
}

/** Records everything the bot does; message ids are sequential. */
export class FakeChat implements ChatApi {
  sent: Sent[] = [];
  edits: Sent[] = [];
  answers: Array<{ callbackId: string; text?: string }> = [];
  private id = 100;

  async send(chatId: number, msg: OutgoingMessage) {
    const s = { chatId, messageId: ++this.id, text: msg.text, buttons: msg.buttons ?? [] };
    this.sent.push(s);
    return s.messageId;
  }
  async edit(chatId: number, messageId: number, msg: OutgoingMessage) {
    this.edits.push({ chatId, messageId, text: msg.text, buttons: msg.buttons ?? [] });
  }
  async answerCallback(callbackId: string, text?: string) {
    this.answers.push({ callbackId, text });
  }
  last(): Sent {
    return this.sent[this.sent.length - 1]!;
  }
  to(chatId: number): Sent[] {
    return this.sent.filter((s) => s.chatId === chatId);
  }
}
