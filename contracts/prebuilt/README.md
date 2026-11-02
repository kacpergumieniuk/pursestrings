# Prebuilt contracts

`near_guard.wasm` (the PurseStrings contract) and `test_token.wasm` (the fake "USDC" used in the demo), built with
`npm run build:contracts` (`cargo near build non-reproducible-wasm`) from this repository's sources. They are here so
that the demo runs on a machine without Rust: `npm run demo:sandbox` and `npm run demo:video` use them when
`contracts/target/near/` does not exist, and say so. If you build the contracts yourself, your build is used instead.

`SHA256SUMS` lists their hashes; `npm test` checks them (`test/prebuilt.test.ts`).

These are **non-reproducible** builds: the compiler embeds local paths of dependencies, so a build on another machine
gives a different hash. The testnet vault's code is checked the same way in the README ("Verify the deployed code").
