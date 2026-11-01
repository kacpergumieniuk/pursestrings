/**
 * Counterparty check for a payment receiver: does the account exist, how old is it,
 * is it a contract whose code just changed, does its name imitate a known account,
 * is it on a scam list, have we paid it before?
 */
import { checkAccountName, isImplicitAccount } from "./account-name";
import type { NearDataSource } from "./near-data";
import type { ScamList } from "./scam-list";
import { type CheckResult, type Flag, result } from "./types";

const DAY = 86_400_000;

export interface CounterpartyOptions {
  data: NearDataSource;
  scamList?: ScamList;
  trustedAccounts?: string[];
  /** Receivers this agent has paid successfully before (local ledger). */
  priorPayees?: Set<string>;
  now?: number;
}

export async function checkCounterparty(receiverId: string, opts: CounterpartyOptions): Promise<CheckResult> {
  const id = receiverId.trim().toLowerCase();
  const now = opts.now ?? Date.now();
  const name = checkAccountName(id, { network: opts.data.network, trusted: opts.trustedAccounts, scamList: opts.scamList });
  const flags: Flag[] = [...name.flags];
  const facts: Record<string, unknown> = {};
  if (flags.some((f) => f.code === "INVALID_ACCOUNT_ID" || f.code === "NON_ASCII_ACCOUNT")) {
    return result("counterparty", id, flags, facts);
  }
  const trusted = (opts.trustedAccounts ?? []).map((a) => a.toLowerCase()).includes(id);
  if (trusted) flags.push({ code: "TRUSTED_RECEIVER", severity: "info", message: `${id} is on the owner's trusted list` });

  const acct = await opts.data.viewAccount(id);
  facts.exists = acct.exists;
  facts.isContract = acct.hasContract;
  if (!acct.exists) {
    if (isImplicitAccount(id)) {
      flags.push({ code: "UNFUNDED_IMPLICIT", severity: "low", message: "implicit account has never been funded" });
    } else {
      flags.push({
        code: "ACCOUNT_NOT_FOUND",
        severity: "high",
        message: `${id} does not exist on ${opts.data.network}: the transfer would fail, and whoever registers the name later gets future payments`,
      });
    }
    return result("counterparty", id, flags, facts);
  }

  if (acct.hasContract) flags.push({ code: "IS_CONTRACT", severity: "info", message: "receiver is a smart contract" });

  if (!trusted) {
    const created = await opts.data.createdAt?.(id);
    if (created) {
      const age = now - created;
      facts.ageMs = age;
      if (age < DAY) flags.push({ code: "NEW_ACCOUNT", severity: "medium", message: `account is less than a day old` });
      else if (age < 7 * DAY) flags.push({ code: "NEW_ACCOUNT", severity: "low", message: `account is ${Math.round(age / DAY)} days old` });
    }
    if (acct.hasContract) {
      const deploys = await opts.data.deployments?.(id);
      if (deploys && deploys.length > 1 && now - deploys[0]! < 7 * DAY) {
        flags.push({ code: "CODE_CHANGED_RECENTLY", severity: "medium", message: "contract code was replaced in the last 7 days" });
      }
    }
    if (opts.priorPayees && !opts.priorPayees.has(id)) {
      flags.push({ code: "FIRST_PAYMENT", severity: "low", message: "this agent has never paid this receiver" });
    }
  }
  return result("counterparty", id, flags, facts);
}
