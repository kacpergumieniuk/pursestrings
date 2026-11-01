//! End-to-end tests on a local NEAR sandbox node.
//!
//! The agent signs real transactions with the function-call key that the Guard
//! contract added to the vault account. We check that the key can only do what
//! the policy allows, both at the protocol level (key permissions) and at the
//! contract level (caps, lists, approvals).
//!
//! Requires `cargo near` (https://github.com/near/cargo-near) on PATH; the test
//! builds both contracts before starting the sandbox.

use near_api::{Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer, Tokens};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

const USDC: u128 = 1_000_000; // 6 decimals

fn build(crate_dir: &str, artifact: &str) -> Vec<u8> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let manifest = root.join(crate_dir).join("Cargo.toml");
    let status = Command::new("cargo")
        .args(["near", "build", "non-reproducible-wasm", "--manifest-path"])
        .arg(&manifest)
        .status()
        .expect("`cargo near` must be installed to run sandbox tests");
    assert!(status.success(), "building {crate_dir} failed");
    std::fs::read(root.join("target/near").join(artifact).join(format!("{artifact}.wasm"))).unwrap()
}

struct Env {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    genesis: Arc<Signer>,
    agent: Arc<Signer>,
    agent_pk: String,
    owner: AccountId,
    vault: AccountId,
    alice: AccountId,
    usdc: AccountId,
    fake_usdc: AccountId,
}

async fn create(sandbox: &near_sandbox::Sandbox, name: &str, near: u128) -> AccountId {
    let id: AccountId = name.parse().unwrap();
    sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(near)).send().await.unwrap();
    id
}

async fn setup() -> Env {
    let guard_wasm = build("guard", "near_guard");
    let token_wasm = build("test-token", "test_token");

    let sandbox = near_sandbox::Sandbox::start_sandbox().await.unwrap();
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse().unwrap());
    let genesis = Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap(),
    )
    .unwrap();

    let owner = create(&sandbox, "owner.sandbox", 50).await;
    let vault = create(&sandbox, "vault.sandbox", 50).await;
    let alice = create(&sandbox, "alice.sandbox", 10).await;
    let _bob = create(&sandbox, "bob.sandbox", 10).await;
    let usdc = create(&sandbox, "usdc.sandbox", 20).await;
    let fake_usdc = create(&sandbox, "usdc-airdrop.sandbox", 20).await;

    Contract::deploy(vault.clone())
        .use_code(guard_wasm)
        .with_init_call("new", json!({ "owner_id": owner }))
        .unwrap()
        .with_signer(genesis.clone())
        .send_to(&net)
        .await
        .unwrap()
        .assert_success();

    for (token, symbol) in [(&usdc, "USDC"), (&fake_usdc, "USDC")] {
        Contract::deploy(token.clone())
            .use_code(token_wasm.clone())
            .with_init_call(
                "new",
                json!({
                    "owner_id": vault, "total_supply": (1_000_000 * USDC).to_string(),
                    "name": "USD Coin", "symbol": symbol, "decimals": 6, "icon": null
                }),
            )
            .unwrap()
            .with_signer(genesis.clone())
            .send_to(&net)
            .await
            .unwrap()
            .assert_success();
    }
    // alice registers with the real USDC; bob does not.
    Contract(usdc.clone())
        .call_function("storage_deposit", json!({ "account_id": alice }))
        .transaction()
        .deposit(NearToken::from_millinear(10))
        .with_signer(alice.clone(), genesis.clone())
        .send_to(&net)
        .await
        .unwrap()
        .assert_success();

    // The owner registers the agent; the contract adds the agent's function-call key to the vault.
    let agent_sk = near_api::signer::generate_secret_key().unwrap();
    let agent_pk = agent_sk.public_key().to_string();
    let agent = Signer::from_secret_key(agent_sk).unwrap();
    owner_call(
        &net,
        &genesis,
        &owner,
        &vault,
        "add_agent",
        json!({
            "public_key": agent_pk, "name": "treasury-bot",
            "limits": [
                { "asset": "near", "per_tx": NearToken::from_near(2).as_yoctonear().to_string(),
                  "per_day": NearToken::from_near(5).as_yoctonear().to_string() },
                { "asset": usdc, "per_tx": (100 * USDC).to_string(), "per_day": (250 * USDC).to_string() }
            ]
        }),
    )
    .await;
    owner_call(&net, &genesis, &owner, &vault, "allow", json!({ "kind": "token", "account_ids": [usdc] })).await;

    Env { sandbox, net, genesis, agent, agent_pk, owner, vault, alice, usdc, fake_usdc }
}

async fn owner_call(net: &NetworkConfig, signer: &Arc<Signer>, owner: &AccountId, vault: &AccountId, method: &str, args: Value) {
    // Owner admin methods require exactly 1 yoctoNEAR (proves a full-access key signed).
    // `report` is also open to reporter bots that use function-call keys, so it takes no deposit.
    let deposit = if method == "report" { 0 } else { 1 };
    Contract(vault.clone())
        .call_function(method, args)
        .transaction()
        .deposit(NearToken::from_yoctonear(deposit))
        .gas(NearGas::from_tgas(50))
        .with_signer(owner.clone(), signer.clone())
        .send_to(net)
        .await
        .unwrap()
        .assert_success();
}

/// Sign with the agent's function-call key on the vault account. Returns (result json, logs).
async fn agent_call(e: &Env, method: &str, args: Value) -> (Value, Vec<String>) {
    let res = Contract(e.vault.clone())
        .call_function(method, args)
        .transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(e.vault.clone(), e.agent.clone())
        .send_to(&e.net)
        .await
        .unwrap()
        .assert_success();
    let logs = res.logs().iter().map(|s| s.to_string()).collect();
    (res.json::<Value>().unwrap(), logs)
}

async fn near_balance(e: &Env, who: &AccountId) -> u128 {
    Tokens::account(who.clone()).near_balance().fetch_from(&e.net).await.unwrap().total.as_yoctonear()
}

async fn ft_balance(e: &Env, token: &AccountId, who: &AccountId) -> u128 {
    let v: Value = Contract(token.clone())
        .call_function("ft_balance_of", json!({ "account_id": who }))
        .read_only()
        .fetch_from(&e.net)
        .await
        .unwrap()
        .data;
    v.as_str().unwrap().parse().unwrap()
}

async fn view(e: &Env, method: &str, args: Value) -> Value {
    Contract(e.vault.clone()).call_function(method, args).read_only().fetch_from(&e.net).await.unwrap().data
}

#[tokio::test]
async fn guard_end_to_end() {
    let e = setup().await;
    let one = NearToken::from_near(1).as_yoctonear();

    // 0. The vault now holds a function-call key for the agent, scoped to the agent methods.
    let keys = Account(e.vault.clone()).list_keys().fetch_from(&e.net).await.unwrap();
    let keys_dbg = format!("{keys:?}");
    assert!(keys_dbg.contains(&e.agent_pk), "agent key missing: {keys_dbg}");
    assert!(keys_dbg.contains("agent_transfer_near"), "{keys_dbg}");

    // 1. Normal transfer within caps: executed.
    let before = near_balance(&e, &e.alice).await;
    let (r, logs) =
        agent_call(&e, "agent_transfer_near", json!({ "receiver_id": e.alice, "amount": one.to_string() })).await;
    assert_eq!(r["status"], "executed", "{r}");
    assert!(logs.iter().any(|l| l.contains("transfer_allowed")));
    assert_eq!(near_balance(&e, &e.alice).await, before + one);

    // 2. Over the per-transaction cap: blocked on chain, nothing moves, the attempt is logged.
    let (r, logs) = agent_call(
        &e,
        "agent_transfer_near",
        json!({ "receiver_id": e.alice, "amount": (3 * one).to_string() }),
    )
    .await;
    assert_eq!(r["status"], "blocked");
    assert_eq!(r["code"], "OVER_TX_CAP");
    assert!(logs.iter().any(|l| l.contains("transfer_blocked")));
    assert_eq!(near_balance(&e, &e.alice).await, before + one);

    // 3. Allowlisted token within caps: executed.
    let (r, _) = agent_call(
        &e,
        "agent_transfer_ft",
        json!({ "token_id": e.usdc, "receiver_id": e.alice, "amount": (50 * USDC).to_string() }),
    )
    .await;
    assert_eq!(r["status"], "executed", "{r}");
    assert_eq!(ft_balance(&e, &e.usdc, &e.alice).await, 50 * USDC);

    // 4. Look-alike "USDC" token that is not allowlisted: blocked.
    let (r, _) = agent_call(
        &e,
        "agent_transfer_ft",
        json!({ "token_id": e.fake_usdc, "receiver_id": e.alice, "amount": (10 * USDC).to_string() }),
    )
    .await;
    assert_eq!(r["code"], "TOKEN_NOT_ALLOWLISTED");

    // 5. Token transfer to an account not registered with the token fails in the token
    //    contract; the callback reports it and refunds the agent's daily budget.
    let bob: AccountId = "bob.sandbox".parse().unwrap();
    let (r, _) = agent_call(
        &e,
        "agent_transfer_ft",
        json!({ "token_id": e.usdc, "receiver_id": bob, "amount": (10 * USDC).to_string() }),
    )
    .await;
    assert_eq!(r["status"], "failed", "{r}");
    let agent = view(&e, "get_agent", json!({ "public_key": e.agent_pk })).await;
    let usdc_limit = agent["limits"].as_array().unwrap().iter().find(|l| l["asset"] == e.usdc.as_str()).unwrap();
    assert_eq!(usdc_limit["spent_today"], (50 * USDC).to_string());

    // 6. NEAR to a non-existent named account fails and is refunded the same way.
    let (r, _) = agent_call(
        &e,
        "agent_transfer_near",
        json!({ "receiver_id": "ghost.sandbox", "amount": one.to_string() }),
    )
    .await;
    assert_eq!(r["status"], "failed", "{r}");

    // 7. Denylist reported with evidence beats everything, including sub-accounts.
    owner_call(
        &e.net,
        &e.genesis,
        &e.owner,
        &e.vault,
        "report",
        json!({ "kind": "recipient", "account_id": "bob.sandbox", "reason": "phishing payout address",
                "evidence": "https://example.org/report/1" }),
    )
    .await;
    let (r, _) =
        agent_call(&e, "agent_transfer_near", json!({ "receiver_id": "bob.sandbox", "amount": "1" })).await;
    assert_eq!(r["code"], "RECIPIENT_DENYLISTED");

    // 8. Over-cap payments can be escalated to the owner, who approves them.
    let (r, _) = agent_call(
        &e,
        "agent_request_approval",
        json!({ "asset": "near", "receiver_id": e.alice, "amount": (10 * one).to_string(),
                "justification": "quarterly vendor invoice" }),
    )
    .await;
    assert_eq!(r["status"], "pending_approval");
    let id = r["request_id"].as_str().unwrap().to_string();
    let before = near_balance(&e, &e.alice).await;
    owner_call(&e.net, &e.genesis, &e.owner, &e.vault, "approve_request", json!({ "request_id": id })).await;
    assert_eq!(near_balance(&e, &e.alice).await, before + 10 * one);

    // 9. Daily cap: 1 NEAR spent earlier (the failed one was refunded); 2 + 2 more hits 5.
    for _ in 0..2 {
        let (r, _) =
            agent_call(&e, "agent_transfer_near", json!({ "receiver_id": e.alice, "amount": (2 * one).to_string() }))
                .await;
        assert_eq!(r["status"], "executed", "{r}");
    }
    let (r, _) =
        agent_call(&e, "agent_transfer_near", json!({ "receiver_id": e.alice, "amount": (2 * one).to_string() }))
            .await;
    assert_eq!(r["code"], "OVER_DAILY_CAP");
    let agent = view(&e, "get_agent", json!({ "public_key": e.agent_pk })).await;
    assert_eq!(agent["blocked"], 4, "{agent}");

    // 10. Pause stops everything.
    owner_call(&e.net, &e.genesis, &e.owner, &e.vault, "set_paused", json!({ "paused": true })).await;
    let (r, _) = agent_call(&e, "agent_transfer_near", json!({ "receiver_id": e.alice, "amount": "1" })).await;
    assert_eq!(r["code"], "PAUSED");
}

#[tokio::test]
async fn agent_key_cannot_escape_the_contract() {
    let e = setup().await;

    // A function-call key cannot sign a plain NEAR transfer from the vault.
    let direct = Tokens::account(e.vault.clone())
        .send_to(e.alice.clone())
        .near(NearToken::from_near(1))
        .with_signer(e.agent.clone())
        .send_to(&e.net)
        .await;
    assert!(direct.is_err(), "direct transfer with agent key must be rejected: {direct:?}");

    // ...cannot call owner methods on the guard (not in the key's method list)...
    let owner_method = Contract(e.vault.clone())
        .call_function("set_paused", json!({ "paused": false }))
        .transaction()
        .with_signer(e.vault.clone(), e.agent.clone())
        .send_to(&e.net)
        .await;
    assert!(owner_method.is_err(), "owner method with agent key must be rejected: {owner_method:?}");

    // ...cannot call any other contract (e.g. ft_transfer on the token directly)...
    let other_contract = Contract(e.usdc.clone())
        .call_function("ft_transfer", json!({ "receiver_id": e.alice, "amount": "1" }))
        .transaction()
        .with_signer(e.vault.clone(), e.agent.clone())
        .send_to(&e.net)
        .await;
    assert!(other_contract.is_err(), "calling another contract must be rejected: {other_contract:?}");

    // ...and cannot attach a deposit to the allowed methods.
    let with_deposit = Contract(e.vault.clone())
        .call_function("agent_transfer_near", json!({ "receiver_id": e.alice, "amount": "1" }))
        .transaction()
        .deposit(NearToken::from_yoctonear(1))
        .with_signer(e.vault.clone(), e.agent.clone())
        .send_to(&e.net)
        .await;
    assert!(with_deposit.is_err(), "deposit with a function-call key must be rejected: {with_deposit:?}");

    // The owner can revoke the agent: its key is deleted from the vault.
    owner_call(&e.net, &e.genesis, &e.owner, &e.vault, "remove_agent", json!({ "public_key": e.agent_pk })).await;
    let keys = Account(e.vault.clone()).list_keys().fetch_from(&e.net).await.unwrap();
    assert!(!format!("{keys:?}").contains(&e.agent_pk), "agent key should be deleted");
    let after_revoke = Contract(e.vault.clone())
        .call_function("agent_transfer_near", json!({ "receiver_id": e.alice, "amount": "1" }))
        .transaction()
        .with_signer(e.vault.clone(), e.agent.clone())
        .send_to(&e.net)
        .await;
    assert!(after_revoke.is_err(), "revoked key must not sign: {after_revoke:?}");
    drop(e.sandbox);
}
