# Open questions

Points found while the specification was written from the reference code: places where the code is
looser or stricter than its own comments, where a rule lives in the host program and not in the core,
or where a second implementation needs something pinned down. Each one is to be closed, by a decision
written into the specification or by a change of rules made as [README.md](README.md) says, before
the specification is called version 1.0. Numbers are per part.


## Part A — [01-foundation.md](01-foundation.md)

E-1. Minimum record length. The comment in `transport.rs` says framing admits "any length from 1 to
MAX_RECORD", but `known_magic` requires at least 4 bytes, so the effective minimum is 4 and each
decoder imposes its own larger minimum.

E-2. Free field order. For the eleven ledger magics and XO1 a reader accepts the public key after
the chunks and a payment id between chunks; only MD1 requires the fixed order. A second
implementation that only accepts the writer's layout would disagree on such transactions.

E-3. Non-canonical asset ids panic. `lib.rs: asset_from_bytes` calls the dependency's
`Id::try_from([u8; 32])`, which in `penumbra-sdk-asset` 2.1.1 unwraps the canonical-encoding check
and panics instead of returning an error. Inside `apply_carrier` the panic is caught and the record
is `rejected` with "Malformed record", so the outcome is still a rejection (counter incremented).
In a build where panics abort (for example a wasm engine), or on any path that decodes a record
outside `apply_carrier`, the process would stop instead. The specification above states the
intended outcome (reject).

E-4. Asset derivation loses case. `asset_for_mint` lowercases the mint string before hashing. Mint
identifiers that differ only by letter case (base58 strings are case-sensitive) map to the same
asset id. The Penumbra hashing step (BLAKE2b-512, personalization `Penumbra_AssetID`, reduction
mod q) is taken from the dependency, not from the core; it should be confirmed with a test vector.
`parse_denom` returns nothing for a string matching a registered display denomination; no
`uxmr20private…` string appears to, but this also rests on the dependency.

E-5. Exact acceptance sets of the dependency. Which 32-byte strings decode as a SpendAuth
verification key (for example whether the identity element is accepted), and which 64-byte strings
verify as signatures (canonical scalar, cofactor behaviour), are defined by `decaf377-rdsa` 0.11.0
and `decaf377` 0.10.1, not by the core. A byte-exact second implementation needs these stated or
covered by vectors. Signature bytes are not validated at decode time, only at verification.

E-6. Issuer key is not bound inside the pool. `Pool` stores only the domain. The issuer key used
for XC1 is whatever `Vks.issuer` the caller passes; nothing in `pool.rs` checks it against the
`issuer_vk` that the domain was computed from. The same holds for the two Groth16 verifying keys.
The specification assumes the host passes the manifest's keys.

E-7. `chain` is described only as "Chain genesis" (32 bytes). The core does not say whether this is
the genesis block hash or how the host checks it against the node.

E-8. XC1 has no asset restriction beyond "not an open token", and the two kinds behave identically.
The credit table is keyed by `binding` alone, across assets and kinds. XR1's `binding` is not
checked for uniqueness. XR1 is the only record of this part that requires `txid` to be 32-byte hex;
the "carrier already indexed" check can only fire if a host applies two records under one txid.

E-9. Order within a block and one record per transaction. The core says only "canonical chain
order". The indexer host that drives it iterates a block's non-coinbase transactions in block order
and calls `wire_at` once per transaction; the coinbase transaction is not examined. This should be
stated normatively from the host, since the core does not enforce it. The core also does not
enforce non-decreasing heights.

E-10. `rejected` and `accepted` are part of `summary()`. They depend on activation settings (a
record below its activation height is `ignored`, not `rejected`) and on whether the host presents
pre-activation records at all. A completed private transfer counts once (the completing part); a
stored part counts in neither. A state hash that includes these counters makes readers with
different activation builds, or hosts that filter differently, disagree even when balances agree.

E-11. List hash is defined only in a comment. `checkpoint.rs` documents `height:txid\n` lines but
the core has no code for it. The indexer host formats `height` as a decimal integer and `txid` as
it stores it (lowercase hex), over the transactions whose record it lists, and `records` is the
line count. Whether rejected records' transactions are in the list is decided by the host, not the
core (`pool.rs: open_record` says lists "count what the ledger does not answer `ignored` to").
`Anchor::from_extra` is more lenient than `unframe` (three-byte and non-canonical varints, no
`extra` length limit, no public-key requirement, unchecked skip for tag `0x01`); anchors are not
consensus, but the difference is worth a decision.

E-12. `summary()` as a basis for a state hash. (a) It does not commit to the note set: two states
that differ only in who owns which note (same counts and per-asset totals) have identical
summaries, so an XP1 to a different recipient is invisible. The same is true of the nullifier set
(count only; the tree root does commit to commitments but not to nullifiers), pending parts, lots
and open tokens. (b) Member order inside JSON objects depends on whether the JSON library is built
with insertion-order maps; the lock file of this crate has sorted maps, but another workspace
linking the core could differ. A state hash should define its own canonical serialization and
cover the full state. (c) `outstanding` is computed with an unchecked 128-bit subtraction; it
cannot underflow while the invariant holds.

E-13. `create_outputs` inserts by note id without checking for an existing entry. For the records
of this part an id collision would require a SHA-256 collision or re-applying an accepted record,
which the checks prevent; part C handles the one case (XO1) where identical record bytes could
recur.

E-14. `protocol.records` and `network.startHeight` of the manifest are carried but never read by
the core. The first height a reader scans from is therefore a host matter and should be specified
there.

E-15. Activation values are not in the source. The four mainnet activation heights are injected at
build time; the heights of the live network cannot be read from the core and must be taken from the
build configuration of the deployed readers. `market.rs` also defines magics `XK1` + 0xFE and
`XK2` + 0xFE (offer, withdraw) that are not in `transport.rs: MAGICS` and so are never records.

E-16. `keys.rs: TokenAddress::parse` tests for the lowercase prefix `xmr20t1` before bech32m
decoding, so an all-uppercase unified address is refused even though the bech32m decoder itself
accepts uppercase. Not consensus.

E-17. Section 3.6 (payload) overlaps with part B and is included because `payload.rs` belongs to
the foundation files; one of the two parts should own it.


## Part B — [02-private-and-anchored.md](02-private-and-anchored.md)

1. **Tree capacity.** `ledger.rs: Ledger::commit` only calls `Tree::insert`; no block or epoch is
   ever ended. In `penumbra-sdk-tct` an insertion fails when the current block is full
   (`InsertError::BlockFull`). As written, the pool therefore stops accepting any record that
   adds a commitment (XS1, XU1, XMA/XMB completion) once one tct block is full (believed to be
   4^8 = 65,536 commitments; confirm against the tct crate). A second implementation must
   reproduce this limit to agree; the project should decide whether it is intended.
2. **Sign of the public amount in XS1.** The module comment of `shield.rs` writes the shield
   relation as `cv_out + commit(-amount, 0)`. The code (`conservation_key` with
   `provides = true`) adds the commitment of the *positive* public amount to `out.cv` (an output
   commitment is to the negative note value). Section 2.2 follows the code.
3. **Result label of ignored parts.** A part of an already completed operation, and a
   byte-identical duplicate of a pending part, are "ignored (not stored)" by `pool.rs: part` but
   are reported with result `pending` by `pool.rs: apply_carrier`, not `ignored`. Record lists
   or checkpoints that count results may depend on this.
4. **Parts are stored before any cryptographic check.** Any 932- or 900-byte record that decodes
   is stored under whatever `op` it claims; `op`, signatures and proofs are checked only when a
   pair is tried. Pending parts never expire and their number is unbounded. Proof bytes are not
   even deserialized until a pair is tried.
5. **Only new pairs are tried.** A pair that failed because, for example, its anchor was not yet
   known is not retried when state changes; it completes only if a further (different) part with
   the same `op` arrives. A byte-identical resubmission is ignored as a duplicate. Confirm this
   is intended.
6. **Order of counterpart trials** is the arrival order of pending parts under the `op`. Since
   `op` commits to the anchor, nullifiers and commitments, and the signatures cover the rest
   except `auth` and `binding` themselves, two different valid pairs for one `op` can differ only
   in signature or proof bytes; the first to pass wins and the rest are deleted.
7. **Intermediate root.** The root after the first of the two outputs of a private transfer is
   not accepted as an anchor (one root is recorded per update). The root of the empty tree is
   accepted.
8. **Ciphertext is not validated by the ledger.** An output whose ciphertext the recipient cannot
   decrypt is still a valid commitment. The payload format is the project's own
   (`payload.rs`: "NOT the upstream note ciphertext").
9. **Anchors are not validated.** An anchor is any non-zero 32 bytes: no point check, no check
   against the Monero chain, duplicates allowed. A note anchored to a value that can never be a
   spent key image of a future carrier is unspendable and remains counted in public supply.
10. **XL1 has a redundant check** (4.7 step 12) and checks the asset only after the whole-lot
    check, so a wrong-asset sale of the right quantity fails with the asset error, and of the
    wrong quantity with the whole-lot error.
11. **`offer` and `terms` are opaque to the ledger**, and the ledger verifies no XMR payment for
    XL1. Any payment guarantee comes from how the carrier is constructed, which is outside the
    core crate. `terms_digest` is defined but not enforced.
12. **Doc comment versus code on consuming kinds.** `pool.rs: take_inputs` and `market.rs` list
    XP1, XR1, XS1, XA1, XL1 as the consuming paths; the same function is also called by XW1 and
    the XT1 listing with the carrier's key images. The reference builders for XW1 and XT1 select
    only plain notes, but admission would accept anchored inputs there if the carrier spent the
    anchor.
13. **Mainnet activation height is not in the core source.** It is a build-time variable. A build
    note elsewhere in the repository names 3796100 for `XMR20_MARKET_MAINNET_ACTIVATION`; the
    specification should state the height from an authoritative release record.
14. **Vendored crate.** `Cargo.toml` patches `penumbra-sdk-shielded-pool` to a local vendored
    copy. `penumbra.rs` states the circuits are unchanged; this part did not compare the vendored
    copy with the published 2.1.1 crate. The verifying-key id check (1.2) is what binds a verifier
    to Penumbra's circuits.
15. **Status labels in the source.** `lib.rs` names the protocol
    `XMR20-UNSHIELDED-v0.2-experimental` and calls the code unreviewed research code;
    `market.rs` is headed "EXPERIMENTAL, UNREVIEWED. Real trading is disabled" and
    `MARKET_PROTOCOL` is `XMR20-MARKET-v1-experimental`. These strings are not used in any signed
    message of this part.
16. **Naming.** The private transfer is called "XM4" in comments and in the three labels, while
    the magics are XMA and XMB.
17. **Shielded amounts are 128-bit.** Public amounts are `u64`, but a shielded note amount is a
    Penumbra 128-bit amount and the ledger places no 64-bit bound on notes created by XMB.
18. **Zero change in XS1.** `change.owner` must be a valid key equal to the input owner even when
    `change.amount` is 0 and no change note is created. XU1 always creates a shielded change
    commitment.
19. **Exact field-element conversion of public inputs** (1.1) is delegated to arkworks
    `ToConstraintField` implementations in the Penumbra crates; a second implementation in another
    language needs that conversion spelled out from those crates. The same holds for the balance
    commitment generators, nullifier derivation, `PayloadKey` encryption (cipher and nonce) and
    the decaf377-rdsa signature scheme, which this part references by crate and version only.
20. **Host trust for key images.** The core receives key images as a plain list and cannot check
    they belong to the carrier. The host's extraction of key images from the Monero transaction
    is outside the core crate and should be specified with the host interface.


## Part C — [03-address-moves-trades-open-tokens.md](03-address-moves-trades-open-tokens.md)

Address owners and signatures

1. The address owner hash takes the 64 key bytes only. The address kind and the network
   are not hashed, so the same key pair gives one owner on every network.
2. In `XW1` recipients of kind `0x00`/`0x01` the two keys are not checked in any way
   (any 64 bytes are accepted and hashed). Only the signer's spend key is checked, by
   the signature. The signer's view key is never checked as a curve point; it enters
   the message hash and the address text as bytes.
3. `address.rs: verify_spend_signature` and `trade.rs: usable` decompress the spend key
   with the curve library's decompression and do not compare the re-compressed point
   with the given bytes, unlike `open.rs: usable`, which does. Whether a non-canonical
   encoding of a spend key can pass in `XW1`/`XT1` depends on that library call; a
   second implementation needs this pinned down, since the raw bytes enter the hashes.
4. `r` (and `cs` of a certificate) may be zero; only `c` (`cc`) is required non-zero.
5. The certificate's message uses the address text on the reader's network and
   lowercase hex strings; its scheme label is a literal with no named constant. The
   comment in `address.rs` points to a wallet source file outside the core for the
   signer's side.

XW1

6. `until` is inclusive: the record applies at `height == until`.
7. `FLAG_FEE_IN_XMR` is not verified against any XMR payment; it changes the text and
   forbids a token fee.
8. For an asset that is not an open token the `ticker` field is not compared with
   anything. It is signed as part of the text and the body.
9. The comment on `pool.rs: prepare_address_move` says anchored notes are never moved by
   `XW1`. The admission path (`pool.rs: address_move`) resolves inputs with the
   carrier's key images, so an anchored input is accepted when the carrier spends its
   anchor key image. The same holds for `XT1` list. The helper only avoids selecting
   such notes.
10. Note selection (`prepare_address_move`, the `tradeListPrepare` operation) and the
    JSON helper operations are not ledger rules and are left out of this part.
11. The record id includes `variant`, `c` and `r`, so output note ids depend on the
    signature bytes.

XT1

12. A claim is not bounded by the reservation's `payBy` (`pool.rs: settle`); a test in
    `trade_tests.rs` confirms a claim five blocks after `payBy`. The header comment of
    `trade.rs` does not state this.
13. The payment's height has only an upper bound (the claim's block). A payment made
    before the reservation, or before the listing, satisfies a claim when its amount
    equals `pay`.
14. The header comment of `trade.rs` describes cancel as "while no reservation is
    running (height <= its payBy)"; the code allows a cancel only when
    `height > payBy` of the latest reservation, which is the reading used here.
15. A lot does not expire by itself. After `until` no reservation is accepted, but the
    lot note stays under the lot owner until a cancel or a late claim.
16. Cancel compares the seller as a whole party (kind byte included); reserve compares
    buyer and seller by address owner (kind byte not included).
17. The seller's view key is not checked at listing. When it does not decompress, every
    claim for the lot is rejected and only a cancel moves the lot note.
18. In `paid_to` one invalid transaction key, or one output that belongs to the seller
    with a commitment that does not match, rejects the whole claim rather than being
    skipped.
19. The payment tail uses the modulus 999,999 and a big-endian read of the first four
    code bytes; every other integer in this part is little-endian.
20. Step 1 of a claim answers `pending` and is not counted as accepted; the count
    changes at settlement. The host must call the settlement once for every block that
    has waiting claims; a claim left over from another block is rejected at the next
    settlement (`"Claim from another block"`).
21. An `XT1` whose fifth byte is not 1 to 3 is labelled a claim by the dispatcher and
    then fails decoding, so an unknown operation is `rejected`, not `ignored`.
22. The set of used payments is the token ledger's own; it is not shared with payments
    the XMR721 ledger has seen.
23. The remainder of a list (`inputs − amount`) is converted to 64 bits after the
    inputs are marked spent in the working copy; a failure discards the copy, so the
    order has no visible effect.
24. The reservation text takes the token name from the lot at the time the reservation
    is applied (`pool.rs: terms`), not from the list record's own text.

Open tokens

25. The creator's share note id is `note_id(token id, 0)`; every other record uses the
    SHA-256 of its bytes as the record id. The token id excludes `variant`, `c`, `r`, so
    the same body signed again (another nonce or ending) has the same token id and is
    rejected as deployed already.
26. An `MD1` record that is not an open deploy is `ignored`; an open deploy that fails
    the ledger checks of section 4.5 is `rejected`. Record lists and checkpoints that
    count non-ignored records depend on this split (`pool.rs: open_record`).
27. The "asset in use" check reads the minted totals map by key. A deploy with no `pre`
    still creates the key with 0.
28. `lim` in units is 0 when the text has no `lim`; such a token has `left == 0` from
    the start, so check 6 of section 4.6 refuses every mint before check 7 is reached.
29. The mainnet heights of all three rule sets are compile-time environment values and
    appear nowhere in the core's source. OPEN.md gives 3,812,510 for open tokens. The
    heights for `XW1` and `XT1` must be taken from the build configuration of the
    deployed readers.
30. The asset id derivation is delegated to the Penumbra asset registry
    (`parse_denom(...).id()`); its exact hash belongs in part A next to the derivation
    for bridged tokens.
31. The JSON escaping of `tick` and `name` is whatever the JSON library writes. Given
    the refused code points, only `"` and `\` can need escaping, which is what section
    4.2 states; this was inferred from the refused list, not from a test of every code
    point in this part.
32. `transport.rs: wire_at` gives an ordinary record precedence: a `tx_extra` that
    unframes as an ordinary record is never read as an open record.
33. A `tick` that is literally `TOKEN` and a `tick` that does not fit the field both
    give the ticker field `TOKEN`; the 16 hex characters of the id tell them apart.
34. `address.rs: TESTNET` is defined but no network kind selects it.
