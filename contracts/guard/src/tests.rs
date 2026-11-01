//! Unit tests for the Guard policy engine (mocked blockchain).

use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

const AGENT_A: &str = "ed25519:4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const AGENT_B: &str = "ed25519:8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const STRANGER_KEY: &str = "ed25519:CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";
const HOUR: u64 = 3_600 * 1_000_000_000;
const DAY: u64 = 24 * HOUR;
const T0: u64 = 1_793_500_000 * 1_000_000_000; // 2026-11-01 02:26:40 UTC
/// 2026-11-01 23:30 UTC, half an hour before the UTC day boundary.
const LATE: u64 = (T0 / DAY) * DAY + 23 * HOUR + 30 * 60 * 1_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn pk(s: &str) -> PublicKey {
    s.parse().unwrap()
}
fn near(n: u128) -> U128 {
    U128(n * 10u128.pow(24))
}
fn vault() -> AccountId {
    acc("vault.testnet")
}
fn owner() -> AccountId {
    acc("owner.testnet")
}
fn usdc() -> AccountId {
    acc("usdc.fakes.testnet")
}

fn base_ctx(ts: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault())
        .account_balance(NearToken::from_near(100))
        .block_timestamp(ts);
    b
}

fn as_owner(ts: u64) {
    let mut b = base_ctx(ts);
    b.predecessor_account_id(owner())
        .signer_account_id(owner())
        .attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(b.build());
}

fn as_agent(key: &str, ts: u64) {
    let mut b = base_ctx(ts);
    b.predecessor_account_id(vault())
        .signer_account_id(vault())
        .signer_account_pk(pk(key));
    testing_env!(b.build());
}

fn as_account(a: &str, ts: u64) {
    let mut b = base_ctx(ts);
    b.predecessor_account_id(acc(a)).signer_account_id(acc(a));
    testing_env!(b.build());
}

fn as_callback(ts: u64, result: PromiseResult) {
    let mut b = base_ctx(ts);
    b.predecessor_account_id(vault()).signer_account_id(vault());
    testing_env!(
        b.build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn limits_near(per_tx: u128, per_day: u128) -> Vec<AssetLimitInput> {
    vec![AssetLimitInput {
        asset: "near".into(),
        per_tx: near(per_tx),
        per_day: near(per_day),
    }]
}

/// Vault with one agent: 2 NEAR per tx, 5 NEAR per day; 100 USDC (6 dp) per tx / 250 per day.
fn setup() -> Guard {
    as_owner(T0);
    let mut g = Guard::new(owner(), None);
    let mut limits = limits_near(2, 5);
    limits.push(AssetLimitInput {
        asset: usdc().to_string(),
        per_tx: U128(100_000_000),
        per_day: U128(250_000_000),
    });
    let _ = g.add_agent(pk(AGENT_A), "treasury-bot".into(), limits, None);
    g.allow(ListKind::Token, vec![usdc()]);
    g
}

fn send_near(g: &mut Guard, key: &str, to: &str, amount: U128) -> Option<GuardResult> {
    send_near_at(g, key, to, amount, T0)
}

fn send_near_at(g: &mut Guard, key: &str, to: &str, amount: U128, ts: u64) -> Option<GuardResult> {
    as_agent(key, ts);
    match g.agent_transfer_near(acc(to), amount, None) {
        PromiseOrValue::Value(r) => Some(r),
        PromiseOrValue::Promise(_) => None, // executed (promise scheduled)
    }
}

/// The NEAR limit view of `key` as seen at `ts`.
fn near_view_at(g: &Guard, key: &str, ts: u64) -> AssetLimitView {
    as_account("anyone.testnet", ts);
    g.get_agent(pk(key))
        .unwrap()
        .limits
        .into_iter()
        .find(|l| l.asset == "near")
        .unwrap()
}

#[test]
fn init_defaults() {
    let g = setup();
    let p = g.get_policy();
    assert_eq!(p.owner_id, owner());
    assert!(!p.paused);
    assert_eq!(p.recipient_mode, ListMode::Open);
    assert_eq!(p.token_mode, ListMode::AllowlistOnly);
    assert_eq!(p.agents, 1);
    assert_eq!(g.version(), env!("CARGO_PKG_VERSION"));
}

#[test]
#[should_panic(expected = "owner only")]
fn add_agent_requires_owner() {
    let mut g = setup();
    let mut b = base_ctx(T0);
    b.predecessor_account_id(acc("mallory.testnet"))
        .attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(b.build());
    let _ = g.add_agent(pk(AGENT_B), "evil".into(), limits_near(100, 100), None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_calls_require_one_yocto() {
    let mut g = setup();
    as_account("owner.testnet", T0);
    g.set_paused(true);
}

#[test]
#[should_panic(expected = "per_tx cap cannot exceed per_day cap")]
fn rejects_inconsistent_limits() {
    let mut g = setup();
    as_owner(T0);
    let _ = g.add_agent(pk(AGENT_B), "b".into(), limits_near(10, 1), None);
}

#[test]
fn add_agent_schedules_function_call_key() {
    as_owner(T0);
    let mut g = Guard::new(owner(), None);
    let _ = g.add_agent(pk(AGENT_A), "a".into(), limits_near(1, 1), None);
    let receipts = near_sdk::test_utils::get_created_receipts();
    let dbg = format!("{receipts:?}");
    assert!(dbg.contains("AddKeyWithFunctionCall"), "{dbg}");
    assert!(dbg.contains("agent_transfer_near"), "{dbg}");
    assert!(dbg.contains("vault.testnet"), "{dbg}");
}

#[test]
fn transfer_within_caps_executes_and_tracks_spend() {
    let mut g = setup();
    assert_eq!(send_near(&mut g, AGENT_A, "alice.testnet", near(2)), None);
    let logs = get_logs().join("\n");
    assert!(logs.contains("transfer_allowed"), "{logs}");
    let v = g.get_agent(pk(AGENT_A)).unwrap();
    let l = v.limits.iter().find(|l| l.asset == "near").unwrap();
    assert_eq!(l.spent_today, near(2));
    assert_eq!(l.remaining_today, near(3));
}

#[test]
fn over_per_tx_cap_is_blocked_and_recorded() {
    let mut g = setup();
    let r = send_near(&mut g, AGENT_A, "alice.testnet", near(3)).unwrap();
    assert_eq!(r.status, "blocked");
    assert_eq!(r.code, "OVER_TX_CAP");
    assert!(get_logs().join("").contains("transfer_blocked"));
    let v = g.get_agent(pk(AGENT_A)).unwrap();
    assert_eq!(v.blocked, 1);
    assert_eq!(
        v.limits
            .iter()
            .find(|l| l.asset == "near")
            .unwrap()
            .spent_today,
        U128(0)
    );
}

#[test]
fn daily_cap_accumulates_within_the_window() {
    let mut g = setup();
    assert!(send_near(&mut g, AGENT_A, "alice.testnet", near(2)).is_none());
    assert!(send_near(&mut g, AGENT_A, "alice.testnet", near(2)).is_none());
    let r = send_near(&mut g, AGENT_A, "alice.testnet", near(2)).unwrap();
    assert_eq!(r.code, "OVER_DAILY_CAP");
    assert_eq!(
        r.reason,
        "2 NEAR + 4 NEAR spent in the last 24h exceeds the daily cap of 5 NEAR"
    );
    // 1 NEAR still fits.
    assert!(send_near(&mut g, AGENT_A, "alice.testnet", near(1)).is_none());
    let v = near_view_at(&g, AGENT_A, T0);
    assert_eq!(v.spent_today, near(5));
    assert_eq!(v.remaining_today, near(0));
}

#[test]
fn window_does_not_reset_at_utc_midnight() {
    // The bug being fixed: with a UTC-day cap, 4 NEAR at 23:30 plus 4 more at 00:30 both passed.
    let mut g = setup();
    assert!(send_near_at(&mut g, AGENT_A, "alice.testnet", near(2), LATE).is_none());
    assert!(send_near_at(&mut g, AGENT_A, "alice.testnet", near(2), LATE).is_none());
    let after_midnight = LATE + HOUR;
    assert_ne!(
        after_midnight / DAY,
        LATE / DAY,
        "must cross a UTC day boundary"
    );
    let r = send_near_at(&mut g, AGENT_A, "alice.testnet", near(2), after_midnight).unwrap();
    assert_eq!(r.code, "OVER_DAILY_CAP");
    assert!(r.reason.contains("spent in the last 24h"), "{}", r.reason);
    let v = near_view_at(&g, AGENT_A, after_midnight);
    assert_eq!(v.spent_today, near(4));
    assert_eq!(v.remaining_today, near(1));
    assert!(send_near_at(&mut g, AGENT_A, "alice.testnet", near(1), after_midnight).is_none());
}

#[test]
fn budget_is_fresh_after_25_hours() {
    let mut g = setup();
    for amt in [2, 2, 1] {
        assert!(send_near_at(&mut g, AGENT_A, "alice.testnet", near(amt), LATE).is_none());
    }
    // Still counted 24h later (each spend counts for 24h to 25h)...
    let r = send_near_at(&mut g, AGENT_A, "alice.testnet", near(1), LATE + DAY).unwrap();
    assert_eq!(r.code, "OVER_DAILY_CAP");
    let v = near_view_at(&g, AGENT_A, LATE + DAY);
    assert_eq!(v.spent_today, near(5));
    let frees_at = (LATE / HOUR + 25) * HOUR;
    assert_eq!(v.next_release_at, Some(U64(frees_at)));
    assert!(frees_at > LATE + DAY && frees_at <= LATE + 25 * HOUR);
    // ...and gone once the bucket expires.
    let v = near_view_at(&g, AGENT_A, frees_at);
    assert_eq!(v.spent_today, U128(0));
    assert_eq!(v.next_release_at, None);
    assert!(send_near_at(&mut g, AGENT_A, "alice.testnet", near(2), LATE + 25 * HOUR).is_none());
    let v = near_view_at(&g, AGENT_A, LATE + 25 * HOUR);
    assert_eq!(v.spent_today, near(2));
}

#[test]
fn spends_expire_individually() {
    let mut g = setup();
    assert!(send_near_at(&mut g, AGENT_A, "alice.testnet", near(2), T0).is_none());
    assert!(send_near_at(&mut g, AGENT_A, "alice.testnet", near(2), T0 + 12 * HOUR).is_none());
    let v = near_view_at(&g, AGENT_A, T0 + 12 * HOUR);
    assert_eq!(v.spent_today, near(4));
    assert_eq!(v.next_release_at, Some(U64((T0 / HOUR + 25) * HOUR)));
    // At T+25h only the second spend counts.
    let at = T0 + 25 * HOUR;
    let v = near_view_at(&g, AGENT_A, at);
    assert_eq!(v.spent_today, near(2));
    assert_eq!(v.remaining_today, near(3));
    assert_eq!(
        v.next_release_at,
        Some(U64(((T0 + 12 * HOUR) / HOUR + 25) * HOUR))
    );
    // 3 NEAR fits (2 + 1), a further 1 does not.
    assert!(send_near_at(&mut g, AGENT_A, "alice.testnet", near(2), at).is_none());
    assert!(send_near_at(&mut g, AGENT_A, "alice.testnet", near(1), at).is_none());
    let r = send_near_at(&mut g, AGENT_A, "alice.testnet", near(1), at).unwrap();
    assert_eq!(r.code, "OVER_DAILY_CAP");
    // The expired bucket was pruned on write.
    let buckets = &g.agents.get(AGENT_A).unwrap().spent["near"];
    assert_eq!(
        buckets,
        &vec![((T0 + 12 * HOUR) / HOUR, near(2).0), (at / HOUR, near(3).0)]
    );
}

#[test]
fn bucket_count_stays_bounded() {
    as_owner(T0);
    let mut g = Guard::new(owner(), None);
    let _ = g.add_agent(pk(AGENT_A), "a".into(), limits_near(1, 100), None);
    // One spend every 20 minutes for 100 hours.
    for i in 0..300u64 {
        let ts = T0 + i * HOUR / 3;
        assert!(
            send_near_at(&mut g, AGENT_A, "alice.testnet", U128(1), ts).is_none(),
            "spend {i}"
        );
        let buckets = &g.agents.get(AGENT_A).unwrap().spent["near"];
        assert!(buckets.len() <= 25, "{} buckets at {i}", buckets.len());
        // Same-hour spends are merged; buckets are strictly increasing in hour.
        assert!(buckets.windows(2).all(|w| w[0].0 < w[1].0));
    }
    let last = T0 + 299 * HOUR / 3;
    let buckets = &g.agents.get(AGENT_A).unwrap().spent["near"];
    assert_eq!(buckets.len(), 25);
    let v = near_view_at(&g, AGENT_A, last);
    assert_eq!(
        v.spent_today.0,
        buckets.iter().map(|(_, a)| a).sum::<u128>()
    );
    assert!(v.spent_today.0 >= 72 && v.spent_today.0 <= 75);
}

#[test]
fn unknown_key_is_blocked() {
    let mut g = setup();
    let r = send_near(&mut g, STRANGER_KEY, "alice.testnet", near(1)).unwrap();
    assert_eq!(r.code, "UNKNOWN_AGENT");
}

#[test]
#[should_panic(expected = "agent methods must be signed with an agent key of the vault account")]
fn other_accounts_cannot_call_agent_methods() {
    let mut g = setup();
    as_account("mallory.testnet", T0);
    let _ = g.agent_transfer_near(acc("mallory.testnet"), near(1), None);
}

#[test]
fn tokens_need_allowlist_and_denylist_wins() {
    let mut g = setup();
    as_agent(AGENT_A, T0);
    let r = g.agent_transfer_ft(acc("scamcoin.testnet"), acc("alice.testnet"), U128(1), None);
    let PromiseOrValue::Value(r) = r else {
        panic!("expected block")
    };
    assert_eq!(r.code, "TOKEN_NOT_ALLOWLISTED");

    assert!(matches!(
        g.agent_transfer_ft(usdc(), acc("alice.testnet"), U128(50_000_000), None),
        PromiseOrValue::Promise(_)
    ));

    as_owner(T0);
    g.report(
        ListKind::Token,
        usdc(),
        "issuer compromised".into(),
        Some("https://example.org/x".into()),
    );
    as_agent(AGENT_A, T0);
    let PromiseOrValue::Value(r) = g.agent_transfer_ft(usdc(), acc("alice.testnet"), U128(1), None)
    else {
        panic!("expected block")
    };
    assert_eq!(r.code, "TOKEN_DENYLISTED");
    assert!(r.reason.contains("issuer compromised"));
}

#[test]
fn token_caps_are_independent_of_near_caps() {
    let mut g = setup();
    as_agent(AGENT_A, T0);
    let PromiseOrValue::Value(r) =
        g.agent_transfer_ft(usdc(), acc("alice.testnet"), U128(100_000_001), None)
    else {
        panic!("expected block")
    };
    assert_eq!(r.code, "OVER_TX_CAP");
    // An allowlisted token without a budget for this agent:
    as_owner(T0);
    g.allow(ListKind::Token, vec![acc("usdt.fakes.testnet")]);
    as_agent(AGENT_A, T0);
    let PromiseOrValue::Value(r) = g.agent_transfer_ft(
        acc("usdt.fakes.testnet"),
        acc("alice.testnet"),
        U128(1),
        None,
    ) else {
        panic!("expected block")
    };
    assert_eq!(r.code, "ASSET_NOT_PERMITTED");
}

#[test]
fn recipient_denylist_covers_sub_accounts_only() {
    let mut g = setup();
    as_owner(T0);
    g.report(
        ListKind::Recipient,
        acc("drainer.testnet"),
        "known drainer".into(),
        None,
    );
    let r = send_near(&mut g, AGENT_A, "claim.drainer.testnet", near(1)).unwrap();
    assert_eq!(r.code, "RECIPIENT_DENYLISTED");
    assert!(r.reason.contains("drainer.testnet"));
    // A different account that merely ends with the same letters is not affected.
    assert!(send_near(&mut g, AGENT_A, "notdrainer.testnet", near(1)).is_none());
    assert!(
        g.get_deny_entry(ListKind::Recipient, acc("a.b.drainer.testnet"))
            .is_some()
    );
    assert!(
        g.get_deny_entry(ListKind::Recipient, acc("xdrainer.testnet"))
            .is_none()
    );
}

#[test]
fn recipient_allowlist_mode() {
    let mut g = setup();
    as_owner(T0);
    g.set_list_mode(ListKind::Recipient, ListMode::AllowlistOnly);
    g.allow(ListKind::Recipient, vec![acc("payroll.testnet")]);
    assert!(send_near(&mut g, AGENT_A, "payroll.testnet", near(1)).is_none());
    let r = send_near(&mut g, AGENT_A, "alice.testnet", near(1)).unwrap();
    assert_eq!(r.code, "RECIPIENT_NOT_ALLOWLISTED");
    as_owner(T0);
    g.unallow(ListKind::Recipient, vec![acc("payroll.testnet")]);
    assert_eq!(
        send_near(&mut g, AGENT_A, "payroll.testnet", near(1))
            .unwrap()
            .code,
        "RECIPIENT_NOT_ALLOWLISTED"
    );
}

#[test]
fn pause_and_disable() {
    let mut g = setup();
    as_owner(T0);
    g.set_paused(true);
    assert_eq!(
        send_near(&mut g, AGENT_A, "alice.testnet", near(1))
            .unwrap()
            .code,
        "PAUSED"
    );
    as_owner(T0);
    g.set_paused(false);
    g.set_agent_enabled(pk(AGENT_A), false);
    assert_eq!(
        send_near(&mut g, AGENT_A, "alice.testnet", near(1))
            .unwrap()
            .code,
        "AGENT_DISABLED"
    );
}

#[test]
fn zero_and_self_transfers_are_blocked() {
    let mut g = setup();
    assert_eq!(
        send_near(&mut g, AGENT_A, "alice.testnet", U128(0))
            .unwrap()
            .code,
        "ZERO_AMOUNT"
    );
    assert_eq!(
        send_near(&mut g, AGENT_A, "vault.testnet", near(1))
            .unwrap()
            .code,
        "SELF_TRANSFER"
    );
}

#[test]
fn reserve_protects_storage_and_gas_money() {
    as_owner(T0);
    let mut g = Guard::new(owner(), Some(near(99)));
    let _ = g.add_agent(pk(AGENT_A), "a".into(), limits_near(5, 5), None);
    // Balance 100, reserve 99 (+ storage): 2 NEAR is not spendable.
    let r = send_near(&mut g, AGENT_A, "alice.testnet", near(2)).unwrap();
    assert_eq!(r.code, "INSUFFICIENT_BALANCE");
}

#[test]
fn reporters() {
    let mut g = setup();
    as_owner(T0);
    g.set_reporter(acc("risk-oracle.testnet"), true);
    as_account("risk-oracle.testnet", T0);
    g.report(
        ListKind::Recipient,
        acc("phish.testnet"),
        "lookalike of wrap.testnet".into(),
        None,
    );
    let denied = g.list_denied(ListKind::Recipient, None, None);
    assert_eq!(denied.len(), 1);
    assert_eq!(denied[0].entry.reported_by, acc("risk-oracle.testnet"));
}

#[test]
#[should_panic(expected = "only the owner or an approved reporter can report")]
fn strangers_cannot_report() {
    let mut g = setup();
    as_account("mallory.testnet", T0);
    g.report(
        ListKind::Recipient,
        acc("alice.testnet"),
        "grief".into(),
        None,
    );
}

#[test]
fn over_cap_can_be_escalated_and_approved() {
    let mut g = setup();
    as_agent(AGENT_A, T0);
    let r = g.agent_request_approval(
        "near".into(),
        acc("vendor.testnet"),
        near(20),
        None,
        "annual invoice".into(),
    );
    assert_eq!(r.status, "pending_approval");
    assert_eq!(r.code, "OVER_TX_CAP");
    let id = r.request_id.unwrap();
    assert_eq!(g.list_pending(None, None).len(), 1);
    assert_eq!(g.get_agent(pk(AGENT_A)).unwrap().pending, 1);

    as_owner(T0);
    let _ = g.approve_request(id);
    assert!(g.list_pending(None, None).is_empty());
    assert_eq!(g.get_agent(pk(AGENT_A)).unwrap().pending, 0);
    assert!(get_logs().join("").contains("approval_resolved"));
    // Approved transfers do not consume the agent's own daily budget.
    let near_l = g
        .get_agent(pk(AGENT_A))
        .unwrap()
        .limits
        .into_iter()
        .find(|l| l.asset == "near")
        .unwrap();
    assert_eq!(near_l.spent_today, U128(0));
}

#[test]
fn denylisted_recipient_cannot_be_escalated() {
    let mut g = setup();
    as_owner(T0);
    g.report(
        ListKind::Recipient,
        acc("drainer.testnet"),
        "known drainer".into(),
        None,
    );
    as_agent(AGENT_A, T0);
    let r = g.agent_request_approval(
        "near".into(),
        acc("drainer.testnet"),
        near(1),
        None,
        "trust me".into(),
    );
    assert_eq!(r.status, "blocked");
    assert_eq!(r.code, "RECIPIENT_DENYLISTED");
    assert!(g.list_pending(None, None).is_empty());
}

#[test]
fn hard_blocks_win_over_soft_ones() {
    // Unknown token (soft) + denylisted recipient (hard): the hard block is reported and cannot be escalated.
    let mut g = setup();
    as_owner(T0);
    g.report(
        ListKind::Recipient,
        acc("drainer.testnet"),
        "known drainer".into(),
        None,
    );
    as_agent(AGENT_A, T0);
    let PromiseOrValue::Value(r) = g.agent_transfer_ft(
        acc("fake-usdc.testnet"),
        acc("claim.drainer.testnet"),
        U128(1),
        None,
    ) else {
        panic!("expected block")
    };
    assert_eq!(r.code, "RECIPIENT_DENYLISTED");
    let r = g.agent_request_approval(
        "fake-usdc.testnet".into(),
        acc("claim.drainer.testnet"),
        U128(1),
        None,
        "x".into(),
    );
    assert_eq!(r.status, "blocked");
    assert!(g.list_pending(None, None).is_empty());
}

#[test]
#[should_panic(expected = "recipient is denylisted")]
fn approval_rechecks_denylist() {
    let mut g = setup();
    as_agent(AGENT_A, T0);
    let r = g.agent_request_approval(
        "near".into(),
        acc("vendor.testnet"),
        near(20),
        None,
        "x".into(),
    );
    as_owner(T0);
    g.report(
        ListKind::Recipient,
        acc("vendor.testnet"),
        "vendor got hacked".into(),
        None,
    );
    let _ = g.approve_request(r.request_id.unwrap());
}

#[test]
fn pending_requests_are_bounded_and_rejectable() {
    let mut g = setup();
    as_agent(AGENT_A, T0);
    let mut last = None;
    for _ in 0..MAX_PENDING_PER_AGENT {
        last = g
            .agent_request_approval(
                "near".into(),
                acc("vendor.testnet"),
                near(20),
                None,
                "x".into(),
            )
            .request_id;
    }
    let r = g.agent_request_approval(
        "near".into(),
        acc("vendor.testnet"),
        near(20),
        None,
        "x".into(),
    );
    assert_eq!(r.code, "TOO_MANY_PENDING");
    as_owner(T0);
    g.reject_request(last.unwrap(), Some("no".into()));
    assert_eq!(
        g.get_agent(pk(AGENT_A)).unwrap().pending,
        MAX_PENDING_PER_AGENT - 1
    );
}

#[test]
fn failed_transfer_refunds_daily_budget() {
    let mut g = setup();
    assert!(send_near(&mut g, AGENT_A, "ghost.testnet", near(2)).is_none());
    // The callback carries the hour bucket the spend was recorded in.
    let callback_args: Vec<near_sdk::serde_json::Value> =
        near_sdk::test_utils::get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .filter_map(|a| match a {
                near_sdk::mock::MockAction::FunctionCallWeight {
                    method_name, args, ..
                } if method_name == b"on_transfer_settled" => {
                    near_sdk::serde_json::from_slice(&args).ok()
                }
                _ => None,
            })
            .collect();
    assert_eq!(callback_args.len(), 1);
    assert_eq!(callback_args[0]["hour"], (T0 / HOUR).to_string());
    assert!(callback_args[0].get("day").is_none());
    as_callback(T0, PromiseResult::Failed);
    let r = g.on_transfer_settled(
        AGENT_A.into(),
        "near".into(),
        acc("ghost.testnet"),
        near(2),
        U64(T0 / HOUR),
        true,
    );
    assert_eq!(r.status, "failed");
    assert_eq!(near_view_at(&g, AGENT_A, T0).spent_today, U128(0));
    assert!(!g.agents.get(AGENT_A).unwrap().spent.contains_key("near"));
}

#[test]
fn refund_hits_only_the_matching_hour_bucket() {
    let mut g = setup();
    assert!(send_near_at(&mut g, AGENT_A, "alice.testnet", near(2), LATE).is_none());
    assert!(send_near_at(&mut g, AGENT_A, "ghost.testnet", near(2), LATE + HOUR).is_none());
    // The failure callback lands in a later block (and a later hour): the right bucket is refunded.
    as_callback(LATE + 2 * HOUR, PromiseResult::Failed);
    let r = g.on_transfer_settled(
        AGENT_A.into(),
        "near".into(),
        acc("ghost.testnet"),
        near(2),
        U64((LATE + HOUR) / HOUR),
        true,
    );
    assert_eq!(r.status, "failed");
    assert_eq!(
        g.agents.get(AGENT_A).unwrap().spent["near"],
        vec![(LATE / HOUR, near(2).0)]
    );
    // A refund for an hour with no bucket changes nothing; refunds never underflow.
    as_callback(LATE + 2 * HOUR, PromiseResult::Failed);
    let _ = g.on_transfer_settled(
        AGENT_A.into(),
        "near".into(),
        acc("ghost.testnet"),
        near(2),
        U64(LATE / HOUR - 1),
        true,
    );
    as_callback(LATE + 2 * HOUR, PromiseResult::Failed);
    let _ = g.on_transfer_settled(
        AGENT_A.into(),
        "near".into(),
        acc("ghost.testnet"),
        near(9),
        U64(LATE / HOUR),
        true,
    );
    assert_eq!(
        near_view_at(&g, AGENT_A, LATE + 2 * HOUR).spent_today,
        U128(0)
    );
}

#[test]
fn uncounted_failure_is_not_refunded() {
    // Owner-approved transfers (`counted = false`) never touched the agent's budget.
    let mut g = setup();
    assert!(send_near(&mut g, AGENT_A, "alice.testnet", near(2)).is_none());
    as_callback(T0, PromiseResult::Failed);
    let _ = g.on_transfer_settled(
        AGENT_A.into(),
        "near".into(),
        acc("ghost.testnet"),
        near(2),
        U64(T0 / HOUR),
        false,
    );
    assert_eq!(near_view_at(&g, AGENT_A, T0).spent_today, near(2));
}

#[test]
fn successful_settlement_counts_execution() {
    let mut g = setup();
    assert!(send_near(&mut g, AGENT_A, "alice.testnet", near(1)).is_none());
    as_callback(T0, PromiseResult::Successful(vec![]));
    let r = g.on_transfer_settled(
        AGENT_A.into(),
        "near".into(),
        acc("alice.testnet"),
        near(1),
        U64(T0 / HOUR),
        true,
    );
    assert_eq!(r.status, "executed");
    assert_eq!(g.get_agent(pk(AGENT_A)).unwrap().executed, 1);
}

#[test]
fn remove_agent_drops_pending_and_key() {
    let mut g = setup();
    as_agent(AGENT_A, T0);
    g.agent_request_approval(
        "near".into(),
        acc("vendor.testnet"),
        near(20),
        None,
        "x".into(),
    );
    as_owner(T0);
    let _ = g.remove_agent(pk(AGENT_A));
    assert!(g.get_agent(pk(AGENT_A)).is_none());
    assert!(g.list_pending(None, None).is_empty());
    assert_eq!(
        send_near(&mut g, AGENT_A, "alice.testnet", near(1))
            .unwrap()
            .code,
        "UNKNOWN_AGENT"
    );
}

#[test]
fn preflight_matches_enforcement() {
    let g = setup();
    as_account("anyone.testnet", T0);
    assert_eq!(
        g.preflight(pk(AGENT_A), "near".into(), acc("alice.testnet"), near(1))
            .status,
        "allowed"
    );
    assert_eq!(
        g.preflight(pk(AGENT_A), "NEAR".into(), acc("alice.testnet"), near(3))
            .code,
        "OVER_TX_CAP"
    );
    assert_eq!(
        g.preflight(
            pk(AGENT_A),
            "scam.testnet".into(),
            acc("alice.testnet"),
            U128(1)
        )
        .code,
        "TOKEN_NOT_ALLOWLISTED"
    );
}

#[test]
fn multiple_agents_have_separate_budgets() {
    let mut g = setup();
    as_owner(T0);
    let _ = g.add_agent(pk(AGENT_B), "grants-bot".into(), limits_near(1, 1), None);
    assert!(send_near(&mut g, AGENT_A, "alice.testnet", near(2)).is_none());
    assert_eq!(
        send_near(&mut g, AGENT_B, "alice.testnet", near(2))
            .unwrap()
            .code,
        "OVER_TX_CAP"
    );
    assert!(send_near(&mut g, AGENT_B, "alice.testnet", near(1)).is_none());
    assert_eq!(g.list_agents(None, None).len(), 2);
}

#[test]
fn amounts_are_readable_in_reasons() {
    assert_eq!(fmt_amount("near", 2 * 10u128.pow(23)), "0.2 NEAR");
    assert_eq!(fmt_amount("near", 10u128.pow(24)), "1 NEAR");
    assert_eq!(fmt_amount("usdc.testnet", 5), "5 units of usdc.testnet");
    let mut g = setup();
    let r = send_near(&mut g, AGENT_A, "alice.testnet", near(3)).unwrap();
    assert_eq!(r.reason, "3 NEAR exceeds the per-transaction cap of 2 NEAR");
}

#[test]
fn ownership_transfer() {
    let mut g = setup();
    as_owner(T0);
    g.transfer_ownership(acc("dao.testnet"));
    assert_eq!(g.get_policy().owner_id, acc("dao.testnet"));
}
