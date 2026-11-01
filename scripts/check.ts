/**
 * Stand-alone risk checks (read-only, no keys needed).
 *   npm run check -- account <account_id> [--network mainnet|testnet]
 *   npm run check -- token <token_contract> [--network ...]
 *   npm run check -- url <url>
 *   npm run check -- text "<message the agent received>"
 *   npm run check -- swap <amount_in_NEAR> [destination_asset_id] [--slippage-bps 100]
 *   npm run check -- evm <0xaddress>          (needs GUARD_EVM_VERDICT_URL)
 * Add --json for machine-readable output.
 */
import "../src/demo/env";
import { printAssessment } from "../src/demo/print";
import { checkEvmToken, LiveNearData, RiskEngine, ScamList, type AgentAction, type Network } from "../src/risk";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const network = (flag("--network") ?? "mainnet") as Network;
const slippage = Number(flag("--slippage-bps") ?? 100);
const json = argv.includes("--json");
const [kind, ...rest] = argv.filter((a) => a !== "--json");
const target = rest.join(" ");

const engine = new RiskEngine({ data: new LiveNearData({ network }), scamList: await ScamList.load() });
let action: AgentAction;
let sourceText: string | undefined;
switch (kind) {
  case "account":
    action = { kind: "transfer_near", receiverId: target, amount: "1" };
    break;
  case "token":
    action = { kind: "transfer_ft", tokenId: target, receiverId: network === "mainnet" ? "near" : "testnet", amount: "1" };
    break;
  case "url":
    action = { kind: "open_link", url: target };
    break;
  case "text":
    action = { kind: "open_link", url: "https://near.org" };
    sourceText = target;
    break;
  case "swap": {
    const [amt = "1", dest = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"] = rest;
    const recipient = process.env.GUARD_INTENTS_RECIPIENT ?? "intents.near";
    action = { kind: "swap", originAsset: "nep141:wrap.near", destinationAsset: dest, amount: (BigInt(Math.round(Number(amt) * 1e6)) * 10n ** 18n).toString(), recipient, refundTo: recipient, slippageBps: slippage };
    break;
  }
  case "evm": {
    const r = await checkEvmToken("base", target);
    console.log(json ? JSON.stringify(r, null, 2) : `${r.verdict}: ${r.reasons.join("; ")}`);
    process.exit(0);
  }
  default:
    console.error("usage: npm run check -- account|token|url|text|swap|evm <target> [--network mainnet|testnet] [--json]");
    process.exit(1);
}
const a = await engine.assess(action, sourceText ? { sourceText } : undefined);
if (json) console.log(JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
else {
  if (kind === "account") a.checks = a.checks.filter((c) => c.check !== "context");
  printAssessment(a);
}
