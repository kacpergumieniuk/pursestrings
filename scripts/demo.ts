/**
 * npm run demo                  -> run against the testnet environment from `npm run testnet:setup`
 * npm run demo:sandbox          -> start a local NEAR sandbox, deploy everything, run, tear down
 *
 * Flags:
 *   --bypass-risk   skip the off-chain risk layer (simulates a compromised agent; the contract still enforces)
 *   --approve-warn  auto-approve WARN verdicts (default: ask on a TTY, otherwise decline)
 *   --no-intents    skip the NEAR Intents dry-run bonus step
 */
import { createInterface } from "node:readline/promises";
import { approveAll, denyAll, type HumanApprover } from "../src/agent/guarded-wallet";
import { runDemo } from "../src/demo/run";
import { loadState, sandboxFactory, setupDemo, statePath } from "../src/demo/setup";
import { JsonRpcProvider, type KeyPairString } from "near-api-js";

const args = new Set(process.argv.slice(2));

const interactive: HumanApprover = {
  async approve(a) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question(`  WARN: ${a.reasons.slice(0, 2).join(" | ")}\n  approve this action? [y/N] `);
    rl.close();
    return /^y(es)?$/i.test(ans.trim());
  },
};
const approver = args.has("--approve-warn") ? approveAll : process.stdin.isTTY ? interactive : denyAll;
const opts = { bypassRiskLayer: args.has("--bypass-risk"), approver, intents: !args.has("--no-intents") };

if (args.has("--sandbox")) {
  const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = await import("near-sandbox");
  console.log("starting a local NEAR sandbox node (first run downloads the binary)...");
  const sandbox = await Sandbox.start({});
  try {
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const state = await setupDemo({
      network: "sandbox",
      rpcUrl: sandbox.rpcUrl,
      factory: sandboxFactory(provider, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY as KeyPairString),
      log: (m) => console.log(`  setup: ${m}`),
      tag: "demo",
    });
    await runDemo(state, opts);
  } finally {
    await sandbox.tearDown();
  }
} else {
  const state = loadState("testnet");
  if (!state) {
    console.error(`No testnet environment at ${statePath("testnet")}. Run \`npm run testnet:setup\` first, or try \`npm run demo:sandbox\`.`);
    process.exit(1);
  }
  await runDemo(state, opts);
}
