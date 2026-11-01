/**
 * Offline data for the console mode (`--offline`) and the deterministic video demo.
 * Mainnet facts were recorded from the public RPC (rpc.mainnet.fastnear.com) on 2026-11-01:
 * account existence, whether it has a contract, and `ft_metadata`. Indexer facts (age, holders)
 * are left out, so those checks report "unknown", exactly as they do when an indexer is down.
 */
import { FixtureNearData } from "../risk/near-data";
import type { Network } from "../risk/types";
import type { NearDataSource } from "../risk/near-data";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export function recordedMainnetData(): FixtureNearData {
  return new FixtureNearData("mainnet", {
    accounts: {
      "wrap.near": { exists: true, hasContract: true },
      "wrap-near.near": { exists: true, hasContract: false },
      "usdt.tether-token.near": { exists: true, hasContract: true },
      [USDC]: { exists: true, hasContract: true },
      "intents.near": { exists: true, hasContract: true },
    },
    views: {
      "wrap.near:ft_metadata": { spec: "ft-1.0.0", name: "Wrapped NEAR fungible token", symbol: "wNEAR", decimals: 24, icon: "" },
      "wrap.near:ft_total_supply": "1",
      "usdt.tether-token.near:ft_metadata": { spec: "ft-1.0.0", name: "Tether USD", symbol: "USDt", decimals: 6, icon: "data:image/svg+xml,icon" },
      "usdt.tether-token.near:ft_total_supply": "1",
      [`${USDC}:ft_metadata`]: { spec: "ft-1.0.0", name: "USDC", symbol: "USDC", decimals: 6, icon: "data:image/svg+xml,icon" },
      [`${USDC}:ft_total_supply`]: "1",
    },
  });
}

/** Data sources for the offline console: recorded mainnet facts, optionally a live/local network for the vault. */
export function offlineData(extra: Partial<Record<Network, NearDataSource>> = {}): Partial<Record<Network, NearDataSource>> {
  return { mainnet: recordedMainnetData(), testnet: new FixtureNearData("testnet"), ...extra };
}
