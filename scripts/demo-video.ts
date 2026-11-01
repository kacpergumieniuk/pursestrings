/**
 * npm run demo:video   The whole Guard story in one paced, deterministic terminal run, for recording.
 *
 * Runs on a local NEAR sandbox node: the real Guard contract, a real agent function-call key,
 * the real risk layer and the Telegram bot in console mode (owner approval is a real
 * `approve_request` signed by the owner key on the sandbox). Nothing touches testnet or mainnet:
 * mainnet facts for /check and the NEAR Intents quote are recordings from 2026-11-01.
 *
 * Flags:
 *   --fast         no pauses or typing effect (CI / quick check)
 *   --pace <x>     multiply every pause (default 1; 0.5 = twice as fast)
 *   --osc          emit chat-event markers for the HTML viewer (scripts/record-demo.ts sets this)
 * Same accounts, messages, verdicts and order on every run; only tx hashes differ.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, JsonRpcProvider, type KeyPairString, nearToYocto } from "near-api-js";
import { ScriptedBrain, type BrainContext } from "../src/agent/brain";
import { denyAll, GuardedWallet, type WalletOutcome } from "../src/agent/guarded-wallet";
import { bold, cyan, dim, green, red, yellow } from "../src/demo/print";
import { inbox } from "../src/demo/run";
import { type DemoState, ROOT, sandboxFactory, setupDemo } from "../src/demo/setup";
import { AgentGuard } from "../src/near/guard-client";
import { type Assessment, RiskEngine } from "../src/risk/engine";
import { checkIntentsQuote } from "../src/risk/intents";
import { LiveNearData } from "../src/risk/near-data";
import { ScamList } from "../src/risk/scam-list";
import type { Verdict } from "../src/risk/types";
import { Checker, ConsoleChat, ContractOwnerControl, GuardBot, oscEvent, reportOutcome } from "../src/telegram";
import { describeAgentAction } from "../src/telegram/bridge";
import { offlineData } from "../src/telegram/offline";

const argv = process.argv.slice(2);
const fast = argv.includes("--fast");
const paceArg = argv.indexOf("--pace");
const PACE = fast ? 0 : paceArg >= 0 ? Number(argv[paceArg + 1]) : 1;
const OSC = argv.includes("--osc");
const out = (s = "") => process.stdout.write(s + "\n");
const pause = (ms: number) => (PACE > 0 ? new Promise((r) => setTimeout(r, ms * PACE)) : Promise.resolve());

async function typeOut(prefix: string, text: string, cps = 90) {
  if (PACE === 0) return out(prefix + text);
  process.stdout.write(prefix);
  for (const ch of text) {
    process.stdout.write(ch);
    await pause(1000 / cps);
  }
  out();
}

const W = 92;
let sceneNo = 0;
const SCENES = 7;
async function scene(title: string, subtitle: string) {
  sceneNo++;
  await pause(900);
  if (OSC) process.stdout.write(oscEvent({ type: "scene", n: sceneNo, title, subtitle }));
  out();
  out(cyan("━".repeat(W)));
  out(bold(`  ${sceneNo}/${SCENES}  ${title}`));
  out(dim(`       ${subtitle}`));
  out(cyan("━".repeat(W)));
  await pause(1300);
}

const tag = (v: Verdict | string) => {
  const s = ` ${v} `;
  return v === "ALLOW" || v === "executed" ? green(bold(s)) : v === "WARN" || v === "pending_approval" ? yellow(bold(s)) : red(bold(s));
};
const shortTx = (h: string) => `${h.slice(0, 8)}…`;

function showAssessment(a: Assessment, max = 5) {
  out(`  ${bold("risk layer")}      ${tag(a.verdict)}`);
  const flags = a.checks
    .flatMap((c) => c.flags.map((f) => ({ ...f, check: c.check })))
    .filter((f) => (a.verdict === "ALLOW" ? f.severity === "info" : ["critical", "high"].includes(f.severity)))
    .sort((x, y) => (x.severity === y.severity ? 0 : x.severity === "critical" ? -1 : 1));
  for (const f of flags.slice(0, max)) {
    const mark = f.severity === "critical" ? red("✗") : f.severity === "high" ? yellow("!") : green("✓");
    out(`     ${mark} ${f.code.padEnd(26)} ${dim(f.message.length > 70 ? f.message.slice(0, 69) + "…" : f.message)}`);
  }
  if (flags.length > max) out(dim(`       …and ${flags.length - max} more`));
}

function showOnChain(o: WalletOutcome) {
  const r = o.onChain?.result;
  if (r) out(`  ${bold("guard contract")}  ${tag(r.status)} ${r.code}: ${r.reason} ${dim(`(tx ${shortTx(o.onChain!.txHash)})`)}`);
  const e = o.escalation?.result;
  if (e) out(`  ${bold("escalation")}      ${tag(e.status)} request #${e.request_id} filed on chain; only the owner can execute it ${dim(`(tx ${shortTx(o.escalation!.txHash)})`)}`);
}

/** Replays the 1Click dry-run quote recorded from the live API on 2026-11-01 (signature included). */
function recordedOneClick(): typeof fetch {
  const tokens = readFileSync(join(ROOT, "test/fixtures/oneclick-tokens.json"), "utf8");
  const quote = readFileSync(join(ROOT, "test/fixtures/oneclick-quote.json"), "utf8");
  return (async (url: string | URL) => new Response(String(url).endsWith("/v0/tokens") ? tokens : quote)) as typeof fetch;
}

// ---------------------------------------------------------------------------------------------

const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = await import("near-sandbox");
out(bold("GUARD") + "  a policy firewall for AI-agent wallets on NEAR");
out(dim("local NEAR sandbox node · real Guard contract · real agent key · Telegram bot in console mode"));
out(dim("starting the node and deploying the vault…"));
const sandbox = await Sandbox.start({});
try {
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const s: DemoState = await setupDemo({
    network: "sandbox",
    rpcUrl: sandbox.rpcUrl,
    factory: sandboxFactory(provider, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY as KeyPairString),
    tag: "video",
  });
  await story(s, provider);
} finally {
  await sandbox.tearDown();
}

async function story(s: DemoState, provider: JsonRpcProvider) {
  const data = new LiveNearData({ network: "sandbox", rpcUrl: s.rpcUrl, nearblocksUrl: null, fastnearUrl: null });
  const guard = new AgentGuard({ vaultId: s.vault.id, rpcUrl: s.rpcUrl, network: "sandbox", agentKey: s.agent.key, publicKey: s.agent.publicKey });
  const scamList = await ScamList.load();
  const denied = await guard.listDenied("recipient");
  scamList.add(denied.map((d) => ({ type: "account" as const, value: d.account_id, reason: d.entry.reason, source: "guard denylist" })));
  const trusted = [s.payee.id, s.vendor.id];
  const engine = new RiskEngine({ data, scamList, trustedAccounts: trusted, trustedTokens: s.allowedTokens });
  const wallet = new GuardedWallet({ engine, guard, approver: denyAll, escalateSoftBlocks: true });
  const compromised = new GuardedWallet({ engine, guard, bypassRiskLayer: true, escalateSoftBlocks: false });
  const brain = new ScriptedBrain();
  const ctx: BrainContext = {
    tokens: {},
    resolveToken: async (tokenId) => ({ tokenId, decimals: (await data.viewFunction<{ decimals: number }>(tokenId, "ft_metadata")).decimals }),
  };

  const OWNER = 1001;
  const GROUP = -2002;
  const chat = new ConsoleChat({ chatNames: { [OWNER]: "owner (Telegram, private chat)", [GROUP]: "NEAR builders (Telegram group)" }, osc: OSC, width: W });
  const checker = new Checker({ data: offlineData({ sandbox: data }), scamList, trustedAccounts: trusted, trustedTokens: s.allowedTokens });
  const owner = new ContractOwnerControl(s);
  const bot = new GuardBot({ chat, checker, owner, ownerUserIds: [OWNER], botUsername: "GuardBot" });
  const messages = inbox(s);

  const run = async (w: GuardedWallet, msg: { from: string; text: string }, label: string) => {
    out(`  ${bold("incoming message")} ${dim(`from ${msg.from}`)}`);
    await typeOut("  ", dim(`"${msg.text}"`));
    await pause(700);
    const action = (await brain.plan(msg.text, ctx))!;
    out(`  ${bold("agent proposes")}  ${describeAgentAction(action)}`);
    await pause(900);
    const o = await w.execute(action, { sourceText: msg.text, justification: msg.text });
    if (o.assessment) showAssessment(o.assessment);
    else out(`  ${bold("risk layer")}      ${yellow(bold(" SKIPPED "))} ${dim("compromised agent: only the contract stands in the way")}`);
    await pause(700);
    if (o.decision === "refused_by_risk_layer") out(`  ${bold("=>")} ${red(bold("refused before signing"))}: the agent's key never touched the chain`);
    else {
      out(`  ${bold("signing")}         ${dim("agent_" + (action.kind === "transfer_ft" ? "transfer_ft" : "transfer_near") + " with the agent's function-call key")}`);
      await pause(500);
      showOnChain(o);
    }
    await pause(900);
    void label;
    return o;
  };

  // 1 ---------------------------------------------------------------------------------------
  await scene("The agent gets a budget, not your keys", "Guard contract on the vault account; the agent signs with a limited function-call key");
  const ak = (await provider.viewAccessKey({ accountId: s.vault.id, publicKey: s.agent.publicKey })) as unknown as {
    permission: { FunctionCall?: { receiver_id: string; method_names: string[]; allowance?: string | null } } | string;
  };
  const fc = typeof ak.permission === "object" ? ak.permission.FunctionCall : undefined;
  out(`  vault       ${s.vault.id}`);
  out(`  owner       ${s.owner.id} ${dim("(approves, pauses, sets policy)")}`);
  out(`  agent key   ${s.agent.publicKey.slice(0, 22)}…`);
  out(`              receiver ${fc?.receiver_id}, methods ${fc?.method_names.join(", ")}`);
  out(`  policy      0.5 NEAR per tx, 1 NEAR per rolling 24h; tokens allowlist-only; denylist ${s.drainerParent}`);
  await pause(1500);
  out(`  ${bold("test")}  the agent tries a plain 0.01 NEAR transfer with its own key…`);
  await pause(800);
  try {
    await new Account(s.vault.id, provider, s.agent.key).transfer({ receiverId: s.payee.id, amount: nearToYocto("0.01") });
    out(red("  unexpected: the transfer went through"));
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0]!.replace(/ed25519:\S+/g, "<agent key>");
    out(`  ${red(bold(" REJECTED "))} by the NEAR protocol: a function-call key cannot sign transfers`);
    out(dim(`             (${msg.length > 70 ? msg.slice(0, 69) + "…" : msg})`));
  }
  await pause(1500);

  // 2 ---------------------------------------------------------------------------------------
  await scene("A normal payment", "risk layer ALLOW, contract executes within the caps");
  await run(wallet, messages[0]!, "normal");
  out(`  ${bold("=>")} ${green(bold("paid"))}: 0.2 NEAR sent to ${s.payee.id}`);

  // 3 ---------------------------------------------------------------------------------------
  await scene("A prompt-injected scam", "the agent is gullible on purpose and tries to pay the drainer");
  const injected = await run(wallet, messages[1]!, "injected");
  await pause(600);
  out(dim("  Guard notifies the owner on Telegram:"));
  await reportOutcome(bot, injected, "sandbox", "treasury-agent");
  await pause(2200);

  // 4 ---------------------------------------------------------------------------------------
  await scene("Over the cap: the owner decides from Telegram", "the contract blocks it on chain; the request goes to the owner's phone");
  await run(wallet, messages[2]!, "over-cap");
  out(dim("  Guard sends the request to the owner on Telegram, with a risk check of the receiver:"));
  await bot.syncPending();
  await pause(2500);
  const m = chat.lastWithButtons(OWNER)!;
  const approve = chat.button(m, 1)!;
  chat.showTap(m, approve);
  await pause(600);
  await bot.handleCallback({ callbackId: "video-1", chatId: OWNER, chatType: "private", messageId: m.messageId, userId: OWNER, data: approve.data });
  await pause(2200);

  // 5 ---------------------------------------------------------------------------------------
  await scene("A compromised agent skips the risk layer", "only the on-chain policy is left, and it still refuses");
  const bypass = await run(compromised, messages[1]!, "bypass");
  out(dim("  The owner is told about the blocked attempt:"));
  await reportOutcome(bot, bypass, "sandbox", "treasury-agent");
  await pause(2200);

  // 6 ---------------------------------------------------------------------------------------
  await scene("Community guard in a Telegram group", "anyone can paste an account, token or link and get a verdict");
  for (const [user, text] of [
    ["alice", "/check@GuardBot wrap-near.near"],
    ["bob", "/check@GuardBot https://near.org.claim-rewards.xyz/connect"],
    ["carol", "/check@GuardBot wrap.near"],
  ] as const) {
    chat.showUser(GROUP, user, text);
    await pause(700);
    await bot.handleMessage({ chatId: GROUP, chatType: "supergroup", userId: 3000, userName: user, text });
    await pause(1800);
  }

  // 7 ---------------------------------------------------------------------------------------
  await scene("Swaps through NEAR Intents", "1Click quotes as dry runs: signature, echo, loss and slippage are checked");
  const req = {
    originAsset: "nep141:wrap.near",
    destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    amount: "1000000000000000000000000",
    recipient: "intents.near",
    refundTo: "intents.near",
  };
  for (const [label, bps] of [
    ["swap 1 NEAR -> USDC, 1% slippage", 100],
    ["injected: same swap, 40% slippage", 4000],
  ] as const) {
    const r = await checkIntentsQuote({ ...req, slippageBps: bps }, { fetchImpl: recordedOneClick() });
    const d = r.data ?? {};
    out(`  ${label.padEnd(36)} ${tag(r.verdict)} ${dim(`out ${d.amountOut ?? "?"}, loss ${d.lossPct ?? "?"}%, signature ${d.signatureValid ? "valid" : "n/a"}`)}`);
    for (const f of r.flags.filter((x) => x.severity === "critical" || x.severity === "high").slice(0, 2)) out(`     ${red("✗")} ${f.code}: ${dim(f.message)}`);
    await pause(1600);
  }
  out(dim("  (quote recorded from the live 1Click API on 2026-11-01; dry: true, nothing executes)"));

  // end -------------------------------------------------------------------------------------
  await pause(1200);
  const agent = (await guard.getAgent(s.agent.publicKey)) as { executed: number; blocked: number; limits: Array<{ asset: string; spent_today: string }> };
  out();
  out(cyan("━".repeat(W)));
  out(bold("  On chain after the story"));
  out(`  executed ${agent.executed} · blocked attempts recorded ${agent.blocked} · approved by the owner 1 · scams paid 0`);
  out(cyan("━".repeat(W)));
  out(bold("  Guard") + dim("  caps · deny lists · owner approval on Telegram · scam and phishing checks"));
  out(dim("  Built at NEAR HACKATHON 2026 · MIT · testnet only"));
  if (OSC) process.stdout.write(oscEvent({ type: "end" }));
  await pause(2500);
}
