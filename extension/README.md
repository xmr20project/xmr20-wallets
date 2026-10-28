# extension/ — XMR20 Wallet for Chrome (0.1.118)

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

Testers may get a ready-made zip instead, for example `XMR20-Wallet-0.1.117.zip`:

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

`build.mjs` follows the same recipe as the real releases (0.1.103–0.1.118):

- **Start from the previous release's files.** These are in `prebuilt/`: the popup page, icons, background service
  worker, approval page, Monero Market files and older workers. They are kept exactly as installed in 0.1.117.
- **Rebuild from source:**
  - `app.js` (the wallet) from `src/app.js`, with `../engine/token` and `../engine/shared`
  - `vendor/` (the engine files) from `../engine/build.mjs`
  - `style.css` from `../engine/shared/extension-style.css` + `../engine/token/private-format.css`
  - `manifest.json`

Checked on 28 October 2026:

- Every file of `dist/` except `app.js` and `manifest.json` is byte-identical to the installed 0.1.117.
- The Chromium smoke test loads the extension with its usual ID and shows the start screen without page errors.

`app.js` is not byte-identical to an app.js built in the main repository. The main repository's build takes
`@solana/web3.js`, `@noble/*` and similar libraries from three separate `node_modules` folders (the same versions), and
bundles three copies. This repository installs one copy, so its `app.js` is smaller: about 1.0 MB instead of 1.6 MB.

`src/` is the code only the extension uses. Code the website wallet also uses is in `../engine/shared/`.
`background.js` and `approval.js` are kept prebuilt, like the release recipe does; their sources are in `src/` for
reading.

## Tests

```bash
npm test -w extension
```

This runs 44 of the extension's unit-test files (408 tests). They cover bridge reads and retries, holdings and prices,
site connection policy, saved scan progress, max amounts, pending debits and more. The remaining test files of the main
repository need its review bundles or older build outputs, so they stay there.
