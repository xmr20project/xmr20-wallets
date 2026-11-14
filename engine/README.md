# engine/ — the shared XMR20 wallet engine

All three wallets use this code: the Chrome extension, the xmr20.org website wallet and the terminal wallet (CLI).
Each file exists **once** in this repository, and the wallets import it from here.

> **Experimental.** The token format, the private bridge and the holder engine have not had an independent security
> review. The private proofs use Penumbra's published circuits and keys.

## What is where

| Folder | What it does |
|---|---|
| `token/` | **XMR20 tokens on Monero.** `token-format.js` handles Open and Private balances, sends (open to a Monero address, private to an `xmr20p1…` address), Make private / Make open, the private bridge to and from Solana with its fee checks, `xmr20p1…` addresses (bech32m form of the Penumbra address), and "Enable private transfers". Next to it are its two workers (`private-holder.worker.js`, `private-claim.worker.js`), the encrypted journal (`private-journal.js`), the scanner and carrier builder (`holder-*.js`), Monero-address certificates (`address-cert.js`), its screen styles (`private-format.css`) and the mainnet parameter manifest. |
| `holder-wasm/` | **The holder engine.** Rust code compiled to `holder.wasm`: token keys (scheme XMR20-TKD1), local chain scanning, building and proving records, Monero carrier transactions, and the Monero Market's anchored lots (from block 3,796,100). `holder.wasm` is the built file the wallets use; the Rust sources are next to it ([README](holder-wasm/README.md)). `mordinals.wasm` is the same engine plus the Mordinals operations, which the extension's Collectibles tab runs (0.1.142+). |
| `monero/` | **The XMR wallet.** `runtime/` holds the Monero worker exactly as installed in wallet 0.1.144: `native.worker.js` with its XMR20 coin guard (`native-carrier-guard.js`), `market-ordinary-guard.js`, `native-carrier-transaction.js` and `keys.worker.js`. `native-wallet-client.js` is the small client the website and the CLI use to talk to it. `patches/` keeps the four scripts that added the TKD1 change-freeze fix, the 3-coin split (`prepareSplit`), the choice of 2 to 16 coins (`coins`) and one transaction paying up to three exact amounts for a Mordinal purchase (`preparePayments`, 0.1.142) to the worker; `runtime/` already contains their result. |
| `headless/` | **For programs without screens.** `token-ops.js` lets the CLI use the token engine: it fills the same fields and presses the same buttons a person would, and stops at every review. It does not repeat any engine logic. |
| `shared/` | **Other code the extension and the website both use**, so it isn't copied twice: wallet helpers from the extension (`core.js`, prices, holdings, the native send and swap pages…), the older bridge SDK (`bridge-sdk/`), the native-market client and XN1 format (`native-market/`), the shared protocol constants (`protocol/`), three website modules the extension imports (`website/`, among them the SOL ⇄ wXMR swap checks), the extension's base stylesheet and the build plugin (`build-tools/`). |
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

It then compares every file with the one installed in **XMR20 Wallet 0.1.144** and writes
the result to `dist/HASHES.json`. All 13 files are byte-identical, with one checked exception: the token worker imports the
market's CommonJS codec (`market-mapcodec.cjs`), and because `engine/` is an ES-module package esbuild adds a 2-character
interop flag to that import. Without that flag the worker is byte-identical; `build.mjs` checks exactly this. The extension, website and CLI builds call this build
themselves.

## Tests

```bash
npm test -w engine
```

- `engine-build.test.mjs`: the build is byte-identical to wallet 0.1.144 (apart from the interop flag above).
- `xmr20p-address.test.mjs`: `xmr20p1…` ⇄ `penumbra1…` round trips, the BIP-350 vectors, and that a mistyped address
  is refused.
- `worker-split.test.mjs`: the Monero worker's `prepareSplit` builds one transaction to yourself with 2 equal payments
  plus change, never relays it, refuses tiny balances, and refuses to spend an XMR20 carrier coin.
- `worker-split-coins.test.mjs`: Split with 2 to 16 coins (Monero allows 16 outputs per transaction): equal payments to
  yourself plus change, at least 0.0002 XMR per coin, 3 coins when none is chosen, never relayed, carrier coins never spent.
- `worker-payments.test.mjs`: `preparePayments` (0.1.142) pays up to three exact amounts in one transaction, never
  relays it, and refuses an empty or longer list, a bad address or amount, this wallet's own address, and a transaction
  that does not pay exactly what was asked.
- `token-pending.test.mjs`: the real token module with its encrypted journal: right after a private send the private balance
  leaves out the notes the transfer holds ("200 pending"), and each pending operation is one compact row; tokens arriving show
  as Pending while they wait in the node's pool, then Confirming n/10, and the wallet's own change is not shown as received.
- `guard-tkd1.test.mjs`: the coin guard recognises XMR20-TKD1 carrier coins and keeps them frozen.
- `holder-carrier-distribution.test.mjs`: private and open transfers read the Monero output distribution once and then only the
  last blocks, give the engine the same numbers as a whole-chain read, read everything again after a reorganisation, and share
  one read between the warm-up (a transfer screen opened) and a quote.
- `headless.test.mjs`: the headless layer drives the real token module in Chromium, offline, with stand-in workers.
  It stops at the fee review, Cancel releases the coin, refusals come back as errors, and the split is relayed only
  after approval. It needs Playwright's Chromium (`npm run setup -w cli`); without it, this test is skipped.

## Monero Market (31 October 2026, experimental)

The token worker also runs the market's wallet operations (`token/market-worker.js`, with `market-nft-ledger.js` and the
reader's codec `market-mapcodec.cjs`/`market-rc.cjs`). They are switched on by the market settings in `build.mjs`
(`marketDefine`). The market host both wallets use (`shared/market-host.js`, `market-open.js`, `market-reviews.js`,
`market-relay-seal.js`, `market-nft-messages.js`, `market-wallet.css`) keeps the seller's and buyer's state in the
encrypted journal (`token/private-journal.js`), talks to the order book at `https://api.xmr20.org/market`, and asks for
every approval in the wallet's own dialog. In the main repository six wallet files get their market hooks from patches
(`wallet-extension/market/patches`) only in market builds; here those six files are published with the hooks applied
(`token/private-holder.worker.js`, `token/private-journal.js`, and in the extension `background.js`,
`native-popup-channel.js`, `site-broker.js`, `site-policy.js`). Without the market settings the hooks do nothing.

## Where it came from

These are the main repository's files (`wallet-extension/src`, `website/frontend/src`, `website/services/native-market`,
`proof-of-concepts/joint-escrow-wallet`), moved into this layout with only their import paths changed. They are the
sources of 3 November 2026: extension 0.1.135 (the tester zip) and the website wallet as live on xmr20.org since
release 63 (2 November 2026). The market files come from `wallet-extension/market/` (its patches are applied to six
wallet files here) and the market engine from the Monero Market research folder. The one edit besides import paths is in
`web-wallet/src/private-wallet-host.js`: it now imports the stylesheet from `shared/extension-style.css` and
`token/private-format.css`, the two files the extension's `style.css` starts from.

On 14 November 2026 the files the extension uses were brought up to extension 0.1.144 (the 0.1.143 features): the Solana node choice
(`shared/solana-rpc.js`, `core.js`, `public-balance.js`, `solana-holdings.js`, `preferences.js`), market lots of any
token (`shared/market-host.js`, `market-reviews.js`), the swap checks (`shared/website/sol-wxmr-swap.js`) and the Monero
worker's `preparePayments`. The website wallet and the CLI in this repository pass none of the new options; with the
defaults these files work as before for them (the first free public Solana node, XMR20 lots only, no payments action).
