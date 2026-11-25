# Part B — Private balances and anchored lots

This part specifies the shielded pool and the records that touch it (XS1, XU1, XMA, XMB), and the
anchored public notes used as market lots (XA1, XL1). Record framing in `tx_extra`, the ledger
domain, the record id, the public note id, the owner key and the records XP1, XC1, XR1 are defined
in Part A. XW1, XT1 and XO1 are defined in Part C. They are referred to here by name only.

Conventions used in this part:

- All multi-byte integers are little-endian. `u64` is 8 bytes, `u8` is 1 byte.
- `H(x)` is SHA-256 of `x` (`lib.rs: hash`).
- `M(label, body)` is `H(label || domain || body)`, where `domain` is the 32-byte ledger domain
  (`lib.rs: message`). Every label below is given as an ASCII string followed by one zero byte,
  written `\0`.
- "record id" is `H(record bytes)` (`public.rs: record_id`). "note id" of output `i` of a record is
  `H("XMR20-PUBLIC-NOTE-v1\0" || record id || u16 i)` (`public.rs: note_id`).
- "asset id" is the 32-byte encoding of a Penumbra `asset::Id` (`lib.rs: asset_from_bytes`).
- "carrier" is the Monero transaction whose `tx_extra` holds the record. One carrier holds at most
  one record (`transport.rs: unframe_of`).
- Error texts in quotation marks are the texts of the reference implementation. They are
  informative; the failure conditions are normative.

A record that fails any check changes no ledger state (`pool.rs: apply_carrier` applies each record
to a copy of the state and keeps the copy only on success). A panic while a record is processed is
treated as a failed check with the text "Malformed record" (`pool.rs: apply_carrier`).

---

## 1. The shielded pool

### 1.1 Reused cryptography

The shielded pool uses the Penumbra shielded-pool construction through these crates, at these exact
versions (`Cargo.toml` of the core crate):

| Crate | Version | Use |
|---|---|---|
| `penumbra-sdk-shielded-pool` | 2.1.1 | `Note`, `SpendCircuit`, `OutputCircuit`, spend and output plans |
| `penumbra-sdk-tct` | 2.1.1 | tiered commitment tree, `Root`, `StateCommitment` |
| `penumbra-sdk-sct` | 2.1.1 | `Nullifier` and its derivation |
| `penumbra-sdk-asset` | 2.1.1 | `asset::Id`, `Value`, `Balance`, balance `Commitment` |
| `penumbra-sdk-keys` | 2.1.1 | spend key, full viewing key, address, payload key |
| `penumbra-sdk-proof-params` | 2.1.1 | key ids (`debug_id`) of proving and verifying keys |
| `decaf377` | 0.10.1 | group and fields (`Fq`, `Fr`), BLS12-377 pairing types |
| `decaf377-rdsa` | 0.11.0 | `SpendAuth` and `Binding` signatures |
| `decaf377-ka` | 2.1.1 | key agreement for the note payload |
| `ark-groth16` | 0.4.0 | Groth16 verification over BLS12-377 |

Two zero-knowledge statements are used, both Groth16 over BLS12-377, both unchanged Penumbra
circuits (`penumbra.rs`, module comment):

- **Spend proof** (`SpendCircuit`). Public inputs, in this order: anchor (tree root, one `Fq`),
  balance commitment `cv`, nullifier `nf`, randomized verification key `rk`
  (`penumbra.rs: ShieldedInput::verify`).
- **Output proof** (`OutputCircuit`). Public inputs, in this order: note commitment, balance
  commitment `cv` (`penumbra.rs: ShieldedOutput::verify`).

Each public input is converted to field elements with the arkworks `ToConstraintField<Fq>`
conversion of its type and the results are concatenated in the order given
(`penumbra.rs: push`). `rk` is first decompressed from its 32-byte decaf377 encoding; a failure to
decompress fails the check with "Invalid randomized key".

A proof is 192 bytes: the arkworks compressed serialization of a `Proof<Bls12_377>`
(`penumbra.rs: PROOF_BYTES`, `compress`, `verify_proof`). Proof bytes are deserialized, with
validation, only when the proof is verified, not when the record is decoded.

The ledger runs no setup of its own. The security of the proofs rests on Penumbra's published
parameters (`penumbra.rs`, module comment).

### 1.2 Parameters and how they are pinned

Verifying keys:

| Circuit | Penumbra key id (`VerifyingKeyExt::debug_id`) |
|---|---|
| Spend | `groth16vk1zu2ks8er6fcj65y7w735wqzj9nx4fd5rsf2483lqyn0jqtlts2hssw2nfh` |
| Output | `groth16vk1lnuw3xdngtwsq42wa5g4ceq3c3zyn6j2c0e57xzde43lznzuvf2sxmsdcc` |

A verifier obtains each verifying key as the hex text of its arkworks compressed serialization
(the `spend_vk` and `output_vk` fields of the ledger configuration, `lib.rs: Config`). It
deserializes the key, requires its key id to equal the id in the table, and prepares it for
verification (`penumbra.rs: read_vk`). The same two hex texts are inputs of the ledger domain
(`lib.rs: Config::computed_domain`, Part A), so every signature in this part is bound to the exact
verifying keys.

Proving keys (needed only to create records):

| Circuit | File length (bytes) | SHA-256 of the file | Penumbra key id (`ProvingKeyExt::debug_id`) |
|---|---|---|---|
| Spend | 21,673,392 | `87eca85bef562803fb9684c56c0a6db84aa6d0791b1c00b909e6f2a5c2cff452` | `groth16pk1ke43yax8cg78h69y0pn6kvjcktdakwq9m4c58nyam8hffweramfqxr94fh` |
| Output | 7,257,360 | `c9e97866edd6c815a7bcb2f3b5493713794369692bb96e5a2e682613c330e4a8` | `groth16pk1rkpwdlcaw56gvyqpt0lm7lvj8q9mx93gqpz85dl9l3u677k75reqcnuq7d` |

(`penumbra.rs: SPEND_PK_BYTES`, `SPEND_PK_SHA256`, `SPEND_PK_ID`, `OUTPUT_PK_BYTES`,
`OUTPUT_PK_SHA256`, `OUTPUT_PK_ID`.) A proving-key file is the arkworks uncompressed serialization
of a `ProvingKey<Bls12_377>`. It is authenticated by length and SHA-256 before it is parsed
(`manifest.rs: authenticate_file`) and its key id is checked after parsing
(`penumbra.rs: load_pk`). The parameter manifest (format string `XMR20-PARAMS-2`) is rejected
unless it carries exactly these lengths, hashes and ids and its verifying keys equal those of the
configuration (`manifest.rs: Manifest::validate`).

### 1.3 Wire pieces shared by the records

**Shielded input** — 256 bytes (`penumbra.rs: ShieldedInput`):

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 32 | `cv` | balance commitment, decaf377 element encoding |
| 32 | 32 | `nf` | nullifier, canonical `Fq` encoding |
| 64 | 192 | `proof` | spend proof (1.1) |

**Shielded output** — 400 bytes (`penumbra.rs: ShieldedOutput`, `payload.rs: Payload`):

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 32 | `cv` | balance commitment, decaf377 element encoding |
| 32 | 32 | `cm` | note commitment (`StateCommitment`), canonical `Fq` encoding |
| 64 | 32 | `epk` | ephemeral public key (`decaf377-ka` public key) |
| 96 | 112 | `ciphertext` | encrypted note, 96 bytes of plaintext plus a 16-byte tag |
| 208 | 192 | `proof` | output proof (1.1) |

Bytes 32..208 of a shielded output are its **payload** (176 bytes).

Decoding rules:

- `cv` must decode as a Penumbra balance `Commitment` (`penumbra.rs: ShieldedInput::decode`,
  `ShieldedOutput::decode`).
- `nf` must decode as a Penumbra `Nullifier`.
- `cm` must decode as a `StateCommitment` (`payload.rs: Payload::decode`).
- `epk` must decompress as a decaf377 element and must not be the identity element; otherwise the
  payload is rejected with "Invalid encryption point" or "Identity encryption point"
  (`payload.rs: nonidentity`).
- `ciphertext` and `proof` are opaque at decode time.

Every record decoder in this part re-encodes the decoded record and requires the result to equal
the received bytes ("Canonical record"). A non-canonical encoding of any field therefore rejects
the record.

**Anchor (tree root) on the wire** — 32 bytes, the canonical `Fq` encoding of the root
(`penumbra.rs: root_bytes`). It is decoded by prefixing the two bytes `0x0A 0x20` and decoding the
result as Penumbra's protobuf `MerkleRoot` (`penumbra.rs: root_from_bytes`).

**Note payload encryption** (`payload.rs`). This is not Penumbra's note ciphertext format.

- Plaintext, 96 bytes: diversifier (16) `||` amount (16, little-endian `u128`) `||` asset id (32)
  `||` rseed (32). These are bytes 0..16 and 80..160 of Penumbra's 160-byte `Note::to_bytes`
  (`payload.rs: Payload::encrypt`).
- Shared secret: decaf377 key agreement between the note's ephemeral secret key and the
  recipient's transmission key.
- Key: BLAKE2b with 32-byte output and personalization `XMR20_M3_Cipher`, over
  `"compact-note-v1\0" || shared secret (32) || epk (32) || cm (32)` (`payload.rs: key`).
- Cipher: Penumbra `PayloadKey::encrypt` with `PayloadKind::Note`.
- A recipient accepts a decrypted note only if the note rebuilt from the plaintext and one of its
  own addresses (the address for the diversifier's index, or, when the diversifier is 16 zero
  bytes, also its transparent address) has commitment `cm`, ephemeral public key `epk`, and is
  controlled by its full viewing key (`payload.rs: Payload::decrypt`).

The ledger does not check the ciphertext. Only `cm` and `epk` take part in admission (1.3 decoding
rules; `cm` is a public input of the output proof).

### 1.4 State

The shielded-pool state is (`ledger.rs: Ledger`):

| Item | Content |
|---|---|
| `tree` | a Penumbra tiered commitment tree (`penumbra_sdk_tct::Tree`) |
| `nullifiers` | the set of 32-byte nullifiers already spent |
| `roots` | the set of 32-byte roots accepted as anchors |
| `history` | the list of every payload inserted, in insertion order |
| `domain` | the ledger domain |

Rules:

1. Initial state: an empty tree, an empty nullifier set, an empty history, and `roots` containing
   the root of the empty tree (`ledger.rs: Ledger::new`).
2. A state update is one call that adds a set of nullifiers and appends a list of note commitments
   (`ledger.rs: Ledger::commit`). Each commitment is inserted at the next free position of the
   tree, with `Witness::Keep`, in the order given, and its payload is appended to `history`. After
   all commitments of the call are inserted, the new tree root is added to `roots`.
3. No block or epoch boundary is ever inserted into the tree. All commitments go into the first
   block of the first epoch (the reference implementation never calls the tree's block or epoch
   functions).
4. If a tree insertion fails, the record that caused it is rejected ("Commitment tree insert")
   and changes nothing.
5. **Anchors.** A record's anchor is accepted if and only if it is a member of `roots`
   (`ledger.rs: Ledger::known_root`). Roots are never removed. Every root the pool has had after a
   completed update, and the root of the empty tree, stays valid as an anchor without limit of
   time or height. A root that exists only between two insertions of one update (the state after
   the first of the two outputs of a private transfer) is not in `roots`.
6. **Nullifiers.** A nullifier is added when the record that reveals it is applied and is never
   removed. A record that reveals a nullifier already in the set is rejected.
7. **Commitments.** A record whose output commitment already has a position in the tree is
   rejected (`ledger.rs: Ledger::commitment_exists`).

The pool also keeps, per asset, two public tallies (`pool.rs: Pool`): `shielded_in`, the sum of
XS1 `amount` fields applied, and `shielded_out`, the sum of XU1 public output amounts applied,
both as unsigned 128-bit integers. The shielded supply of an asset is `shielded_in - shielded_out`
(`pool.rs: shielded_supply`). The reference implementation reports the ledger as consistent for an
asset when public supply + shielded supply = minted - burned and the shielded supply is not
negative (`pool.rs: invariant`). This is a reported property, not an admission check.

The state is a pure function of the ordered list of (record bytes, carrier transaction id, block
height, carrier key images) on the canonical chain. A reader rebuilds it from that list after a
reorganisation (`pool.rs`, module comment).

### 1.5 Value and asset encoding

- A shielded note holds a Penumbra `Value`: an asset id and a 128-bit amount. The asset id of a
  shielded note is the same 32 bytes as the public asset id of the token: there is one asset-id
  space for public notes and shielded notes. The mapping from a token to its asset id is defined
  in Part A (`lib.rs: asset_for_mint`) and, for open tokens, Part C.
- A public amount is a `u64`. When a public amount crosses the boundary it is turned into the
  Penumbra value `(asset id, amount)` with the amount widened to 128 bits (`lib.rs: value`).
- A balance commitment is Penumbra's: `Balance::commit(blinding)`. A spend's balance is the
  positive value of its note; an output's balance is the negative value of its note
  (`shield.rs: conservation_key`, comment).
- The public amount of an XS1 or XU1 enters value conservation as a balance commitment with
  blinding factor zero (2.3, 2.6). Because the commitment generator depends on the asset id, this
  also binds the shielded side of the record to the record's public `asset` field.
- Nullifiers are Penumbra's: derived from the nullifier key, the note's tree position and the
  note commitment (`ledger.rs: Ledger::owned`).

### 1.6 Keys (context)

A holder's shielded spend key is derived from the account root by the key schedule `XMR20-TKD1`
(`keys.rs: derive_token_spend_key`): BLAKE2b, 32-byte output, keyed with the 32-byte root,
personalization `XMR20-TKD1`, over `"xmr20/private-token/spend-key" || u32 account`. The result is
the bytes of a Penumbra `SpendKey`. The shielded address is the payment address of index 0 of its
full viewing key (`keys.rs: shielded_address`). The owner key of public notes is a separate key
(Part A). Key derivation is not an admission rule: the ledger accepts any valid keys.

---

## 2. XS1 shield and XU1 unshield

Each is one record in one carrier. XS1 moves a public amount into one new shielded note. XU1
spends one shielded note, creates one public note and one shielded change note.

### 2.1 XS1 layout

Magic: `58 53 31 FE` (`"XS1"` then `0xFE`) (`shield.rs: MAGIC_SHIELD`).
`n` is the input count, 1 to 4. Size: `613 + 32·n` bytes (645, 677, 709 or 741).

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 4 | magic | `58 53 31 FE` |
| 4 | 32 | `asset` | asset id |
| 36 | 1 | `nIn` | `u8`, 1..=4 |
| 37 | 32·n | `inputs` | `n` public note ids |
| 37+32n | 32 | `change.owner` | owner key (decaf377-rdsa `SpendAuth` verification key) |
| 69+32n | 8 | `change.amount` | `u64` |
| 77+32n | 8 | `amount` | `u64`, the amount shielded |
| 85+32n | 400 | `out` | shielded output (1.3) |
| 485+32n | 64 | `ownerSig` | decaf377-rdsa `SpendAuth` signature |
| 549+32n | 64 | `conservation` | decaf377-rdsa `Binding` signature |

Signed message, for both signatures: `M("XMR20-UNSHIELDED-SHIELD-v1\0", bytes 0 .. 485+32n)`
(`shield.rs: SHIELD_LABEL`, `Shield::body`, `Shield::message`).

### 2.2 XS1 checks, in order

Decoding (`shield.rs: Shield::decode`):

1. The record has at least 4 bytes and starts with the magic ("XS1 magic").
2. `asset` decodes as an asset id ("Asset id encoding").
3. `nIn` is in 1..=4 ("Input count").
4. Every later field is present ("Truncated record"); `out` decodes by the rules of 1.3.
5. No byte follows `conservation` ("Trailing bytes").
6. The re-encoded record equals the received bytes ("Canonical record").
7. `amount` > 0 ("Positive shielded amount required").
8. No note id appears twice in `inputs` ("Duplicate input").
9. `change.owner` decodes as a `SpendAuth` verification key ("Invalid change owner key"). This
   holds also when `change.amount` is 0.

Admission (`pool.rs: shield`, `pool.rs: take_inputs`):

10. For each input, in record order:
    a. the note id is an unspent public note ("Public input already spent" if it was spent,
       otherwise "Unknown public input");
    b. the note's asset equals `asset` ("Input asset differs from the record asset");
    c. if the note is anchored (4.3), the carrier's key images contain its anchor ("Anchored
       input: the carrier does not spend its anchor key image");
    d. the note's owner equals the owner of the previous inputs ("Inputs belong to different
       owners");
    e. the running 128-bit total does not overflow.
11. Total of the inputs = `amount + change.amount`, computed in 128 bits ("Shield does not
    conserve value").
12. `change.owner` equals the owner key of the inputs ("Shield change must return to the owner").
13. `out.cm` has no position in the tree ("Output commitment already exists").
14. `ownerSig` verifies under the owner key of the inputs over the signed message ("Owner
    signature rejected") (`shield.rs: Shield::verify_crypto`).
15. `conservation` verifies as a `Binding` signature over the same message under the key whose
    32-byte encoding is the encoding of `out.cv + C`, where `C` is the balance commitment of the
    positive value `(asset, amount)` with blinding 0. If those bytes are not a valid `Binding`
    verification key the check fails ("Conservation key"); if the signature fails, "Shield
    conservation rejected" (`shield.rs: conservation_key` with `provides = true`).
16. `out.proof` verifies as an output proof with public inputs (`out.cm`, `out.cv`) ("Output
    proof rejected").

### 2.3 XS1 effect

(`pool.rs: shield`)

1. Every input note is removed from the unspent public notes and its id is added to the spent
   set.
2. If `change.amount` > 0, a plain public note is created with id `note_id(record id, 0)`, the
   record's asset, owner `change.owner`, amount `change.amount`, the carrier's height and
   transaction id. If `change.amount` = 0 no note is created (`pool.rs: create_outputs`).
3. `out` is committed to the shielded pool: its commitment is inserted in the tree, its payload
   appended to the history, and the new root added to `roots`. No nullifier is added.
4. `shielded_in[asset]` increases by `amount`.

The amount shielded is public because `amount` is in the record. The recipient of the shielded
note is not public.

### 2.4 XU1 layout

Magic: `58 55 31 FE` (`"XU1"` then `0xFE`) (`shield.rs: MAGIC_UNSHIELD`).
Size: exactly 924 bytes (`shield.rs: UNSHIELD_BYTES`).

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 4 | magic | `58 55 31 FE` |
| 4 | 32 | `asset` | asset id |
| 36 | 32 | `anchor` | tree root (1.3) |
| 68 | 256 | `in` | shielded input (1.3): `cv` at 68, `nf` at 100, `proof` at 132 |
| 324 | 32 | `rk` | randomized `SpendAuth` verification key |
| 356 | 64 | `auth` | `SpendAuth` signature by `rk` |
| 420 | 32 | `out.owner` | owner key of the new public note |
| 452 | 8 | `out.amount` | `u64`, the amount unshielded |
| 460 | 400 | `change` | shielded output (1.3): `cv` at 460, payload at 492, `proof` at 668 |
| 860 | 64 | `conservation` | `Binding` signature |

Signed message, for both signatures:
`M("XMR20-UNSHIELDED-UNSHIELD-v1\0", bytes 0..356 || bytes 420..860)`, that is, every byte of the
record except the two signatures (`shield.rs: UNSHIELD_LABEL`, `Unshield::message`).

An XU1 spends exactly one shielded note. It always carries one shielded change output, also when
the change value is zero.

### 2.5 XU1 checks, in order

Decoding (`shield.rs: Unshield::decode`):

1. The record is exactly 924 bytes and starts with the magic ("XU1 size/magic").
2. `asset` decodes as an asset id.
3. `anchor` decodes as a root ("Anchor: …").
4. `in` decodes by the rules of 1.3.
5. `rk` decodes as a `SpendAuth` verification key.
6. `change` decodes by the rules of 1.3.
7. The re-encoded record equals the received bytes ("Canonical record").
8. `out.amount` > 0 ("Positive public amount required").
9. `out.owner` decodes as a `SpendAuth` verification key ("Invalid output owner key").

Admission (`pool.rs: unshield`):

10. `anchor` is a member of `roots` ("Unknown anchor").
11. `in.nf` is not in the nullifier set ("Spent token input").
12. `change.cm` has no position in the tree ("Change commitment already exists").
13. `auth` verifies under `rk` over the signed message ("Spend authorization rejected")
    (`shield.rs: Unshield::verify_crypto`).
14. `conservation` verifies as a `Binding` signature over the same message under the key whose
    encoding is the encoding of `in.cv + change.cv + C`, where `C` is the balance commitment of
    the negative value `-(asset, out.amount)` with blinding 0 ("Conservation key" / "Unshield
    conservation rejected") (`shield.rs: conservation_key` with `provides = false`).
15. `in.proof` verifies as a spend proof with public inputs (`anchor`, `in.cv`, `in.nf`, `rk`)
    ("Spend proof rejected").
16. `change.proof` verifies as an output proof with public inputs (`change.cm`, `change.cv`)
    ("Output proof rejected").

The carrier's key images are not used by XU1.

### 2.6 XU1 effect

(`pool.rs: unshield`)

1. `in.nf` is added to the nullifier set; `change` is committed to the pool (commitment inserted,
   payload appended, new root added to `roots`).
2. A plain public note is created with id `note_id(record id, 0)`, the record's asset, owner
   `out.owner`, amount `out.amount`, the carrier's height and transaction id.
3. `shielded_out[asset]` increases by `out.amount`.

---

## 3. XMA / XMB two-part private transfer

A private transfer spends three shielded notes and creates two. It does not fit one carrier, so
it is split in two records, each in its own carrier (`private2.rs`, module comment):

- **Part A (XMA)** carries the anchor, the three spends and the spend authorization.
- **Part B (XMB)** carries the two outputs and the value-conservation signature.

The module and its labels call the operation "XM4".

### 3.1 XMA layout

Magic: `58 4D 41 FE` (`"XMA"` then `0xFE`) (`private2.rs: MAGIC_A`). Size: exactly 932 bytes
(`private2.rs: A_BYTES`).

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 4 | magic | `58 4D 41 FE` |
| 4 | 32 | `op` | operation id (3.3) |
| 36 | 32 | `anchor` | tree root (1.3) |
| 68 | 256 | `inputs[0]` | shielded input (1.3) |
| 324 | 256 | `inputs[1]` | shielded input |
| 580 | 256 | `inputs[2]` | shielded input |
| 836 | 32 | `rk` | randomized `SpendAuth` verification key, shared by the three spends |
| 868 | 64 | `auth` | `SpendAuth` signature by `rk` |

`bodyA` is bytes 0..868. `auth` signs `M("XMR20-XM4-A-v1\0", bodyA)`
(`private2.rs: A_LABEL`, `PartA::message`).

### 3.2 XMB layout

Magic: `58 4D 42 FE` (`"XMB"` then `0xFE`) (`private2.rs: MAGIC_B`). Size: exactly 900 bytes
(`private2.rs: B_BYTES`).

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 4 | magic | `58 4D 42 FE` |
| 4 | 32 | `op` | operation id (3.3) |
| 36 | 400 | `outputs[0]` | shielded output (1.3): `cv` at 36, `cm` at 68 |
| 436 | 400 | `outputs[1]` | shielded output: `cv` at 436, `cm` at 468 |
| 836 | 64 | `binding` | `Binding` signature |

`bodyB` is bytes 0..836. `binding` signs `M("XMR20-XM4-B-v1\0", bodyA || bodyB)`, where `bodyA`
is that of the part A it is paired with (`private2.rs: B_LABEL`, `Operation::message_b`).

### 3.3 How the two parts are linked

The operation id is (`private2.rs: op_id`, `OP_LABEL`):

```
op = H( "XMR20-XM4-OP-v1\0" || domain || anchor (32)
        || nf of inputs[0] || nf of inputs[1] || nf of inputs[2]
        || cm of outputs[0] || cm of outputs[1] )
```

Both parts carry `op`. A pair is one operation only if `op` of part A and `op` of part B both
equal the value computed from the anchor and nullifiers of that part A and the commitments of that
part B. In addition, `binding` signs both bodies, so part B is bound to every byte of part A
except `auth`; and `auth` signs `bodyA`, which contains `op`, so part A is bound to the two output
commitments.

### 3.4 Decoding checks

Part A (`private2.rs: PartA::decode`):

1. Exactly 932 bytes, starting with the magic ("XMA size/magic").
2. `anchor` decodes as a root; each input decodes by 1.3; `rk` decodes as a `SpendAuth`
   verification key.
3. The re-encoded record equals the received bytes ("Canonical record").
4. The three nullifiers are pairwise different ("Duplicate input nullifier").

Part B (`private2.rs: PartB::decode`):

1. Exactly 900 bytes, starting with the magic ("XMB size/magic").
2. Each output decodes by 1.3.
3. The re-encoded record equals the received bytes ("Canonical record").
4. The two note commitments differ ("Duplicate outputs").

A part that fails decoding is rejected. `op` is not checked at decode time.

### 3.5 Ordering and timing rules

(`pool.rs: part`)

Parts are processed in canonical chain order like every record. The pool keeps two pending stores,
one for parts A and one for parts B, each mapping an `op` value to the list of pending parts that
carry it, in arrival order; and a map of completed operations by `op`. On arrival of a part that
decodes:

1. If `op` is a completed operation, the part is ignored: not stored, no state change.
2. Otherwise, if a pending part of the same kind under the same `op` has the same SHA-256 of its
   full record bytes, the part is ignored: not stored, no state change.
3. Otherwise the pool takes the pending parts of the other kind stored under the same `op`, in
   arrival order, and for each runs the full pair check (3.6) of the new part with that
   counterpart against the current state. The first counterpart that passes completes the
   operation (3.7) and processing of the part ends.
4. If no counterpart passes, or there is none, the new part is appended to its pending list.

Consequences:

- The parts may arrive in either order, in the same block or any number of blocks apart. There is
  no height rule and pending parts never expire.
- Only pairs that include the newly arrived part are tried. A pending pair is not retried when
  unrelated state changes.
- All checks of 3.6 are made against the state at the moment the later part of the pair is
  processed. The anchor of part A only has to be in `roots` at that moment.
- A pending part reserves nothing: it does not mark its nullifiers or commitments. Any other
  record may use them first, in which case the pair fails when tried.
- Several different parts can be pending under one `op` value (for instance parts that copy the
  `op` of another operation but do not belong to it). They do not prevent the genuine pair from
  completing.
- The number of pending parts is not bounded by the ledger rules.

The reference implementation reports a stored or ignored part with the result `pending`, and the
part that completes an operation with the result `accepted` (`pool.rs: apply_carrier`). A part
with result `pending` does not count as accepted or rejected.

### 3.6 Pair checks, in order

(`pool.rs: try_complete`, `private2.rs: Operation::verify_crypto`)

1. `anchor` of part A is a member of `roots` ("Unknown anchor").
2. None of the three nullifiers of part A is in the nullifier set ("Spent token input").
3. Neither output commitment of part B has a position in the tree ("Output commitment already
   exists").
4. `op` of part A and `op` of part B both equal the operation id computed as in 3.3 ("Parts do
   not belong to one operation").
5. `auth` verifies under `rk` over `M("XMR20-XM4-A-v1\0", bodyA)` ("Spend authorization
   rejected").
6. `binding` verifies as a `Binding` signature over `M("XMR20-XM4-B-v1\0", bodyA || bodyB)`
   under the key whose encoding is the encoding of
   `inputs[0].cv + inputs[1].cv + inputs[2].cv + outputs[0].cv + outputs[1].cv` ("Conservation
   rejected"; the pair also fails if those bytes are not a valid `Binding` verification key).
7. Each of the three spend proofs verifies with public inputs (`anchor`, that input's `cv`, that
   input's `nf`, `rk`) ("Spend proof rejected").
8. Each of the two output proofs verifies with public inputs (that output's `cm`, that output's
   `cv`) ("Output proof rejected").

No public amount and no asset id appear in the pair. Value conservation per asset follows from
check 6: the sum of the five balance commitments must be a commitment to zero value.

### 3.7 Effect of a completed operation

(`pool.rs: try_complete`, `pool.rs: finish`)

1. The three nullifiers of part A are added to the nullifier set.
2. `outputs[0]` then `outputs[1]` are inserted in the tree in that order, their payloads appended
   to the history in that order, and the root after both insertions is added to `roots`.
3. Every pending part A and part B stored under this `op` is removed, including parts that did
   not take part in the completion.
4. `op` is recorded as completed, with the SHA-256 of each part's record bytes, each carrier's
   transaction id, and the height of the part that arrived later.

No public note is created or spent and no per-asset tally changes.

A spend of a zero-value note is permitted by the spend circuit without a tree membership proof;
the reference builder pads a transfer to three inputs with such notes
(`private2.rs: build`, `penumbra.rs: spend_witness`). Their nullifiers are added to the nullifier
set like any other.

### 3.8 If only one part appears

A lone part A or part B has no effect on balances, nullifiers, the tree or `roots`. It stays
pending without limit of time. The notes it refers to remain spendable by any other record. If the
missing part appears later, the pair is checked against the state at that time and completes only
if every check of 3.6 passes then.

---

## 4. XA1 / XL1 anchored lots

### 4.1 Anchored notes

A public note has an optional **anchor**: 32 bytes interpreted as a Monero key image
(`pool.rs: PublicNote`). A note without an anchor is a **plain** note. A note with an anchor is an
**anchored** note. In the records of this section an anchor field of 32 zero bytes means "no
anchor" (`market.rs: NO_ANCHOR`).

**Anchor key image rule.** A record that takes an anchored note as an input is accepted only if
the set of key images of the inputs of that record's own carrier contains the note's anchor
(`pool.rs: take_inputs`). The comparison is byte equality of 32-byte values. The rule is applied
in the single input-resolution function used by every record kind that consumes public notes: XP1,
XR1, XS1, XA1, XL1, XW1 and the listing operation of XT1.

**What is read from the carrier.** Only the key images of the carrier transaction's inputs: one
32-byte key image per input. Their order is not significant. No ring member, output key, amount or
other field of the carrier is read for this rule.

**How the host supplies it.** The ledger core does not parse Monero transactions. The host passes
each record together with the carrier's transaction id, the block height, and the list of the
carrier's input key images (`pool.rs: apply_carrier`, parameter `native`, documented as "the
carrier's input key images, in transaction order"). A host that passes no key images
(`pool.rs: apply`, which passes an empty list) can never consume an anchored note; every such
record is rejected.

The ledger does not check that an anchor is a valid key image, that it is unspent on the Monero
chain, or that it is unique. Two notes may name the same anchor (`market.rs: Anchored::check`,
comment). The ledger has no depth or finality rule for the creation of an anchored note
(`market.rs`, module comment).

### 4.2 Activation height gate

XA1 and XL1 apply from a block height `market_from` held by the reader (`pool.rs: Pool`,
`market_from`). If `market_from` is unset, or the carrier's height is below it, an XA1 or XL1
record is **ignored**: the result is the same as for a record with an unknown magic, no state
changes and no counter changes (`pool.rs: apply_carrier`). The comparison is
`height >= market_from`.

The value by network kind (`market.rs: activation`):

| Network kind | `market_from` |
|---|---|
| `offline-fakechain` | 0 |
| `stagenet` | 0 |
| `mainnet` | the value of the build-time variable `XMR20_MARKET_MAINNET_ACTIVATION` (a decimal block height of 1 to 12 digits), or unset if the variable is absent |
| any other | unset |

XS1, XU1, XMA and XMB have no activation gate.

The gate applies only to the two record kinds. The anchor key image rule of 4.1 is applied by
every consuming record at every height; below the gate no anchored note can exist, because only
XA1 and XL1 create them.

### 4.3 XA1 layout — anchored transfer

Magic: `58 41 31 FE` (`"XA1"` then `0xFE`) (`market.rs: MAGIC_ANCHORED`).
`n` is the input count and `m` the output count, each 1 to 4.
Size: `102 + 32·n + 72·m` bytes (206 to 518) (`market.rs: Anchored::wire_len`).

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 4 | magic | `58 41 31 FE` |
| 4 | 32 | `asset` | asset id |
| 36 | 1 | `nIn` | `u8`, 1..=4 |
| 37 | 1 | `nOut` | `u8`, 1..=4 |
| 38 | 32·n | `inputs` | `n` public note ids |
| 38+32n | 72·m | `outputs` | `m` anchored outputs |
| 38+32n+72m | 64 | `sig` | `SpendAuth` signature by the owner of the inputs |

Anchored output — 72 bytes (`market.rs: AnchoredOutput`):

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 32 | `owner` | owner key |
| 32 | 8 | `amount` | `u64` |
| 40 | 32 | `anchor` | key image, or 32 zero bytes for a plain output |

`sig` signs `M("XMR20-MARKET-ANCHOR-AUTH-v1\0", bytes 0 .. 38+32n+72m)`
(`market.rs: ANCHOR_LABEL`, `Anchored::message`).

### 4.4 XA1 checks, in order

Gate: 4.2. Then decoding (`market.rs: Anchored::decode`, `Anchored::check`):

1. At least 4 bytes, starting with the magic ("XA1 magic").
2. `asset` decodes as an asset id.
3. `nIn` and `nOut` are each in 1..=4 ("Input/output count").
4. All fields are present ("Truncated record") and no byte follows `sig` ("Trailing bytes").
5. The re-encoded record equals the received bytes ("Canonical record").
6. No note id appears twice in `inputs` ("Duplicate input").
7. For each output in order: `amount` > 0 ("Zero-value output"), then `owner` decodes as a
   `SpendAuth` verification key ("Invalid owner key").

Admission (`pool.rs: anchored`, `pool.rs: take_inputs`):

8. For each input, in record order: checks 10a to 10e of 2.2 (unspent and known; same asset;
   anchor key image rule if the input is anchored; same owner; no overflow).
9. Total of the inputs = total of the output amounts, in 128 bits ("Anchored transfer does not
   conserve value").
10. `sig` verifies under the owner key of the inputs over the signed message ("Owner signature
    rejected").

### 4.5 XA1 effect

(`pool.rs: anchored`, `pool.rs: create_anchored`)

1. Every input note is spent.
2. For each output `i` (0-based, record order) a public note is created with id
   `note_id(record id, i)`, the record's asset, the output's owner and amount, the carrier's
   height and transaction id, and anchor = the output's `anchor` field, or no anchor if that field
   is 32 zero bytes.

XA1 is the only record that turns a plain note into an anchored note at the holder's choice. It
can also move, split and merge anchored notes and turn an anchored note back into a plain one, in
each case only in a carrier that spends the anchors of the anchored inputs.

### 4.6 XL1 layout — whole-lot sale

Magic: `58 4C 31 FE` (`"XL1"` then `0xFE`) (`market.rs: MAGIC_SALE`). Size: exactly 268 bytes
(`market.rs: Sale::BYTES`).

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 4 | magic | `58 4C 31 FE` |
| 4 | 32 | `asset` | asset id |
| 36 | 32 | `lot` | note id of the anchored note sold |
| 68 | 8 | `quantity` | `u64` |
| 76 | 32 | `buyer` | owner key of the buyer |
| 108 | 32 | `buyerAnchor` | key image, or 32 zero bytes for a plain note |
| 140 | 32 | `offer` | 32-byte digest, not zero |
| 172 | 32 | `terms` | 32-byte digest, not zero |
| 204 | 64 | `sig` | `SpendAuth` signature by the owner of the lot (the seller) |

`sig` signs `M("XMR20-MARKET-SALE-AUTH-v1\0", bytes 0..204)`
(`market.rs: SALE_LABEL`, `Sale::message`).

### 4.7 XL1 checks, in order

Gate: 4.2. Then decoding (`market.rs: Sale::decode`, `Sale::check`):

1. Exactly 268 bytes, starting with the magic ("XL1 size/magic").
2. `asset` decodes as an asset id.
3. The re-encoded record equals the received bytes ("Canonical record").
4. `quantity` > 0 ("Positive lot quantity required").
5. `offer` is not 32 zero bytes and `terms` is not 32 zero bytes ("Offer and terms digests
   required").
6. `buyer` decodes as a `SpendAuth` verification key ("Invalid owner key").

Admission (`pool.rs: sale`):

7. `lot` is an unspent public note ("Lot already spent" if it was spent, otherwise "Unknown
   lot").
8. The lot note is anchored ("Lot is not an anchored note").
9. The lot note's amount equals `quantity` ("Whole lot only: quantity differs from the lot
   note").
10. The lot note's asset equals `asset` ("Input asset differs from the record asset").
11. The carrier's key images contain the lot note's anchor ("Anchored input: the carrier does not
    spend its anchor key image").
12. The lot note's amount equals `quantity` again, as a conservation check ("Sale does not
    conserve value"); this cannot fail after check 9.
13. The lot note's owner key differs from `buyer` ("Buyer must differ from the seller").
14. `sig` verifies under the lot note's owner key over the signed message ("Seller signature
    rejected").

### 4.8 XL1 effect

(`pool.rs: sale`)

1. The lot note is spent.
2. One public note is created with id `note_id(record id, 0)`, the record's asset, owner `buyer`,
   amount `quantity`, the carrier's height and transaction id, and anchor = `buyerAnchor`, or no
   anchor if `buyerAnchor` is 32 zero bytes.

The ledger does not interpret `offer` or `terms` beyond requiring them to be non-zero, and it does
not check any Monero payment for an XL1. A function that computes a terms digest exists
(`market.rs: terms_digest`, label `"XMR20-MARKET-TERMS-v1\0"`), with input
`offer (32) || lot (32) || quantity u64 || price u64 || u8 length of payout || payout bytes ||
buyer (32) || buyerAnchor (32) || fee u64 || sellerAnchor (32)` under `M`; admission does not call
it.

### 4.9 Lot lifecycle

For XA1 and XL1 a lot is not a separate ledger object: it is an anchored public note. Its states
are those of a public note.

| Step | Record | Condition on the carrier | Result |
|---|---|---|---|
| Creation | XA1 with an output whose `anchor` is not zero | spends the anchors of any anchored inputs | an anchored note (the lot); other outputs may be plain change |
| Sale | XL1 naming the lot | spends the lot's anchor | lot spent; buyer receives a note of the whole quantity, anchored or plain |
| Release / cancel | any record that consumes public notes (XA1 with plain outputs, XP1, XR1, XS1, XW1, XT1 listing) | spends the lot's anchor | lot spent; outputs as that record defines |
| Re-anchoring | XA1 with anchored inputs and anchored outputs | spends the anchors of the inputs | new anchored notes |

Rules that follow from 4.1 to 4.8:

- A lot is sold only whole. There is no partial fill.
- A lot has no expiry in the ledger. It stays an unspent anchored note until a record consumes it.
- Because a Monero key image can be spent at most once on a chain, at most one carrier on a chain
  can satisfy the anchor rule for a given anchor.
- The carrier of the consuming record is identified only by its key images. Any record that passes
  its own checks and rides in a carrier spending the anchor consumes the note; the owner's
  signature on the record is still required.
- If the key image named as an anchor is spent by a transaction that carries no accepted record
  consuming the note, no later carrier can spend that key image, and the note can no longer be
  consumed.

The off-chain offer and withdrawal messages (`market.rs: Offer`, `Withdraw`; magics `58 4B 31 FE`
and `58 4B 32 FE`) are not ledger records, never appear on chain, and are not part of admission.
Their expiry (at most seven days, `market.rs: MAX_OFFER_SECONDS`) is an order-book rule, not a
ledger rule.

The lot objects with the states open, sold and cancelled in `pool.rs` (`Lot`, `LotStatus`) belong
to XT1 (Part C), not to XA1/XL1.

---

## 5. What an outside verifier needs, and what stays hidden

### 5.1 Inputs beyond the record bytes

To reproduce the ledger state of this part a verifier needs, for every carrier on the canonical
chain in chain order (order of blocks, then order of transactions in the block):

| Input | Used by | Purpose |
|---|---|---|
| Record bytes (unframed from `tx_extra`, Part A) | all | everything in sections 2 to 4 |
| Block height of the carrier | XA1, XL1 | activation gate (4.2); also stored on every created public note and on completed private transfers |
| Transaction id of the carrier | all that create notes | stored on created notes and completed operations; not an admission input in this part |
| Key images of the carrier's inputs | XS1, XA1, XL1 (and XP1, XR1, XW1, XT1 listing) | anchor key image rule (4.1) |
| Ledger domain | all | every signed message and the operation id |
| Spend and output verifying keys | XS1, XU1, XMA/XMB | proof verification (1.2) |
| `market_from` for the network | XA1, XL1 | activation gate |

A verifier also needs the complete prior state: unspent and spent public notes with their anchors,
the commitment tree, the nullifier set, the set of roots, the pending parts and the completed
operations. Because anchors are accepted from any earlier root and parts stay pending without
limit, none of this state can be discarded.

The ledger assumes the host supplies only carriers that Monero consensus has accepted
(`pool.rs: apply`, comment). In particular the ledger does not itself verify that a key image
supplied by the host belongs to the carrier.

### 5.2 Public and hidden data

| Record | Public | Hidden |
|---|---|---|
| XS1 | asset; input note ids and so their owner and amounts; amount shielded; change owner and amount; the new note commitment and ephemeral key | recipient of the shielded note |
| XU1 | asset; amount unshielded; owner of the new public note; nullifier of the spent note; anchor used; change commitment | which note was spent; its amount; the change amount; the spender |
| XMA + XMB | anchor used; three nullifiers; two note commitments and ephemeral keys; that the two carriers form one operation (same `op`) | asset; all amounts; sender; recipients; which notes were spent; which inputs are zero-value padding |
| XA1 | asset; input note ids; every output's owner, amount and anchor key image | — |
| XL1 | asset; lot note id; quantity; seller (owner of the lot); buyer; buyer anchor; `offer` and `terms` digests | the content behind the `offer` and `terms` digests |

Per asset, the totals `shielded_in`, `shielded_out` and their difference are public. Shielded
amounts are hidden only inside that total.

An anchored note publishes a Monero key image before it is spent. When a carrier later spends
that key image, the record it carries links the key image to the note
(`market.rs`, module comment, "DISCLOSURE").

---
