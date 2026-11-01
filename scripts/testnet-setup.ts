/**
 * Creates throwaway testnet accounts with the public faucet, deploys the Guard and the fake token,
 * registers the agent and writes everything to .guard-local/testnet.json (gitignored, 0600).
 * Keys are never printed. Testnet only: this script refuses any other network.
 *
 *   npm run testnet:setup            # creates a new environment if none exists
 *   npm run testnet:setup -- --force # creates a fresh one
 */
import { JsonRpcProvider } from "near-api-js";
import { explorerAccount } from "../src/near/guard-client";
import { loadState, saveState, setupDemo, statePath, TESTNET_RPC, testnetFactory } from "../src/demo/setup";

const rpcUrl = process.env.GUARD_TESTNET_RPC ?? TESTNET_RPC;
if (!/testnet/.test(rpcUrl)) throw new Error(`refusing to run against a non-testnet RPC: ${rpcUrl}`);

const existing = loadState("testnet");
if (existing && !process.argv.includes("--force")) {
  console.log(`testnet environment already exists (${statePath("testnet")}): vault ${existing.vault.id}. Use --force for a new one.`);
  process.exit(0);
}
const provider = new JsonRpcProvider({ url: rpcUrl });
const state = await setupDemo({ network: "testnet", rpcUrl, factory: testnetFactory(provider), log: (m) => console.log(`setup: ${m}`) });
saveState(state);
console.log(`\nsaved to ${statePath("testnet")} (keys stay in that file)`);
for (const [label, id] of [
  ["owner", state.owner.id],
  ["vault (Guard contract)", state.vault.id],
  ["payee", state.payee.id],
  ["vendor", state.vendor.id],
  ["fake USDC token", state.scamToken],
] as const) {
  console.log(`  ${label.padEnd(24)} ${explorerAccount("testnet", id)}`);
}
console.log(`  agent function-call key  ${state.agent.publicKey}`);
