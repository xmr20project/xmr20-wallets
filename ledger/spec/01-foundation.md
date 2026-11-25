# XMR20 token ledger specification — Part A: foundation

This part specifies how records are carried in Monero transactions, the ledger domain and its
parameters, public notes and keys, the three basic public records (XP1, XC1, XR1), the order of
application, checkpoint anchors and the state summary.

Conventions used in this part:

- "MUST" statements describe what the reference core does; a second implementation has to behave
  identically to agree on state.
- `H(x)` is SHA-256 of the byte string `x`, 32 bytes (`lib.rs: hash`).
- `LE16`, `LE32`, `LE64` are unsigned little-endian integers of 2, 4 and 8 bytes. Every multi-byte
  integer in every record of this part is little-endian. No big-endian integer occurs.
- `a || b` is byte concatenation. Quoted strings are ASCII; `\0` is one zero byte.
- "hex" is lowercase hexadecimal without prefix.
- Each rule cites its source as `file.rs: function_name`.

Record types specified elsewhere (XS1, XU1, XMA, XMB, XA1, XL1 in part B; XW1, XT1, XO1 and the MD1
open deploy in part C) are mentioned here only where framing or dispatch requires it.

---

## 1. Carrying records in Monero transactions

### 1.1 Overview

A record is a byte string of 4 to 1,011 bytes that starts with a 4-byte magic. It is carried in the
`extra` field of the prefix of an ordinary Monero transaction, split into chunks, each chunk inside
one "extra nonce" field. A transaction carries at most one record: all chunks found in one `extra`
are concatenated into a single byte string (`transport.rs: unframe_of`).

Constants (`transport.rs`):

| Name | Value | Meaning |
|---|---|---|
| `EXTRA_LIMIT` | 1060 | Maximum length in bytes of the whole `extra` field |
| `CHUNK` | 254 | Maximum record bytes per chunk |
| `MAX_RECORD` | 1011 | Maximum record length in bytes |

### 1.2 Record magics

A record of the ledger starts with one of these eleven magics (`transport.rs: MAGICS`,
`transport.rs: known_magic`). A byte string shorter than 4 bytes has no known magic.

| Magic (ASCII) | Hex | Record | Specified in |
|---|---|---|---|
| `XP1` + 0xFE | `58 50 31 FE` | public transfer | this part |
| `XC1` + 0xFE | `58 43 31 FE` | public credit | this part |
| `XR1` + 0xFE | `58 52 31 FE` | public burn | this part |
| `XS1` + 0xFE | `58 53 31 FE` | shield | part B |
| `XU1` + 0xFE | `58 55 31 FE` | unshield | part B |
| `XMA` + 0xFE | `58 4D 41 FE` | private transfer, part A | part B |
| `XMB` + 0xFE | `58 4D 42 FE` | private transfer, part B | part B |
| `XA1` + 0xFE | `58 41 31 FE` | anchored transfer | part B |
| `XL1` + 0xFE | `58 4C 31 FE` | lot sale | part B |
| `XW1` + 0xFE | `58 57 31 FE` | address move | part C |
| `XT1` + 0xFE | `58 54 31 FE` | trade | part C |

Two further magics belong to open tokens and are deliberately not in the list above
(`transport.rs: open_magic`):

| Magic (ASCII) | Hex | Record |
|---|---|---|
| `XO1` + 0xFE | `58 4F 31 FE` | open mint |
| `MD1` + 0xFE | `4D 44 31 FE` | inscription of the XMR721 ledger (only an open deploy is a record here) |

### 1.3 Grammar of `extra`

```
extra      = *field                      ; total length <= 1060 bytes
field      = pubkey-field / nonce-field
pubkey-field = %x01 32OCTET              ; transaction public key
nonce-field  = %x02 length data          ; 1 <= len(data) <= 255
length     = %x01-7F                     ; value 1..127, one byte
           / %x80-FF %x01                ; value 128..255, two bytes
data       = chunk / payment-id
chunk      = %x7F *254OCTET              ; marker 0x7F, then 0..254 record bytes
payment-id = %x01 8OCTET                 ; encrypted payment id, exactly 9 bytes
```

Parsing rules, applied in this order while scanning `extra` from offset 0
(`transport.rs: unframe_of`):

1. If `extra` is longer than 1,060 bytes, parsing fails.
2. Read one tag byte.
3. Tag `0x01`: this is the transaction public key. It MUST be the first and only field with this
   tag (a second one fails immediately), and 32 bytes MUST remain. The 32 bytes are skipped; they
   are not validated as a curve point.
4. Tag `0x02`: read the length as a base-128 varint, least significant group first, of at most two
   bytes. A byte below 0x80 ends the varint. A second byte equal to 0x00 fails ("noncanonical nonce
   length"). A third byte is never read: a second byte of 0x80 or more fails. Running out of input
   while reading the length fails. The decoded length MUST satisfy `1 <= length <= 255` and
   `length` bytes MUST remain. (With these rules the two-byte form can only encode 128 to 255, and
   its second byte is always 0x01.)
   - If the first data byte is `0x7F`, the remaining `length - 1` bytes are appended to the chunk
     list as one chunk (possibly empty).
   - Otherwise the field is a payment id. It MUST be the only payment id in `extra`, its first
     byte MUST be `0x01` and its length MUST be exactly 9. An unencrypted payment id (first byte
     `0x00`) therefore fails.
5. Any other tag (including padding `0x00`, merge-mining `0x03`, additional public keys `0x04`)
   fails.
6. After the last field: exactly one public-key field MUST have been seen, otherwise parsing fails.
7. If the chunk list is empty, the result is "no record".
8. `b` = concatenation of all chunks in order of appearance.
9. (Open variant only, see 1.6.)
10. `b` MUST be 1 to 1,011 bytes long and MUST start with a known magic (`transport.rs: parts_of`);
    otherwise parsing fails.
11. Canonical chunking: the chunk list MUST equal `b` split into consecutive pieces of 254 bytes,
    the last piece holding the remaining 1 to 254 bytes. Any other split (a short chunk that is not
    the last, an empty chunk, a trailing empty chunk) fails.
12. The result is the record `b`.

Fields may appear in any order for the eleven magics of 1.2: the public key may follow the chunks,
and the payment id may sit between chunks. Chunks are always concatenated in order of appearance.

### 1.4 When a transaction carries no record

For the ledger, "parsing fails" and "no record" mean the same thing: the transaction carries no
record and has no effect on state. `unframe` reports failure as an error and an absent record as
`None`; callers treat both alike (`transport.rs: wire_at` uses `.ok().flatten()`). A transaction
carries no record when any of the following holds:

- `extra` is longer than 1,060 bytes;
- `extra` contains any field other than one transaction public key, at most one 9-byte encrypted
  payment id, and `0x7F`-marked nonce chunks;
- the transaction public key is absent or duplicated;
- there is no `0x7F` chunk;
- the concatenated chunks are empty, longer than 1,011 bytes, or do not start with a known magic;
- the chunking is not canonical;
- a nonce length is encoded non-canonically, is zero, exceeds 255, or runs past the end.

The checkpoint anchor (section 6) uses the same `0x7F` chunks with magic `XCK` + 0xFD, which is not
a known magic; a transaction carrying an anchor therefore carries no record.

### 1.5 Size limits and framing produced by a writer

`transport.rs: frame_of` produces: the public-key field first (`0x01` + 32 bytes), then one nonce
field per chunk in order, each `0x02`, length, `0x7F`, chunk bytes. With `l = chunk length + 1`,
the length is one byte `l` when `l < 128`, otherwise the two bytes `(l & 0x7F) | 0x80` and
`l >> 7`. The result MUST NOT exceed 1,060 bytes. No payment id is written.

The exact framed size without a payment id (`transport.rs: framed_extra_len`) is

```
33 + sum over chunks of (1 + (1 if c + 1 < 128 else 2) + c + 1)      ; c = chunk length
```

A 1,011-byte record frames to exactly 1,060 bytes (three chunks of 254 and one of 249). A reader
accepts any field order (1.3), so a reader MUST NOT require this layout for the eleven magics.
With a payment id present (11 bytes) the largest record that still fits is 1,000 bytes.

A writer splits a record with `transport.rs: parts` (known magics) or `transport.rs: parts_open`
(known and open magics); both apply rule 10 of 1.3 and then split into 254-byte pieces.

### 1.6 Open-token variants

`transport.rs: unframe` never returns a record with an open magic: rule 10 fails for it.
`transport.rs: unframe_open` applies the same algorithm with two differences:

- Rule 10 also admits the two open magics.
- Rule 9: if `b` starts with the MD1 magic, the result is "no record" (not a failure) unless all of
  the following hold: the first byte of `extra` is `0x01` (the public-key field is first); the
  payment id, if present, appears before every chunk; and `5 <= len(b) <= 1000`
  (`open.rs: MAX_INSCRIPTION`). Records with any other magic, including XO1, keep the free field
  order of 1.3.

`transport.rs: wire_at(extra, open, height)` gives the record a transaction carries at a block
height for a reader of both sets:

1. If `unframe(extra)` yields a record, that record.
2. Otherwise, if `unframe_open(extra)` yields a record `w` and `open.rs: record_at(open, w, height)`
   is true, then `w`. `record_at` is false when open tokens are not active at `height` (2.5); when
   active it is true for every XO1-magic record and for an MD1-magic record only if it decodes as
   an open deploy and its signature verifies (part C).
3. Otherwise no record.

### 1.7 Record id and note id

The record id of a record is the SHA-256 of its complete wire bytes, signature included
(`public.rs: record_id`):

```
record_id = H(wire)
```

The id of the public note created as output `index` of a record (`public.rs: note_id`):

```
note_id = H( "XMR20-PUBLIC-NOTE-v1\0" || record_id || LE16(index) )
```

The label is 21 bytes (20 ASCII characters and one zero byte); the hashed string is 55 bytes.
`index` is the position of the output in the record's output list, starting at 0. A note id is
never a native Monero outpoint.

### 1.8 Common decoding helpers

All record decoders read through `lib.rs: Reader`:

- `take(n)` fails ("truncated record") if fewer than `n` bytes remain.
- `u8` reads one byte; `u64` reads `LE64`.
- `done` fails ("trailing bytes") unless the whole input was consumed.

The domain-separated message digest used by every signature of this part is
(`lib.rs: message`):

```
message(label, domain, body) = H( label || domain || body )
```

where `label` is a fixed protocol string, `domain` is the 32-byte ledger domain (section 2) and
`body` is the record without its signature.

---

## 2. The ledger domain and manifest

### 2.1 Protocol identity strings

| Constant (`lib.rs`) | Value |
|---|---|
| `SCHEME` | `XMR20-TKD1` |
| `PROTOCOL` | `XMR20-UNSHIELDED-v0.2-experimental` |
| `DOMAIN_LABEL` | `XMR20-UNSHIELDED-DOMAIN-v1` |
| `MANIFEST_FORMAT` | `XMR20-PARAMS-2` |

### 2.2 Configuration (`parameters.json`)

`lib.rs: Config` is a JSON object with exactly these string members:

| Member | Content |
|---|---|
| `chain` | hex of the 32-byte chain genesis value |
| `domain` | hex of the 32-byte ledger domain |
| `spend_vk` | hex of the spend-circuit verifying key (compressed arkworks encoding, see part B) |
| `output_vk` | hex of the output-circuit verifying key (same encoding) |
| `issuer_vk` | hex of the 32-byte issuer verification key (section 3.3) |

### 2.3 Ledger domain

The ledger domain is a 32-byte value fixed for the life of a ledger. It is computed from the
configuration (`lib.rs: Config::computed_domain`):

```
domain = H( "XMR20-UNSHIELDED-DOMAIN-v1" || 0x00
            || LE32(len(chain))     || chain
            || LE32(len(spend_vk))  || spend_vk
            || LE32(len(output_vk)) || output_vk
            || LE32(len(issuer_vk)) || issuer_vk )
```

where each of the four values is the byte string obtained by hex-decoding the configuration member,
and `len` is its length in bytes.

`lib.rs: Config::validate` requires, in order: `chain` decodes to exactly 32 bytes; `issuer_vk`
decodes to exactly 32 bytes; the lowercase hex of the computed domain equals the `domain` member as
a string (an uppercase `domain` member does not match). `Config::domain` returns the 32 bytes after
validation. The lengths of the two verifying keys are not checked here.

The domain enters every signed message of the ledger (1.8), so a record signed for one ledger does
not verify on a ledger with a different genesis, verifying key or issuer key.

Values fixed per ledger: `chain`, `spend_vk`, `output_vk`, `issuer_vk`, and therefore `domain`.
The pool is created from the domain alone (`pool.rs: Pool::new`, `ledger.rs: Ledger::new`); the
issuer key and the two prepared verifying keys are supplied to each application call in
`pool.rs: Vks`.

### 2.4 Asset ids

An asset id is a 32-byte string: the canonical little-endian encoding of an element of the decaf377
base field Fq (the scalar field of BLS12-377), as used by Penumbra (`penumbra_sdk_asset::asset::Id`).

- Decoding (`lib.rs: asset_from_bytes`): the input MUST be exactly 32 bytes and MUST be the
  canonical encoding of a field element (integer below the field modulus). See note E-3 for what
  the reference does on a non-canonical encoding.
- In state and in JSON output an asset is identified by the lowercase hex of these 32 bytes; asset
  equality is equality of that string (`pool.rs: take_inputs`).

Derivation for a bridged token (`lib.rs: asset_for_mint`), given a mint string:

1. Lowercase the mint string (Unicode lowercasing), then keep only the characters that are ASCII
   letters or digits.
2. `denom = "uxmr20private" || filtered`.
3. The asset id is the Penumbra asset id of the base denomination `denom`: the 64-byte
   BLAKE2b-512 hash of the UTF-8 bytes of `denom` with personalization `Penumbra_AssetID`,
   interpreted as a little-endian integer and reduced modulo the Fq modulus
   (`penumbra_sdk_asset`, version 2.1.1, `asset::REGISTRY.parse_denom(..).id()`).

Open tokens derive their asset from `"uxmr20open" || hex(token id)` by the same step 3
(`open.rs: asset_for_open`, part C).

No record of this part restricts which asset ids may appear: an XC1 may credit any validly encoded
asset id that is not an open token (4.3).

### 2.5 Activation heights

Record types are switched on by block height. The pool holds four optional settings, all unset
(`None`) in a new pool (`pool.rs: Pool::new`); the host sets them from the functions below, keyed
by the manifest's network kind. An unset value means "never": the record type is ignored at every
height.

Build-time constants (read with `option_env!` when the core is compiled):

| Environment variable (build time) | Constant | Gates | When unset |
|---|---|---|---|
| `XMR20_MARKET_MAINNET_ACTIVATION` | `market.rs: MAINNET_ACTIVATION` | XA1, XL1 on mainnet | `None`: never active on mainnet |
| `XMR20_ADDRESS_MOVES_MAINNET_ACTIVATION` | `address.rs: MAINNET_ACTIVATION` | XW1 on mainnet | `None`: never active on mainnet |
| `XMR20_TRADES_MAINNET_ACTIVATION` | `trade.rs: MAINNET_ACTIVATION` | XT1 on mainnet | `None`: never active on mainnet |
| `XMR20_OPEN_TOKENS_MAINNET_ACTIVATION` | `open.rs: MAINNET_ACTIVATION` | XO1 and MD1 open deploy on mainnet | `None`: never active on mainnet |

Each value, when set, MUST be 1 to 12 ASCII decimal digits; anything else stops compilation
(`parse_height` in each of the four files). The value is the first block height at which the record
type applies (the comparison is `height >= from`).

Run-time variable:

| Environment variable (run time) | Read by | Meaning | When unset |
|---|---|---|---|
| `XMR20_OPEN_TEST_LEDGER` | `open.rs: activation_from_env` | 64 hex characters (surrounding whitespace trimmed): the domain of the XMR721 ledger whose inscriptions announce open tokens on a test chain. Ignored when the network kind is `mainnet`. | Open tokens are off on test chains |

Resulting activation per network kind:

| Network kind | XA1/XL1 (`market.rs: activation`) | XW1 (`address.rs: activation`) | XT1 (`trade.rs: activation`) | Open tokens (`open.rs: activation`) |
|---|---|---|---|---|
| `offline-fakechain` | from 0 | from 0, mainnet address bytes | from 0, mainnet address bytes | from 0 if a test ledger domain is given, else never; mainnet address bytes |
| `stagenet` | from 0 | from 0, stagenet address bytes | from 0, stagenet address bytes | from 0 if a test ledger domain is given, else never; stagenet address bytes |
| `mainnet` | build constant | build constant, mainnet address bytes | build constant, mainnet address bytes | build constant; XMR721 ledger domain `H("XMR721 mainnet ledger 1")` (`open.rs: mainnet_inscriptions`) |
| anything else | never | never | never | never |

Address network bytes (`address.rs`): mainnet main 18, subaddress 42; stagenet main 24,
subaddress 36.

XP1, XC1, XR1, XS1, XU1, XMA and XMB are not gated by height in the core: they apply at every
height the host presents.

### 2.6 Manifest (`XMR20-PARAMS-2`)

The manifest is a JSON document that pins the parameters of one ledger (`manifest.rs: Manifest`).

| Member | Type | Content |
|---|---|---|
| `format` | string | MUST equal `XMR20-PARAMS-2` |
| `label` | string | free text; not checked |
| `protocol.version` | string | MUST equal `XMR20-UNSHIELDED-v0.2-experimental` |
| `protocol.scheme` | string | MUST equal `XMR20-TKD1` |
| `protocol.domainLabel` | string | MUST equal `XMR20-UNSHIELDED-DOMAIN-v1` |
| `protocol.records` | object | map from a record name to `{ "magic": string, "bytes": string }`; not checked by the core |
| `network.kind` | string | MUST be `offline-fakechain`, `stagenet` or `mainnet` |
| `network.genesis` | string | MUST equal `config.chain` |
| `network.startHeight` | integer | optional, default 0; not read by the core |
| `ledgerDomain` | string | MUST equal `config.domain` |
| `issuerVk` | string | MUST equal `config.issuer_vk` |
| `config` | object | the configuration of 2.2 |
| `parametersJson` | file pin | pin of the `parameters.json` file |
| `files.spend` | file pin | pin of the spend proving-key file |
| `files.output` | file pin | pin of the output proving-key file |
| `provenance` | any JSON | optional, default null; not checked |

A file pin (`manifest.rs: ManifestFile`) is `{ "path": string, "bytes": integer, "sha256": string,
"vk": string (optional, default ""), "keyId": string (optional, default "") }`.

`manifest.rs: Manifest::validate` checks, in this order, and returns the ledger domain:

1. `format`, `protocol.version`, `protocol.domainLabel`, `protocol.scheme` equal the constants.
2. `network.kind` is one of the three accepted kinds.
3. `network.genesis == config.chain`.
4. `ledgerDomain == config.domain`.
5. `issuerVk == config.issuer_vk`.
6. `files.spend.vk == config.spend_vk` and `files.output.vk == config.output_vk`.
7. `files.spend.keyId` and `files.output.keyId` equal the proving-key ids below.
8. `files.spend.bytes` and `files.spend.sha256` equal the spend values below.
9. `files.output.bytes` and `files.output.sha256` equal the output values below.
10. For each of `parametersJson`, `files.spend`, `files.output`: `sha256` is hex of exactly 32
    bytes and `bytes > 0`.
11. `config` validates as in 2.3.

All string comparisons are exact.

Pinned proving-key files (`penumbra.rs`):

| | Spend | Output |
|---|---|---|
| Length in bytes | 21,673,392 | 7,257,360 |
| SHA-256 | `87eca85bef562803fb9684c56c0a6db84aa6d0791b1c00b909e6f2a5c2cff452` | `c9e97866edd6c815a7bcb2f3b5493713794369692bb96e5a2e682613c330e4a8` |
| Proving-key id | `groth16pk1ke43yax8cg78h69y0pn6kvjcktdakwq9m4c58nyam8hffweramfqxr94fh` | `groth16pk1rkpwdlcaw56gvyqpt0lm7lvj8q9mx93gqpz85dl9l3u677k75reqcnuq7d` |

A parameter file is authenticated before it is parsed (`manifest.rs: authenticate_file`): its
length MUST equal the pinned `bytes` and the hex of its SHA-256 MUST equal the pinned `sha256`.

---

## 3. Notes and owners

### 3.1 Public notes

A public note is an amount of one asset held by one owner key. Notes are the only form of public
balance: the balance of an owner in an asset is the sum of its unspent notes of that asset
(`pool.rs: public_balances`).

State kept per unspent note (`pool.rs: PublicNote`), keyed by its 32-byte note id (1.7):

| Field | Type | Content |
|---|---|---|
| `asset` | string | hex of the 32-byte asset id |
| `amount` | u64 | amount in base units; greater than 0 for every note created by the records of this part |
| `owner` | string | hex of the 32-byte owner key |
| `height` | u64 | block height of the creating transaction, as given by the host |
| `txid` | string | id of the creating transaction, as given by the host |
| `anchor` | optional string | hex of a native key image that every consuming carrier must spend; absent for a plain note (set only by the records of part B) |

Two sets hold the note state (`pool.rs: Pool`):

- `notes`: map from note id to the unspent note, ordered by note id bytes.
- `spent_notes`: set of the ids of every note ever consumed.

Consuming a note removes it from `notes` and adds its id to `spent_notes`
(`pool.rs: spend_inputs`). Creating outputs (`pool.rs: create_outputs`) walks the record's output
list in order; an output with amount 0 creates no note but still occupies its index; every other
output `i` is stored under `note_id(record_id, i)` as a plain note (`anchor` absent).

### 3.2 Resolving inputs

Every record that consumes public notes resolves its inputs with `pool.rs: take_inputs`, given the
list of input note ids, the record's asset (hex) and the key images spent by the carrier
transaction (`native`, in transaction order; empty when the host supplies none). For each input in
record order:

1. The id MUST be in `notes`. Otherwise the record fails with "already spent" if the id is in
   `spent_notes`, else "unknown input".
2. The note's asset MUST equal the record's asset.
3. If the note has an anchor, `native` MUST contain that key image.
4. The note's owner MUST equal the owner of the first input.
5. The amount is added to a running total in 128-bit arithmetic; overflow fails.

The result is the common owner key (decoded as a verification key, 3.3) and the total. One record
therefore spends the notes of exactly one owner and one asset.

### 3.3 Owner keys and signatures

- Curve and scheme: decaf377 with the decaf377-rdsa signature scheme, SpendAuth domain, as
  implemented by `decaf377-rdsa` version 0.11.0.
- An owner key is the 32-byte encoding of a SpendAuth verification key (a compressed decaf377
  element). Wherever a record names an owner, the 32 bytes MUST decode with
  `VerificationKey::<SpendAuth>::try_from` (`public.rs: check_outputs`, `public.rs: Credit::decode`,
  `public.rs: Burn::decode`, `keys.rs: owner_vk`).
- A signature is 64 bytes in the decaf377-rdsa encoding.
- The message given to the signature scheme is always the 32-byte digest
  `message(label, domain, body)` of 1.8. The labels of this part:

| Label constant | Bytes | Used by |
|---|---|---|
| `public.rs: AUTH_LABEL` | `"XMR20-UNSHIELDED-AUTH-v1\0"` (25 bytes) | XP1 and XR1, signed by the owner of the inputs |
| `public.rs: ISSUER_LABEL` | `"XMR20-UNSHIELDED-ISSUER-v1\0"` (27 bytes) | XC1, signed by the issuer |
| `checkpoint.rs: LABEL` | `"XMR20-CHECKPOINT-v1\0"` (20 bytes) | checkpoint anchor, signed by the issuer |

- The issuer key is a single SpendAuth verification key per ledger: `issuer_vk` of the
  configuration. Signing uses fresh randomness, so two signatures over the same body differ and
  give different record ids.

Not every owner key has a known signing key. Parts B and C define owner keys derived from Monero
addresses and from listed lots that only other record types can spend. A note owned by such a key
cannot be consumed by XP1 or XR1, because no valid signature under that key exists.

### 3.4 Wallet key schedule `XMR20-TKD1`

This schedule is how the reference wallets derive keys (`keys.rs`). It is not consensus: the ledger
only ever sees owner keys and signatures.

```
prf(root, msg, account) = BLAKE2b( digest length 32, key = root,
                                   personalization = "XMR20-TKD1",
                                   input = msg || LE32(account) )
```

- `root` is the account's 32-byte Monero private spend key.
- Shielded spend key: `prf(root, "xmr20/private-token/spend-key", account)`, used as the 32 bytes
  of a Penumbra `SpendKey` (`keys.rs: derive_token_spend_key`, `keys.rs: token_spend_key`). The
  shielded address is the Penumbra payment address at index 0 of its full viewing key
  (`keys.rs: shielded_address`).
- Owner signing key: `prf(root, "xmr20/public-token/owner-key", account)` interpreted as a
  little-endian integer and reduced modulo the decaf377 scalar field order r
  (`keys.rs: owner_signing_key`). The owner key is the 32-byte encoding of its verification key
  (`keys.rs: owner_key`).

### 3.5 Token addresses

`keys.rs: TokenAddress` has two textual forms:

- Unified address: bech32m (BIP-350, checksum constant `0x2bc830a3`) with human-readable part
  `xmr20t`. The data is 112 bytes: the 80-byte Penumbra address encoding (`Address::to_vec`)
  followed by the 32-byte owner key. Parsing (`keys.rs: TokenAddress::parse`) trims surrounding
  whitespace, requires the string to start with lowercase `xmr20t1`, requires a valid bech32m
  checksum, exactly 112 data bytes, a valid Penumbra address and a valid owner key.
- A Penumbra address string starting with `penumbra1` is accepted as a recipient without an owner
  key (private-only).
- Anything else is not a token address.

The bech32m implementation (`keys.rs: bech32m_encode`, `keys.rs: bech32m_decode`) rejects
mixed-case strings, requires a separator `1` with at least one character before it and at least six
after it, uses 8-to-5-bit conversion with padding on encode, and on decode requires fewer than 8
leftover bits, all zero. No overall length limit is applied.

### 3.6 Shielded note payload (shared with part B)

A shielded output is published as a 176-byte payload (`payload.rs: Payload`,
`payload.rs: PAYLOAD_BYTES`):

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 32 | note commitment | Penumbra state commitment (canonical Fq, little-endian) |
| 32 | 32 | ephemeral public key | decaf377 key-agreement public key |
| 64 | 112 | ciphertext | 96-byte plaintext and authentication tag |

`payload.rs: Payload::decode` requires exactly 176 bytes, a valid commitment encoding, and an
ephemeral key that decompresses to a point other than the identity.

The plaintext is `diversifier (16) || amount (16) || asset id (32) || rseed (32)`: the raw
diversifier followed by bytes 80 onward of Penumbra's note encoding. The symmetric key is

```
BLAKE2b( digest length 32, personalization = "XMR20_M3_Cipher",
         input = "compact-note-v1\0" || shared secret || ephemeral public key || commitment )
```

used with Penumbra's `PayloadKey` note encryption (`payload.rs: key`, `payload.rs: Payload::encrypt`).
Decryption reconstructs the recipient address from the viewing key and accepts the note only if it
recommits to the published commitment, reproduces the ephemeral key and is controlled by the
viewing key (`payload.rs: Payload::decrypt`). The ledger itself never decrypts payloads.

---

## 4. Record formats

### 4.0 Shared structure

Every record of this part has the shape `body || signature`, where the signature is the last 64
bytes and `body` begins with the 4-byte magic. There is no separate version or length field; the
record length is the length recovered from the chunks (section 1).

Public output (`lib.rs: PublicOutput`), 40 bytes:

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 32 | owner | owner key (3.3) |
| 32 | 8 | amount | `LE64` |

Limits (`public.rs: MAX_IO`): at most 4 inputs and at most 4 outputs per record.

Every decoder ends with a canonical check: the decoded record, re-encoded, MUST equal the input
bytes.

In the check lists below, a failure at any step rejects the record (5.3). Steps are in the order
the reference evaluates them, which determines the reported error but not the outcome.

### 4.1 XP1 — public transfer

Moves the whole value of 1 to 4 notes of one owner and one asset to 1 to 4 new notes.

Layout (`public.rs: Transfer::body`, `public.rs: Transfer::encode`), with `nIn`, `nOut` in 1..4:

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 4 | magic | `58 50 31 FE` |
| 4 | 32 | asset | asset id (2.4) |
| 36 | 1 | nIn | unsigned byte |
| 37 | 1 | nOut | unsigned byte |
| 38 | 32 × nIn | inputs | note ids |
| 38 + 32·nIn | 40 × nOut | outputs | public outputs (4.0) |
| 38 + 32·nIn + 40·nOut | 64 | signature | decaf377-rdsa SpendAuth |

Length: `102 + 32·nIn + 40·nOut` bytes; minimum 174 (1 input, 1 output), maximum 390 (4 and 4).

Signed message: `message("XMR20-UNSHIELDED-AUTH-v1\0", domain, body)` where `body` is every byte
before the signature (`public.rs: Transfer::message`).

Checks, in order (`public.rs: Transfer::decode`, then `pool.rs: transfer`):

1. The record is at least 4 bytes and starts with the XP1 magic.
2. 32 bytes of asset are present and decode as an asset id.
3. `nIn` and `nOut` are present and each is between 1 and 4.
4. `nIn` note ids, `nOut` outputs and 64 signature bytes are present.
5. No bytes follow the signature.
6. The re-encoded record equals the input.
7. No input note id appears twice.
8. For each output in order: the amount is greater than 0, then the owner decodes as an owner key.
9. The inputs resolve as in 3.2 against the record's asset and the carrier's key images.
10. The input total equals the sum of the output amounts (128-bit sum).
11. The signature verifies under the owner key of the inputs.

Effect:

- Each input note is consumed.
- For `i` in `0..nOut-1`, a plain note `note_id(record_id, i)` is created with the record's asset,
  output `i`'s owner and amount, and the carrier's height and txid.
- Supply counters do not change.

### 4.2 XC1 — public credit

Creates one new note by authority of the issuer, bound to a unique 32-byte binding.

Layout (`public.rs: Credit::body`, `public.rs: Credit::encode`), fixed length 173 bytes
(`public.rs: Credit::BYTES`):

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 4 | magic | `58 43 31 FE` |
| 4 | 1 | kind | 1 = deposit (`KIND_DEPOSIT`), 2 = migration (`KIND_MIGRATION`) |
| 5 | 32 | asset | asset id (2.4) |
| 37 | 8 | amount | `LE64` |
| 45 | 32 | owner | owner key (3.3) |
| 77 | 32 | binding | opaque 32 bytes, not all zero |
| 109 | 64 | issuer signature | decaf377-rdsa SpendAuth |

Signed message: `message("XMR20-UNSHIELDED-ISSUER-v1\0", domain, body)` where `body` is bytes
0..108 (`public.rs: Credit::message`).

Checks, in order (`public.rs: Credit::decode`, then `pool.rs: credit`):

1. The record is exactly 173 bytes and starts with the XC1 magic.
2. The asset decodes as an asset id.
3. The re-encoded record equals the input.
4. `kind` is 1 or 2.
5. `amount` is greater than 0 and `binding` is not 32 zero bytes.
6. `owner` decodes as an owner key.
7. `binding` is not already a key of the ledger's credit table (whatever the asset or kind of the
   earlier credit).
8. The signature verifies under the issuer key.
9. The asset is not the asset of an open token (part C).

Effect:

- A plain note `note_id(record_id, 0)` is created with the asset, `owner`, `amount`, and the
  carrier's height and txid.
- `minted[asset]` increases by `amount`.
- The credit table gains the entry `binding -> { kind, asset, amount, owner, txid, height }`.

The meaning of `binding` (which deposit or migration claim it stands for) is defined by the issuer
and is not interpreted by the ledger. The two kinds are applied identically.

### 4.3 XR1 — public burn

Destroys `amount` from 1 to 4 notes of one owner and returns the remainder to the same owner.

Layout (`public.rs: Burn::body`, `public.rs: Burn::encode`), with `nIn` in 1..4:

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 4 | magic | `58 52 31 FE` |
| 4 | 32 | asset | asset id (2.4) |
| 36 | 1 | nIn | unsigned byte |
| 37 | 32 × nIn | inputs | note ids |
| 37 + 32·nIn | 8 | amount | `LE64`, the burned amount |
| 45 + 32·nIn | 32 | change owner | owner key (3.3) |
| 77 + 32·nIn | 8 | change amount | `LE64`, may be 0 |
| 85 + 32·nIn | 32 | binding | opaque 32 bytes, not all zero |
| 117 + 32·nIn | 64 | signature | decaf377-rdsa SpendAuth |

Length: `181 + 32·nIn` bytes; minimum 213, maximum 309.

Signed message: `message("XMR20-UNSHIELDED-AUTH-v1\0", domain, body)` where `body` is every byte
before the signature (`public.rs: Burn::message`). XP1 and XR1 share the label; the magic at the
start of `body` separates them.

Checks, in order (`public.rs: Burn::decode`, then `pool.rs: burn`):

1. The record is at least 4 bytes and starts with the XR1 magic.
2. The asset decodes as an asset id.
3. `nIn` is between 1 and 4.
4. `nIn` note ids, the amount, the change output, the binding and 64 signature bytes are present.
5. No bytes follow the signature.
6. The re-encoded record equals the input.
7. No input note id appears twice.
8. `amount` is greater than 0 and `binding` is not 32 zero bytes.
9. The change owner decodes as an owner key (also when the change amount is 0).
10. The carrier's txid, as given by the host, is hex of exactly 32 bytes.
11. That txid is not already a key of the ledger's redemption table.
12. The inputs resolve as in 3.2 against the record's asset and the carrier's key images.
13. The input total equals `amount + change amount` (128-bit sum).
14. The change owner equals the owner key of the inputs.
15. The signature verifies under the owner key of the inputs.

Effect:

- Each input note is consumed.
- If the change amount is greater than 0, a plain note `note_id(record_id, 0)` is created for the
  owner with the change amount; if it is 0, no note is created.
- `burned[asset]` increases by `amount`.
- The redemption table gains the entry
  `txid (32 bytes) -> { asset, amount, binding (hex), owner (hex), txid, height }`.

The `binding` of a burn is not checked for uniqueness; it is recorded for the party that redeems
the burned amount.

### 4.4 Supply accounting

Four per-asset counters, each a map from asset hex to an unsigned 128-bit integer
(`pool.rs: Pool`). A key is created the first time a record adds to it.

| Counter | Increased by |
|---|---|
| `minted` | XC1 `amount`; open deploy and open mint (part C) |
| `burned` | XR1 `amount` |
| `shielded_in` | XS1 shielded amount (part B) |
| `shielded_out` | XU1 unshielded amount (part B) |

Derived views:

- `public_supply[asset]` = sum of the amounts of all unspent public notes of the asset
  (`pool.rs: public_supply`). An asset with no unspent note has no entry.
- `shielded_supply[asset]` = `shielded_in − shielded_out` as a signed 128-bit integer, for every
  asset with an entry in either counter (`pool.rs: shielded_supply`).
- `outstanding[asset]` = `minted − burned` for every asset with an entry in `minted`
  (`pool.rs: outstanding`).

Invariant (`pool.rs: invariant`): for every asset appearing in any of the three views,
`public_supply + shielded_supply == outstanding` and `shielded_supply >= 0`, with missing entries
read as 0. XP1 preserves it by conservation; XC1 adds the same amount to public supply and
`minted`; XR1 removes `amount` from public supply and adds it to `burned`.

---

## 5. Order of application

### 5.1 Input to the ledger

The ledger state is a pure function of the ordered sequence of calls
`apply_carrier(wire, txid, height, native, vks)` (`pool.rs: Pool::apply_carrier`), plus, for XT1
claims only, the end-of-block calls of part C. The core's stated contract is that it is called
"with native-consensus-validated carriers in canonical chain order" and that the state is "rebuilt
from the canonical native chain on every scan" (`pool.rs` module comment and `apply_carrier`
comment).

- `wire`: the record carried by the transaction (section 1), or absent.
- `txid`: the transaction id as text. XR1 requires it to be hex of 32 bytes (4.3); for other
  records of this part it is stored as given.
- `height`: the height of the block containing the transaction.
- `native`: the key images of the transaction's inputs, in transaction order.
  `pool.rs: Pool::apply` is the same call with an empty list; through it no anchored note can be
  consumed.
- `vks`: the issuer verification key and the two prepared Groth16 verifying keys.

One transaction carries at most one record (1.1), so there is at most one call with a record per
transaction. Blocks are applied in ascending height; within a block, transactions are applied in
the order the chain gives them (see note E-9). The core does not check that heights are
non-decreasing.

### 5.2 Dispatch

`apply_carrier` returns a JSON object whose `record` member is `ignored`, `accepted`, `pending` or
`rejected`. The steps, in order:

1. No record: `ignored`.
2. The record starts with none of the eleven known magics and neither open magic: `ignored`.
3. The kind is chosen from the first four bytes: XP1 `public-transfer`, XC1 `public-credit`,
   XR1 `public-burn`, XS1 `shield`, XU1 `unshield`, XA1 `anchored-transfer`, XL1 `lot-sale`,
   XW1 `address-move`, XT1 `trade-list` / `trade-cancel` / `trade-reserve` / `trade-claim` by its
   fifth byte (any other or missing fifth byte selects `trade-claim`), XO1 `open-mint`,
   MD1 `open-deploy`, XMA `private-part-a`, XMB `private-part-b`.
4. Height gates, each answering `ignored`:
   - XA1 or XL1 when the market setting is unset or `height` is below it;
   - XW1 when the address-move setting is unset or `height` is below its start;
   - XT1 when the trade setting is unset or `height` is below its start;
   - XO1 or MD1 when the open-token setting is unset or `height` is below its start;
   - MD1, when open tokens are active, unless the record decodes as an open deploy and its
     signature verifies (part C).
5. The record handler runs on a copy of the whole state.
6. If the handler succeeds, the copy replaces the state. The result is `pending` for a private
   part that did not complete an operation and for every XT1 claim; otherwise it is `accepted` and
   the `accepted` counter increases by 1.
7. If the handler fails, or panics (reported as "Malformed record"), the state is unchanged except
   that the `rejected` counter increases by 1; the result is `rejected` with an `error` text.

`ignored` changes nothing, not even a counter. XP1, XC1 and XR1 have no height gate: they are
never `ignored` and never `pending`.

### 5.3 Failed records

A record that fails any check changes nothing except the `rejected` counter (5.2 step 7): no note
is consumed or created and no table entry is written. The native transaction remains in the chain
and its fee is spent (`pool.rs` module comment). A later transaction may carry the same record
bytes again; it is evaluated afresh against the state at that point.

Replay of an accepted record of this part is impossible by construction: an XP1 or XR1 names
inputs that are now spent, and an XC1 names a binding that is now in the credit table.

### 5.4 Reorganizations

The core has no undo operation. Its stated model is that the state is rebuilt by applying the
records of the canonical chain in order (`pool.rs` module comment; the comment on
`pool.rs: part` adds "deterministic on replay and rollback (the pool is rebuilt from canonical
records)"). A host that follows a reorganization MUST arrive at the state obtained by applying
exactly the records of the new canonical chain from an empty pool. `Pool` is cloneable, so a host
may keep snapshots; this is an implementation matter.

### 5.5 Initial state

`pool.rs: Pool::new(domain)`: no notes, no spent ids, all counters and tables empty, `accepted`,
`rejected` and `pending_records` zero, all four activation settings unset. The shielded ledger
(`ledger.rs: Ledger::new`) starts with an empty Penumbra tiered commitment tree, no nullifiers, no
payload history, and a root set containing only the root of the empty tree.

The shielded ledger state (`ledger.rs: Ledger`): `tree` (commitment tree), `nullifiers` (set of
32-byte nullifiers), `history` (every published payload in insertion order), `roots` (every root
the tree has ever had, as 32-byte canonical Fq encodings, `ledger.rs: root_bytes`) and `domain`.
`ledger.rs: Ledger::commit` adds the given nullifiers, inserts each output commitment into the tree
in order, appends each payload to `history`, and then records the new root once. Records of this
part never call it.

---

## 6. Checkpoint anchors

### 6.1 Purpose and status

An anchor is a statement signed by the issuer about the list of record-carrying transactions up to
a block. It is not a record: its magic is not a known magic, every reader sees no record in the
carrying transaction (1.4), and no balance depends on it (`checkpoint.rs` module comment).

### 6.2 Byte layout

Fixed length 140 bytes (`checkpoint.rs: BYTES`, `checkpoint.rs: Anchor::body`,
`checkpoint.rs: Anchor::sign`):

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 4 | magic | `58 43 4B FD` (`XCK` + 0xFD) |
| 4 | 4 | height | `LE32` |
| 8 | 32 | block hash | 32 bytes, the hash of the block at `height` |
| 40 | 32 | list hash | 32 bytes (6.3) |
| 72 | 4 | records | `LE32`, number of entries in the hashed list |
| 76 | 64 | signature | decaf377-rdsa SpendAuth |

### 6.3 List hash

As documented in the module comment of `checkpoint.rs`: the list hash is the SHA-256 of the
concatenation of one line `height:txid\n` for every record-carrying transaction at or below
`height`, in chain order, and `records` is compared together with it. The core contains no function
that computes this hash; the exact text form of `height` and `txid` is not defined in the core (see
note E-11).

### 6.4 Signature and verification

Signer: the ledger's issuer key (the same key that signs XC1).

Signed message: `message("XMR20-CHECKPOINT-v1\0", domain, bytes 0..75)`.

`checkpoint.rs: Anchor::verify(wire, issuer, domain)`:

1. `wire` MUST be exactly 140 bytes and start with the magic.
2. The four fields are read at the offsets above.
3. The signature MUST verify under the issuer key over the message above.

Verification does not compare `height` or the block hash with any chain; the caller does that and
compares `records` and the list hash with its own list.

### 6.5 Extraction from `extra`

`checkpoint.rs: Anchor::from_extra` uses a parser that is more lenient than section 1.3:

1. Scan fields from offset 0.
2. Tag `0x01`: skip 32 bytes (no count limit, no bounds check; running past the end ends the scan).
3. Tag `0x02`: read a base-128 varint length of at most three bytes (a third byte of 0x80 or more
   yields no anchor; non-canonical encodings are accepted). The length MUST be at least 1 and the
   data MUST fit, else no anchor. If the first data byte is `0x7F`, append the rest to the
   collected bytes; any other nonce is skipped.
4. Any other tag: no anchor.
5. The collected bytes MUST be exactly 140 bytes and start with the magic; they are the anchor
   wire. Otherwise there is no anchor.

There is no limit on the length of `extra`, no requirement of a public key, and no canonical
chunking requirement. A 140-byte anchor in one chunk has a 141-byte nonce and therefore a two-byte
length `8D 01`.

---

## 7. `summary()`

`pool.rs: Pool::summary` returns one JSON object. Its members:

| Member | JSON type | Value |
|---|---|---|
| `root` | string | hex of the current shielded tree root (32 bytes, canonical Fq, little-endian; `ledger.rs: root_bytes`) |
| `shieldedNotes` | number | number of payloads in the shielded history |
| `nullifiers` | number | number of nullifiers in the set |
| `publicNotes` | number | number of unspent public notes |
| `minted` | object | asset hex → decimal string of `minted` |
| `burned` | object | asset hex → decimal string of `burned` |
| `outstanding` | object | asset hex → decimal string of `minted − burned`, for every key of `minted` |
| `publicSupply` | object | asset hex → decimal string of the sum of unspent notes; only assets with at least one unspent note |
| `shieldedSupply` | object | asset hex → decimal string of `shielded_in − shielded_out` (signed), for every key of either counter |
| `invariant` | object | `{ "ok": boolean, "rows": array }` (below) |
| `accepted` | number | the `accepted` counter (5.2) |
| `rejected` | number | the `rejected` counter (5.2) |
| `pendingParts` | number | number of stored, uncompleted private-transfer parts (part B) |
| `completedOperations` | number | number of completed private-transfer operations (part B) |
| `credits` | array | one object per credit-table entry (below) |
| `redemptions` | array | one object per redemption-table entry (below) |

`invariant.rows`: one object per asset in the union of the keys of `publicSupply`,
`shieldedSupply` and `outstanding`, in ascending order of the asset hex string:
`{ "asset": string, "publicSupply": string, "shieldedSupply": string, "outstanding": string,
"ok": boolean }`, the three amounts as decimal strings of signed 128-bit values. `ok` of a row is
`publicSupply + shieldedSupply == outstanding && shieldedSupply >= 0`; `invariant.ok` is the
conjunction of the rows (true when there are none).

`credits`: in ascending order of the 32 binding bytes, each
`{ "binding": hex, "kind": number, "asset": hex, "amount": decimal string, "owner": hex,
"txid": string, "height": number }`.

`redemptions`: in ascending order of the 32 bytes of the carrier txid, each
`{ "txid": string, "asset": hex, "amount": decimal string, "binding": hex, "owner": hex,
"height": number }`.

Ordering and determinism:

- All per-asset objects are built from ordered maps keyed by the asset hex string, so their natural
  order is ascending by that string, which equals ascending order of the asset id bytes.
- Array order is fixed as stated above.
- Amounts are decimal strings; counts, `kind` and `height` are JSON numbers.
- The order of members inside each JSON object is determined by the JSON library: with the
  dependency set locked for this crate, objects are stored in sorted maps and serialize with
  members in ascending byte order of their names, not in the order written above (see note E-12).
- The summary depends only on the pool state; it contains no time, randomness or host data other
  than the `txid` and `height` values the host supplied when records were applied.

State that `summary()` does not expose: the public notes themselves (ids, owners, amounts, assets,
heights, anchors) beyond their count and per-asset totals; the set of spent note ids; the
nullifiers and payloads beyond their counts; the root history; the contents of pending and
completed private-transfer operations; lots, reservations, used payments and pending claims
(part C); open tokens (part C); the activation settings; the ledger domain.

---
