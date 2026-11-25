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
| [`read-mainnet.mjs`](read-mainnet.mjs) | One command that runs the reader on mainnet and prints its checkpoints |
| [`spec/`](spec) | The specification, draft 1: the same rules as text, for a second implementation, with what each key can and cannot do and the open questions |

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
{"height":3813840,"blockHash":"d927883e…","records":42,"listHash":"d9f47472…","stateHash":"…"}
```

`listHash` is the SHA-256 over one line `<height>:<txid>\n` for every transaction that carries
a record of the ledger, in chain order. The same values, signed by the issuer and written into
the Monero chain once a day, are collected in the `xmr20-checkpoints` repository. A reader
that prints another hash for the same block is not reading the same ledger: the difference is
then public and can be traced to one transaction.

`stateHash` is one hash over the whole ledger state at the end of that block: every note and
its owner, every lot, every open token, the shielded pool. Two readers that print the same
`stateHash` for a block agree on who owns what there, not only on which transactions they
read. [State hash](#state-hash) describes it byte by byte.

The last line is the state hash and the ledger summary at the newest block: how many notes and
how much of each token exists, in the open and in the shielded pool.

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

## State hash

The state hash is a SHA-256 over the ledger state, written out in a fixed byte layout. It is
made of 21 sections. Each section has a hash of its own, so two readers whose state hashes
differ can compare section by section and see where (the reader's `stateSections` request
lists them for its newest block).

```
section tag  = the 21 ASCII characters XMR20-STATE-SECTION-1 and one zero byte
state tag    = the 13 ASCII characters XMR20-STATE-1 and one zero byte
section hash = SHA-256( section tag || text(name) || u64(number of items) || the items in order )
state hash   = SHA-256( state tag || the 21 section hashes in the order of the table below )
```

Values are written like this:

| Value | Bytes |
| --- | --- |
| `u8`, `bool` | one byte; a bool is 0 or 1 |
| `u64` | 8 bytes, little-endian. Every count and every length is a `u64` |
| `u128` | 16 bytes, little-endian |
| `bytes32` | the 32 bytes as they are |
| `text`, `bytes` | the length in bytes as a `u64`, then the bytes. Text is UTF-8 |
| `hex` | 32 bytes written as `text` of 64 lowercase hexadecimal characters (so 8 length bytes and 64 characters) |
| `txid` | the hash of the Monero transaction that carried the record, as `hex`. A reader that keeps transaction ids in capital letters writes them in lowercase here |
| `option(x)` | one byte 0 when absent; one byte 1 and then `x` when present |
| `address` | a Monero address: `u8` (1 for a subaddress, 0 for a standard address), spend key `bytes32`, view key `bytes32` |

Maps and sets are written by ascending key, compared byte by byte (a `hex` key by its
characters, which is the same order as its bytes). Lists are written in the order the ledger
keeps them, which is the order the records arrived in. `asset` is an asset id, `height` the
block of the transaction that carried the record. `note id`, `record id` and `operation id`
are the ids the [specification](spec/README.md) defines for a note, a record and a two-part
private transfer.

| # | Section | Items, in order | One item |
| --- | --- | --- | --- |
| 1 | `domain` | one | ledger domain `bytes32` |
| 2 | `shielded-root` | one | root of the commitment tree of the shielded pool `bytes32` (defined below the table) |
| 3 | `nullifiers` | set | nullifier `bytes32` |
| 4 | `roots` | set | every root the commitment tree has had, the empty tree's included: `bytes32` |
| 5 | `history` | list | a shielded payload as it stands in its record, 176 bytes without a length: commitment 32, ephemeral key 32, ciphertext 112 |
| 6 | `notes` | map by note id | note id `bytes32`, asset `hex`, amount `u64`, owner key `hex`, height `u64`, txid `txid`, anchor key image `option(hex)` |
| 7 | `spent-notes` | set | note id `bytes32` |
| 8 | `minted` | map by asset | asset `hex`, total `u128` |
| 9 | `burned` | map by asset | asset `hex`, total `u128` |
| 10 | `shielded-in` | map by asset | asset `hex`, total `u128` |
| 11 | `shielded-out` | map by asset | asset `hex`, total `u128` |
| 12 | `credits` | map by binding | binding `bytes32`, kind `u8`, asset `hex`, amount `u64`, owner key `hex`, txid `txid`, height `u64` |
| 13 | `redemptions` | map by carrier | carrier transaction id `bytes32`, asset `hex`, amount `u64`, binding `hex`, owner key `hex`, txid `txid`, height `u64` |
| 14 | `pending-a` | map by operation id | operation id `bytes32`, number of waiting first parts `u64`, then each part in the order it arrived: its record `bytes` (932 bytes), the SHA-256 of the record `bytes32`, txid `txid`, height `u64` |
| 15 | `pending-b` | map by operation id | the same for second parts (records of 900 bytes) |
| 16 | `completed` | map by operation id | operation id `bytes32`, SHA-256 of the first part's record `hex`, of the second part's record `hex`, txid of the first part `txid`, of the second `txid`, height `u64` |
| 17 | `lots` | map by lot id | lot id (the record id of the listing) `bytes32`, asset `hex`, ticker `text`, amount `u64`, price `u64`, seller `address`, last block of the listing `u64`, height `u64`, txid `txid`, note id of the lot's note `bytes32`, status `u8` (0 open, 1 sold, 2 cancelled), number of reservations `u64`, each reservation in order (buyer `address`, height `u64`, pay-by block `u64`, exact payment in piconero `u64`, record id `bytes32`), claim `option`(buyer `address`, payment transaction id `bytes32`, height of the payment `u64`, height `u64`, txid `txid`) |
| 18 | `used-payments` | set | id of a payment transaction that bought a lot `bytes32` |
| 19 | `pending-claims` | list | a claim waiting for the end of its block: record `bytes`, txid `txid`, height `u64`. Empty at the end of every block |
| 20 | `open-tokens` | map by asset | asset `hex`, token id `bytes32`, number in order of deployment `u64`, from the deploy text: tick `text`, name `option(text)`, max `u64`, col `option(text)`, lim `option(u64)`, pre `option(u64)` (whole tokens, as written in the text; an absent field is absent); creator `address`, units left to mint `u64`, number of mints `u64`, height `u64`, txid `txid` |
| 21 | `open-ids` | map by token id | token id `bytes32`, asset `hex` |

The number of items of a map is its number of keys; a section with no items is the hash of
the section tag, the name and a zero count.

`shielded-root` is the root of Penumbra's tiered commitment tree (`penumbra-sdk-tct` 2.1.1)
that holds the commitment of every payload of `history`, inserted in that order. The ledger
never closes a block or an epoch of that tree, so all commitments are in its first block. The
root is one field element, written as its 32 canonical little-endian bytes. The root of the
empty tree is 32 zero bytes.

`pending-a` and `pending-b` hold the parts of two-part private transfers that are waiting for
their other part. A part is kept when its bytes are a canonical record of its kind, its
operation is not complete, the same bytes are not waiting already, and it did not complete an
operation when it arrived. A part that looks right and can never complete therefore stays,
until the operation of its id completes; then every waiting part of that operation is removed.

What the state hash does not cover:

- the reader's settings: the blocks from which rules apply, the address network of signed
  texts, and the id of the XMR721 ledger whose deploy records are read. On mainnet they are
  constants (the table above and the specification's list of mainnet values), and no record
  changes them. Two readers with different settings can print the same state hash for a block
  and judge a later record differently, so compare the settings as well as the hash;
- the reader's counts of accepted and refused records (no rule reads them);
- the inside of the commitment tree beyond its root and the payloads that were put into it.

The reader takes the state hash at the end of a block: after every record of the block is
applied and every claim of the block is settled. It keeps the hash of every 720th block. The
hashes are worked out again from the record log on every start and after a chain
reorganisation, so a restarted reader prints the same values as one that read straight
through, and a block that left the chain takes its hash with it.

Test vectors are in
[`core/src/state_hash_fixture.json`](core/src/state_hash_fixture.json): for the empty ledger of
the domain of 32 bytes `0x11` and for a fixed state with something in every section, each
section's name, item count, the bytes its hash is taken over and its hash, and the state hash.
The states are built in the tests of
[`core/src/pool/state_hash.rs`](core/src/pool/state_hash.rs), which check the file against the
code. The state hash of that empty ledger is
`00de0453c27a256d74af79e3f59c83b14d9f5d36b540e1dde24f14815dbcffb9`; of the fixed state,
`460239e41a75e1d776f43ad2b593c5c09e21cc04e35bf9f278099d40d5c61b71`.

## Tests

```
cargo test --release --manifest-path core/Cargo.toml
cargo test --release --manifest-path indexer/Cargo.toml
```

The core's tests make real proofs and need Penumbra's two proving keys (29 MB), which are
not kept here: [`params/README.md`](params/README.md) says where they come from and how they
are checked. Five tests compare the core with the XMR721 rule library on generated cases
(`review-parity/gen.mjs`).
