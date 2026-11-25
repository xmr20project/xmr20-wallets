# Part C — Moves by Monero address, trades, and open tokens

This part specifies four record families of the XMR20 token ledger:

- `XW1`, a move of Open notes signed with a Monero wallet message signature;
- `XT1`, listing, cancelling, reserving and claiming a lot paid for in XMR;
- the open deploy, an XMR721 `MD1` mint record that the token ledger reads as the
  announcement of a token;
- `XO1`, an unsigned mint of an open token.

Terms defined in part A and used here without definition: *framing* (how a record is
carried in `tx_extra`), *ledger domain* (32 bytes, `lib.rs: Config::computed_domain`),
*record id*, *note id*, *asset id*, *Open note*, *owner key*, *input resolution*
(`pool.rs: take_inputs`), and the four results a reader gives for a carrier:
`accepted`, `rejected`, `pending`, `ignored`. Records `XP1`, `XC1`, `XR1` are part A;
shielded records and the anchored records `XA1`, `XL1` are part B.

Conventions of this part:

- All multi-byte integers in records are **little-endian** unless a rule says otherwise.
- `H(x)` is SHA-256. `K(x)` is Keccak-256 (the original Keccak padding, as Monero uses).
- `M(label, body)` is `H(label || domain || body)` with the 32-byte ledger domain
  (`lib.rs: message`).
- `Hs(x)` is `K(x)` read as a little-endian integer and reduced modulo the Ed25519 group
  order `l`.
- `hex(x)` is lowercase hexadecimal.
- `height` is the height of the block that holds the carrier transaction.
- record id = `H(record bytes)` over the whole record as framed, signature included
  (`public.rs: record_id`).
- note id = `H("XMR20-PUBLIC-NOTE-v1" 0x00 || record id || index)` with `index` a `u16`
  little-endian (`public.rs: note_id`).
- A *party* is 65 bytes: `kind` (1 byte: `0x00` standard address, `0x01` subaddress),
  `B` (32 bytes, the public spend key in the address), `A` (32 bytes, the public view key
  in the address). For a subaddress these are the subaddress's own two keys.

A record that fails any check changes nothing in the ledger. Each record is applied to a
copy of the state and the copy replaces the state only when every check passes
(`pool.rs: apply_carrier`).

---

## 1. Address owners

### 1.1 Owner key of a Monero address

An Open note names its owner by a 32-byte owner key (a decaf377-rdsa `SpendAuth`
verification key encoding, part A). A Monero address is given an owner key for which no
signing key is known, so that only the records of this part move its notes.

For an address with public spend key `B` and public view key `A`
(`address.rs: owner_key`):

1. `h = BLAKE2b-512(label || B || A)`, unkeyed, no salt, no personalisation, 64-byte
   output, where `label` is the 23 bytes `XMR20-ADDRESS-OWNER-v1` followed by `0x00`
   (`address.rs: OWNER_LABEL`). `B` and `A` are the 32-byte key encodings exactly as they
   stand in the address.
2. `f1` = the first 32 bytes of `h`, read as a little-endian integer and reduced modulo
   the decaf377 base field order (the BLS12-377 scalar field, `Fq`).
   `f2` = the last 32 bytes of `h`, read the same way.
3. `P = hash_to_curve(f1, f2)`, the decaf377 two-element hash-to-group map
   (`decaf377::Element::hash_to_curve`).
4. The owner key is the 32-byte canonical decaf377 compression of `P`.

The address kind (standard or subaddress) and the network are **not** inputs to the hash.
The owner key depends on the 64 key bytes only.

### 1.2 Address types

- On the wire an address is a party (`kind`, `B`, `A`). `kind` is `0x00` or `0x01`; any
  other value fails decoding (`address.rs: Move::decode`, `trade.rs: read_party`).
- Standard addresses and subaddresses are allowed. Integrated addresses have no
  encoding in these records.
- In text an address is the usual Monero base58 string of 95 characters: one prefix
  byte, `B`, `A`, and the first 4 bytes of `K(prefix || B || A)`, 69 bytes in all,
  encoded in Monero's block base58 (8-byte blocks to 11 characters, the final 5-byte
  block to 7 characters) (`address.rs: Address::encode`, `Address::decode`).
- Decoding a text address requires exactly 95 characters, a valid base58 block
  encoding with every block value in range, 69 decoded bytes, a matching checksum and a
  prefix byte of the reader's network; anything else is an error
  (`address.rs: Address::decode`, `unbase58`).

### 1.3 Networks

A reader is configured with one network (`address.rs: Net`). The network supplies the two
prefix bytes used whenever a rule writes an address into a text that is signed.

| Network | Standard prefix | Subaddress prefix | Constant |
|---|---|---|---|
| mainnet | 18 | 42 | `MAINNET` |
| stagenet | 24 | 36 | `STAGENET` |
| testnet | 53 | 63 | `TESTNET` |

The network kind string of the reader selects the network and the activation height of
each rule set (`address.rs: activation`, `trade.rs: activation`, `open.rs: activation`):

| Network kind | Address network | `XW1` from | `XT1` from | Open tokens from |
|---|---|---|---|---|
| `mainnet` | mainnet | build-time height | build-time height | build-time height |
| `stagenet` | stagenet | 0 | 0 | 0, only when a test XMR721 ledger domain is supplied |
| `offline-fakechain` | mainnet | 0 | 0 | 0, only when a test XMR721 ledger domain is supplied |
| any other | — | never | never | never |

A rule set whose activation is absent, or whose activation height is above `height`,
does not exist for that carrier: the reader answers `ignored`, exactly as for a record
with an unknown magic (`pool.rs: apply_carrier`).

### 1.4 Monero message signatures

`XW1`, the signed `XT1` operations and the open deploy carry a Monero wallet message
signature in the wallet2 `SigV2` form, made with the **spend** key of the signing
address. A record carries it as `variant` (1 byte), `c` (32 bytes), `r` (32 bytes).

Message hash (`address.rs: message_hash`), for the signed byte string `t` and the
signer's keys `B`, `A`:

```
h = K( "MoneroMessageSignature" 0x00 || B || A || 0x00 || varint(len(t)) || t )
```

The single byte `0x00` after `A` is the wallet2 mode byte for a spend-key signature.
`varint` is the Monero variable-length integer (7 bits per byte, least significant group
first, high bit set on every byte but the last).

Verification (`address.rs: verify_spend_signature`) succeeds only when all of this
holds:

1. `B` decompresses to an Ed25519 point, is not the identity and is in the prime-order
   subgroup.
2. `c` and `r` are canonical scalars (each below `l`).
3. `c` is not zero.
4. With `R' = c·B + r·G`: `Hs(h || B || compress(R')) == c`.

A view-key signature (mode byte `0x01`) never verifies.

The signed byte string is `text || ending`, where `text` is the UTF-8 text the record's
rule builds and `ending` is selected by `variant` (`address.rs: SUFFIX`):

| `variant` | Ending |
|---|---|
| 0 | empty |
| 1 | `0x0a` |
| 2 | `0x0d 0x0a` |

Any other `variant` fails decoding. A wallet shows a signature as `SigV2` followed by the
Monero base58 encoding of `c || r` (64 bytes) (`address.rs: parse_signature`).

---

## 2. XW1 — move signed by a Monero address

Magic: `58 57 31 fe` (`XW1` `0xfe`) (`address.rs: MAGIC_MOVE`).

### 2.1 Layout

Fields in order. Offsets after `inputs` depend on the counts; sizes are in bytes.

| # | Size | Field | Encoding |
|---|---|---|---|
| 1 | 4 | `magic` | `58 57 31 fe` |
| 2 | 32 | `asset` | asset id, canonical encoding (part A) |
| 3 | 4 | `until` | `u32` LE, last block height at which the move applies |
| 4 | 1 | `nIn` | 1 to 4 |
| 5 | 32 × `nIn` | `inputs` | note ids |
| 6 | 1 | `nTo` | 1 to 3 |
| 7 | variable | `recipients` | `nTo` recipients, see below |
| 8 | 32 | `feeOwner` | owner key of the fee note, or 32 zero bytes |
| 9 | 8 | `feeAmount` | `u64` LE, units |
| 10 | 8 | `change` | `u64` LE, units |
| 11 | 1 | `flags` | bit 0 `FLAG_FEE_IN_XMR`; all other bits zero |
| 12 | 1 | `signerKind` | `0x00` standard address, `0x01` subaddress |
| 13 | 32 | `B` | signer's public spend key |
| 14 | 32 | `A` | signer's public view key |
| 15 | 1 | `tickerLen` | 1 to 12 |
| 16 | `tickerLen` | `ticker` | ASCII letters and digits |
| 17 | 1 | `variant` | 0, 1 or 2 (section 1.4) |
| 18 | 32 | `c` | signature scalar |
| 19 | 32 | `r` | signature scalar |

The **body** is fields 1 to 16 (`address.rs: Move::body`). Nothing follows field 19.

A recipient is `kind` (1 byte), kind-specific keys, then `amount` (`u64` LE, units):

| `kind` | Keys | Size with amount | The note's owner |
|---|---|---|---|
| `0x00` | `B`(32) `A`(32) of a standard address | 73 | the address owner of (`B`, `A`) |
| `0x01` | `B`(32) `A`(32) of a subaddress | 73 | the address owner of (`B`, `A`) |
| `0x02` | `key`(32), an owner key | 41 | `key` |
| `0x03` | `B`(32) `A`(32) `opk`(32) `cc`(32) `cs`(32) | 169 | `opk` |

Kind `0x03` names a standard address together with an owner key `opk` and a
certificate (`cc`, `cs`) by which the address's spend key assigns that owner key
(section 2.4). The address in a kind `0x03` recipient is always a standard address.

### 2.2 The signed text

The text is one line, built from the record (`address.rs: Move::text_as`):

```
XMR20 move: send <sends>; <fee>; from <signer>; valid until block <until>; code <code>
```

- `<sends>`: one item per recipient, in record order, joined by the five characters
  ` and ` (space, `and`, space). An item is
  - `<amount> <name> to <address>` for kinds `0x00`, `0x01` and `0x03`, where `<address>`
    is the recipient's 95-character address on the reader's network (for kind `0x03`
    the address, not `opk`);
  - `<amount> <name> to XMR20 key <hex(key)>` for kind `0x02` (64 hex characters).
- `<fee>` is
  - `fee <amount> <name>` when `feeAmount` is above 0;
  - otherwise `network fee paid in XMR` when flag bit 0 is set;
  - otherwise `no fee`.
- `<signer>`: the signing address (`signerKind`, `B`, `A`) on the reader's network.
- `<until>`: `until` in decimal, no padding, no separators.
- `<code>`: 32 hex characters, `hex` of the first 16 bytes of
  `M("XMR20-ADDRESS-MOVE-v1" 0x00, body)` (`address.rs: Move::code`, `MOVE_LABEL`).
- `<amount>`: the amount in units divided by 1,000,000, written as the integer part in
  decimal, then, only when the fraction is not zero, a `.` and the six-digit fraction
  with trailing zeros removed (`address.rs: amount`). Examples: `5000000` → `5`,
  `1500000` → `1.5`, `1` → `0.000001`.
- `<name>`: the `ticker` field, except for an open token, where it is the token's label
  (section 4.7).

The body is under the code, so the signature covers every field of the body, the
ledger domain and, through the address strings, the network.

### 2.3 Signature

The signer is the party (`signerKind`, `B`, `A`). The signed byte string is the text of
section 2.2 followed by the ending `variant` selects; verification is section 1.4
(`address.rs: Move::verify_sig_as`).

### 2.4 Recipient certificate (kind 0x03)

A certificate is valid only when all of this holds (`address.rs: verify_certificate`):

1. The spend key `B` of the recipient's address decompresses, is not the identity and
   is in the prime-order subgroup.
2. `cc` and `cs` are canonical scalars and `cc` is not zero.
3. With
   `m = K("XMR20-OPEN-OWNER-v1" 0x00 || address || 0x00 || hex(opk) || 0x00 || hex(domain))`,
   where `address` is the 95 ASCII characters of the standard address on the reader's
   network and both hex strings are 64 lowercase ASCII characters, and with
   `R' = cc·B + cs·G`: `Hs(m || B || compress(R')) == cc`.

### 2.5 Replay protection

- Each input note is consumed once; a second copy of the record finds its inputs spent.
- `until` bounds the block heights at which the record applies.
- The code binds the body to the ledger domain; address strings bind the text to the
  network.

### 2.6 Fee output

A move may create one fee note. When `feeAmount` is above 0, flag bit 0 must be clear
and `feeOwner` must be a valid owner key; the fee note goes to `feeOwner`. When
`feeAmount` is 0, `feeOwner` must be 32 zero bytes. Flag bit 0 states that the relay is
paid in XMR; the ledger checks only that it is not combined with a token fee.

### 2.7 Checks, in order

Activation gate first (section 2.9). Then (`address.rs: Move::decode`, `Move::check`,
`pool.rs: address_move`):

Decoding:

1. `magic` matches; `asset` is a canonical asset id.
2. `nIn` is 1 to 4; `nTo` is 1 to 3; every recipient `kind` is 0 to 3.
3. `signerKind` is 0 or 1.
4. `ticker` is valid UTF-8 of `tickerLen` bytes.
5. No bytes follow `r`; no field is truncated.
6. No input note id appears twice.
7. Every recipient amount is above 0.
8. For kinds `0x02` and `0x03`, the owner key (`key`, `opk`) is a valid decaf377-rdsa
   verification key encoding.
9. `flags` has no bit set other than bit 0.
10. The fee rules of section 2.6 hold.
11. `ticker` is 1 to 12 bytes, each an ASCII letter or digit.
12. `variant` is 0, 1 or 2.

Against the ledger:

13. `until >= height`.
14. Input resolution (part A) over `inputs` for `asset`: every input exists and is
    unspent, has the record's asset, all inputs have one owner; an anchored input
    additionally requires the carrier to spend its anchor key image (part B).
15. The owner of the inputs equals the address owner of (`B`, `A`) of the signer.
16. The sum of the inputs equals the sum of all recipient amounts plus `feeAmount` plus
    `change`, computed without overflow in 128 bits.
17. When `asset` is an open token's asset, `ticker` equals the token's ticker field
    (section 4.7).
18. The signature verifies over the text of section 2.2.
19. Every kind `0x03` certificate verifies (section 2.4).

### 2.8 Effect

1. Every input note is removed and recorded as spent.
2. With `rid` the record id, notes of `asset` are created at these indices
   (`pool.rs: address_move`, `create_outputs`):
   - index `i` (0 ≤ `i` < `nTo`): recipient `i`, its amount, its owner;
   - index `nTo`: `feeAmount` to `feeOwner`;
   - index `nTo + 1`: `change` to the signer's address owner.
   An output whose amount is 0 creates no note; the indices of the other outputs do not
   shift. Each note id is `note_id(rid, index)`.
3. The result is `accepted`.

### 2.9 Activation gate

`XW1` applies when the reader's address-move activation is set and `height` is at or
above its height (`pool.rs: apply_carrier`, `address.rs: activation`). The mainnet height
is fixed when the reader is built (`address.rs: MAINNET_ACTIVATION`, from
`XMR20_ADDRESS_MOVES_MAINNET_ACTIVATION`); a reader built without it never applies `XW1`
on mainnet.

---

## 3. XT1 — trades paid in XMR

Magic: `58 54 31 fe` (`XT1` `0xfe`) (`trade.rs: MAGIC_TRADE`). The fifth byte is the
operation.

| `op` | Operation | Signed by |
|---|---|---|
| `0x01` | list | the seller |
| `0x02` | cancel | the seller |
| `0x03` | reserve | the buyer |
| `0x04` | claim | nobody |

A record with `XT1` magic and any other fifth byte, or none, is `rejected` once the
gate of section 3.9 is open.

For every operation the **body** is `magic || op || fields` without `variant`, `c`, `r`
(`trade.rs: Body::bytes`), and

```
code = first 16 bytes of M("XMR20-TRADE-v1" 0x00, body)
```

(`trade.rs: Body::code`, `TRADE_LABEL`). In texts `<code>` is its 32 hex characters.

A **lot** is identified by the record id of its list record (the *lot id*).

Formats used in texts:

- token amounts: as `<amount>` in section 2.2 (`trade.rs: token_amount`);
- XMR amounts: piconero divided by 10^12, the integer part in decimal, then, only when
  the fraction is not zero, a `.` and the twelve-digit fraction with trailing zeros
  removed (`trade.rs: xmr_amount`);
- addresses: 95 characters on the reader's network;
- block heights: decimal.

### 3.1 State

The ledger keeps (`pool.rs: Lot`, `Reservation`, `Pool`):

- per lot: asset, ticker field, amount, price, seller (party), `until`, the lot note's
  id, a status (`open`, `sold`, `cancelled`), the list of its reservations in the order
  applied, and the claim that sold it;
- per reservation: buyer (party), the height it was applied at, `payBy`, the exact
  payment `pay`, and the reserve record's id;
- the set of payment transaction ids that have bought a lot;
- the claims of the current block that wait for settlement.

A reservation is **running** at `height` while `height <= payBy`.

### 3.2 List (op 0x01)

| # | Size | Field | Encoding |
|---|---|---|---|
| 1 | 4 | `magic` | `58 54 31 fe` |
| 2 | 1 | `op` | `0x01` |
| 3 | 32 | `asset` | asset id, canonical encoding |
| 4 | 4 | `until` | `u32` LE, last block height of the listing |
| 5 | 1 | `nIn` | 1 to 4 |
| 6 | 32 × `nIn` | `inputs` | note ids |
| 7 | 8 | `amount` | `u64` LE, units listed |
| 8 | 8 | `price` | `u64` LE, piconero for the whole lot |
| 9 | 1 | `tickerLen` | 1 to 12 |
| 10 | `tickerLen` | `ticker` | ASCII letters and digits |
| 11 | 65 | `seller` | party |
| 12 | 1 | `variant` | 0, 1 or 2 |
| 13 | 32 | `c` | signature scalar |
| 14 | 32 | `r` | signature scalar |

Signed text (`trade.rs: Body::text_as`):

```
XMR20 list: sell <amount> <name> for <price> XMR paid to <seller>; valid until block <until>; code <code>
```

`<name>` is the `ticker` field, or the label of an open token (section 4.7).

Checks, in order (`trade.rs: Trade::decode`, `Body::check`, `pool.rs: trade`):

1. Decoding: canonical `asset`; `nIn` 1 to 4; valid UTF-8 `ticker`; seller `kind` 0 or 1;
   no input twice; `amount > 0` and `price > 0`; `ticker` 1 to 12 ASCII letters or
   digits; `variant` 0 to 2; no trailing bytes.
2. The seller's spend key decompresses, is not the identity and is in the prime-order
   subgroup (`trade.rs: usable`).
3. `until >= height`.
4. Input resolution over `inputs` for `asset` (as section 2.7, check 14).
5. The owner of the inputs equals the seller's address owner.
6. The sum of the inputs is at least `amount`.
7. When `asset` is an open token's asset, `ticker` equals the token's ticker field.
8. The seller's signature verifies over the text.
9. The sum of the inputs minus `amount` fits in 64 bits.

Effect, with `rid` the record id (the lot id):

1. The inputs are spent.
2. Index 0: a note of `amount` owned by the **lot owner** of `rid` (below). This is the
   lot note.
3. Index 1: the remainder (inputs minus `amount`) to the seller's address owner; no
   note when it is 0.
4. A lot is stored under `rid` with status `open` and no reservation.

Lot owner (`trade.rs: lot_owner`): the decaf377 compression of
`hash_to_curve(f1, f2)`, computed as in section 1.1 from
`BLAKE2b-512("XMR20-TRADE-LOT-v1" 0x00 || lot id)`. No signing key is known for it, so
only cancel and claim move a lot note.

### 3.3 Cancel (op 0x02)

| # | Size | Field | Encoding |
|---|---|---|---|
| 1 | 4 | `magic` | `58 54 31 fe` |
| 2 | 1 | `op` | `0x02` |
| 3 | 32 | `lot` | lot id |
| 4 | 65 | `seller` | party |
| 5 | 1 | `variant` | 0, 1 or 2 |
| 6 | 32 | `c` | signature scalar |
| 7 | 32 | `r` | signature scalar |

The record is 167 bytes. Signed text:

```
XMR20 cancel listing <lot16>; from <seller>; code <code>
```

`<lot16>` is the first 16 hex characters of `hex(lot)`.

Checks, in order:

1. Decoding (seller `kind`, `variant`, exact length).
2. The lot exists.
3. The lot's status is `open`.
4. `seller` equals the lot's seller in all 65 bytes.
5. When the lot has a reservation, the latest one is no longer running:
   `height > payBy`.
6. The seller's signature verifies over the text.

Effect: the lot note is spent; one note of the lot's amount is created at index 0 of
the cancel record's id, owned by the seller's address owner; the lot's status becomes
`cancelled`.

### 3.4 Reserve (op 0x03)

| # | Size | Field | Encoding |
|---|---|---|---|
| 1 | 4 | `magic` | `58 54 31 fe` |
| 2 | 1 | `op` | `0x03` |
| 3 | 32 | `lot` | lot id |
| 4 | 4 | `payBy` | `u32` LE, last block height of the reservation |
| 5 | 65 | `buyer` | party |
| 6 | 1 | `variant` | 0, 1 or 2 |
| 7 | 32 | `c` | signature scalar |
| 8 | 32 | `r` | signature scalar |

The record is 171 bytes. Signed text, one line:

```
XMR20 reserve: buy <amount> <name> for <price> XMR; pay exactly <pay> XMR to <seller> by block <payBy>; tokens to <buyer>; code <code>
```

`<amount>`, `<price>` and `<seller>` are the lot's. `<name>` is the lot's stored ticker
field, or the label of an open token when the lot's asset is an open token's
(`pool.rs: terms`). `<pay>` is the payment of section 3.5 as an XMR amount.

Checks, in order:

1. Decoding.
2. The lot exists.
3. The lot's status is `open`.
4. `height <= until` of the lot.
5. The buyer's spend key is usable (as check 2 of section 3.2).
6. The buyer's address owner differs from the seller's address owner.
7. When the lot has a reservation, the latest one is no longer running:
   `height > ` its `payBy`.
8. `payBy > height`.
9. `payBy <= height + 30` (`trade.rs: MAX_RESERVE`).
10. `payBy <= until` of the lot.
11. The buyer's signature verifies over the text.
12. `pay` does not overflow 64 bits.

Effect: a reservation (buyer, `height`, `payBy`, `pay`, record id) is appended to the
lot. No note moves.

A reservation therefore runs for at most 30 blocks after the block that carries it.

### 3.5 The payment rule

For a reserve record with code `code` on a lot with price `price`
(`trade.rs: Body::pay_amount`):

```
tail = 1 + ( (code[0..4] read as a big-endian u32) mod 999999 )
pay  = price + tail
```

`tail` is 1 to 999,999 piconero. `code` is the code of the **reserve** body (it covers
the lot id, `payBy` and the buyer). A reservation is refused when the sum overflows.

A claim succeeds only when the payment transaction pays the seller's address **exactly**
`pay` piconero (section 3.7).

### 3.6 Claim (op 0x04)

| # | Size | Field | Encoding |
|---|---|---|---|
| 1 | 4 | `magic` | `58 54 31 fe` |
| 2 | 1 | `op` | `0x04` |
| 3 | 32 | `lot` | lot id |
| 4 | 32 | `paymentTxid` | id of the Monero payment transaction |
| 5 | 1 | `nKeys` | 1 to 17 (`trade.rs: MAX_KEYS`) |
| 6 | 32 × `nKeys` | `keys` | transaction secret keys |

A claim has no `variant`, `c` or `r` and no signature. Anyone may post it. The proof
of payment it carries is the payment transaction's id and its transaction secret keys:
`keys[0]` is the transaction's main secret key, `keys[1 + i]` is the additional secret
key of output `i` when the transaction has additional keys.

A claim is handled in two steps.

**Step 1, at the claim's place in the block** (`pool.rs: trade`), in order:

1. Decoding (`nKeys` 1 to 17, exact length).
2. The lot exists.
3. The lot's status is `open`.
4. The lot has at least one reservation.
5. `paymentTxid` is not in the set of used payments.

When these hold the claim is stored as waiting and the result is `pending`. Otherwise
it is `rejected`.

**Step 2, at the end of the block** (`pool.rs: resolve_claims`, `settle`): after every
carrier of the block has been applied, the waiting claims are settled in the order they
were applied, each against the state the previous one left. In order:

1. The claim was stored at this `height`.
2. The lot exists and its status is `open`.
3. The lot has a reservation; `R` is the **latest** one.
4. `paymentTxid` is not in the set of used payments.
5. The host supplied payment facts for `paymentTxid` (section 3.7).
6. The facts name the same transaction id.
7. The payment's block height is at most `height`.
8. The amount paid to the lot's seller, computed as in section 3.7, equals `R.pay`.

Effect: the lot note is spent; one note of the lot's amount is created at index 0 of
the **claim** record's id, owned by the address owner of `R`'s buyer; `paymentTxid` joins
the set of used payments; the lot's status becomes `sold`. The result of the claim is
`accepted`, otherwise `rejected`.

The settlement does not compare `height` with `R.payBy`: a claim for the latest
reservation settles after that reservation stopped running, as long as the lot is still
`open` and no later reservation was applied.

### 3.7 Payment facts and the amount paid

For each waiting claim the host supplies, from the Monero node it follows
(`trade.rs: PaymentFacts`, `PaymentOutput`, `pool.rs: claim_payments`):

| Field | Content |
|---|---|
| `txid` | the 32-byte id of the transaction, which the host has checked against the transaction it fetched |
| `height` | the height of the block that holds the transaction on the host's chain |
| `outputs` | for every output, in transaction order: the one-time output key (32 bytes), the 8-byte encrypted amount, the amount commitment (32 bytes) |

A transaction that is not in a block of the host's chain is not supplied, and the claim
is rejected. **Height bound:** the payment's `height` must be at most the claim's block
height. There is no lower bound.

Amount paid to an address with spend key `B` and view key `A`
(`trade.rs: paid_to`):

1. `A` and `B` decompress as Ed25519 points; otherwise the claim is rejected.
2. Every key in `keys` is a canonical scalar and not zero; otherwise the claim is
   rejected.
3. For each output `i` (from 0), try the scalars `keys[0]` and then, when present,
   `keys[1 + i]`. For a scalar `k`:
   - `D = 8·(k·A)`;
   - `s = Hs( compress(D) || varint(i) )`;
   - the output belongs to the address when `s·G + B` equals the output key; otherwise
     try the next scalar;
   - `amount` = the 8 encrypted-amount bytes XOR the first 8 bytes of
     `K("amount" || s)`, read as a `u64` LE (`s` as its 32-byte encoding);
   - `mask = Hs("commitment_mask" || s)`;
   - `mask·G + amount·H` must equal the output's commitment, with `H` the Monero amount
     generator
     `8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94`; when it does
     not, the claim is rejected;
   - `amount` is added to the total (overflow rejects the claim) and no further scalar
     is tried for this output.
4. The amount paid is the total over all outputs.

### 3.8 Lot lifetime

- A lot is created `open` by a list record and leaves that status only by a cancel
  (`cancelled`) or a settled claim (`sold`). Both are final.
- `until` is the last height at which a reservation is accepted, and it caps `payBy`.
- Passing `until` moves no note. After `until` the lot note stays with the lot owner
  until the seller cancels or a claim for the latest reservation settles.
- A later reservation replaces an earlier one as the latest once the earlier one has
  stopped running. A payment made for an earlier reservation does not satisfy a later
  one unless the two `pay` amounts are equal.

### 3.9 Activation gate

`XT1` applies when the reader's trade activation is set and `height` is at or above
its height (`pool.rs: apply_carrier`, `trade.rs: activation`). The mainnet height is
fixed when the reader is built (`trade.rs: MAINNET_ACTIVATION`, from
`XMR20_TRADES_MAINNET_ACTIVATION`). The network of the texts is the trade activation's
network.

---

## 4. Open tokens

An open token is announced by one record of the XMR721 ledger (the *open deploy*) and
minted with `XO1` records. No issuer key signs for it.

### 4.1 Which record is an open deploy

The open deploy is an XMR721 record with magic `4d 44 31 fe` (`MD1` `0xfe`) and
operation byte `0x08` (mint) of exactly this shape (`open.rs: Deploy::decode`,
`Deploy::body`):

| # | Size | Field | Required value |
|---|---|---|---|
| 1 | 4 | `magic` | `4d 44 31 fe` |
| 2 | 1 | `op` | `0x08` |
| 3 | 32 | `collection` | 32 zero bytes |
| 4 | 4 | `edition` | 4 zero bytes |
| 5 | 65 | `creator` | party; both keys usable (below) |
| 6 | 1 | `flags` | `0x00` |
| 7 | 1 | `nameLen` | `0x00` |
| 8 | 1 | `type` | `0x06` (`open.rs: TYPE_JSON`) |
| 9 | 2 | `contentLen` | `u16` LE |
| 10 | `contentLen` | `content` | an open deploy text (section 4.2) |
| 11 | 1 | `variant` | 0, 1 or 2 |
| 12 | 32 | `c` | signature scalar |
| 13 | 32 | `r` | signature scalar |

The **body** is fields 1 to 10.

Conditions (`open.rs: Deploy::decode`, `Deploy::verify_sig`):

1. The record is at most 1,000 bytes (`open.rs: MAX_INSCRIPTION`).
2. The fields have the required values; nothing follows `r`.
3. Each of the creator's two keys decompresses as an Ed25519 point, is not the
   identity, is in the prime-order subgroup, and is written in its canonical encoding
   (compressing the point gives the same 32 bytes) (`open.rs: usable`).
4. `content` is an open deploy text.
5. Encoding the decoded fields again gives the same bytes.
6. The creator's Monero message signature (section 1.4) verifies over

   ```
   XMR721 mint: one NFT in no collection; <n> bytes of type 6, SHA-256 <sha>; first owner <creator>; code <code>
   ```

   with `<n>` = `contentLen` in decimal, `<sha>` = `hex(H(content))`, `<creator>` = the
   creator's address on the reader's network, `<code>` = the first 32 hex characters of
   the token id (section 4.3) (`open.rs: Deploy::signed_text`).

Carriage (`transport.rs: unframe_of`, `wire_at`): the open magics are not among the
ledger's ordinary magics. A reader that follows open tokens reads a transaction's
`tx_extra` first for an ordinary record; when it carries none, it reads it for an `XO1`
or `MD1` record. An `MD1` record is taken only when the transaction public key is the
first field of `tx_extra`, an encrypted payment id (if any) comes before every chunk,
and the record is 5 to 1,000 bytes. `XO1` is taken in any field order the framing
allows.

An `MD1` record that does not meet every condition above is not a record of this ledger:
the result is `ignored`, not `rejected` (`pool.rs: apply_carrier`,
`open.rs: record_at`).

### 4.2 The deploy text

A JSON object written in exactly one way (`open.rs: Text::write`, `Text::read`):

```
{"p":"xmr20","op":"deploy","tick":<tick>[,"name":<name>],"max":"<max>","dec":"6","mode":"open"[,"col":"<col>"][,"lim":"<lim>"][,"pre":"<pre>"]}
```

Fields appear in this order with no whitespace; bracketed parts are present only when
the field is.

| Field | Presence | Value |
|---|---|---|
| `p` | required | `"xmr20"` |
| `op` | required | `"deploy"` |
| `tick` | required | readable text of 1 to 32 characters (`open.rs: MAX_TICK`) |
| `name` | optional | readable text of 1 to 64 characters (`open.rs: MAX_NAME`) |
| `max` | required | a whole number, 1 to 18,446,744,073,709 (`open.rs: MAX_WHOLE`) |
| `dec` | required | `"6"` |
| `mode` | required | `"open"` |
| `col` | optional | 64 characters, each `0`–`9` or `a`–`f` |
| `lim` | see rule 4 | a whole number, 1 to `max` |
| `pre` | optional | a whole number, 1 to `max` |

Rules:

1. The text is 1 to 600 bytes of UTF-8 (`open.rs: MAX_TEXT`), parses as a JSON object,
   holds no key other than the ten above, and every value is a JSON string.
2. A *whole number* is 1 to 14 ASCII digits with no leading zero, of value 1 to
   `MAX_WHOLE` (`open.rs: whole`). `max`, `lim` and `pre` count whole tokens; one token
   is 1,000,000 units (`open.rs: UNIT`).
3. *Readable* text (`open.rs: readable`) has 1 to the stated number of Unicode scalar
   values, does not begin or end with U+0020, and holds no code point of the fixed
   list `open.rs: HIDDEN`.
4. `lim` is present exactly when something is left to mint: present when `pre` is
   absent or below `max`; absent when `pre` equals `max`.
5. `pre` is never `"0"`; a creator who takes nothing omits it.
6. `tick` and `name` are written as JSON strings with `"` as `\"` and `\` as `\\`; every
   other character they may hold is written as its UTF-8 bytes.
7. The text is a deploy text only when writing the parsed fields again by this section
   gives the identical bytes.

`col` is carried and not interpreted by the token ledger.

### 4.3 Token id and asset id

- **Token id** = `H("MORDINALS-RECORD-v1" 0x00 || L || body)` where `L` is the 32-byte
  domain of the XMR721 ledger whose inscriptions announce tokens and `body` is fields
  1 to 10 of section 4.1 (`open.rs: Deploy::id`, `ID_TAG`). This is the record's id on
  the XMR721 ledger. The signature and `variant` are not part of it.
- **Asset id** = the asset id (part A) of the base denomination string `uxmr20open`
  followed by the 64 hex characters of the token id (`open.rs: asset_for_open`).

### 4.4 The XMR721 ledger domain

`L` enters the token id and, through its code, the deploy's signed text. It is part of
the reader's open-token activation (`open.rs: Activation`):

- mainnet: `L = H("XMR721 mainnet ledger 1")`, the 23 ASCII bytes with no terminator
  (`open.rs: mainnet_inscriptions`);
- `stagenet` and `offline-fakechain`: a 32-byte value given to the reader; without it
  open tokens are off (`open.rs: activation`, `activation_from_env`).

`L` is distinct from the token ledger's own domain, which the codes of `XW1` and `XT1`
use. A deploy signed for another XMR721 ledger has another id and its signature does not
verify under this `L`.

### 4.5 Applying a deploy

For an `MD1` record that is an open deploy by section 4.1, in order
(`pool.rs: open_deploy`):

1. No open token has this token id.
2. No open token has a token id with the same first 8 bytes (the 16 hex characters a
   signed text shows, `open.rs: ID_SHOWN`, `shown_range`).
3. The asset id has no entry in the ledger's per-asset minted totals and is not an open
   token's asset.

A deploy that fails one of these is `rejected`.

Effect:

1. With `pre` the creator's share in units (`pre` × 1,000,000, or 0 when absent): when
   it is above 0, one note of that amount is created with id
   `note_id(token id, 0)`, owned by the address owner (section 1.1) of the creator's
   address. The note id is derived from the **token id**, not from the SHA-256 of the
   record bytes.
2. The asset's minted total is created and increased by `pre` units.
3. The token is stored with its id, deploy text, creator, the carrier's height and
   transaction id, `left = max × 1,000,000 − pre × 1,000,000`, a mint count of 0, and a
   number: its position, from 1, among the open tokens in the order they were applied.

Nothing else is derived from the XMR721 ledger: whether a record is an open deploy
depends on its bytes, its carriage, its signature, its block and the open tokens applied
before it.

### 4.6 XO1 — open mint

Magic: `58 4f 31 fe` (`XO1` `0xfe`) (`open.rs: MAGIC_MINT`). The record is exactly 84
bytes (`open.rs: Mint::BYTES`).

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 4 | `magic` | `58 4f 31 fe` |
| 4 | 32 | `asset` | asset id, canonical encoding |
| 36 | 8 | `amount` | `u64` LE, units requested |
| 44 | 32 | `owner` | owner key that receives the note |
| 76 | 8 | `salt` | any 8 bytes |

There is no signature. Whoever gets the record into a block mints to `owner`.

Checks, in order (`open.rs: Mint::decode`, `pool.rs: open_mint`):

1. The record is 84 bytes with the magic.
2. `asset` is a canonical asset id.
3. `amount > 0`.
4. `owner` is a valid decaf377-rdsa verification key encoding.
5. `asset` is the asset of an open token already applied.
6. The token's `left` is above 0.
7. `amount` is at most the token's `lim` in units (`lim` × 1,000,000; 0 when the text
   has no `lim`).
8. With `rid` the record id: `note_id(rid, 0)` is neither an existing note nor a spent
   note.

Effect:

1. `credited = min(amount, left)`.
2. One note of `credited` units of `asset` is created with id `note_id(rid, 0)`, owned
   by `owner`.
3. The asset's minted total increases by `credited`; `left` decreases by `credited`;
   the token's mint count increases by 1.

**Supply cap.** `left` starts at `max − pre` in units, only mints decrease it, a mint is
refused when it is 0, and the last mint is cut down to what is left. The total ever
created for an open token is `pre` plus the applied mints and never exceeds `max`.

**Replay.** The record id is the hash of the 84 bytes, so a second carrier of the same
bytes is refused by check 8. Minting again for the same owner and amount needs another
`salt`.

An `XO1` applied before its token's deploy is `rejected` (check 5); the same bytes
carried again after the deploy mint.

### 4.7 How records name an open token

For a record whose `asset` is an open token's (`pool.rs: open_label`,
`open.rs: ticker_field`, `label`):

- **Ticker field.** The `ticker` field of an `XW1` or an `XT1` list record must equal the
  deploy's `tick` when `tick` is 1 to 12 bytes, each an ASCII letter or digit; otherwise
  it must equal the five characters `TOKEN`. Any other value rejects the record.
- **Label.** In the signed texts of `XW1`, `XT1` list and `XT1` reserve the token is
  named

  ```
  <ticker field> (token <first 16 hex characters of the token id>)
  ```

  in place of the bare ticker field. Example: `PEPE (token 3f9a1c0be27d4a66)`.

For every other asset the texts name the record's `ticker` field as written.

### 4.8 Interaction with other records

- **`XC1`** for the asset of an open token is `rejected` (`pool.rs: credit`). The check
  comes after the credit's binding and signature checks.
- An earlier accepted `XC1` for an asset id makes a later deploy of that asset
  `rejected` (section 4.5, check 3).
- `XP1`, `XR1`, `XW1`, `XT1` and the records of part B treat an open token's asset as
  any other asset; only the naming rules of section 4.7 differ.
- A burn (`XR1`) reduces the outstanding supply. It does not increase `left`.

### 4.9 Activation gate

Open deploys and `XO1` apply when the reader's open-token activation is set and
`height` is at or above its height (`pool.rs: apply_carrier`, `open.rs: record_at`).
Below it both are `ignored`, and a deploy record carried there makes no token; the same
record carried again at or above the height is the token's deploy. The mainnet height is
fixed when the reader is built (`open.rs: MAINNET_ACTIVATION`, from
`XMR20_OPEN_TOKENS_MAINNET_ACTIVATION`).

---

## 5. Constants

| Value | Name in the code | Use |
|---|---|---|
| `58 57 31 fe` | `address.rs: MAGIC_MOVE` | `XW1` magic |
| `58 54 31 fe` | `trade.rs: MAGIC_TRADE` | `XT1` magic |
| `58 4f 31 fe` | `open.rs: MAGIC_MINT` | `XO1` magic |
| `4d 44 31 fe` | `open.rs: MAGIC_INSCRIPTION` | `MD1` magic |
| `XMR20-ADDRESS-OWNER-v1` + `0x00` | `address.rs: OWNER_LABEL` | address owner hash |
| `XMR20-ADDRESS-MOVE-v1` + `0x00` | `address.rs: MOVE_LABEL` | `XW1` code |
| `XMR20-TRADE-v1` + `0x00` | `trade.rs: TRADE_LABEL` | `XT1` code |
| `XMR20-TRADE-LOT-v1` + `0x00` | `trade.rs: LOT_OWNER_LABEL` | lot owner hash |
| `XMR20-OPEN-OWNER-v1` + `0x00` | literal in `address.rs: verify_certificate` | recipient certificate |
| `MoneroMessageSignature` + `0x00` | literal in `address.rs: message_hash` | message hash |
| `MORDINALS-RECORD-v1` + `0x00` | `open.rs: ID_TAG` | token id |
| `XMR721 mainnet ledger 1` | literal in `open.rs: mainnet_inscriptions` | mainnet XMR721 domain preimage |
| `uxmr20open` | literal in `open.rs: asset_for_open` | denomination prefix |
| 4 | `address.rs: MAX_INPUTS` | most inputs of an `XW1` |
| 3 | `address.rs: MAX_RECIPIENTS` | most recipients of an `XW1` |
| 12 | `address.rs: MAX_TICKER`, `trade.rs: MAX_TICKER` | most bytes of a ticker field |
| 6 | `address.rs: DECIMALS` | decimals of every token amount in texts |
| 1 | `address.rs: FLAG_FEE_IN_XMR` | `XW1` flag bit 0 |
| `""`, `"\n"`, `"\r\n"` | `address.rs: SUFFIX` | text endings by `variant` |
| 18 / 42 | `address.rs: MAINNET` | mainnet address prefixes (standard / subaddress) |
| 24 / 36 | `address.rs: STAGENET` | stagenet address prefixes |
| 53 / 63 | `address.rs: TESTNET` | testnet address prefixes |
| 95 | literal in `address.rs: Address::decode` | characters of a text address |
| 1, 2, 3, 4 | `trade.rs: OP_LIST`, `OP_CANCEL`, `OP_RESERVE`, `OP_CLAIM` | `XT1` operations |
| 30 | `trade.rs: MAX_RESERVE` | most blocks from a reservation to its `payBy` |
| 4 | `trade.rs: MAX_INPUTS` | most inputs of a list |
| 17 | `trade.rs: MAX_KEYS` | most transaction keys of a claim |
| 999,999 | literal in `trade.rs: Body::pay_amount` | modulus of the payment tail |
| 1,000,000 | literal in `trade.rs: token_amount` | units per token in texts |
| 1,000,000,000,000 | literal in `trade.rs: xmr_amount` | piconero per XMR in texts |
| 16 (bytes) | literals in `address.rs: Move::code`, `trade.rs: Body::code` | length of a code |
| 16 (hex characters) | literal in `trade.rs: Body::text_as` | lot id shown in a cancel text |
| `8b65…1f94` (section 3.7) | literal in `trade.rs: amount_h` | Monero amount generator `H` |
| 8 | `open.rs: INSCRIPTION_MINT` | `MD1` mint operation |
| 6 | `open.rs: TYPE_JSON` | content type of a deploy |
| 1,000 | `open.rs: MAX_INSCRIPTION` | most bytes of an `MD1` record |
| 600 | `open.rs: MAX_TEXT` | most bytes of a deploy text |
| 1,000,000 | `open.rs: UNIT` | units per whole token |
| 18,446,744,073,709 | `open.rs: MAX_WHOLE` | largest `max`, `lim`, `pre` (`u64::MAX / UNIT`) |
| 14 | literal in `open.rs: whole` | most digits of a whole number |
| 32 | `open.rs: MAX_TICK` | most characters of `tick` |
| 64 | `open.rs: MAX_NAME` | most characters of `name` |
| 16 | `open.rs: ID_SHOWN` | hex characters of a token id in a label |
| 32 (hex characters) | literal in `open.rs: Deploy::signed_text` | code shown in the deploy's signed text |
| 84 | `open.rs: Mint::BYTES` | size of an `XO1` |
| `TOKEN` | literal in `open.rs: ticker_field` | ticker field of a token whose `tick` does not fit |
| 10 names | `open.rs: FIELDS` | keys a deploy text may hold |
| 47 ranges | `open.rs: HIDDEN` | code points refused in `tick` and `name` |
| 1,060 / 254 / 1,011 | `transport.rs: EXTRA_LIMIT`, `CHUNK`, `MAX_RECORD` | framing limits (part A) |

---

## 6. Disagreements between OPEN.md, open.mjs and the core

No disagreement was found in the deploy text rules (fields, order, limits, the refused
code points, the whole-number form), in the record shape, in the token id, in the signed
text of the deploy, in the label and ticker-field rules, or in the `XO1` layout and its
checks. The points below differ or are stated differently.

1. **A deploy refused because its asset is in use.** `open.mjs: projectOpen` cannot see
   the token ledger and lists such a deploy as a token; it also keeps the first 16 hex
   characters of its id, so a later deploy whose id starts the same way is refused by
   `projectOpen` but applied by the core (`pool.rs: open_deploy` records the id of an
   applied deploy only). `open.mjs` states this in a comment and OPEN.md section 10
   names the first half; the second half (a token in the core that the list refuses) is
   stated only in the `open.mjs` comment.
2. **"Has supply" against "has a minted total".** OPEN.md (section 4 rule 8, section 8)
   refuses a deploy when its asset "already has supply". The core refuses it when the
   asset has an entry in the minted totals (`pool.rs: open_deploy`), which stays after
   every credited unit has been burned.
3. **Token numbers.** OPEN.md section 4 says an open deploy takes the next token number
   after the tokens before it in ledger order, referring to the numbering of all
   tokens. The core numbers open tokens among themselves from 1
   (`pool.rs: open_deploy`). `open.mjs: projectOpen` gives no number. Numbers are not
   used by any record.
4. **A second deploy with the same id.** OPEN.md section 4 rule 5 and `projectOpen` pass
   over it; the core answers `rejected`. The ledger state is the same; the result
   reported for the carrier and the reader's rejected count differ from a silent pass.
5. **Status wording.** OPEN.md states the opening block 3,812,510 for mainnet. The core
   holds no mainnet height in its source; it is supplied at build time, and the header
   of `open.rs` still describes the rules as a draft that is off until activation.
6. **Readable text.** `token.mjs: readable` refuses any leading or trailing white space
   by `trim()` and refuses ill-formed strings; `open.rs: readable` refuses a leading or
   trailing U+0020 only. Every other white-space character `trim()` removes is in the
   refused list, and text decoded from UTF-8 is well formed, so the two accept the same
   texts.

---
