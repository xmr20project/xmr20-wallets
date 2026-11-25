# XMR20 token ledger — specification, draft 1

Status: draft. This describes the rules the mainnet token ledger runs today, written from the
reference core ([`../core`](../core)) so that a second, independent implementation can be built from the text. It is
not version 1.0 yet: the points in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) and the list under
"Before version 1.0" below are still open, and nobody outside the project has reviewed it.

The token ledger is the set of balances of XMR20 tokens on Monero: the tokens bridged from
Solana, the tokens launched on Monero, and open tokens anyone deploys and mints. It is worked
out from records in Monero transactions, in chain order. This document says exactly how.

| Part | What it specifies |
| --- | --- |
| [01-foundation.md](01-foundation.md) | How records travel in `tx_extra`; the ledger domain and its parameters; notes, keys and signatures; public transfer (`XP1`), credit (`XC1`) and burn (`XR1`); the order of application; checkpoint anchors |
| [02-private-and-anchored.md](02-private-and-anchored.md) | The shielded pool; shield (`XS1`) and unshield (`XU1`); the two-part private transfer (`XMA`, `XMB`); anchored notes and lots (`XA1`, `XL1`) |
| [03-address-moves-trades-open-tokens.md](03-address-moves-trades-open-tokens.md) | Balances held by plain Monero addresses and moved by a wallet's message signature (`XW1`); trades paid in XMR (`XT1`); open tokens: the deploy and the mint (`XO1`) |
| [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) | Where the code and its comments differ, where a rule lives outside the core, and what a second implementation still needs pinned down |

## 1. The mainnet ledger

Every value that makes a reader a reader of the mainnet ledger and of no other.

| Value | Mainnet |
| --- | --- |
| Network | Monero mainnet; genesis `418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3` |
| Parameters manifest | format `XMR20-PARAMS-2`, SHA-256 `1b1a27dcb1c4b3d93e4b38963c0b32595e44362a86296aa9445f468a51f1841b` |
| Ledger domain | `e7aaca529eabea9bd58845591a570ae4cccb4bc0b2259d9b3ae3b5f89f00c6af` |
| Issuer key | `e222e5e6896280cabefc461c749835a8f40adfdb622f9bff359f34c64758b901` |
| Spend and output proofs | Penumbra's circuits and keys, unchanged: verifying key ids `groth16vk1zu2ks8er6fcj65y7w735wqzj9nx4fd5rsf2483lqyn0jqtlts2hssw2nfh` (spend) and `groth16vk1lnuw3xdngtwsq42wa5g4ceq3c3zyn6j2c0e57xzde43lznzuvf2sxmsdcc` (output) |
| First block read | 3,792,000 |
| Anchored notes and lots (`XA1`, `XL1`) from block | 3,796,100 |
| Moves by Monero address (`XW1`) from block | 3,797,288 |
| Trades paid in XMR (`XT1`) from block | 3,797,400 |
| Open tokens (open deploy, `XO1`) from block | 3,812,510 |
| XMR721 ledger whose deploy records are read | domain `ec7f7d26dba6725124df69417d43335c52e34557fc61c1d8d6b4736370e6ba1d` |

A record of a kind whose first block has not come is passed over as if it were not there.

## 2. What each key can and cannot do

This section is the trust statement of the ledger. It says what is enforced by the rules and
what rests on someone's conduct.

**Holders.** A note is spent only by a record signed with its owner's key: the holder's token
key, or, for a balance at a plain Monero address, a message signature of that address's spend
key. No record type moves, freezes or takes back a note without that signature. This holds for
every token on the ledger.

**The issuer key** signs credit records (`XC1`). A credit creates new units of a bridged or
launched token, and the ledger checks only the signature and that the credit's binding was not
used before. The ledger does not look at Solana. So:

- the holder of the issuer key can create units of any bridged or launched token without a
  matching deposit. The rules do not prevent it; they make it visible, because every credit is
  a public record with a binding that either matches a custody deposit on Solana or does not;
- the issuer key cannot create units of an open token (a credit for one is refused), cannot
  spend or freeze anyone's notes, and cannot undo a record;
- the issuer key is part of the ledger domain. It cannot be replaced without starting a new
  ledger.

**Custody on Solana.** Tokens bridged to Monero are held by a custody program on Solana and
released when a holder burns on Monero. The operator of the bridge signs those releases. The
operator therefore controls the backing of bridged tokens, not the notes on Monero. This is a
trust in the bridge that open tokens do not have: an open token exists only on Monero, with a
supply fixed by its deploy record.

**Open tokens.** Nobody has a key over an open token. Its name, supply, amount per mint and the
creator's share are fixed by the deploy record; anyone mints until the supply is reached.

**Checkpoint anchors** are signed with the issuer key and state the list of records up to a
block. They let a wallet start quickly. They are a statement by the issuer, not an independent
check; a wallet that reads the chain itself needs none.

**Relays and services** carry records into Monero transactions for wallets that cannot build
them. They can decline or delay a record and cannot change one. A trading service that holds
balances for its users is a custodian of those balances, outside these rules.

**The project** has no key that changes a balance. What it has is the reference code: a new
rule reaches the ledger only as section 4 says.

## 3. What a verifier needs

A reader rebuilds the whole public state from:

1. a Monero node (a restricted public node is enough), read from block 3,792,000;
2. the values of section 1;
3. for a claim of a trade, the payment transactions it names, as the node returns them.

No view key, no server and no snapshot is needed. Private balances are hidden by design: a
verifier checks every proof and the total supply of each token, and does not learn who holds a
shielded note or how much is in it. To check that bridged supply is backed, a verifier compares
the credit and burn records with the custody program's deposits and releases on Solana.

## 4. Changing the rules

The same policy as XMR721 (RULES.md section 14 of that repository):

1. A change is a new numbered version of this specification and of the reference core, with
   the block from which it applies.
2. It is published in the public repository at least 5,040 blocks (about seven days) before
   that block.
3. No version changes how a block before its first block is judged.
4. No version adds a way to move, burn or freeze a holder's notes without the holder's
   signature, and none gives any key a say over tokens it does not hold.
5. A fault that lets someone take or create tokens against these rules, or that makes readers
   disagree, may be closed with less notice; the version then says so and names the fault.

## Before version 1.0

- A build of the reader and of the wallet engines that anyone can repeat to the same binary.
  The source is in this folder; the block heights of section 1 are constants in it.
- The wallets are built on this core. The wallet engine in `engine/` of this repository is
  still built from an earlier copy.
- A state hash is defined over the full public state (every note with its owner, lots,
  pending parts, open tokens, the nullifier set) with its own canonical byte form, and
  published at fixed blocks. The summary the core has today counts notes and totals only.
- Rules that live in the host program are moved into this text as rules: the order of
  transactions within a block, that the mining reward transaction is not read, how key images
  and payment facts are taken from the node, how the record list of an anchor is built.
- Every point of OPEN-QUESTIONS.md is closed, each by a sentence in this specification or by
  a change made as section 4 says.
- Test vectors for every record type, accepted and refused, that a second implementation can
  replay; and a replay of the whole mainnet chain to the published state hashes.
- A review by someone outside the project.
