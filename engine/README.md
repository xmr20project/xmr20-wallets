# engine/ — the shared XMR20 wallet engine

All three wallets use this code: the Chrome extension, the xmr20.org website wallet and the terminal wallet (CLI).
Each file exists **once** in this repository, and the wallets import it from here.

> **Experimental.** The token format, the private bridge and the holder engine have not had an independent security
> review. The private proofs use Penumbra's published circuits and keys.

## What is where

| Folder | What it does |
|---|---|
| `token/` | **XMR20 tokens on Monero.** `token-format.js` handles Open and Private balances, sends (open to a Monero address, private to an `xmr20p1…` address), Make private / Make open, the private bridge to and from Solana with its fee checks, `xmr20p1…` addresses (bech32m form of the Penumbra address), and "Enable private transfers". Next to it are its two workers (`private-holder.worker.js`, `private-claim.worker.js`), the encrypted journal (`private-journal.js`), the scanner and carrier builder (`holder-*.js`), Monero-address certificates (`address-cert.js`), its screen styles (`private-format.css`) and the mainnet parameter manifest. |
| `holder-wasm/` | **The holder engine.** Rust code compiled to `holder.wasm`: token keys (scheme XMR20-TKD1), local chain scanning, building and proving records, and Monero carrier transactions. `holder.wasm` is the built file the wallets use; the Rust sources are next to it ([README](holder-wasm/README.md)). |
| `monero/` | **The XMR wallet.** `runtime/` holds the Monero worker exactly as installed in wallet 0.1.119: `native.worker.js` with its XMR20 coin guard (`native-carrier-guard.js`), `market-ordinary-guard.js`, `native-carrier-transaction.js` and `keys.worker.js`. `native-wallet-client.js` is the small client the website and the CLI use to talk to it. `patches/` keeps the two scripts that added the TKD1 change-freeze fix and the 3-coin split (`prepareSplit`) to the worker; `runtime/` already contains their result. |
| `headless/` | **For programs without screens.** `token-ops.js` lets the CLI use the token engine: it fills the same fields and presses the same buttons a person would, and stops at every review. It does not repeat any engine logic. |
| `shared/` | **Other code the extension and the website both use**, so it isn't copied twice: wallet helpers from the extension (`core.js`, prices, holdings, the native send and swap pages…), the older bridge SDK (`bridge-sdk/`), the native-market client and XN1 format (`native-market/`), the shared protocol constants (`protocol/`), two website modules the extension imports (`website/`), the extension's base stylesheet and the build plugin (`build-tools/`). |
| `tests/` | Engine tests (see below). |

## Build

From the repository folder:

```bash
npm run build:engine
```

This writes `engine/dist/`:

- both token workers, built with esbuild
- `holder.wasm` and `parameters-manifest.json`
- the Monero worker files
- the Monero library, from the npm package `monero-ts` 0.11.16

It then compares every file with the one installed in **XMR20 Wallet 0.1.119** and writes
the result to `dist/HASHES.json`. All 13 files are byte-identical. The extension, website and CLI builds call this build
themselves.

## Tests

```bash
npm test -w engine
```

- `engine-build.test.mjs`: the build is byte-identical to wallet 0.1.119.
- `xmr20p-address.test.mjs`: `xmr20p1…` ⇄ `penumbra1…` round trips, the BIP-350 vectors, and that a mistyped address
  is refused.
- `worker-split.test.mjs`: the Monero worker's `prepareSplit` builds one transaction to yourself with 2 equal payments
  plus change, never relays it, refuses tiny balances, and refuses to spend an XMR20 carrier coin.
- `guard-tkd1.test.mjs`: the coin guard recognises XMR20-TKD1 carrier coins and keeps them frozen.
- `holder-carrier-distribution.test.mjs`: private and open transfers read the Monero output distribution once and then only the
  last blocks, give the engine the same numbers as a whole-chain read, read everything again after a reorganisation, and share
  one read between the warm-up (a transfer screen opened) and a quote.
- `headless.test.mjs`: the headless layer drives the real token module in Chromium, offline, with stand-in workers.
  It stops at the fee review, Cancel releases the coin, refusals come back as errors, and the split is relayed only
  after approval. It needs Playwright's Chromium (`npm run setup -w cli`); without it, this test is skipped.

## Where it came from

These are the main repository's files (`wallet-extension/src`, `website/frontend/src`, `website/services/native-market`,
`proof-of-concepts/joint-escrow-wallet`), moved into this layout with only their import paths changed. They are the
sources of 28 October 2026: extension 0.1.119 (the tester zip) and website wallet release 9 (live on xmr20.org since
28 October 2026). The one edit besides import paths is in
`web-wallet/src/private-wallet-host.js`: it now imports the stylesheet from `shared/extension-style.css` and
`token/private-format.css`, the two files the extension's `style.css` is built from.
