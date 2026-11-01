import { describe, expect, it } from "vitest";
import { blockedEventsFromLogs, FastNearBlockedSource, GuardBot, MemoryOwnerControl, VaultWatcher } from "../src/telegram";
import { FakeChat, makeChecker } from "./telegram-fixtures";

const VAULT = "vault.owner.testnet";
/** A real log line from testnet tx CV5dxxU… (compromised agent -> drainer, blocked on chain). */
const BLOCKED_LOG =
  'EVENT_JSON:{"standard":"nearguard","version":"1.0.0","event":"transfer_blocked","data":{"agent":"ed25519:8YSMRnKQkZvWuAuCUooF9mbd5Pf9Z8rXRd2zDCx78qHr","asset":"usdc-airdrop.guard-owner-mvxpkwqz.testnet","receiver_id":"claim.drainer-mvxpkwqz.testnet","amount":"250000000","code":"RECIPIENT_DENYLISTED","reason":"recipient drainer-mvxpkwqz.testnet is denylisted: payout account of a known airdrop-drainer campaign"}}';

function fakeChain() {
  const txs: Array<{ transaction_hash: string; is_signer: boolean; tx_block_height: number }> = [];
  const logs: Record<string, string[]> = {};
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("/v0/account")) {
      expect(body.account_id).toBe(VAULT);
      return new Response(JSON.stringify({ account_txs: [...txs].reverse() }));
    }
    expect(body).toMatchObject({ method: "tx", params: { sender_account_id: VAULT } });
    return new Response(JSON.stringify({ result: { transaction_outcome: { outcome: { logs: [] } }, receipts_outcome: [{ outcome: { logs: logs[body.params.tx_hash] ?? [] } }] } }));
  }) as typeof fetch;
  return { txs, logs, fetchImpl };
}

describe("blockedEventsFromLogs", () => {
  it("parses Guard's transfer_blocked events and ignores everything else", () => {
    const ev = blockedEventsFromLogs([BLOCKED_LOG, "plain log", 'EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[]}', "EVENT_JSON:{broken"]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ code: "RECIPIENT_DENYLISTED", receiver_id: "claim.drainer-mvxpkwqz.testnet" });
  });
});

describe("VaultWatcher", () => {
  it("does not replay history, then notifies new pending requests and blocked attempts once", async () => {
    const chain = fakeChain();
    chain.txs.push({ transaction_hash: "old", is_signer: true, tx_block_height: 1 });
    chain.logs.old = [BLOCKED_LOG];
    const chat = new FakeChat();
    const vault = new MemoryOwnerControl(VAULT, { agents: [] }, "testnet");
    const bot = new GuardBot({ chat, checker: makeChecker(), owner: vault, ownerUserIds: [1001], precheckReceivers: false });
    const blocked = new FastNearBlockedSource({
      vaultId: VAULT,
      network: "testnet",
      rpcUrl: "https://rpc.invalid",
      txApiUrl: "https://tx.invalid",
      fetchImpl: chain.fetchImpl,
      agentNames: async () => new Map([["ed25519:8YSMRnKQkZvWuAuCUooF9mbd5Pf9Z8rXRd2zDCx78qHr", "treasury-agent"]]),
    });
    const watcher = new VaultWatcher({ bot, blocked });

    expect(await watcher.tick()).toEqual({ pending: 0, blocked: 0 });

    vault.add({ id: "4" });
    chain.txs.push({ transaction_hash: "newtx", is_signer: true, tx_block_height: 2 }, { transaction_hash: "incoming", is_signer: false, tx_block_height: 3 });
    chain.logs.newtx = [BLOCKED_LOG];
    expect(await watcher.tick()).toEqual({ pending: 1, blocked: 1 });
    expect(await watcher.tick()).toEqual({ pending: 0, blocked: 0 });

    const notice = chat.sent.find((s) => s.text.startsWith("⛔"))!;
    expect(notice.text).toContain('Agent "treasury-agent" tried to send 250000000 units of token usdc-airdrop.guard-owner-mvxpkwqz.testnet to claim.drainer-mvxpkwqz.testnet');
    expect(notice.text).toContain("RECIPIENT_DENYLISTED");
    expect(notice.text).toContain("Tx: https://testnet.nearblocks.io/txns/newtx");
  });

  it("keeps running when a source fails", async () => {
    const chat = new FakeChat();
    const vault = new MemoryOwnerControl(VAULT, { agents: [] }, "testnet");
    vault.listPending = async () => {
      throw new Error("RPC down");
    };
    const logs: string[] = [];
    const watcher = new VaultWatcher({ bot: new GuardBot({ chat, checker: makeChecker(), owner: vault, ownerUserIds: [1] }), blocked: { poll: async () => Promise.reject(new Error("indexer down")) }, log: (m) => logs.push(m) });
    expect(await watcher.tick()).toEqual({ pending: 0, blocked: 0 });
    expect(logs).toEqual(["pending poll failed: RPC down", "blocked poll failed: indexer down"]);
  });
});
