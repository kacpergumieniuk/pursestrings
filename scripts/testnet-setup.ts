/**
 * Creates throwaway testnet accounts with the public faucet, deploys the Guard and the fake token,
 * registers the agent and writes everything to .guard-local/testnet.json (gitignored, 0600).
 * Keys are never printed. Testnet only: this script refuses any other network.
 *
 *   npm run testnet:setup            # creates a new environment if none exists
 *   npm run testnet:setup -- --force # creates a fresh one
 *   npm run testnet:setup -- --redeploy # upgrades the Guard code on the existing vault (state is kept)
 */
import "../src/demo/env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, JsonRpcProvider } from "near-api-js";
import { explorerAccount } from "../src/near/guard-client";
import { loadState, ROOT, saveState, setupDemo, statePath, TESTNET_RPC, testnetFactory } from "../src/demo/setup";

const rpcUrl = process.env.GUARD_TESTNET_RPC ?? TESTNET_RPC;
// Safety: refuse anything that is not testnet (never touch mainnet accounts or funds).
const status = (await (
  await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }) })
).json()) as { result?: { chain_id?: string } };
if (status.result?.chain_id !== "testnet") throw new Error(`refusing to run: ${rpcUrl} reports chain_id ${status.result?.chain_id}`);

const existing = loadState("testnet");
if (existing && process.argv.includes("--redeploy")) {
  const wasm = new Uint8Array(readFileSync(join(ROOT, "contracts/target/near/near_guard/near_guard.wasm")));
  const vault = new Account(existing.vault.id, new JsonRpcProvider({ url: rpcUrl }), existing.vault.key);
  const r = await vault.deployContract(wasm);
  console.log(`redeployed Guard to ${existing.vault.id}: ${explorerAccount("testnet", existing.vault.id)} (tx ${(r as { transaction: { hash: string } }).transaction.hash})`);
  process.exit(0);
}
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
