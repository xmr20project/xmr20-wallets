# web-wallet/ — the xmr20.org wallet

The wallet on **https://xmr20.org** (**Connect wallet**). It connects to your Phantom or Solflare wallet for Solana.
It keeps a Monero wallet in your browser for XMR and XMR20 on Monero (Open and Private). It runs the same token engine
as the extension and the CLI ([`../engine`](../engine)).

> **Experimental, real funds on mainnet, no independent security review.**

## Use it

Open **https://xmr20.org** and click **Connect wallet**. That's all. Nothing to download.

Browser data is kept per website. A Monero wallet you create on xmr20.org stays in that browser. To use it somewhere
else, use **Show recovery phrase** in the wallet and import the phrase there.

## Run your own copy (for developers)

After "Download (once)" in the [main README](../README.md):

```bash
npm run dev:web
```

Then open http://127.0.0.1:5180/wallet/wallet.html.

- The wallet's `/api/…` requests are forwarded to `api.xmr20.org`, the same way xmr20.org forwards them.
- The private bridge and its Monero node are forwarded without a browser Origin header.
- By default the local copy is **review only**: it shows reviews, but you cannot send.
- `npm run dev:web -- --live` allows real transactions. Each one still needs your Phantom or Solflare approval.

## Build

```bash
npm run build:web
```

This writes `web-wallet/dist/`, served at `/wallet/` on xmr20.org, with the live site's release flags.
`prepare-public.mjs` copies the engine's browser files into `public/` first:

- `public/xmr20-private/`: the token workers, `holder.wasm`, the parameter manifest and the Monero library
- `public/monero-native/`: the Monero worker
- `public/monero-wallet/`: the Monero library and the older bridge's offline signer

The live xmr20.org site is a larger website. The main repository builds this wallet into it, and publishes it there.
This folder holds the wallet part on its own.

## What is where

- `wallet.html`, `src/wallet-entry.jsx`: the standalone wallet page.
- `src/wallet-menu.jsx`, `src/wallet-library.jsx`: the wallet panel and its token list.
- `src/native-balance.jsx`, `src/website-xmr-send.jsx`: the Monero row (sync, unlock, Send XMR, Show recovery phrase).
- `src/private-wallet-host.js`, `src/private-tokens.jsx`: host the shared token engine (Open/Private XMR20, the private
  bridge, Enable private transfers) inside the page. Solana signing goes through Phantom or Solflare.
- `src/website-native-swap.jsx`, `src/website-native-bridge.jsx`: the older bridge's screens.
- `src/website-xmr-detail.jsx`, `src/website-xmr-split.jsx`, `src/xmr-tx-store.js`: the Monero screen (Send, Split, Bridge,
  your receive address), splitting XMR into coins, and this browser's own XMR sends and splits with their confirmations.
- `src/profile-page.jsx`, `src/profile-store.js`: the profile page (portfolio, wallet, activity). The profile itself is
  kept in this browser only.
- `src/wxmr-bridge.js`, `src/website-wxmr-bridge.jsx`, `src/website-wxmr-send.jsx`: XMR ⇄ wXMR through the wxmr.io
  bridge (a public Solana program run by the wXMR team) and sending wXMR.
- `src/solana-chain-holdings.js`, `src/site-prices.js`: Solana token balances read from the chain, and display prices
  (Raydium LaunchLab for XMR20 tokens, CoinGecko for SOL/XMR).
- `src/wallet-premium.css`: the wallet's look.
- `shared/`: small helpers only the website uses. Code shared with the extension is in `../engine/shared/`.

Checked on 28 October 2026:

- `npm run build:web` succeeds.
- The built wallet opens in Chromium and shows **Connect wallet** without page errors.
