# XMR20 token ledger: the rules as code, and a reader anyone can run

The XMR20 token ledger is worked out from records in Monero transactions. This folder holds
the code that does it, so that anyone can read the chain themselves and compare the result
with anyone else's, the project's included.

| Folder | What it is |
| --- | --- |
| [`core/`](core) | The rules: every record type, its checks and its effect. The wallets and the reader are built on this one crate. The specification is written from it |
| [`indexer/`](indexer) | The reader: follows a Monero node, applies the records with the core, keeps a log, recovers from restarts and chain reorganisations |
| [`lab/`](lab) | What the reader shares with the other programs: reading the parameters manifest, talking to a Monero node |
| [`params/mainnet-v1/`](params/mainnet-v1) | The parameters of the mainnet ledger: its domain, the issuer's public key, Penumbra's verifying keys |
| [`vendor/`](vendor) | Two published crates with small changes, listed in [`vendor/README.md`](vendor/README.md) |
| [`spec/`](spec) | The specification, draft 1: the same rules as text, for a second implementation, with what each key can and cannot do and the open questions |
| [`read-mainnet.mjs`](read-mainnet.mjs) | One command that runs the reader on mainnet and prints its checkpoints |

Status: this is the code the mainnet ledger runs, published for checking. It has not been
reviewed by anyone outside the project.

## Read the mainnet ledger yourself

Rust (stable), Node.js 22 or newer, and a synchronized Monero node. A restricted public node
works; your own node removes the need to trust one.

```
cargo build --release --manifest-path indexer/Cargo.toml
node read-mainnet.mjs --node http://127.0.0.1:18081 --state ./xmr20-state --once
```

It reads every block from 3,792,000 and prints one line for every 720th block:

```
{"height":3813840,"blockHash":"d927883e…","records":42,"listHash":"d9f47472…"}
```

`listHash` is the SHA-256 over one line `<height>:<txid>\n` for every transaction that carries
a record of the ledger, in chain order. The same values, signed by the issuer and written into
the Monero chain once a day, are collected in the `xmr20-checkpoints` repository. A reader
that prints another hash for the same block is not reading the same ledger: the difference is
then public and can be traced to one transaction.

The last line is the ledger summary at the newest block: how many notes and how much of each
token exists, in the open and in the shielded pool.

## What makes it the mainnet ledger

Nothing is read from a server, and nothing is given to the build from outside:

- `params/mainnet-v1/manifest.json`, pinned in `read-mainnet.mjs` by its SHA-256
  (`1b1a27dc…f1841b`): network, genesis, first block, ledger domain, issuer key, verifying keys;
- four constants in `core/src/`: the blocks from which later rules apply on mainnet.

| Rule | From block | Constant |
| --- | --- | --- |
| Anchored notes and lots (`XA1`, `XL1`) | 3,796,100 | `market::MAINNET_ACTIVATION` |
| Moves by Monero address (`XW1`) | 3,797,288 | `address::MAINNET_ACTIVATION` |
| Trades paid in XMR (`XT1`) | 3,797,400 | `trade::MAINNET_ACTIVATION` |
| Open tokens (open deploy, `XO1`) | 3,812,510 | `open::MAINNET_ACTIVATION` |

A record of a kind whose block has not come is passed over as if it were not there, so a
reader built from this source judges every earlier block as the readers before it did.

## Tests

```
cargo test --release --manifest-path core/Cargo.toml
cargo test --release --manifest-path indexer/Cargo.toml
```

The core's tests make real proofs and need Penumbra's two proving keys (29 MB), which are
not kept here: [`params/README.md`](params/README.md) says where they come from and how they
are checked. Five tests compare the core with the XMR721 rule library on generated cases
(`review-parity/gen.mjs`).
