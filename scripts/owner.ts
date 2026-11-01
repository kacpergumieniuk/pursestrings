/**
 * Owner actions on the testnet vault (signed with the owner's full-access key from .guard-local).
 *   npm run owner -- status
 *   npm run owner -- approve <request_id>
 *   npm run owner -- reject <request_id> [note]
 *   npm run owner -- pause | unpause
 *   npm run owner -- report <account_id> <reason...>
 */
import { explorerTx, OwnerGuard } from "../src/near/guard-client";
import { loadState } from "../src/demo/setup";

const [cmd = "status", ...rest] = process.argv.slice(2);
const s = loadState("testnet");
if (!s) {
  console.error("no testnet environment; run `npm run testnet:setup` first");
  process.exit(1);
}
const owner = new OwnerGuard({ vaultId: s.vault.id, rpcUrl: s.rpcUrl, network: "testnet", ownerId: s.owner.id, ownerKey: s.owner.key });
const show = (o: { txHash: string; result: unknown }) => console.log(JSON.stringify(o.result ?? "ok"), explorerTx("testnet", o.txHash));

switch (cmd) {
  case "status":
    console.log(JSON.stringify({ policy: await owner.getPolicy(), agent: await owner.getAgent(s.agent.publicKey), pending: await owner.listPending(), denied: await owner.listDenied("recipient") }, null, 2));
    break;
  case "approve":
    show(await owner.approve(rest[0]!));
    break;
  case "reject":
    show(await owner.reject(rest[0]!, rest.slice(1).join(" ") || undefined));
    break;
  case "pause":
  case "unpause":
    show(await owner.setPaused(cmd === "pause"));
    break;
  case "report":
    show(await owner.report("recipient", rest[0]!, rest.slice(1).join(" ") || "reported by owner"));
    break;
  default:
    console.error(`unknown command ${cmd}`);
    process.exit(1);
}
