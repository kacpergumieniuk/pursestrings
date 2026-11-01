# Naming: why PurseStrings

**Decision (2026-11-01): the project is called PurseStrings** (written `PurseStrings`, slug `pursestrings`).
Tagline: *Your agent carries the purse. You hold the strings.*

"Guard" was too generic: Safeguard and Wallet Guard already exist, and the word is unsearchable.

## What makes a name stick (crypto, dev tools, hackathons)

- **A concrete image beats an abstract word.** Strong crypto names picture something: Ledger, MetaMask, Phantom, Safe.
  The picture explains the product before the README does.
- **It tells the story in one line.** Judges remember a demo by one sentence. "Hold the purse strings" already means
  "control the money", which is the whole product.
- **It passes the radio test.** You hear it once and can say and spell it. Two plain English words do.
- **It is searchable and free where it matters.** On NEAR that means the `.near` account; then npm, GitHub, a domain, and no
  token or agent product with the same name.
- **Short beats clever, but unique beats short.** All the one-word candidates (Bouncer, Reins, Curfew, Warden) are taken
  everywhere. A familiar two-word idiom fused into one word gives uniqueness without inventing a word.

## Candidates

About 15 candidates were generated. Five went to the full check (web search for crypto and AI-agent products, CoinGecko token
search, npm, GitHub, `<name>.near` via `view_account` on `rpc.mainnet.fastnear.com`, and RDAP for `.xyz` and `.dev`).

Shortlist, checked 2026-11-01:

| Name | Crypto / AI-agent collisions | Token (CoinGecko) | npm | GitHub repos named so | `.near` | `.xyz` | `.dev` |
|---|---|---|---|---|---|---|---|
| **PurseStrings** | none found | none | free | 5 (Roll20 script, budget demos; all 0–1 stars) | **free** | **free** | **free** |
| Chaperone | "Agent Chaperone" (Jev): runtime security layer that screens AI-agent tool calls against prompt injection; same space | none | taken | 264 | free | taken | taken |
| Purser | `purser` on npm is an Ethereum wallet library; Purserfi (PURSER) token | PURSER | taken | 150 | free | taken | taken |
| Airlock | Magna's Airlock (token-unlock protocol, Zellic audit); airlock.run (AI app platform) | none | taken | 1,007 | free | taken | taken |
| Reins | "Rein": control plane for AI-agent payments (rules, payment monitoring, counterparty scoring); almost the same product | none | free | 1,729 | taken | taken | taken |

Also generated, dropped after the quick checks: Bouncer (generic; `bouncer.near`, npm and domains taken), Bridle, Spotter,
Curfew, Tollgate, Cordon, Warden (Warden Protocol is an AI-agent chain), Tripwire (well-known security product), Handbrake
(the video transcoder), Seatbelt (Apple sandbox and GhostPack tool names). Already known to be taken: Pocket Money (AutEng),
LEASH (Shiba ecosystem token).

## Why PurseStrings wins

- The idiom *to hold the purse strings* means to control the money. That is exactly the split we built: the agent gets a
  budget and a limited key (the purse), and the owner keeps the caps, the deny lists, the pause switch and the approvals (the
  strings).
- It is the only shortlisted name that is free on every channel we checked: `pursestrings.near`, npm, `.xyz`, `.dev`, and no
  crypto product, token or AI-agent tool with that name.
- It is two everyday words: easy to say, spell and remember, and it reads well in a tweet.
- Trade-offs: 12 letters is long, and the idiom may be less familiar to non-native speakers. The tagline explains it in eight
  words. Chaperone was the runner-up but collides with an AI-agent security tool.

None of the free names or accounts were registered; that is the owner's call.

## What was renamed, and what was not

Renamed (everything a user, judge or viewer sees): README, `docs/SUBMISSION.md` (project name, idea text, X post drafts),
Telegram bot texts (help, notices, `/whoami`, command descriptions), CLI and demo output, the demo viewer page, `package.json`
name (`pursestrings`) and description, crate descriptions and repository links, the demo video and its files
(`docs/video/pursestrings-demo.{mp4,en.srt,cast}`, re-recorded and re-rendered), the scene stills, the sandbox demo accounts
(`purse-owner-…`), the dashboard logo (`dashboard/logos/guard.svg`, now a drawstring purse), and the GitHub repository
(`kacpergumieniuk/near-guard` → `kacpergumieniuk/pursestrings`).

Kept on purpose (renaming would be risky or would break deployed state):

| Identifier | Why it stays |
|---|---|
| Contract crate `near-guard`, directory `contracts/guard`, wasm `near_guard.wasm` | build paths, the sandbox tests and the upgrade fixture (`near_guard_7c32380.wasm`) depend on them |
| Rust types `Guard`, `GuardResult`, `GuardEvent` | internal names used across the contract, unit tests and sandbox tests; renaming them is churn with no user benefit, just before a deadline |
| NEP-297 event standard `nearguard` | emitted by the deployed testnet vault; the Telegram watcher and indexers match on it |
| Contract method names (`agent_transfer_near`, `approve_request`, …) | part of the deployed contract's interface and the agent's function-call key permissions |
| TypeScript classes `GuardBot`, `AgentGuard`, `OwnerGuard`, `GuardViews`, `GuardedWallet`; file `guard-client.ts` | internal API names, not shown to users |
| Environment variables `GUARD_*` | existing `.env` files keep working |
| `.guard-local/` state directory | holds the existing testnet keys; renaming it would orphan them |
| Testnet accounts `guard-owner-mvxpkwqz.testnet`, `vault.guard-owner-mvxpkwqz.testnet` | live accounts with real transactions linked from the README |
| `docs/demo-output-testnet*.txt` | verbatim logs of real testnet runs made before the rename |
| Telegram console marker `GuardChat`, viewer hook `window.__guardViewer` | internal protocol between the demo and the viewer |
| Git history | commits before 2026-11-01 say "Guard" |

## Sources (read 2026-11-01)

- Naming heuristics: [brandbucket dev-tools naming](https://www.brandbucket.com/industries/dev-tools), [lr0.org on dev-tool names](https://lr0.org/blog/p/namings/)
- Collisions: [Agent Chaperone review (AI Indigo)](https://aiindigo.com/blog/agent-chaperone-screen-ai-agent-tool-calls-and-results-with-jev-deep-dive-technical-review),
  [Rein on Glama](https://glama.ai/mcp/servers/bugiiiii11/rein), [purser on npm](https://npmjs.com/package/purser),
  [Magna Airlock audit (Zellic)](https://reports.zellic.io/publications/airlock), [airlockrun](https://pkg.go.dev/github.com/airlockrun/airlock)
- Registries: `registry.npmjs.org`, GitHub search API, `api.coingecko.com/api/v3/search`, `rdap.centralnic.com/xyz`,
  `pubapi.registry.google/rdap` (`.dev`), NEAR RPC `view_account` on `rpc.mainnet.fastnear.com`
