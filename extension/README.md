# extension/ — XMR20 Wallet for Chrome

Latest ready-made version: **0.1.143** ([install guide](../INSTALL.md)). The source in this folder is the same version:
`npm run build:extension` builds 0.1.143.

The XMR20 Wallet browser extension. It works in Chrome, Brave and Edge. It holds your SOL and Solana tokens, XMR, and
XMR20 tokens on Monero (Open and Private). It also bridges between the two chains.

> **Experimental, real funds on mainnet, no independent security review.** Use small amounts you can afford to lose.
> Write down your recovery phrases.

## Install from this repository

1. Follow "Download (once)" in the [main README](../README.md): install Node.js, get the repository, run `npm install`.
2. Build:

   ```bash
   npm run build:extension
   ```

   This makes the folder `extension/dist`.
3. In Chrome, open `chrome://extensions` and switch on **Developer mode** (top right).
4. Click **Load unpacked** and choose `extension/dist` (the folder that contains `manifest.json`).
5. Pin **XMR20 Wallet** from the puzzle-piece menu, open it, and create or import a wallet.

Chrome runs the wallet from that folder, so don't delete or move it. The extension ID stays the same
(`jigbpnljnmbbkebaopbnnhmiafgnofla`) because `manifest.json` carries the extension's public key.

## Install from a tester zip

You can use a ready-made zip instead: `XMR20-Wallet-0.1.143.zip` from the
[Releases page](https://github.com/xmr20project/xmr20-wallets/releases). It is exactly the build that was installed and
tested. [INSTALL.md](../INSTALL.md) has the same steps with pictures:

1. Unzip it into a folder you will keep.
2. In `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**, and choose the unzipped folder.

## Update to a newer build

Put the new files into the **same folder**, either by rebuilding or by unzipping over it. Then click **Reload** on the
XMR20 Wallet card in `chrome://extensions`. Your wallets stay.

**Never click "Remove":** removing the extension deletes the wallets saved in it. If you already have XMR20 Wallet
loaded from another folder, update that one instead of loading a second copy.

## First steps

1. **Bridge tokens from Solana to Monero.** Tap **Bridge**, choose **To Monero**, and pick the token. You need a little
   SOL for the Solana fee. Tokens arrive as **Open XMR20** after about 20 minutes (10 Monero confirmations). XMR20's
   1.5% token fee applies in each direction.
2. **Add a little XMR for Monero network fees** (about 0.002 XMR). Tap XMR20 under MONERO, copy the address under
   "XMR for network fees", and send XMR to it.
3. **Then try:**
   - Send (open to a Monero address, or private to an `xmr20p1…` address)
   - Make private and Make open
   - Bridge back to Solana

   Private transfers need 2 XMR coins. The **Private** tab offers **Enable private transfers**, which splits your XMR
   into 3 coins once.

The first scan of an account takes 2–3 minutes. After that, only new blocks are scanned.

## How it is built

`build.mjs` follows the same recipe as the real releases (0.1.103–0.1.143):

- **Start from the previous release's files.** These are in `prebuilt/`, kept exactly as installed in 0.1.143: the popup
  page, icons, background service worker, approval page, older workers, and three bundles the releases did not rebuild
  every time:
  - the Monero Market window `market-wallet.*` and background runner `market-runner.*` (since 0.1.126; lots of any XMR20
    token since 0.1.140). The releases built them from `src/market-wallet.js` and `src/market-runner.js` with the market
    settings (`marketDefine` in `../engine/build.mjs`) and, since 0.1.140, `__XMR20_MONERO_MARKET_TOKENS__` (the token
    list for names: `https://api.xmr20.org/api/private-bridge`). This repository keeps them as installed and does not
    rebuild them;
  - `private-balance.js` (private transfers, since 0.1.136): the screens and code in `private-balance/src/` plus
    Helius's Solana Privacy Rings SDK, one ES module the popup loads only when it is opened. See below to rebuild it.
- **Rebuild from source:**
  - `app.js` (the wallet) from `src/app.js`, with `../engine/token`, `../engine/shared` and `src/mordinals`. The popup's
    private transfers rows (0.1.136–0.1.142), the Mordinals screens in Collectibles (0.1.142) and the Solana node choice
    (0.1.141) are plain source here; the release builds added the first two while bundling.
  - `vendor/` (the engine files) from `../engine/build.mjs`
  - `vendor/mordinals.worker.js` from `src/mordinals/mordinals.worker.js`, and `vendor/mordinals.wasm`, the Mordinals
    engine (`../engine/holder-wasm/mordinals.wasm`, source in `../engine/holder-wasm/mordinals/`)
  - `style.css` from `../engine/shared/extension-style.css` + `../engine/token/private-format.css`, then
    `private-balance/private.css`, `src/mordinals/mordinals.css` and `src/wxmr-screens.css`
  - `manifest.json`

The Mordinals screens use the XMR721 rule library in `src/mordinals/rules/`, copied unchanged from
[xmr20project/xmr721](https://github.com/xmr20project/xmr721) (`rules/lib` at commit `7dc983b`). The build fixes the
reader's address and the ledger's settings (`mordinals` in `build.mjs`); the screens refuse a reader that serves anything
else.

Checked on 14 November 2026:

- Every file of `dist/` except `app.js` is byte-identical to the installed 0.1.143, `manifest.json` included, apart from
  esbuild's 2-character interop flag in `vendor/private-holder.worker.js` (see `../engine/README.md`).
- `app.js`: built with the npm libraries left out, this folder's source gives byte for byte the release's popup code,
  except in three shared files. `native-popup-channel.js` and `private-journal.js` keep their Monero Market hooks here,
  which do nothing unless the market window passes its options. `native-swap-page.js` is the newer copy the website wallet
  uses; the releases keep the 0.1.114 one. The newer copy only adds two options (starting side, balance line) the
  extension does not pass.
- `npm run build:private-balance` rebuilds `private-balance.js` byte-identical to the one in `prebuilt/`.
- In Chromium, with a new wallet and no funds, the built extension loads with its usual ID and shows, without page
  errors: Send, Bridge, Swap and Receive at three popup sizes; the wXMR row and screen (with simulated balances of 1 SOL
  and 2.5 wXMR for that new address); Swap with live Jupiter quotes both ways (never sent); the profile link; the private transfers row and screen (read through the gateway, stopped at the fee
  check); Mordinals reading the live XMR721 reader, with Find and Buy.

`app.js` is not byte-identical to an app.js built in the main repository. The main repository's build takes
`@solana/web3.js`, `@noble/*` and similar libraries from three separate `node_modules` folders (the same versions), and
bundles three copies. This repository installs one copy, so its `app.js` is smaller: about 1.0 MB instead of 1.6 MB.

`src/` is the code only the extension uses. Code the website wallet also uses is in `../engine/shared/`.
`background.js` and `approval.js` are kept prebuilt, like the release recipe does; their sources are in `src/` for
reading.

### Rebuild private-balance.js (optional)

```bash
npm run build:private-balance
```

This installs `private-balance/`'s own dependencies (Helius's `@heliuslabs/spr` 0.9.0-alpha and `@solana/kit` 8.6.0,
pinned in its `package-lock.json`) into `private-balance/node_modules`, builds `private-balance/dist/private-balance.js`
with the extension's settings and says whether it is the same file as `prebuilt/private-balance.js`. The folder is not
an npm workspace: the SDK needs `@noble/curves` 2.x while the rest of the wallets use 1.9.7, and a separate install keeps
one copy of each library in the bundle, as in the release.

Licences of the libraries bundled into `private-balance.js`: `private-balance/THIRD-PARTY-NOTICES.txt`.

Private transfers go through `https://api.xmr20.org/api/private-balance/`, which adds the Helius key on the server; the
popup never holds it. Only the sending and receiving Solana addresses are public, not the token or the amount. A private
send costs 0.004 SOL on top of the network fee.

## Tests

```bash
npm test -w extension
```

This runs 51 of the extension's unit-test files (461 tests). They cover bridge reads and retries, holdings and prices,
site connection policy, saved scan progress, max amounts, pending debits, the Solana node choice, wXMR reads, token
sends, market lots of two tokens and more. The remaining test files of the main repository need its review bundles or
older build outputs, so they stay there.
