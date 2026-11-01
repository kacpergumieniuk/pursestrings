/**
 * Guard's Telegram bot.
 *
 *   npm run bot                     Telegram mode. Needs TELEGRAM_BOT_TOKEN; owners in TELEGRAM_OWNER_IDS
 *                                   (comma-separated Telegram user ids; send /whoami to the bot to get yours).
 *   npm run bot:console             The same bot in the terminal, no token needed. Uses the testnet vault
 *                                   from `npm run testnet:setup` if present (Approve signs on testnet).
 *   npm run bot:console -- --offline  No network at all: recorded mainnet facts and a simulated vault.
 *
 * Console input: anything you type is sent by you (the owner) in a private chat with the bot.
 *   :group <text>   send <text> as "alice" in the "NEAR builders" group chat
 *   :tap <n>        press button n on the latest message that has buttons
 *   :watch          poll the vault now (pending requests, blocked attempts)
 *   :help, :quit
 * Lines can also be piped in: printf '/check wrap-near.near\n:quit\n' | npm run bot:console -- --offline
 */
import "../src/demo/env";
import { createInterface } from "node:readline";
import { FixtureNearData, LiveNearData } from "../src/risk/near-data";
import { ScamList } from "../src/risk/scam-list";
import { GuardViews } from "../src/near/guard-client";
import { loadState } from "../src/demo/setup";
import {
  Checker,
  ConsoleChat,
  type ChatApi,
  FastNearBlockedSource,
  GuardBot,
  loadTestnetOwnerControl,
  MemoryOwnerControl,
  type OwnerControl,
  VaultWatcher,
} from "../src/telegram";
import { offlineData } from "../src/telegram/offline";

const args = new Set(process.argv.slice(2));
const consoleMode = args.has("--console");
const offline = args.has("--offline");
const log = (m: string) => console.error(`[guard-bot] ${m}`);

const state = offline ? undefined : loadState("testnet");
const owner: OwnerControl | undefined = offline ? simulatedVault() : loadTestnetOwnerControl();

async function makeChecker(): Promise<Checker> {
  const scamList = await ScamList.load();
  if (state) {
    try {
      const denied = await new GuardViews(state.vault.id, state.rpcUrl, "testnet").listDenied("recipient");
      scamList.add(denied.map((d) => ({ type: "account" as const, value: d.account_id, reason: d.entry.reason, source: `guard:${state.vault.id}` })));
    } catch (e) {
      log(`could not read the vault denylist: ${(e as Error).message}`);
    }
  }
  return new Checker({
    data: offline ? offlineData({ sandbox: new FixtureNearData("sandbox", { accounts: { "vendor.simulated": { exists: true, hasContract: false } } }) }) : { mainnet: new LiveNearData({ network: "mainnet" }), testnet: new LiveNearData({ network: "testnet" }) },
    scamList,
    trustedAccounts: state ? [state.payee.id, state.vendor.id] : offline ? ["vendor.simulated"] : [],
    trustedTokens: state?.allowedTokens,
  });
}

function simulatedVault(): MemoryOwnerControl {
  const v = new MemoryOwnerControl(
    "vault.simulated",
    {
      agents: [
        {
          public_key: "ed25519:simulated",
          name: "treasury-agent",
          enabled: true,
          pending: 1,
          executed: 1,
          blocked: 1,
          limits: [{ asset: "near", per_tx: "500000000000000000000000", per_day: "1000000000000000000000000", spent_today: "200000000000000000000000", remaining_today: "800000000000000000000000" }],
        },
      ],
    },
    "sandbox",
  );
  v.add({ id: "1", receiver_id: "vendor.simulated", justification: "Hi! Please pay vendor.simulated 0.8 NEAR for the quarterly hosting invoice #2026-Q4." });
  return v;
}

function makeWatcher(bot: GuardBot): VaultWatcher {
  const blocked =
    state && owner && !offline
      ? new FastNearBlockedSource({
          vaultId: state.vault.id,
          network: "testnet",
          rpcUrl: state.rpcUrl,
          agentNames: async () => new Map((await owner.status()).agents.map((a) => [a.public_key, a.name])),
        })
      : undefined;
  return new VaultWatcher({ bot, blocked, intervalMs: Number(process.env.GUARD_BOT_POLL_MS ?? 15_000), log });
}

function ownerIds(): number[] {
  return (process.env.TELEGRAM_OWNER_IDS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
}

const checker = await makeChecker();

if (consoleMode) {
  const OWNER = 1001;
  const GROUP = -2002;
  const chat = new ConsoleChat({ chatNames: { [OWNER]: "you (owner, private chat)", [GROUP]: "NEAR builders (group)" } });
  const bot = new GuardBot({ chat: chat as ChatApi, checker, owner, ownerUserIds: [OWNER], botUsername: "GuardBot", log });
  const watcher = makeWatcher(bot);
  console.log(
    `Guard bot, console mode. Vault: ${owner ? `${owner.vaultId} (${owner.network}${offline ? ", simulated" : ""})` : "none (run npm run testnet:setup)"}.` +
      `\nType /help, /check <account|token|link>, /pending, /status. ":group <text>" speaks in a group, ":tap <n>" presses a button, ":quit" exits.\n`,
  );
  await watcher.tick();
  let cbId = 0;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const prompt = () => process.stdin.isTTY && rl.prompt();
  rl.setPrompt("you> ");
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      prompt();
      continue;
    }
    if (line === ":quit" || line === ":q") break;
    if (line === ":help") console.log("  :group <text> | :tap <n> | :watch | :quit; anything else is sent as the owner");
    else if (line === ":watch") console.log(`  polled: ${JSON.stringify(await watcher.tick())}`);
    else if (line.startsWith(":tap")) {
      const n = Number(line.split(/\s+/)[1] ?? "1");
      const m = chat.lastWithButtons(OWNER);
      const b = m && chat.button(m, n);
      if (!m || !b) console.log("  no such button");
      else {
        console.log(`  (you tap "${b.text}")`);
        await bot.handleCallback({ callbackId: `c${++cbId}`, chatId: OWNER, chatType: "private", messageId: m.messageId, userId: OWNER, data: b.data });
      }
    } else if (line.startsWith(":group ")) {
      const text = line.slice(7);
      chat.showUser(GROUP, "alice", text);
      await bot.handleMessage({ chatId: GROUP, chatType: "supergroup", userId: 3003, userName: "alice", text });
    } else {
      chat.showUser(OWNER, "you", line);
      await bot.handleMessage({ chatId: OWNER, chatType: "private", userId: OWNER, text: line });
    }
    prompt();
  }
  rl.close();
  watcher.stop();
} else {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather, put the token in .env, or try `npm run bot:console`.");
    process.exit(1);
  }
  const owners = ownerIds();
  if (owners.length === 0) log("TELEGRAM_OWNER_IDS is empty: /check works, but nobody can approve. Send /whoami to the bot to get your id.");
  if (!owner) log("no testnet vault (.guard-local/testnet.json): owner features are off. Run `npm run testnet:setup`.");
  const { createTelegramBot, BOT_COMMANDS } = await import("../src/telegram/grammy");
  let guard: GuardBot | undefined;
  const { bot, ready } = createTelegramBot(
    token,
    (chat, username) => (guard = new GuardBot({ chat, checker, owner, ownerUserIds: owners, botUsername: username, defaultNetwork: "mainnet", log })),
    { log },
  );
  await ready;
  await bot.api.setMyCommands(BOT_COMMANDS);
  const watcher = makeWatcher(guard!);
  watcher.start();
  const stop = () => {
    watcher.stop();
    void bot.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  log(`@${bot.botInfo.username} running; vault ${owner?.vaultId ?? "-"}; owners ${owners.join(", ") || "-"}`);
  await bot.start({ drop_pending_updates: true });
}
