# engine/holder-wasm/ — the holder engine (Rust → WebAssembly)

`holder.wasm` is the XMR20 holder engine all three wallets load. It does five jobs:

- derives the token keys from the Monero recovery phrase (scheme XMR20-TKD1)
- scans the Monero chain for XMR20 records, locally on your device
- builds and proves records: open and private transfers, Make private / Make open, bridge burns
- builds the Monero "carrier" transactions that publish those records
- saves scan progress

> **EXPERIMENTAL research code, not independently reviewed.** Private proofs use Penumbra's unchanged circuits and
> its published proving keys. XMR20 ran no trusted setup of its own.

## Files

| Path | What it is |
|---|---|
| `holder.wasm` | The built engine (`xmr20-holder-wasm 0.0.3-persist`, sha256 `dab8720b…c111e`). Byte-identical to the one in XMR20 Wallet 0.1.117 and on xmr20.org. |
| `crate/` | The wasm crate (`xmr20-holder-wasm-persist`): `src/lib.rs` (token engine API) and `src/native.rs` (the Monero side: scanning your XMR and building carrier transactions). |
| `core/` | `xmr20-unshielded-core`: the token format (records, ledger rules, proofs over Penumbra's circuits). The bridge's indexer uses it too. |
| `vendor/monero-wallet/` | A vendored copy of the `monero-wallet` crate, used to build Monero transactions. |
| `vendor/penumbra-sdk-shielded-pool/` | Penumbra's `penumbra-sdk-shielded-pool` 2.1.1. Two files differ from upstream (`src/spend/proof.rs`, `src/output/proof.rs`): they make two constructors public. The constraints are unchanged. |
| `vendor/getrandom-0.2.17/` | getrandom 0.2.17. One change: in the browser worker, randomness comes from `crypto.getRandomValues` through the "custom" backend (see its `PATCH-NOTE.txt`). |

## Rebuild (optional, for reviewers)

You need Rust and the wasm target:

```bash
rustup target add wasm32-unknown-unknown
cd engine/holder-wasm/crate
cargo build --release --target wasm32-unknown-unknown
```

The output is `target/wasm32-unknown-unknown/release/xmr20_holder_wasm_persist.wasm`. Release builds take several
minutes the first time.

The rebuilt file works the same, but it is not expected to be byte-identical to `holder.wasm`. Rust embeds source
paths, and this layout's paths differ from the original build's. The rebuild has not been run in this repository's
layout yet. The wallets use the committed `holder.wasm`.
