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

## How private transfers work

XMR20 tokens live on Monero. Every token balance has two sides:

- **Open**: like a normal token. Amounts and owners are visible on chain, and anyone can send open tokens to your
  ordinary Monero address. Tokens bridged from Solana arrive open.
- **Private**: only you can see it. **Make private** moves tokens from your open side to your private side; **Make
  open** moves them back. Both are your explicit choice; nothing becomes private by itself.

A **private transfer** sends from your private side to someone's private address (it starts with `xmr20p1…`; each
wallet shows its own under **Receive private**). The amount and the recipient are not shown on chain. Your
wallet builds a zero-knowledge proof on your own computer (Penumbra's published circuits and keys) that the transfer is
valid without revealing it, and puts the record inside ordinary Monero transactions, whose small XMR network fee you
pay yourself. Like everything here, this is experimental and has not had an independent security review.

Private transfers need 2 XMR coins in your wallet. The wallet's **Enable private transfers** (or **Split** on the
Monero screen) splits your XMR into a few coins once, so you are ready. An incoming transfer shows as **Pending**,
then **Confirming n/10**, until it has 10 Monero confirmations.

## Buying and selling on the Monero Market (experimental)

The [Monero Market](https://xmr20.org/market/) trades **whole lots** of XMR20 for XMR, on Monero. One Monero transaction
pays the seller and delivers the lot to the buyer. On the market page you trade with the xmr20.org website wallet
(**Connect wallet**, top right). The Chrome extension 0.1.128 carries the same market code (a market window and a
background runner); the live page offers the site's own wallet.

- **Selling.** Open XMR20 on the market, go to **Sell**, enter a quantity and a total price in XMR (it starts at the
  Solana price, shown in $), and approve in your wallet. Your wallet moves that exact amount from your Open balance into
  a *lot* and lists it. Everyone sees it as **Listing soon** right away, then it is listed once the lot is in a Monero
  block. Buyers can pay once the lot has 25 confirmations; until then it shows **Tradeable in about N min**.
- **Buying.** Pick a lot, press **Buy** and approve the exact total in your wallet. The seller's wallet checks the same
  transaction and approves it too (automatically while their page or extension is open).
- **Why lots have an anchor.** A lot can only move in a transaction that also spends one specific Monero output, its
  *anchor*. A second sale of the same lot would spend that output twice, which Monero refuses, so a lot cannot be sold
  twice. The wallet makes its anchors early, as ordinary 0-XMR payments to itself, and names one only when it makes a
  lot. An anchor made at the moment of the sale would point out which coin in the transaction is the real one (the
  "black marble" problem Mordinals has); a spare made earlier does not. The first lot from a wallet therefore takes about
  20 minutes (Monero unlocks a new output after 10 blocks); after that the wallet keeps a spare ready.
- **Balances.** From Monero block 3,796,100 every XMR20 wallet and the bridge apply the lot rules, so tokens in a lot
  never count twice.

The settlement is experimental and has not had an independent security review. Trade small amounts.

## What's new (31 October 2026)

- **Monero Market** (above): the market engine (`xmr20-holder-wasm 0.0.6-market-experimental`, built with the mainnet
  start block 3,796,100) in all three wallets.
- **Chrome extension 0.1.128**: the market's wallet code (market window, background runner that approves sales,
  pending lots announced as "Listing soon"). The live market page connects the website wallet.
- **Website wallet** (xmr20.org): **Connect wallet** on https://xmr20.org/market/ is the site's own wallet; it trades
  from the page.
- **CLI 0.4.0**: the same engine, so balances apply the lot rules.

## What's new (30 October 2026)

- **Chrome extension 0.1.124**: while a Make private / Make open / send is on its way, your balance only drops by the
  amount that is moving (with "arriving" on the other side), instead of hiding the whole coin it came from. When the
  bridge restarts, balances stay on screen with a "Bridge restarting" note and open forms wait for it.
- **Website wallet** (xmr20.org): a **profile page** (portfolio, wallet, activity), the **wXMR bridge** (XMR ⇄ wXMR on
  Solana via wxmr.io), Solana balances read directly from the chain with token prices, XMR **splits and sends in
  Activity** with live confirmations and a link from the start, and one Phantom approval per browser session to sync.

## Ready-made downloads

The [Releases page](https://github.com/xmr20project/xmr20-wallets/releases) has files you can use without building
anything:

- **`XMR20-Wallet-0.1.128.zip`**: the Chrome extension, exactly the build that was tested. Unzip it and load it in
  `chrome://extensions` ([steps](extension/README.md#install-from-a-tester-zip)).
- **`xmr20-cli-0.4.0.zip`**: the terminal wallet with its engine already built. You need Node.js 22, then
  `npm install`, `npm run setup` and `./xmr20` ([steps](cli/README.md#ready-made-download)).
- **`SHA256SUMS.txt`**: each file's fingerprint, so you can check that your download is complete and unchanged.

You only need the next section if you want to build the wallets yourself.

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
  0.1.128 (one known exception: a 2-character esbuild flag in the token worker, explained in `engine/build.mjs`).
- The XMR20 token engine runs in the browser: the extension popup, the xmr20.org page, or the CLI's private headless
  Chromium. Your keys never leave your computer. Scanning, proving and signing happen locally.

## Tests

```bash
npm test
```

This runs the engine tests, the extension's unit tests and the CLI's unit tests. More checks are listed in each
folder's README.

GitHub runs these tests, the CLI's engine test and every build automatically on each pull request and each change to
`main` ([`.github/workflows/tests.yml`](.github/workflows/tests.yml)). It only reads the repository: nothing is
published or deployed.

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
