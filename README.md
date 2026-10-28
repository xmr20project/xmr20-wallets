# XMR20 Wallets

This repository holds every XMR20 wallet in one place, plus the engine they all share.

> **Experimental software, real funds.** The wallets work on Monero and Solana **mainnet**. They have **not** had an
> independent security review. Use small amounts you can afford to lose, and write down your recovery phrase.

## What is in here

| Folder | What it is | Who it is for |
|---|---|---|
| [`engine/`](engine/) | **The shared engine.** XMR20 tokens on Monero (Open and Private balances), the private bridge to and from Solana, `xmr20p1…` private addresses, "Enable private transfers", and the Monero (XMR) wallet worker. | Developers. All three wallets below use it, so they behave the same. |
| [`extension/`](extension/) | **XMR20 Wallet for Chrome** (also Brave and Edge). | Most people. It is the most complete wallet. |
| [`web-wallet/`](web-wallet/) | **The wallet on xmr20.org.** It connects to Phantom or Solflare. | People who don't want to install anything. Just open https://xmr20.org. |
| [`cli/`](cli/) | **The terminal wallet.** You type commands like `xmr20 balance`. | People who like the command line, and scripts. |

### Which one should I use?

- **Just want to try XMR20?** Use the website: open https://xmr20.org and click **Connect wallet**. Nothing to download.
- **Want your own wallet that keeps your keys in your browser?** Use the **Chrome extension** ([how](#2-the-chrome-extension)).
- **Comfortable with a terminal?** Use the **CLI** ([how](#3-the-terminal-wallet-cli)).

All three can hold the same Monero wallet. The CLI and the extension can even use the same 25-word phrase. Only send
from one of them at a time.

## Download (once)

1. **Install Node.js** version 22 or newer from https://nodejs.org. Choose the "LTS" download, then open it and click
   through the installer.
2. **Get this repository.** Use one of these:
   - Easiest: on the GitHub page, click the green **Code** button → **Download ZIP**. Unzip it somewhere you will
     keep, for example your Documents folder.
   - Or, with git: `git clone https://github.com/xmr20project/xmr20-wallets.git`
3. **Open a terminal in that folder.**
   - Mac: open the **Terminal** app, type `cd ` (with a space), drag the folder into the window, and press Enter.
   - Windows: open the folder, click the address bar, type `cmd`, and press Enter.
4. **Install the parts the wallets need** (a few minutes, once):

   ```bash
   npm install
   ```

## Run each wallet

### 1. The website wallet

Nothing to build. Open **https://xmr20.org** and click **Connect wallet**.

To run your own copy on your computer (for developers), see [`web-wallet/README.md`](web-wallet/README.md).

### 2. The Chrome extension

```bash
npm run build:extension
```

This makes the folder `extension/dist`. Then:

1. In Chrome, open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and choose the `extension/dist` folder.
3. Pin **XMR20 Wallet** from the puzzle-piece menu, open it, and create or import a wallet.

Full steps, updating and the tester zip: [`extension/README.md`](extension/README.md).

### 3. The terminal wallet (CLI)

```bash
cd cli
npm run setup
./xmr20 create
./xmr20 balance
```

`npm run setup` downloads the small browser engine the CLI runs in, once. On Windows, type `node bin/xmr20.mjs`
instead of `./xmr20`. All commands are explained in [`cli/README.md`](cli/README.md).

## How the parts fit together

```
                 engine/   (one copy, used by all three)
   ┌──────────────┬────────────────┬───────────────────────────────┐
   token/          monero/          holder-wasm/      shared/
   Open/Private    XMR wallet       Rust core that    other code the extension
   tokens, bridge  worker           scans and proves  and website both use
   └──────┬───────┴───────┬────────┴──────────┬────────────────────┘
          │               │                   │
     extension/       web-wallet/            cli/
     (Chrome)         (xmr20.org)            (terminal, runs the engine in a
                                              private headless browser)
```

- `npm run build:engine` puts the engine's browser files in `engine/dist/`. The extension, the website wallet and the CLI
  each copy them from there. The build checks that these files are byte-for-byte the same as in the installed wallet
  0.1.117.
- The XMR20 token engine runs in the browser: the extension popup, the xmr20.org page, or the CLI's private headless
  Chromium. Your keys never leave your computer. Scanning, proving and signing happen locally.

## Tests

```bash
npm test
```

This runs the engine tests, the extension's unit tests and the CLI's unit tests. More checks are listed in each
folder's README.

## Where this came from

The wallets were developed in the main project repository, https://github.com/xmr20project/XMR20. That repository
also holds the website, the bridge server, the indexer and research, and those stay there. This repository is the
wallets' new home. Changes are proposed as pull requests.

## Safety

- Never paste your recovery phrase or Solana secret key into a website, chat or command. The CLI only asks for them
  in hidden prompts.
- Every send shows a review first: amount, recipient and network fee. Nothing is sent until you approve it.
- Tokens are **Open** by default: amounts and owners are visible on chain. **Private** is your explicit choice
  ("Make private").
- Report security problems privately to the project before posting them publicly.

## License

MIT. See [LICENSE](LICENSE). The Monero library (monero-ts), the Penumbra crates and other dependencies keep their own
licenses. Their license files are included where their code is.
