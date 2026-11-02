/**
 * Creates a complete PurseStrings demo environment on testnet (free faucet accounts) or on a
 * local sandbox node:
 *
 *   owner   - the human who controls the policy (the only faucet/genesis-created account)
 *   vault.<owner>  - holds the funds; the PurseStrings contract is deployed here
 *   payee.<owner>  - a normal contractor the agent pays
 *   vendor.<owner> - a vendor whose invoice is above the agent per-transaction cap
 *   usdc-airdrop.<owner> - a fake "USDC" token airdropped into the vault (the scam)
 *   claim.drainer-<id>   - the attacker's payout account (never created)
 *
 * Secrets are written to .guard-local/<network>.json (gitignored, mode 0600) and never printed.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, actions, JsonRpcProvider, KeyPair, type KeyPairString, nearToYocto, teraToGas } from "near-api-js";
import { OwnerGuard } from "../near/guard-client";
import type { Network } from "../risk/types";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const STATE_DIR = join(ROOT, ".guard-local");

export interface KeyedAccount {
  id: string;
  key: KeyPairString;
}

export interface DemoState {
  network: Network;
  rpcUrl: string;
  createdAt: string;
  owner: KeyedAccount;
  vault: KeyedAccount;
  payee: KeyedAccount;
  vendor: KeyedAccount;
  agent: { publicKey: string; key: KeyPairString };
  scamToken: string;
  drainer: string;
  drainerParent: string;
  allowedTokens: string[];
  limits: { nearPerTx: string; nearPerDay: string };
}

export const TESTNET_RPC = "https://test.rpc.fastnear.com";
const FAUCET_HELPER = "https://helper.nearprotocol.com/account";
const WASM = {
  guard: join(ROOT, "contracts/target/near/near_guard/near_guard.wasm"),
  token: join(ROOT, "contracts/target/near/test_token/test_token.wasm"),
};
/** Committed builds of the same sources (see contracts/prebuilt/README.md), used when Rust is not installed. */
export const PREBUILT_DIR = join(ROOT, "contracts/prebuilt");

export function statePath(network: Network): string {
  return join(STATE_DIR, `${network}.json`);
}

export function loadState(network: Network): DemoState | undefined {
  const p = statePath(network);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as DemoState) : undefined;
}

export function saveState(s: DemoState): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const p = statePath(s.network);
  writeFileSync(p, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(p, 0o600);
}

function readWasm(path: string): Uint8Array {
  if (existsSync(path)) return new Uint8Array(readFileSync(path));
  const prebuilt = join(PREBUILT_DIR, basename(path));
  if (existsSync(prebuilt)) {
    console.log(`using the committed ${basename(path)} from contracts/prebuilt (run \`npm run build:contracts\` to build your own)`);
    return new Uint8Array(readFileSync(prebuilt));
  }
  throw new Error(`${path} missing: run \`npm run build:contracts\` first`);
}

async function waitForAccount(provider: JsonRpcProvider, id: string, tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await provider.viewAccount({ accountId: id });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`account ${id} did not appear`);
}

/**
 * Creates the one root account of the demo (the owner). Everything else is a sub-account of it,
 * so a testnet run needs a single faucet account.
 */
export interface AccountFactory {
  /** Top-level suffix, e.g. `testnet` or `sandbox`. */
  suffix: string;
  create(name: string, near: `${number}`): Promise<KeyedAccount>;
}

/** Testnet: the public faucet helper creates `<name>.testnet` and funds it with free testnet NEAR. */
export function testnetFactory(provider: JsonRpcProvider): AccountFactory {
  return {
    suffix: "testnet",
    async create(name) {
      const kp = KeyPair.fromRandom("ed25519");
      const id = `${name}.testnet`;
      const res = await fetch(FAUCET_HELPER, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`faucet helper refused ${id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      await waitForAccount(provider, id);
      return { id, key: kp.toString() as KeyPairString };
    },
  };
}

/** Sandbox: the genesis account creates sub-accounts. */
export function sandboxFactory(provider: JsonRpcProvider, genesisId: string, genesisKey: KeyPairString): AccountFactory {
  const genesis = new Account(genesisId, provider, genesisKey);
  return {
    suffix: genesisId,
    async create(name, near) {
      const kp = KeyPair.fromRandom("ed25519");
      await genesis.createSubAccount({ accountOrPrefix: name, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto(near) });
      return { id: `${name}.${genesisId}`, key: kp.toString() as KeyPairString };
    },
  };
}

export async function setupDemo(opts: {
  network: Network;
  rpcUrl: string;
  factory: AccountFactory;
  log?: (msg: string) => void;
  tag?: string;
}): Promise<DemoState> {
  const log = opts.log ?? (() => {});
  const provider = new JsonRpcProvider({ url: opts.rpcUrl });
  const tag = opts.tag ?? Date.now().toString(36);
  const guardWasm = readWasm(WASM.guard);
  const tokenWasm = readWasm(WASM.token);

  log(`creating the root dev account (tag ${tag})`);
  const owner = await opts.factory.create(`purse-owner-${tag}`, "20");
  const ownerAcc = new Account(owner.id, provider, owner.key);
  const sub = async (prefix: string, near: `${number}`): Promise<KeyedAccount> => {
    const kp = KeyPair.fromRandom("ed25519");
    await ownerAcc.createSubAccount({ accountOrPrefix: prefix, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearToYocto(near) });
    return { id: `${prefix}.${owner.id}`, key: kp.toString() as KeyPairString };
  };
  const vault = await sub("vault", "5.5");
  const payee = await sub("payee", "0.1");
  const vendor = await sub("vendor", "0.1");
  log(`owner ${owner.id}; vault ${vault.id}; payee ${payee.id}; vendor ${vendor.id}`);

  log("deploying the PurseStrings contract to the vault");
  const vaultAcc = new Account(vault.id, provider, vault.key);
  await vaultAcc.signAndSendTransaction({
    receiverId: vault.id,
    actions: [
      actions.deployContract(guardWasm),
      actions.functionCall("new", { owner_id: owner.id, min_balance_reserve: nearToYocto("0.5").toString() }, teraToGas("30"), 0n),
    ],
    waitUntil: "FINAL",
  });

  log("deploying a fake 'USDC' token and airdropping it into the vault");
  const token = await sub("usdc-airdrop", "1.9");
  const scamToken = token.id;
  const tokenAcc = new Account(scamToken, provider, token.key);
  await tokenAcc.signAndSendTransaction({
    receiverId: scamToken,
    actions: [
      actions.deployContract(tokenWasm),
      actions.functionCall(
        "new",
        {
          owner_id: vault.id,
          total_supply: "1000000000000",
          name: "USD Coin - claim your bonus at near-airdrop-claim.xyz",
          symbol: "USDC",
          decimals: 6,
          icon: null,
        },
        teraToGas("30"),
        0n,
      ),
    ],
    waitUntil: "FINAL",
  });

  const agentKp = KeyPair.fromRandom("ed25519");
  const agent = { publicKey: agentKp.getPublicKey().toString(), key: agentKp.toString() as KeyPairString };
  const limits = { nearPerTx: nearToYocto("0.5").toString(), nearPerDay: nearToYocto("1").toString() };
  const allowedTokens =
    opts.network === "testnet" ? ["wrap.testnet", "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"] : [];

  const ownerGuard = new OwnerGuard({ vaultId: vault.id, rpcUrl: opts.rpcUrl, network: opts.network, ownerId: owner.id, ownerKey: owner.key });
  log("owner registers the agent: the contract adds a function-call key to the vault");
  await ownerGuard.addAgent(agent.publicKey, "treasury-agent", [
    { asset: "near", per_tx: limits.nearPerTx, per_day: limits.nearPerDay },
    ...allowedTokens.map((t) => ({ asset: t, per_tx: "10000000", per_day: "20000000" })),
  ]);
  if (allowedTokens.length) await ownerGuard.allow("token", allowedTokens);

  const drainerParent = `drainer-${tag}.${opts.factory.suffix}`;
  log(`owner adds ${drainerParent} (and all its sub-accounts) to the on-chain denylist`);
  await ownerGuard.report("recipient", drainerParent, "payout account of a known airdrop-drainer campaign", "https://example.org/pursestrings-demo/report-1");

  const state: DemoState = {
    network: opts.network,
    rpcUrl: opts.rpcUrl,
    createdAt: new Date().toISOString(),
    owner,
    vault,
    payee,
    vendor,
    agent,
    scamToken,
    drainer: `claim.${drainerParent}`,
    drainerParent,
    allowedTokens,
    limits,
  };
  return state;
}
