/**
 * Canonical accounts, tokens and domains that attackers like to imitate.
 * Verified against RPC `ft_metadata` on 2026-11-01. Extend at runtime via
 * `RiskEngine` options (e.g. the tokens your own guard allowlists).
 */
import type { Network } from "./types";

export interface KnownToken {
  accountId: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface KnownSet {
  tokens: KnownToken[];
  /** Well-known non-token accounts (protocols, bridges, exchanges). */
  accounts: string[];
}

export const KNOWN: Record<Network, KnownSet> = {
  mainnet: {
    tokens: [
      { accountId: "wrap.near", symbol: "wNEAR", name: "Wrapped NEAR", decimals: 24 },
      { accountId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", symbol: "USDC", name: "USDC", decimals: 6 },
      { accountId: "usdt.tether-token.near", symbol: "USDt", name: "Tether USD", decimals: 6 },
      { accountId: "eth.bridge.near", symbol: "ETH", name: "Ether", decimals: 18 },
      { accountId: "nbtc.bridge.near", symbol: "BTC", name: "Bitcoin", decimals: 8 },
      { accountId: "meta-pool.near", symbol: "stNEAR", name: "Staked NEAR", decimals: 24 },
      { accountId: "token.rhealab.near", symbol: "RHEA", name: "Rhea", decimals: 18 },
      { accountId: "token.sweat", symbol: "SWEAT", name: "SWEAT", decimals: 18 },
    ],
    accounts: [
      "near", "intents.near", "wrap.near", "v2.ref-finance.near", "tether-token.near", "bridge.near", "factory.bridge.near",
      "omft.near", "aurora", "relay.aurora", "sputnik-dao.near", "meta-pool.near", "linear-protocol.near", "rhealab.near",
      "burrow.near", "contract.main.burrow.near", "token.sweat", "lockup.near", "poolv1.near", "social.near",
    ],
  },
  testnet: {
    tokens: [
      { accountId: "wrap.testnet", symbol: "wNEAR", name: "Wrapped NEAR", decimals: 24 },
      { accountId: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af", symbol: "USDC", name: "USDC", decimals: 6 },
      { accountId: "usdt.fakes.testnet", symbol: "USDT.e", name: "Tether USD", decimals: 6 },
      { accountId: "usdc.fakes.testnet", symbol: "USDC.e", name: "Bridged USDC", decimals: 6 },
    ],
    accounts: ["testnet", "wrap.testnet", "intents.testnet", "v2.ref-finance.testnet", "sputnik-v2.testnet", "guest-book.testnet"],
  },
  sandbox: { tokens: [], accounts: ["sandbox"] },
};

/** Symbols that scammers copy most. A token using one of these must be the canonical contract. */
export const PROTECTED_SYMBOLS = ["USDC", "USDT", "WNEAR", "NEAR", "ETH", "WETH", "BTC", "WBTC", "STNEAR", "DAI", "SOL", "USDE"];

/** Official domains for the NEAR ecosystem and the brands above. Subdomains are also official. */
export const OFFICIAL_DOMAINS = [
  "near.org", "near.ai", "near.com", "nearhackathon.com", "nearblocks.io", "pikespeak.ai", "mynearwallet.com",
  "meteorwallet.app", "wallet.hot-labs.org", "hot-labs.org", "intents.near.org", "near-intents.org", "chaindefuser.com",
  "rhea.finance", "ref.finance", "app.ref.finance", "metapool.app", "sputnik.fund", "trezu.org", "nearbuilders.org",
  "github.com", "circle.com", "tether.to", "x.com", "twitter.com", "t.me", "discord.gg",
];

/** Brand words that a phishing domain borrows. */
export const BRAND_WORDS = ["near", "intents", "rhea", "meteor", "sweat", "aurora", "usdc", "usdt", "tether", "circle", "metapool", "sputnik"];

export const URL_SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "cutt.ly", "rb.gy", "shorturl.at", "tiny.cc", "rebrand.ly"];

/** TLDs over-represented in phishing (free or cheap, low abuse handling). */
export const RISKY_TLDS = ["zip", "mov", "xyz", "top", "click", "gq", "tk", "ml", "cf", "ga", "icu", "cfd", "sbs", "rest", "lol", "cyou", "buzz", "monster"];
