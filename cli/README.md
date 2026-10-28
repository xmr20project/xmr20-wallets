# XMR20 terminal wallet (CLI) — 0.3.0

A wallet you use by typing commands. It runs the **same engine** as the Chrome extension and xmr20.org
([`../engine`](../engine)), inside a private headless Chromium that has no window, no extensions and no website.

> **Experimental, real funds on mainnet, no independent security review.** Start with small amounts.

## What it can do

- Create a new wallet, or import your 25-word Monero phrase.
- Show your **XMR** balance and every **XMR20** token's **Open** and **Private** balance.
- **Send XMR.**
- **Send XMR20 openly** to a normal Monero address, or **privately** to a private address (`xmr20p1…`).
- **Make private** (Open → Private) and **Make open** (Private → Open).
- **Enable private transfers.** This splits your XMR into 3 coins, which private transfers need. You do it once.
- **Bridge** XMR20 from Solana to Monero, and from Monero back to your Solana address.
- Finish or drop saved operations, and pay a bridge payout fee that is still due.

Every send shows a review: amount, recipient, network fee, and bridge fees if any. **Nothing is sent until you type
`yes`.**

## Ready-made download

If you don't want the whole repository, download **`xmr20-cli-0.3.0.zip`** from the
[Releases page](https://github.com/xmr20project/xmr20-wallets/releases). Its engine files are already built. With Node.js
22.12 or newer installed:

1. Unzip it somewhere you will keep, and open a terminal in the unzipped folder.
2. Install its parts, once: `npm install`
3. Download its browser engine, once: `npm run setup`. On Ubuntu 24.04 or newer, also allow its sandbox once
   ([how](#linux-ubuntu-2404-and-newer)).
4. Make or import a wallet: `./xmr20 create` or `./xmr20 import`. Then `./xmr20 balance`.

Everything below works the same way in that folder. To update, unzip the new version and repeat steps 2 and 3. Your
wallet stays, because it is saved in `~/.xmr20-wallet`, not in the download folder.

Maintainers make this zip with `npm run download:cli` from the repository folder. It is written to `cli/dist/`.

## Set up (once)

From the repository folder, after `npm install` (see the [main README](../README.md)):

```bash
cd cli
npm run setup
```

`setup` downloads Playwright's Chromium, the browser engine the CLI runs in. It also prepares the engine files in
`cli/.engine/`. If you skip it, the engine files are prepared on first use, but the browser download is still needed.

On Mac and Linux you start the CLI with `./xmr20`. On Windows, type `node bin/xmr20.mjs` instead.

### Linux: Ubuntu 24.04 and newer

Ubuntu 24.04 and newer (and 23.10) block the "user namespaces" that the browser engine's security sandbox needs. The CLI
always keeps that sandbox on, so on these systems it stops with "The browser engine could not start its security
sandbox". Allow the sandbox once, only for the browser that `npm run setup` downloaded. Paste this into a terminal as the
user who runs the CLI (not as root). It asks for your password:

```bash
sudo tee /etc/apparmor.d/xmr20-cli-chromium > /dev/null <<EOF
abi <abi/4.0>,
include <tunables/global>

profile xmr20-cli-chromium $HOME/.cache/ms-playwright/chromium*/chrome-linux*/{chrome,headless_shell} flags=(unconfined) {
  userns,
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/xmr20-cli-chromium
```

The rule stays after a restart, and it still applies when `npm run setup` downloads a newer browser. To remove it:

```bash
sudo apparmor_parser -R /etc/apparmor.d/xmr20-cli-chromium
sudo rm /etc/apparmor.d/xmr20-cli-chromium
```

This is the AppArmor rule approach from Chromium's notes on this Ubuntu change
([details](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)).
GitHub's tests run them on Ubuntu 24.04 before the CLI's engine test.

## Make or import a wallet

```bash
./xmr20 create
```

This makes a new Monero wallet (25-word phrase) and a Solana key for the bridge. You choose a password of at least 12
characters, which encrypts the wallet file on your computer. The CLI then offers to show your recovery phrase.
**Write it down.** It is the only way to restore the wallet.

```bash
./xmr20 import
```

This uses a phrase you already have. It asks, in hidden prompts:

- your 25 words
- the restore height (the block your wallet was made at; press Enter to start where XMR20 began, block 3,772,610)
- optionally your Solana secret key (press Enter to make a new one)

It shows the Monero address and asks you to confirm it.

The wallet lives in `~/.xmr20-wallet`. Use `--data-dir /some/other/folder` for a second wallet. Keep the whole folder:
it also holds your saved operations and scan progress.

## Everyday commands

| Command | What it does |
|---|---|
| `./xmr20 balance` | Syncs, then shows XMR and your XMR20 tokens (Open / Private). The first time takes a few minutes. |
| `./xmr20 address` | Your Monero address (XMR and Open XMR20), your private address (`xmr20p1…`, Private XMR20 only) and your Solana address. |
| `./xmr20 send-xmr --to ADDRESS --amount 0.01` | Sends XMR. Use `--max` instead of `--amount` to send everything spendable. |
| `./xmr20 send --token XMR20 --to MONERO_ADDRESS --amount 10` | **Open transfer**: 1 Monero transaction. The amount and both owners are visible on chain. |
| `./xmr20 send --token XMR20 --to xmr20p1... --amount 10 --private` | **Private transfer**: 2 Monero transactions. It spends your Private balance; the amount and recipient stay hidden. |
| `./xmr20 make-private --token XMR20 --amount 10` | Moves Open tokens to Private (1 transaction; this one step shows the amount). |
| `./xmr20 make-open --token XMR20 --amount 10` | Moves Private tokens back to Open (1 transaction per private note). |
| `./xmr20 enable-private --token XMR20` | Splits your XMR into 3 coins so private transfers can pay their 2 fees. Ready in about 20 minutes. |
| `./xmr20 bridge-in --token XMR20 --amount 10` | Solana → Monero. Signed with the wallet's Solana key; needs a little SOL. Arrives as Open in about 20 minutes. |
| `./xmr20 bridge-out --token XMR20 --amount 10` | Monero (Open balance) → your Solana address. |
| `./xmr20 pending` | Operations that have not finished yet. |
| `./xmr20 pending publish ID --token XMR20` | Finishes a saved operation whose transaction needs a new fee. |
| `./xmr20 pending abandon ID --token XMR20` | Drops a saved operation that never reached the chain (this releases its coins). |
| `./xmr20 pay-fee BINDING --token XMR20` | Pays a bridge payout fee that is still due (`balance` shows the command when there is one). |
| `./xmr20 phrase` | Shows your recovery phrase and Solana key. Only do this somewhere private. |
| `./xmr20 doctor` | Checks the wallet folder. `--clear-lock` removes a lock left by a crash. |

`--token` takes the ticker (for example `XMR20`) or the token's mint address.

### Good to know

- **Fees.** Every Monero transaction pays a small network fee (about 0.00004 XMR) from this wallet's XMR. Send the
  wallet a little XMR (about 0.002) first. Bridging also has a bridge fee in SOL and XMR20's 1.5% token fee; the review
  shows them.
- **Private transfers need 2 XMR coins.** If you have fewer, run `enable-private` once.
- **The first private action downloads about 29 MB of proving keys.** They are checked against the manifest shipped in
  the engine, then kept.
- **Lost connection?** Signed transactions are saved in the encrypted journal (`journal/` in the wallet folder). The next
  `balance` asks the Monero node first, and re-sends the same transaction only if the node doesn't know it. It never
  pays twice.
- **One program at a time.** Don't send from the CLI and the extension with the same phrase at the same moment.
- **Ctrl-C** stops cleanly. Scan progress is kept.

## How it works

```
 ./xmr20 (Node.js) ── asks for passwords and approvals, prints results
     │
     ├─ src/engine.mjs: a loopback web server (127.0.0.1, files from .engine/ only) + headless Chromium (Playwright)
     │     └─ browser/host.js: the engine page
     │           ├─ engine/monero   Monero worker: XMR balance, Send XMR, the 3-coin split
     │           └─ engine/headless → engine/token   XMR20 Open/Private, private bridge
     └─ src/network.mjs: the only addresses the page may reach
```

- **The engine is not copied.** `cli/build.mjs` bundles `browser/host.js` with `engine/token`, `engine/monero` and
  `engine/shared`, and copies `engine/dist`. The engine build checks that its files are byte-identical to the installed
  wallet 0.1.118.
- **Headless layer.** The token engine was written for screens. [`engine/headless/token-ops.js`](../engine/headless/token-ops.js)
  lets the CLI use it without one: it fills the same fields and presses the same buttons a person would. It stops at
  every review so the CLI can ask you. No engine logic is repeated.
- **Network.** The page and its workers can reach:
  - the three Monero nodes the Monero worker allows, and only their allowed paths
  - the XMR20 private bridge and its Monero node at `api.xmr20.org`, through the loopback server, without a browser
    Origin header

  Everything else is blocked. The SOL balance shown before a bridge fee is read from `solana-rpc.publicnode.com`.
- **Your keys.** The wallet file (`wallet.json`) is encrypted with your password (scrypt + AES-256-GCM). Its folder is
  readable only by you. Phrases, keys and passwords are never command arguments, environment variables or log lines.

## Tests

```bash
npm test               # unit tests: commands, amounts, the encrypted wallet file, the network allowlist (no network)
npm run test:engine    # starts the private browser offline, makes and restores Monero keys, checks blocking
node test/blocked-sandbox.mjs   # Linux: where Ubuntu blocks the browser's sandbox, the CLI says so and how to allow it
npm run check:readonly -- /path/to/test-account.json   # read-only mainnet sync with a THROWAWAY account
```

`check:readonly` imports a throwaway account into a temporary folder, syncs XMR and XMR20, and prints the balances. It
never approves, signs or sends anything, and never prints keys. Opening the token wallet publishes the account's signed
address-book entry to the bridge, as every wallet does when it opens.

## Changes from 0.2.0

0.2.0 ran the older 0.1.86 native runtime: legacy XN1 tokens, and only the EXTREMIST token. 0.3.0 runs the current
engine: XMR20 Open/Private, the private bridge, XMR sends and the 3-coin split. The 0.2.0 EXTREMIST commands
(`bridge deposit/return`, `status`, `recover`, `wallet backup/restore`) are not carried over. 0.2.0 stays in the main
repository's history.

## Not tested yet

- A real funded send from the CLI: open, private, make private/open, split, bridge in or out. These steps run the same
  engine code the extension and xmr20.org use. Through the CLI they were checked on 28 October 2026 in three ways:
  - on mainnet with a throwaway account that holds no XMR, where the engine stopped with "not enough XMR" before
    anything was built
  - offline, where the real token module stopped at its fee review, Cancel released the coin, and the split was
    relayed only after approval (`engine/tests/headless.test.mjs`)
  - `balance`, `address`, `pending` and `doctor` against mainnet
- Windows, and wallet commands on Linux. The CLI was checked on macOS. On Linux, GitHub's tests run on Ubuntu 24.04:
  they check the blocked-sandbox message, allow the sandbox with the steps above, and start the engine offline.
