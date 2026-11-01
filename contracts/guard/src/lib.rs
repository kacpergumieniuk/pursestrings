//! Guard: an on-chain policy firewall for AI-agent and community wallets on NEAR.
//!
//! The contract is deployed on the account that holds the funds (the "vault").
//! The owner (a separate account) controls the policy. Each agent gets a
//! function-call access key on the vault that can only call the `agent_*`
//! methods below. Because a function-call key cannot attach a deposit or sign a
//! transfer action, the only way for an agent to move funds is through this
//! contract, which enforces:
//!
//! * per-agent, per-asset caps (per transaction and per UTC day),
//! * recipient and token allowlists / denylists (with evidence for deny entries),
//! * a global pause switch,
//! * human approval for anything over the caps (`agent_request_approval`).
//!
//! Agents are identified by the public key that signed the transaction
//! (`env::signer_account_pk()`), so one vault can host several agents with
//! independent budgets.

use std::collections::BTreeMap;

use near_sdk::json_types::{U64, U128};
use near_sdk::store::{IterableMap, IterableSet};
use near_sdk::{
    AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PublicKey, assert_one_yocto, env, near, require,
};

/// Asset id used for native NEAR. Any other asset id is a NEP-141 token contract.
pub const NEAR_ASSET: &str = "near";
const NS_PER_DAY: u64 = 86_400 * 1_000_000_000;
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_SETTLE_CALLBACK: Gas = Gas::from_tgas(10);
/// Methods an agent key may call. Everything else needs the owner account.
pub const AGENT_METHODS: &str = "agent_transfer_near,agent_transfer_ft,agent_request_approval";
const MAX_PENDING_PER_AGENT: u32 = 5;
const MAX_TEXT_LEN: usize = 280;
const MAX_PAGE: u32 = 100;
/// Default gas allowance for a new agent key: 1 NEAR.
const DEFAULT_KEY_ALLOWANCE: NearToken = NearToken::from_near(1);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Agents,
    RecipientAllow,
    RecipientDeny,
    TokenAllow,
    TokenDeny,
    Reporters,
    Pending,
}

/// How a list is applied. `Open`: anything not denylisted passes.
/// `AllowlistOnly`: only allowlisted entries pass (denylist still applies).
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ListMode {
    Open,
    AllowlistOnly,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ListKind {
    Recipient,
    Token,
}

/// Spending limits for one asset, in the asset's smallest unit (yoctoNEAR for NEAR).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AssetLimit {
    pub per_tx: U128,
    pub per_day: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AssetLimitInput {
    /// `"near"` or a NEP-141 token contract account id.
    pub asset: String,
    pub per_tx: U128,
    pub per_day: U128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub name: String,
    pub enabled: bool,
    pub limits: BTreeMap<String, AssetLimit>,
    /// asset -> (UTC day index, amount spent that day)
    pub spent: BTreeMap<String, (u64, u128)>,
    pub pending: u32,
    pub executed: u64,
    pub blocked: u64,
    pub created_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct DenyEntry {
    pub reason: String,
    pub evidence: Option<String>,
    pub reported_by: AccountId,
    pub at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PendingRequest {
    pub id: U64,
    pub agent_key: String,
    pub agent_name: String,
    pub asset: String,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub memo: Option<String>,
    pub justification: String,
    /// The policy check that made this need a human (e.g. `OVER_DAILY_CAP`).
    pub code: String,
    pub created_at: U64,
}

/// Outcome of an agent action. Blocked actions do not panic: they are recorded
/// on chain (event + counter) and returned so the agent can explain itself.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct GuardResult {
    /// `allowed` (preflight only), `executed`, `failed`, `blocked` or `pending_approval`.
    pub status: String,
    pub code: String,
    pub reason: String,
    pub request_id: Option<U64>,
}

#[near(serializers = [json])]
pub struct AssetLimitView {
    pub asset: String,
    pub per_tx: U128,
    pub per_day: U128,
    pub spent_today: U128,
    pub remaining_today: U128,
}

#[near(serializers = [json])]
pub struct AgentView {
    pub public_key: String,
    pub name: String,
    pub enabled: bool,
    pub limits: Vec<AssetLimitView>,
    pub pending: u32,
    pub executed: u64,
    pub blocked: u64,
    pub created_at: U64,
}

#[near(serializers = [json])]
pub struct PolicyView {
    pub owner_id: AccountId,
    pub paused: bool,
    pub recipient_mode: ListMode,
    pub token_mode: ListMode,
    pub min_balance_reserve: U128,
    pub agents: u32,
    pub pending_requests: u32,
    pub reporters: Vec<AccountId>,
}

#[near(serializers = [json])]
pub struct DenyView {
    pub account_id: AccountId,
    pub entry: DenyEntry,
}

/// Policy violations. `is_hard()` ones can never be escalated to a human.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Block {
    Paused,
    UnknownAgent,
    AgentDisabled,
    ZeroAmount,
    SelfTransfer,
    TokenDenylisted,
    TokenNotAllowlisted,
    RecipientDenylisted,
    RecipientNotAllowlisted,
    AssetNotPermitted,
    OverTxCap,
    OverDailyCap,
    InsufficientBalance,
}

impl Block {
    pub fn code(self) -> &'static str {
        match self {
            Block::Paused => "PAUSED",
            Block::UnknownAgent => "UNKNOWN_AGENT",
            Block::AgentDisabled => "AGENT_DISABLED",
            Block::ZeroAmount => "ZERO_AMOUNT",
            Block::SelfTransfer => "SELF_TRANSFER",
            Block::TokenDenylisted => "TOKEN_DENYLISTED",
            Block::TokenNotAllowlisted => "TOKEN_NOT_ALLOWLISTED",
            Block::RecipientDenylisted => "RECIPIENT_DENYLISTED",
            Block::RecipientNotAllowlisted => "RECIPIENT_NOT_ALLOWLISTED",
            Block::AssetNotPermitted => "ASSET_NOT_PERMITTED",
            Block::OverTxCap => "OVER_TX_CAP",
            Block::OverDailyCap => "OVER_DAILY_CAP",
            Block::InsufficientBalance => "INSUFFICIENT_BALANCE",
        }
    }

    /// Hard blocks cannot be turned into an approval request.
    pub fn is_hard(self) -> bool {
        matches!(
            self,
            Block::Paused
                | Block::UnknownAgent
                | Block::AgentDisabled
                | Block::ZeroAmount
                | Block::SelfTransfer
                | Block::TokenDenylisted
                | Block::RecipientDenylisted
        )
    }
}

#[near(event_json(standard = "nearguard"))]
pub enum GuardEvent {
    #[event_version("1.0.0")]
    TransferAllowed { agent: String, asset: String, receiver_id: AccountId, amount: U128 },
    #[event_version("1.0.0")]
    TransferBlocked {
        agent: String,
        asset: String,
        receiver_id: AccountId,
        amount: U128,
        code: String,
        reason: String,
    },
    #[event_version("1.0.0")]
    TransferSettled { agent: String, asset: String, receiver_id: AccountId, amount: U128, success: bool },
    #[event_version("1.0.0")]
    ApprovalRequested { request_id: U64, agent: String, asset: String, receiver_id: AccountId, amount: U128, code: String },
    #[event_version("1.0.0")]
    ApprovalResolved { request_id: U64, approved: bool, note: Option<String> },
    #[event_version("1.0.0")]
    AgentAdded { public_key: String, name: String },
    #[event_version("1.0.0")]
    AgentRemoved { public_key: String },
    #[event_version("1.0.0")]
    PolicyChanged { change: String },
    #[event_version("1.0.0")]
    Reported { kind: ListKind, account_id: AccountId, reporter: AccountId, reason: String, evidence: Option<String> },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guard {
    owner_id: AccountId,
    paused: bool,
    agents: IterableMap<String, Agent>,
    recipient_mode: ListMode,
    recipient_allow: IterableSet<AccountId>,
    recipient_deny: IterableMap<AccountId, DenyEntry>,
    token_mode: ListMode,
    token_allow: IterableSet<AccountId>,
    token_deny: IterableMap<AccountId, DenyEntry>,
    reporters: IterableSet<AccountId>,
    pending: IterableMap<u64, PendingRequest>,
    next_request_id: u64,
    /// NEAR (yocto) that native transfers may never dip into, on top of storage staking.
    min_balance_reserve: u128,
}

fn day_index(ts: u64) -> u64 {
    ts / NS_PER_DAY
}

fn check_text(s: &str, what: &str) {
    require!(s.len() <= MAX_TEXT_LEN, format!("{what} is too long (max {MAX_TEXT_LEN} bytes)"));
}

fn pk_string(pk: &PublicKey) -> String {
    String::from(pk)
}

/// `true` if `account` equals `listed` or is a sub-account of it.
/// Sub-accounts can only be created by their parent, so denying a parent denies its children.
fn is_same_or_sub(account: &AccountId, listed: &AccountId) -> bool {
    let a = account.as_str();
    let l = listed.as_str();
    a == l || (a.len() > l.len() && a.ends_with(l) && a.as_bytes()[a.len() - l.len() - 1] == b'.')
}

#[near]
impl Guard {
    #[init]
    pub fn new(owner_id: AccountId, min_balance_reserve: Option<U128>) -> Self {
        Self {
            owner_id,
            paused: false,
            agents: IterableMap::new(StorageKey::Agents),
            recipient_mode: ListMode::Open,
            recipient_allow: IterableSet::new(StorageKey::RecipientAllow),
            recipient_deny: IterableMap::new(StorageKey::RecipientDeny),
            token_mode: ListMode::AllowlistOnly,
            token_allow: IterableSet::new(StorageKey::TokenAllow),
            token_deny: IterableMap::new(StorageKey::TokenDeny),
            reporters: IterableSet::new(StorageKey::Reporters),
            pending: IterableMap::new(StorageKey::Pending),
            next_request_id: 1,
            min_balance_reserve: min_balance_reserve
                .map(|v| v.0)
                .unwrap_or(NearToken::from_millinear(500).as_yoctonear()),
        }
    }

    // ------------------------------------------------------------------
    // Agent entry points (callable only with an agent key of this account)
    // ------------------------------------------------------------------

    /// Send native NEAR. Caps and lists are enforced; violations are recorded and returned.
    pub fn agent_transfer_near(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> PromiseOrValue<GuardResult> {
        let key = self.assert_agent_call();
        if let Some(m) = &memo {
            check_text(m, "memo");
        }
        self.agent_transfer(key, NEAR_ASSET.to_string(), receiver_id, amount, memo)
    }

    /// Send a NEP-141 token held by the vault (`ft_transfer` with 1 yoctoNEAR attached by the vault).
    pub fn agent_transfer_ft(
        &mut self,
        token_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> PromiseOrValue<GuardResult> {
        let key = self.assert_agent_call();
        if let Some(m) = &memo {
            check_text(m, "memo");
        }
        self.agent_transfer(key, token_id.to_string(), receiver_id, amount, memo)
    }

    /// Ask the owner to approve a transfer that the policy would block with a soft violation
    /// (over a cap, asset not permitted, recipient or token not on the allowlist).
    /// Denylisted recipients/tokens, a paused vault or a disabled agent can never be escalated.
    pub fn agent_request_approval(
        &mut self,
        asset: String,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        justification: String,
    ) -> GuardResult {
        let key = self.assert_agent_call();
        check_text(&justification, "justification");
        if let Some(m) = &memo {
            check_text(m, "memo");
        }
        let asset = Self::normalize_asset(&asset);
        let code = match self.evaluate(&key, &asset, &receiver_id, amount.0) {
            Ok(()) => "WITHIN_POLICY".to_string(),
            Err(b) if b.is_hard() => {
                return self.record_block(&key, &asset, &receiver_id, amount, b);
            }
            Err(b) => b.code().to_string(),
        };
        let agent = self.agents.get_mut(&key).expect("checked by evaluate");
        if agent.pending >= MAX_PENDING_PER_AGENT {
            return GuardResult {
                status: "blocked".into(),
                code: "TOO_MANY_PENDING".into(),
                reason: format!("agent already has {MAX_PENDING_PER_AGENT} pending requests"),
                request_id: None,
            };
        }
        agent.pending += 1;
        let agent_name = agent.name.clone();
        let id = self.next_request_id;
        self.next_request_id += 1;
        self.pending.insert(
            id,
            PendingRequest {
                id: U64(id),
                agent_key: key.clone(),
                agent_name,
                asset: asset.clone(),
                receiver_id: receiver_id.clone(),
                amount,
                memo,
                justification,
                code: code.clone(),
                created_at: U64(env::block_timestamp()),
            },
        );
        GuardEvent::ApprovalRequested {
            request_id: U64(id),
            agent: key,
            asset,
            receiver_id,
            amount,
            code: code.clone(),
        }
        .emit();
        GuardResult {
            status: "pending_approval".into(),
            code,
            reason: format!("request {id} is waiting for the owner"),
            request_id: Some(U64(id)),
        }
    }

    // ------------------------------------------------------------------
    // Callback
    // ------------------------------------------------------------------

    /// Settles a transfer started by this contract. On failure the day's spend is refunded.
    #[private]
    pub fn on_transfer_settled(
        &mut self,
        agent_key: String,
        asset: String,
        receiver_id: AccountId,
        amount: U128,
        day: U64,
        counted: bool,
    ) -> GuardResult {
        let success = near_sdk::is_promise_success();
        if let Some(agent) = self.agents.get_mut(&agent_key) {
            if success {
                agent.executed += 1;
            } else if counted {
                if let Some((d, spent)) = agent.spent.get_mut(&asset) {
                    if *d == day.0 {
                        *spent = spent.saturating_sub(amount.0);
                    }
                }
            }
        }
        GuardEvent::TransferSettled {
            agent: agent_key,
            asset: asset.clone(),
            receiver_id: receiver_id.clone(),
            amount,
            success,
        }
        .emit();
        if success {
            GuardResult {
                status: "executed".into(),
                code: "OK".into(),
                reason: format!("sent {} of {} to {}", amount.0, asset, receiver_id),
                request_id: None,
            }
        } else {
            GuardResult {
                status: "failed".into(),
                code: "TRANSFER_FAILED".into(),
                reason: "the transfer receipt failed; the daily budget was refunded".into(),
                request_id: None,
            }
        }
    }

    // ------------------------------------------------------------------
    // Owner: agents
    // ------------------------------------------------------------------

    /// Register an agent and add its function-call key to this account.
    /// The key may only call `AGENT_METHODS` on this contract and spend at most
    /// `key_allowance` yoctoNEAR on gas (default 1 NEAR).
    #[payable]
    pub fn add_agent(
        &mut self,
        public_key: PublicKey,
        name: String,
        limits: Vec<AssetLimitInput>,
        key_allowance: Option<U128>,
    ) -> Promise {
        self.assert_owner();
        check_text(&name, "name");
        let key = pk_string(&public_key);
        require!(!self.agents.contains_key(&key), "agent key already registered");
        let agent = Agent {
            name: name.clone(),
            enabled: true,
            limits: Self::limits_from_input(limits),
            spent: BTreeMap::new(),
            pending: 0,
            executed: 0,
            blocked: 0,
            created_at: env::block_timestamp(),
        };
        self.agents.insert(key.clone(), agent);
        let allowance = match key_allowance {
            Some(a) => Allowance::limited(NearToken::from_yoctonear(a.0))
                .unwrap_or_else(|| env::panic_str("key_allowance must be > 0")),
            None => Allowance::limited(DEFAULT_KEY_ALLOWANCE).unwrap(),
        };
        GuardEvent::AgentAdded { public_key: key, name }.emit();
        Promise::new(env::current_account_id()).add_access_key_allowance(
            public_key,
            allowance,
            env::current_account_id(),
            AGENT_METHODS,
        )
    }

    /// Remove an agent, drop its pending requests and delete its key from this account.
    #[payable]
    pub fn remove_agent(&mut self, public_key: PublicKey) -> Promise {
        self.assert_owner();
        let key = pk_string(&public_key);
        require!(self.agents.remove(&key).is_some(), "unknown agent");
        let stale: Vec<u64> = self
            .pending
            .iter()
            .filter(|(_, r)| r.agent_key == key)
            .map(|(id, _)| *id)
            .collect();
        for id in stale {
            self.pending.remove(&id);
        }
        GuardEvent::AgentRemoved { public_key: key }.emit();
        Promise::new(env::current_account_id()).delete_key(public_key)
    }

    #[payable]
    pub fn set_agent_enabled(&mut self, public_key: PublicKey, enabled: bool) {
        self.assert_owner();
        let key = pk_string(&public_key);
        let agent = self.agents.get_mut(&key).unwrap_or_else(|| env::panic_str("unknown agent"));
        agent.enabled = enabled;
        GuardEvent::PolicyChanged { change: format!("agent {key} enabled={enabled}") }.emit();
    }

    /// Replace an agent's limits. Today's spend is kept.
    #[payable]
    pub fn set_agent_limits(&mut self, public_key: PublicKey, limits: Vec<AssetLimitInput>) {
        self.assert_owner();
        let key = pk_string(&public_key);
        let limits = Self::limits_from_input(limits);
        let agent = self.agents.get_mut(&key).unwrap_or_else(|| env::panic_str("unknown agent"));
        agent.limits = limits;
        GuardEvent::PolicyChanged { change: format!("agent {key} limits updated") }.emit();
    }

    // ------------------------------------------------------------------
    // Owner: lists, reporters, pause
    // ------------------------------------------------------------------

    #[payable]
    pub fn set_list_mode(&mut self, kind: ListKind, mode: ListMode) {
        self.assert_owner();
        match kind {
            ListKind::Recipient => self.recipient_mode = mode,
            ListKind::Token => self.token_mode = mode,
        }
        GuardEvent::PolicyChanged { change: format!("{kind:?} mode={mode:?}") }.emit();
    }

    #[payable]
    pub fn allow(&mut self, kind: ListKind, account_ids: Vec<AccountId>) {
        self.assert_owner();
        for a in account_ids {
            match kind {
                ListKind::Recipient => self.recipient_allow.insert(a),
                ListKind::Token => self.token_allow.insert(a),
            };
        }
        GuardEvent::PolicyChanged { change: format!("{kind:?} allowlist updated") }.emit();
    }

    #[payable]
    pub fn unallow(&mut self, kind: ListKind, account_ids: Vec<AccountId>) {
        self.assert_owner();
        for a in account_ids {
            match kind {
                ListKind::Recipient => self.recipient_allow.remove(&a),
                ListKind::Token => self.token_allow.remove(&a),
            };
        }
        GuardEvent::PolicyChanged { change: format!("{kind:?} allowlist updated") }.emit();
    }

    /// Add to a denylist with a reason and optional evidence link.
    /// Callable by the owner or by an approved reporter (e.g. the off-chain risk service).
    pub fn report(&mut self, kind: ListKind, account_id: AccountId, reason: String, evidence: Option<String>) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_id || self.reporters.contains(&caller),
            "only the owner or an approved reporter can report"
        );
        check_text(&reason, "reason");
        if let Some(e) = &evidence {
            check_text(e, "evidence");
        }
        let entry = DenyEntry {
            reason: reason.clone(),
            evidence: evidence.clone(),
            reported_by: caller.clone(),
            at: U64(env::block_timestamp()),
        };
        match kind {
            ListKind::Recipient => self.recipient_deny.insert(account_id.clone(), entry),
            ListKind::Token => self.token_deny.insert(account_id.clone(), entry),
        };
        GuardEvent::Reported { kind, account_id, reporter: caller, reason, evidence }.emit();
    }

    /// Remove a denylist entry. Owner only.
    #[payable]
    pub fn undeny(&mut self, kind: ListKind, account_id: AccountId) {
        self.assert_owner();
        match kind {
            ListKind::Recipient => self.recipient_deny.remove(&account_id),
            ListKind::Token => self.token_deny.remove(&account_id),
        };
        GuardEvent::PolicyChanged { change: format!("{kind:?} denylist: removed {account_id}") }.emit();
    }

    #[payable]
    pub fn set_reporter(&mut self, account_id: AccountId, enabled: bool) {
        self.assert_owner();
        if enabled {
            self.reporters.insert(account_id.clone());
        } else {
            self.reporters.remove(&account_id);
        }
        GuardEvent::PolicyChanged { change: format!("reporter {account_id} enabled={enabled}") }.emit();
    }

    /// Emergency stop: every agent action is blocked while paused.
    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        GuardEvent::PolicyChanged { change: format!("paused={paused}") }.emit();
    }

    #[payable]
    pub fn set_min_balance_reserve(&mut self, amount: U128) {
        self.assert_owner();
        self.min_balance_reserve = amount.0;
        GuardEvent::PolicyChanged { change: format!("min_balance_reserve={}", amount.0) }.emit();
    }

    #[payable]
    pub fn transfer_ownership(&mut self, new_owner_id: AccountId) {
        self.assert_owner();
        GuardEvent::PolicyChanged { change: format!("owner {} -> {}", self.owner_id, new_owner_id) }.emit();
        self.owner_id = new_owner_id;
    }

    // ------------------------------------------------------------------
    // Owner: approvals and withdrawals
    // ------------------------------------------------------------------

    /// Execute a pending request. Denylists are re-checked; caps are not (the human decided).
    #[payable]
    pub fn approve_request(&mut self, request_id: U64) -> Promise {
        self.assert_owner();
        let req = self
            .pending
            .remove(&request_id.0)
            .unwrap_or_else(|| env::panic_str("unknown request"));
        if let Some(agent) = self.agents.get_mut(&req.agent_key) {
            agent.pending = agent.pending.saturating_sub(1);
        }
        if req.asset != NEAR_ASSET {
            let token: AccountId = req.asset.parse().unwrap();
            require!(self.token_deny_entry(&token).is_none(), "token is denylisted");
        }
        require!(self.recipient_deny_entry(&req.receiver_id).is_none(), "recipient is denylisted");
        if req.asset == NEAR_ASSET {
            require!(self.spendable_near() >= req.amount.0, "insufficient NEAR above the reserve");
        }
        GuardEvent::ApprovalResolved { request_id, approved: true, note: None }.emit();
        self.start_transfer(req.agent_key, req.asset, req.receiver_id, req.amount, req.memo, false)
    }

    #[payable]
    pub fn reject_request(&mut self, request_id: U64, note: Option<String>) {
        self.assert_owner();
        if let Some(n) = &note {
            check_text(n, "note");
        }
        let req = self
            .pending
            .remove(&request_id.0)
            .unwrap_or_else(|| env::panic_str("unknown request"));
        if let Some(agent) = self.agents.get_mut(&req.agent_key) {
            agent.pending = agent.pending.saturating_sub(1);
        }
        GuardEvent::ApprovalResolved { request_id, approved: false, note }.emit();
    }

    /// Owner withdrawal of NEAR or a token. Not subject to agent caps.
    #[payable]
    pub fn owner_withdraw(&mut self, asset: String, receiver_id: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        let asset = Self::normalize_asset(&asset);
        if asset == NEAR_ASSET {
            require!(self.spendable_near() >= amount.0, "insufficient NEAR above the reserve");
        }
        self.start_transfer("owner".into(), asset, receiver_id, amount, None, false)
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// Dry-run the on-chain policy for an agent key without sending anything.
    pub fn preflight(&self, public_key: PublicKey, asset: String, receiver_id: AccountId, amount: U128) -> GuardResult {
        let asset = Self::normalize_asset(&asset);
        match self.evaluate(&pk_string(&public_key), &asset, &receiver_id, amount.0) {
            Ok(()) => GuardResult {
                status: "allowed".into(),
                code: "OK".into(),
                reason: "within policy".into(),
                request_id: None,
            },
            Err(b) => GuardResult {
                status: "blocked".into(),
                code: b.code().into(),
                reason: self.block_reason(b, &pk_string(&public_key), &asset, &receiver_id, amount.0),
                request_id: None,
            },
        }
    }

    pub fn get_policy(&self) -> PolicyView {
        PolicyView {
            owner_id: self.owner_id.clone(),
            paused: self.paused,
            recipient_mode: self.recipient_mode,
            token_mode: self.token_mode,
            min_balance_reserve: U128(self.min_balance_reserve),
            agents: self.agents.len(),
            pending_requests: self.pending.len(),
            reporters: self.reporters.iter().cloned().collect(),
        }
    }

    pub fn get_agent(&self, public_key: PublicKey) -> Option<AgentView> {
        let key = pk_string(&public_key);
        self.agents.get(&key).map(|a| self.agent_view(&key, a))
    }

    pub fn list_agents(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<AgentView> {
        self.agents
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize)
            .map(|(k, a)| self.agent_view(k, a))
            .collect()
    }

    pub fn list_allowed(&self, kind: ListKind, from_index: Option<u32>, limit: Option<u32>) -> Vec<AccountId> {
        let set = match kind {
            ListKind::Recipient => &self.recipient_allow,
            ListKind::Token => &self.token_allow,
        };
        set.iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize)
            .cloned()
            .collect()
    }

    pub fn list_denied(&self, kind: ListKind, from_index: Option<u32>, limit: Option<u32>) -> Vec<DenyView> {
        let map = match kind {
            ListKind::Recipient => &self.recipient_deny,
            ListKind::Token => &self.token_deny,
        };
        map.iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize)
            .map(|(a, e)| DenyView { account_id: a.clone(), entry: e.clone() })
            .collect()
    }

    /// Denylist entry that applies to `account_id` (exact or parent account), if any.
    pub fn get_deny_entry(&self, kind: ListKind, account_id: AccountId) -> Option<DenyView> {
        let hit = match kind {
            ListKind::Recipient => self.recipient_deny_entry(&account_id),
            ListKind::Token => self.token_deny_entry(&account_id),
        };
        hit.map(|(a, e)| DenyView { account_id: a, entry: e })
    }

    pub fn list_pending(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<PendingRequest> {
        self.pending
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize)
            .map(|(_, r)| r.clone())
            .collect()
    }

    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    fn assert_owner(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    /// Agent methods must be signed by a key of this very account. Returns the signer key.
    fn assert_agent_call(&self) -> String {
        require!(
            env::predecessor_account_id() == env::current_account_id()
                && env::signer_account_id() == env::current_account_id(),
            "agent methods must be signed with an agent key of the vault account"
        );
        pk_string(&env::signer_account_pk())
    }

    fn normalize_asset(asset: &str) -> String {
        let a = asset.trim().to_ascii_lowercase();
        if a == NEAR_ASSET {
            return a;
        }
        let id: AccountId = a.parse().unwrap_or_else(|_| env::panic_str("asset must be \"near\" or a token account id"));
        id.to_string()
    }

    fn limits_from_input(limits: Vec<AssetLimitInput>) -> BTreeMap<String, AssetLimit> {
        let mut out = BTreeMap::new();
        for l in limits {
            require!(l.per_tx.0 <= l.per_day.0, "per_tx cap cannot exceed per_day cap");
            out.insert(Self::normalize_asset(&l.asset), AssetLimit { per_tx: l.per_tx, per_day: l.per_day });
        }
        out
    }

    fn recipient_deny_entry(&self, account: &AccountId) -> Option<(AccountId, DenyEntry)> {
        Self::deny_lookup(&self.recipient_deny, account)
    }

    fn token_deny_entry(&self, account: &AccountId) -> Option<(AccountId, DenyEntry)> {
        Self::deny_lookup(&self.token_deny, account)
    }

    /// Exact match first, then every parent account (`a.b.c` -> `b.c` -> `c`).
    fn deny_lookup(map: &IterableMap<AccountId, DenyEntry>, account: &AccountId) -> Option<(AccountId, DenyEntry)> {
        let s = account.as_str();
        let mut candidates = vec![s];
        for (i, ch) in s.char_indices() {
            if ch == '.' {
                candidates.push(&s[i + 1..]);
            }
        }
        for c in candidates {
            if let Ok(id) = c.parse::<AccountId>() {
                if let Some(e) = map.get(&id) {
                    debug_assert!(is_same_or_sub(account, &id));
                    return Some((id, e.clone()));
                }
            }
        }
        None
    }

    fn spent_today(agent: &Agent, asset: &str, today: u64) -> u128 {
        match agent.spent.get(asset) {
            Some((d, amt)) if *d == today => *amt,
            _ => 0,
        }
    }

    fn spendable_near(&self) -> u128 {
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(storage)
            .saturating_sub(self.min_balance_reserve)
    }

    /// The policy, in order. Returns the first violation.
    fn evaluate(&self, key: &str, asset: &str, receiver: &AccountId, amount: u128) -> Result<(), Block> {
        if self.paused {
            return Err(Block::Paused);
        }
        let agent = self.agents.get(key).ok_or(Block::UnknownAgent)?;
        if !agent.enabled {
            return Err(Block::AgentDisabled);
        }
        if amount == 0 {
            return Err(Block::ZeroAmount);
        }
        if *receiver == env::current_account_id() {
            return Err(Block::SelfTransfer);
        }
        if asset != NEAR_ASSET {
            let token: AccountId = asset.parse().map_err(|_| Block::AssetNotPermitted)?;
            if self.token_deny_entry(&token).is_some() {
                return Err(Block::TokenDenylisted);
            }
            if self.token_mode == ListMode::AllowlistOnly && !self.token_allow.contains(&token) {
                return Err(Block::TokenNotAllowlisted);
            }
        }
        if self.recipient_deny_entry(receiver).is_some() {
            return Err(Block::RecipientDenylisted);
        }
        if self.recipient_mode == ListMode::AllowlistOnly && !self.recipient_allow.contains(receiver) {
            return Err(Block::RecipientNotAllowlisted);
        }
        let limit = agent.limits.get(asset).ok_or(Block::AssetNotPermitted)?;
        if amount > limit.per_tx.0 {
            return Err(Block::OverTxCap);
        }
        let today = day_index(env::block_timestamp());
        let spent = Self::spent_today(agent, asset, today);
        if spent.saturating_add(amount) > limit.per_day.0 {
            return Err(Block::OverDailyCap);
        }
        if asset == NEAR_ASSET && amount > self.spendable_near() {
            return Err(Block::InsufficientBalance);
        }
        Ok(())
    }

    fn block_reason(&self, b: Block, key: &str, asset: &str, receiver: &AccountId, amount: u128) -> String {
        let today = day_index(env::block_timestamp());
        let agent = self.agents.get(key);
        let limit = agent.and_then(|a| a.limits.get(asset));
        match b {
            Block::Paused => "the vault is paused by its owner".into(),
            Block::UnknownAgent => "the signing key is not a registered agent".into(),
            Block::AgentDisabled => "this agent is disabled".into(),
            Block::ZeroAmount => "amount must be greater than zero".into(),
            Block::SelfTransfer => "cannot send to the vault itself".into(),
            Block::TokenDenylisted => {
                let (hit, e) = self.token_deny_entry(&asset.parse().unwrap()).unwrap();
                format!("token {hit} is denylisted: {}", e.reason)
            }
            Block::TokenNotAllowlisted => format!("token {asset} is not on the token allowlist"),
            Block::RecipientDenylisted => {
                let (hit, e) = self.recipient_deny_entry(receiver).unwrap();
                format!("recipient {hit} is denylisted: {}", e.reason)
            }
            Block::RecipientNotAllowlisted => format!("recipient {receiver} is not on the recipient allowlist"),
            Block::AssetNotPermitted => format!("this agent has no budget for {asset}"),
            Block::OverTxCap => format!(
                "amount {amount} exceeds the per-transaction cap {}",
                limit.map(|l| l.per_tx.0).unwrap_or(0)
            ),
            Block::OverDailyCap => {
                let spent = agent.map(|a| Self::spent_today(a, asset, today)).unwrap_or(0);
                format!(
                    "amount {amount} + spent today {spent} exceeds the daily cap {}",
                    limit.map(|l| l.per_day.0).unwrap_or(0)
                )
            }
            Block::InsufficientBalance => format!(
                "amount {amount} would dip into storage staking or the reserve (spendable {})",
                self.spendable_near()
            ),
        }
    }

    fn record_block(&mut self, key: &str, asset: &str, receiver: &AccountId, amount: U128, b: Block) -> GuardResult {
        let reason = self.block_reason(b, key, asset, receiver, amount.0);
        if let Some(agent) = self.agents.get_mut(key) {
            agent.blocked += 1;
        }
        GuardEvent::TransferBlocked {
            agent: key.to_string(),
            asset: asset.to_string(),
            receiver_id: receiver.clone(),
            amount,
            code: b.code().to_string(),
            reason: reason.clone(),
        }
        .emit();
        GuardResult { status: "blocked".into(), code: b.code().into(), reason, request_id: None }
    }

    fn agent_transfer(
        &mut self,
        key: String,
        asset: String,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> PromiseOrValue<GuardResult> {
        let asset = Self::normalize_asset(&asset);
        if let Err(b) = self.evaluate(&key, &asset, &receiver_id, amount.0) {
            return PromiseOrValue::Value(self.record_block(&key, &asset, &receiver_id, amount, b));
        }
        let today = day_index(env::block_timestamp());
        let agent = self.agents.get_mut(&key).expect("checked by evaluate");
        let entry = agent.spent.entry(asset.clone()).or_insert((today, 0));
        if entry.0 != today {
            *entry = (today, 0);
        }
        entry.1 += amount.0;
        GuardEvent::TransferAllowed {
            agent: key.clone(),
            asset: asset.clone(),
            receiver_id: receiver_id.clone(),
            amount,
        }
        .emit();
        PromiseOrValue::Promise(self.start_transfer(key, asset, receiver_id, amount, memo, true))
    }

    fn start_transfer(
        &self,
        key: String,
        asset: String,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        counted: bool,
    ) -> Promise {
        let day = U64(day_index(env::block_timestamp()));
        let transfer = if asset == NEAR_ASSET {
            Promise::new(receiver_id.clone()).transfer(NearToken::from_yoctonear(amount.0))
        } else {
            let token: AccountId = asset.parse().unwrap();
            let args = near_sdk::serde_json::json!({
                "receiver_id": receiver_id,
                "amount": amount,
                "memo": memo,
            });
            Promise::new(token).function_call(
                "ft_transfer",
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
        };
        transfer.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_SETTLE_CALLBACK)
                .on_transfer_settled(key, asset, receiver_id, amount, day, counted),
        )
    }

    fn agent_view(&self, key: &str, a: &Agent) -> AgentView {
        let today = day_index(env::block_timestamp());
        AgentView {
            public_key: key.to_string(),
            name: a.name.clone(),
            enabled: a.enabled,
            limits: a
                .limits
                .iter()
                .map(|(asset, l)| {
                    let spent = Self::spent_today(a, asset, today);
                    AssetLimitView {
                        asset: asset.clone(),
                        per_tx: l.per_tx,
                        per_day: l.per_day,
                        spent_today: U128(spent),
                        remaining_today: U128(l.per_day.0.saturating_sub(spent)),
                    }
                })
                .collect(),
            pending: a.pending,
            executed: a.executed,
            blocked: a.blocked,
            created_at: U64(a.created_at),
        }
    }
}

#[cfg(test)]
mod tests;
