# engine/holder-wasm/ — the holder engine (Rust → WebAssembly)

`holder.wasm` is the XMR20 holder engine all three wallets load. It does five jobs:

- derives the token keys from the Monero recovery phrase (scheme XMR20-TKD1)
- scans the Monero chain for XMR20 records, locally on your device
- builds and proves records: open and private transfers, Make private / Make open, bridge burns
- builds the Monero "carrier" transactions that publish those records
- saves scan progress
- reports the block of every note it holds, and checks transfers still waiting in the Monero node's pool for this wallet,
  without applying them (so wallets can show incoming tokens as Pending, then Confirming n/10)
- the Monero Market (since 31 October 2026, experimental): anchored lots (records XA1/XL1), whole-lot sales in one Monero
  transaction where each wallet signs only its own inputs, spare anchors made ahead of time, and the lot rules every reader
  applies from the mainnet start block 3,796,100

> **EXPERIMENTAL research code, not independently reviewed.** Private proofs use Penumbra's unchanged circuits and
> its published proving keys. XMR20 ran no trusted setup of its own.

## Files

| Path | What it is |
|---|---|
| `holder.wasm` | The built engine (`xmr20-holder-wasm 0.0.6-market-experimental`, built with `XMR20_MARKET_MAINNET_ACTIVATION=3796100`, sha256 `5b599818…`). Byte-identical to the one in XMR20 Wallet 0.1.126–0.1.128 and on xmr20.org (release 31 onwards). |
| `crate/` | The wasm crate (`xmr20-holder-wasm-market`): `src/lib.rs` (token engine API), `src/native.rs` (the Monero side: scanning your XMR and building carrier transactions), `src/market_ops.rs` and `src/native_market.rs` (lots, sales and spare anchors), `src/nft_ops.rs` and `src/nft_v2.rs` (anchored NFT sales, not open yet). The `lab-adversary` feature is a separately built TEST-ONLY copy for the settlement tests; the wallets never use it. |
| `core/` | `xmr20-market-core`: the token format (records, ledger rules, proofs over Penumbra's circuits) plus the market's lot rules (`src/market.rs`) and the activation gate. The bridge's indexer and issuer use it too, built with the same start block. |
| `vendor/monero-wallet/` | A vendored copy of the `monero-wallet` crate, used to build Monero transactions. |
| `vendor/penumbra-sdk-shielded-pool/` | Penumbra's `penumbra-sdk-shielded-pool` 2.1.1. Two files differ from upstream (`src/spend/proof.rs`, `src/output/proof.rs`): they make two constructors public. The constraints are unchanged. |
| `vendor/getrandom-0.2.17/` | getrandom 0.2.17. One change: in the browser worker, randomness comes from `crypto.getRandomValues` through the "custom" backend (see its `PATCH-NOTE.txt`). |

## Rebuild (optional, for reviewers)

You need Rust and the wasm target:

```bash
rustup target add wasm32-unknown-unknown
cd engine/holder-wasm/crate
XMR20_MARKET_MAINNET_ACTIVATION=3796100 cargo build --release --target wasm32-unknown-unknown
```

The output is `target/wasm32-unknown-unknown/release/xmr20_holder_wasm_market.wasm`. Release builds take several
minutes the first time. `XMR20_MARKET_MAINNET_ACTIVATION` sets the market's start block on mainnet; without it the engine
ignores market records on mainnet. Every program that reads XMR20 balances (wallets, the bridge's indexer and issuer) must
be built with the same value.

The rebuilt file works the same, but it is not expected to be byte-identical to `holder.wasm`. Rust embeds source
paths, and this layout's paths differ from the original build's. This layout was compile-checked on 31 October 2026
(`cargo check --release --target wasm32-unknown-unknown`); the wallets use the committed `holder.wasm`.
