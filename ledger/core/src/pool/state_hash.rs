//! State hash: one SHA-256 over the whole ledger state, so that two readers can compare who owns what at a block, not only
//! which transactions they read. The byte layout below is written by hand and is part of what readers compare: a change to it
//! changes every hash (the golden tests at the end of this file catch that). README.md, section "State hash", describes it in
//! words; the two must say the same.
//!
//!   section hash  = SHA-256( "XMR20-STATE-SECTION-1" 0x00 || text(name) || u64(number of items) || the items, in order )
//!   state hash    = SHA-256( "XMR20-STATE-1" 0x00 || the 32-byte section hashes, in the order of `SECTIONS` )
//! The two tags differ, so the bytes hashed for a section are never the bytes hashed for a state.
//!
//!   u8 / bool     one byte (bool: 0 or 1)
//!   u64           8 bytes, little-endian (every count and every length is a u64)
//!   u128          16 bytes, little-endian
//!   bytes32       the 32 bytes as they are
//!   text / bytes  u64 length, then the bytes (text: UTF-8). Hashes, keys and ids that the state keeps as text are lowercase
//!                 hexadecimal text and are written as text, not decoded
//!   txid          text, with the ASCII letters A-F written as a-f. A transaction id is the one text the pool takes from
//!                 its host as it is; every other hexadecimal text is made by the core (`hex::encode`, lowercase). So a host
//!                 that hands over transaction ids in capitals has the same state hash. Fields: the `txid` of a note, a
//!                 credit, a redemption, a stored part, a lot, a lot's claim, a waiting claim and an open token, and
//!                 `txid_a`, `txid_b` of a completed operation
//!   option        one byte 0 (absent) or 1 (present), then the value when present
//!   address       u8 (1 for a subaddress, else 0), spend key bytes32, view key bytes32
//!   maps, sets    by ascending key, compared byte by byte (for a text key: its UTF-8 bytes); lists in their stored order
//!
//! Covered: everything that decides how a later record is judged or who owns what (the fields of each section are listed at
//! its writer below). Not covered, and why:
//!   - `market_from`, `address_moves`, `trades`, `open`: the blocks from which rules apply. They are settings a reader starts
//!     with (constants of the rules on mainnet), not something records change;
//!   - `accepted`, `rejected`: statistics. No rule reads them, and they count what a reader was shown, which is not the same for
//!     every reader (a wallet that starts from a record list is never shown what a full reader refuses);
//!   - `pending_records`: the number of stored parts, which the two pending sections already fix;
//!   - the inside of the commitment tree: its root is covered, and so is every payload that was inserted, in order.
use sha2::{Digest, Sha256};

use super::{LotStatus, Pool};
use crate::address::Address;

pub const STATE_TAG: &[u8] = b"XMR20-STATE-1\0";
pub const SECTION_TAG: &[u8] = b"XMR20-STATE-SECTION-1\0";
/// The sections, in the order the state hash takes them.
pub const SECTIONS: [&str; 21] = [
    "domain", "shielded-root", "nullifiers", "roots", "history", "notes", "spent-notes", "minted", "burned", "shielded-in", "shielded-out", "credits", "redemptions", "pending-a", "pending-b", "completed", "lots", "used-payments", "pending-claims", "open-tokens",
    "open-ids",
];

/// One named part of the state with its own hash, so that two readers whose state hashes differ can see where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateSection {
    pub name: &'static str,
    pub count: u64,
    pub hash: [u8; 32],
}

/// Writes one section: the tag, the name and the item count first, then whatever the caller adds.
struct Section {
    name: &'static str,
    count: u64,
    h: Sha256,
    /// The bytes hashed, kept only when test vectors are written (`Pool::state_preimages`).
    kept: Option<Vec<u8>>,
}
impl Section {
    fn new(name: &'static str, count: usize, keep: bool) -> Self {
        let mut s = Self { name, count: count as u64, h: Sha256::new(), kept: keep.then(Vec::new) };
        s.put(SECTION_TAG);
        s.text(name);
        s.u64(count as u64);
        s
    }
    fn put(&mut self, b: &[u8]) {
        self.h.update(b);
        if let Some(k) = &mut self.kept {
            k.extend_from_slice(b);
        }
    }
    fn u8(&mut self, v: u8) {
        self.put(&[v]);
    }
    fn u64(&mut self, v: u64) {
        self.put(&v.to_le_bytes());
    }
    fn u128(&mut self, v: u128) {
        self.put(&v.to_le_bytes());
    }
    fn b32(&mut self, v: &[u8; 32]) {
        self.put(v);
    }
    fn bytes(&mut self, v: &[u8]) {
        self.u64(v.len() as u64);
        self.put(v);
    }
    fn text(&mut self, v: &str) {
        self.bytes(v.as_bytes());
    }
    /// A transaction id as the host gave it, in lowercase (see the module note).
    fn txid(&mut self, v: &str) {
        self.text(&v.to_ascii_lowercase());
    }
    fn opt_text(&mut self, v: &Option<String>) {
        match v {
            None => self.u8(0),
            Some(t) => {
                self.u8(1);
                self.text(t);
            }
        }
    }
    fn opt_u64(&mut self, v: &Option<u64>) {
        match v {
            None => self.u8(0),
            Some(n) => {
                self.u8(1);
                self.u64(*n);
            }
        }
    }
    fn address(&mut self, a: &Address) {
        self.u8(u8::from(a.sub));
        self.b32(&a.spend);
        self.b32(&a.view);
    }
    fn done(self) -> (StateSection, Vec<u8>) {
        (StateSection { name: self.name, count: self.count, hash: self.h.finalize().into() }, self.kept.unwrap_or_default())
    }
}

/// The state hash of a list of sections (as `Pool::state_sections` returns them).
pub fn state_total(sections: &[StateSection]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(STATE_TAG);
    for s in sections {
        h.update(s.hash);
    }
    h.finalize().into()
}

impl Pool {
    /// The hash of the whole ledger state (see the module note). Two pools that were given the same records in the same
    /// blocks have the same hash; it reads the state and changes nothing.
    pub fn state_hash(&self) -> [u8; 32] {
        state_total(&self.state_sections())
    }
    /// The sections of the state hash, in order, each with its item count and its own hash.
    pub fn state_sections(&self) -> Vec<StateSection> {
        self.write_state(false).into_iter().map(|(s, _)| s).collect()
    }
    /// The sections, each with the bytes its hash was taken over (for test vectors; this holds the whole state in memory).
    pub fn state_preimages(&self) -> Vec<(StateSection, Vec<u8>)> {
        self.write_state(true)
    }
    fn write_state(&self, keep: bool) -> Vec<(StateSection, Vec<u8>)> {
        let mut out = Vec::with_capacity(SECTIONS.len());
        // domain: the ledger domain (one item)
        let mut s = Section::new("domain", 1, keep);
        s.b32(&self.ledger.domain);
        out.push(s.done());
        // shielded-root: the root of the commitment tree (one item)
        let mut s = Section::new("shielded-root", 1, keep);
        s.b32(&crate::ledger::root_bytes(self.ledger.root()));
        out.push(s.done());
        // nullifiers: every spent shielded nullifier
        let mut s = Section::new("nullifiers", self.ledger.nullifiers.len(), keep);
        for n in &self.ledger.nullifiers {
            s.b32(n);
        }
        out.push(s.done());
        // roots: every root the commitment tree ever had
        let mut s = Section::new("roots", self.ledger.roots.len(), keep);
        for r in &self.ledger.roots {
            s.b32(r);
        }
        out.push(s.done());
        // history: every shielded payload in the order it was inserted; one item = its 176 bytes as in a record
        // (commitment 32, ephemeral key 32, ciphertext 112), without a length
        let mut s = Section::new("history", self.ledger.history.len(), keep);
        for p in &self.ledger.history {
            s.b32(&p.note_commitment.0.to_bytes());
            s.b32(&p.ephemeral_key.0);
            s.put(&p.ciphertext);
        }
        out.push(s.done());
        // notes: note id, asset, amount, owner, height, txid, anchor
        let mut s = Section::new("notes", self.notes.len(), keep);
        for (id, n) in &self.notes {
            s.b32(id);
            s.text(&n.asset);
            s.u64(n.amount);
            s.text(&n.owner);
            s.u64(n.height);
            s.txid(&n.txid);
            s.opt_text(&n.anchor);
        }
        out.push(s.done());
        // spent-notes: the id of every note that was spent
        let mut s = Section::new("spent-notes", self.spent_notes.len(), keep);
        for id in &self.spent_notes {
            s.b32(id);
        }
        out.push(s.done());
        // minted, burned, shielded-in, shielded-out: asset, amount
        for (name, map) in [("minted", &self.minted), ("burned", &self.burned), ("shielded-in", &self.shielded_in), ("shielded-out", &self.shielded_out)] {
            let mut s = Section::new(name, map.len(), keep);
            for (asset, v) in map {
                s.text(asset);
                s.u128(*v);
            }
            out.push(s.done());
        }
        // credits: binding, kind, asset, amount, owner, txid, height
        let mut s = Section::new("credits", self.credits.len(), keep);
        for (binding, c) in &self.credits {
            s.b32(binding);
            s.u8(c.kind);
            s.text(&c.asset);
            s.u64(c.amount);
            s.text(&c.owner);
            s.txid(&c.txid);
            s.u64(c.height);
        }
        out.push(s.done());
        // redemptions: carrier transaction id (the key), asset, amount, binding, owner, txid, height
        let mut s = Section::new("redemptions", self.redemptions.len(), keep);
        for (key, r) in &self.redemptions {
            s.b32(key);
            s.text(&r.asset);
            s.u64(r.amount);
            s.text(&r.binding);
            s.text(&r.owner);
            s.txid(&r.txid);
            s.u64(r.height);
        }
        out.push(s.done());
        // pending-a: one item per operation id: the id, the number of stored parts, then each part in the order it arrived:
        // the part's record bytes (a decoded part encodes back to exactly the bytes it came in), their SHA-256, txid, height
        let mut s = Section::new("pending-a", self.pending_a.len(), keep);
        for (op, parts) in &self.pending_a {
            s.b32(op);
            s.u64(parts.len() as u64);
            for p in parts {
                s.bytes(&p.part.encode());
                s.b32(&p.hash);
                s.txid(&p.txid);
                s.u64(p.height);
            }
        }
        out.push(s.done());
        // pending-b: the same for the second parts
        let mut s = Section::new("pending-b", self.pending_b.len(), keep);
        for (op, parts) in &self.pending_b {
            s.b32(op);
            s.u64(parts.len() as u64);
            for p in parts {
                s.bytes(&p.part.encode());
                s.b32(&p.hash);
                s.txid(&p.txid);
                s.u64(p.height);
            }
        }
        out.push(s.done());
        // completed: operation id, hash of part A, hash of part B, txid of A, txid of B, height
        let mut s = Section::new("completed", self.completed.len(), keep);
        for (op, c) in &self.completed {
            s.b32(op);
            s.text(&c.part_a);
            s.text(&c.part_b);
            s.txid(&c.txid_a);
            s.txid(&c.txid_b);
            s.u64(c.height);
        }
        out.push(s.done());
        // lots: lot id, asset, ticker, amount, price, seller, until, height, txid, note id, status (0 open, 1 sold,
        // 2 cancelled), the number of reservations and each one (buyer, height, pay by, pay, record id), the claim as an
        // option (buyer, payment, payment height, height, txid)
        let mut s = Section::new("lots", self.lots.len(), keep);
        for (id, l) in &self.lots {
            s.b32(id);
            s.text(&l.asset);
            s.text(&l.ticker);
            s.u64(l.amount);
            s.u64(l.price);
            s.address(&l.seller);
            s.u64(l.until);
            s.u64(l.height);
            s.txid(&l.txid);
            s.b32(&l.note);
            s.u8(match l.status {
                LotStatus::Open => 0,
                LotStatus::Sold => 1,
                LotStatus::Cancelled => 2,
            });
            s.u64(l.reservations.len() as u64);
            for r in &l.reservations {
                s.address(&r.buyer);
                s.u64(r.height);
                s.u64(r.pay_by);
                s.u64(r.pay);
                s.b32(&r.record);
            }
            match &l.claim {
                None => s.u8(0),
                Some(c) => {
                    s.u8(1);
                    s.address(&c.buyer);
                    s.b32(&c.payment);
                    s.u64(c.payment_height);
                    s.u64(c.height);
                    s.txid(&c.txid);
                }
            }
        }
        out.push(s.done());
        // used-payments: the id of every payment transaction that bought a lot
        let mut s = Section::new("used-payments", self.used_payments.len(), keep);
        for p in &self.used_payments {
            s.b32(p);
        }
        out.push(s.done());
        // pending-claims: record bytes, txid, height; in the order they arrived (empty at the end of every block)
        let mut s = Section::new("pending-claims", self.pending_claims.len(), keep);
        for c in &self.pending_claims {
            s.bytes(&c.wire);
            s.txid(&c.txid);
            s.u64(c.height);
        }
        out.push(s.done());
        // open-tokens: asset (the key), token id, number, the deploy text (tick, name, max, col, lim, pre), creator, left,
        // mints, height, txid
        let mut s = Section::new("open-tokens", self.open_tokens.len(), keep);
        for (asset, t) in &self.open_tokens {
            s.text(asset);
            s.b32(&t.id);
            s.u64(t.number);
            s.text(&t.text.tick);
            s.opt_text(&t.text.name);
            s.u64(t.text.max);
            s.opt_text(&t.text.col);
            s.opt_u64(&t.text.lim);
            s.opt_u64(&t.text.pre);
            s.address(&t.creator);
            s.u64(t.left);
            s.u64(t.mints);
            s.u64(t.height);
            s.txid(&t.txid);
        }
        out.push(s.done());
        // open-ids: token id, asset
        let mut s = Section::new("open-ids", self.open_ids.len(), keep);
        for (id, asset) in &self.open_ids {
            s.b32(id);
            s.text(asset);
        }
        out.push(s.done());
        debug_assert!(out.iter().map(|(s, _)| s.name).eq(SECTIONS));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Claimed, Completed, Credit, Lot, OpenToken, PendingClaim, PublicNote, Redemption, Reservation, StoredA, StoredB};
    use super::*;
    use crate::penumbra::{ShieldedInput, ShieldedOutput, PROOF_BYTES};
    use crate::private2::{PartA, PartB};
    use crate::{open, Payload};
    use decaf377::Fq;
    use decaf377_rdsa::{SpendAuth, VerificationKey};
    use penumbra_sdk_asset::balance::Commitment;
    use penumbra_sdk_sct::Nullifier;
    use penumbra_sdk_tct::{StateCommitment, Witness};
    use std::collections::BTreeSet;

    fn hx(n: u8) -> String {
        hex::encode([n; 32])
    }
    fn addr(n: u8, sub: bool) -> Address {
        Address { sub, spend: [n; 32], view: [n + 1; 32] }
    }
    fn payload(n: u8) -> Payload {
        Payload { note_commitment: StateCommitment(Fq::from(u64::from(n))), ephemeral_key: decaf377_ka::Public([n; 32]), ciphertext: [n; 112] }
    }
    /// A fixed state with something in every section and every optional field both present and absent somewhere.
    fn sample() -> Pool {
        let mut p = Pool::new([0x11; 32]);
        let empty_root = p.ledger.root();
        p.ledger.commit([[0x21; 32], [0x20; 32]], &[&payload(5), &payload(6)]).unwrap();
        p.notes.insert([0x31; 32], PublicNote { asset: hx(0xa1), amount: 1_000_000, owner: hx(0xb1), height: 100, txid: hx(0xc1), anchor: None });
        p.notes.insert([0x32; 32], PublicNote { asset: hx(0xa1), amount: 7, owner: hx(0xb2), height: 101, txid: hx(0xc2), anchor: Some(hx(0xd1)) });
        p.spent_notes.insert([0x33; 32]);
        p.minted.insert(hx(0xa1), (1u128 << 70) + 3);
        p.minted.insert(hx(0xa2), 21_000_000);
        p.burned.insert(hx(0xa1), 9);
        p.shielded_in.insert(hx(0xa1), 500);
        p.shielded_out.insert(hx(0xa1), 200);
        p.credits.insert([0x41; 32], Credit { kind: 1, asset: hx(0xa1), amount: 1_000_007, owner: hx(0xb1), txid: hx(0xc1), height: 100 });
        p.redemptions.insert([0x51; 32], Redemption { asset: hx(0xa1), amount: 9, binding: hx(0x52), owner: hx(0xb1), txid: hx(0x51), height: 102 });
        let rk = VerificationKey::<SpendAuth>::try_from(decaf377::Element::GENERATOR.vartime_compress().0).unwrap();
        let input = |n: u64| ShieldedInput { cv: Commitment(decaf377::Element::IDENTITY), nf: Nullifier(Fq::from(n)), proof: [n as u8; PROOF_BYTES] };
        let a = PartA { op: [0x61; 32], anchor: empty_root, inputs: vec![input(1), input(2), input(3)], rk, auth: [9u8; 64].into() };
        let output = |n: u8| ShieldedOutput { cv: Commitment(decaf377::Element::IDENTITY), payload: payload(n), proof: [n; PROOF_BYTES] };
        let b = PartB { op: [0x62; 32], outputs: vec![output(7), output(8)], binding: [8u8; 64].into() };
        p.pending_a.insert(a.op, vec![StoredA { hash: crate::hash(&a.encode()), part: a, txid: hx(0xc3), height: 103 }]);
        p.pending_b.insert(b.op, vec![StoredB { hash: crate::hash(&b.encode()), part: b, txid: hx(0xc4), height: 104 }]);
        p.pending_records = 2;
        p.completed.insert([0x63; 32], Completed { part_a: hx(0x64), part_b: hx(0x65), txid_a: hx(0xc5), txid_b: hx(0xc6), height: 105 });
        p.lots.insert(
            [0x71; 32],
            Lot {
                asset: hx(0xa1),
                ticker: "XMR20".into(),
                amount: 250,
                price: 300_000_000_000,
                seller: addr(0x72, false),
                until: 900,
                height: 106,
                txid: hx(0xc7),
                note: [0x73; 32],
                status: LotStatus::Sold,
                reservations: vec![Reservation { buyer: addr(0x74, true), height: 107, pay_by: 117, pay: 300_000_000_123, record: [0x75; 32] }],
                claim: Some(Claimed { buyer: addr(0x74, true), payment: [0x81; 32], payment_height: 108, height: 109, txid: hx(0xc8) }),
            },
        );
        p.lots.insert([0x76; 32], Lot { asset: hx(0xa2), ticker: "PEPE".into(), amount: 5, price: 1, seller: addr(0x77, true), until: 950, height: 110, txid: hx(0xc9), note: [0x78; 32], status: LotStatus::Open, reservations: vec![], claim: None });
        p.used_payments.insert([0x81; 32]);
        p.pending_claims.push(PendingClaim { wire: vec![1, 2, 3], txid: hx(0xca), height: 111 });
        p.open_tokens.insert(
            hx(0xa2),
            OpenToken { id: [0x91; 32], number: 1, text: open::Text { tick: "PEPE".into(), name: Some("P\u{e9}p\u{e9}".into()), max: 21_000_000, col: None, lim: Some(1000), pre: None }, creator: addr(0x92, false), left: 20_999_000, mints: 3, height: 112, txid: hx(0xcb) },
        );
        p.open_tokens.insert(hx(0xa3), OpenToken { id: [0x94; 32], number: 2, text: open::Text { tick: "B".into(), name: None, max: 1, col: Some("c".into()), lim: None, pre: Some(1) }, creator: addr(0x95, true), left: 0, mints: 0, height: 113, txid: hx(0xcc) });
        p.open_ids.insert([0x91; 32], hx(0xa2));
        p.open_ids.insert([0x94; 32], hx(0xa3));
        p
    }
    fn total_hex(p: &Pool) -> String {
        hex::encode(p.state_hash())
    }
    /// The names of the sections whose hashes differ between two pools.
    fn differing(a: &Pool, b: &Pool) -> BTreeSet<&'static str> {
        a.state_sections().into_iter().zip(b.state_sections()).filter(|(x, y)| x != y).map(|(x, _)| x.name).collect()
    }

    /// The test vectors of the README: the fixed state above and the empty state, each section with the bytes hashed and its
    /// hash. Written by the test below when XMR20_WRITE_STATE_FIXTURE=1, compared with the code otherwise.
    const FIXTURE: &str = include_str!("../state_hash_fixture.json");
    fn vectors(p: &Pool) -> serde_json::Value {
        let pre = p.state_preimages();
        // each hash again from its bytes, and the total from the hashes, without the writer
        let mut total = STATE_TAG.to_vec();
        for (s, bytes) in &pre {
            assert!(bytes.starts_with(SECTION_TAG));
            assert_eq!(crate::hash(bytes), s.hash, "{}", s.name);
            total.extend(s.hash);
        }
        assert_eq!(crate::hash(&total), p.state_hash());
        assert_eq!(pre.iter().map(|(s, _)| s.clone()).collect::<Vec<_>>(), p.state_sections());
        serde_json::json!({
            "stateHash": total_hex(p),
            "sections": pre.iter().map(|(s, bytes)| serde_json::json!({"name":s.name,"count":s.count,"preimage":hex::encode(bytes),"hash":hex::encode(s.hash)})).collect::<Vec<_>>(),
        })
    }

    /// The layout is fixed: these values change only when the encoding (or the commitment tree) changes. Anyone who
    /// implements the README's description gets the same values for the same states; the fixture file holds the bytes.
    #[test]
    fn golden_state_hashes() {
        let empty = Pool::new([0x11; 32]);
        assert_eq!(empty.state_sections().iter().map(|s| s.name).collect::<Vec<_>>(), SECTIONS);
        // the README says so: the root of the empty tree is 32 zero bytes, and it is the one root an empty ledger has had
        assert_eq!(crate::ledger::root_bytes(empty.ledger.root()), [0u8; 32]);
        assert_eq!(empty.ledger.roots.iter().collect::<Vec<_>>(), [&[0u8; 32]]);
        assert_eq!(total_hex(&empty), "00de0453c27a256d74af79e3f59c83b14d9f5d36b540e1dde24f14815dbcffb9");
        let p = sample();
        assert_eq!(hex::encode(crate::ledger::root_bytes(p.ledger.root())), "f46dbe7e6803925173240fa8452f9d2e30f6c72603a3b334ef2c720eec660401");
        assert_eq!(total_hex(&p), "460239e41a75e1d776f43ad2b593c5c09e21cc04e35bf9f278099d40d5c61b71");
        let made = serde_json::json!({
            "about": "Test vectors of the XMR20 state hash (README, section State hash). preimage = the bytes a section hash is taken over; stateHash = SHA-256 over the state tag and the section hashes in order.",
            "sectionTag": hex::encode(SECTION_TAG),
            "stateTag": hex::encode(STATE_TAG),
            "empty": vectors(&empty),
            "sample": vectors(&p),
        });
        if std::env::var("XMR20_WRITE_STATE_FIXTURE").as_deref() == Ok("1") {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/state_hash_fixture.json");
            std::fs::write(path, serde_json::to_string_pretty(&made).unwrap() + "\n").unwrap();
            return;
        }
        let kept: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(kept, made, "state_hash_fixture.json is not what the code gives (write it again with XMR20_WRITE_STATE_FIXTURE=1 only when the encoding was meant to change)");
    }

    /// A host that hands over transaction ids in capitals has the same state hash; no other text is folded.
    #[test]
    fn the_letter_case_of_a_transaction_id_does_not_count() {
        let base = sample();
        let mut p = base.clone();
        let up = |t: &mut String| *t = t.to_ascii_uppercase();
        p.notes.values_mut().for_each(|n| up(&mut n.txid));
        p.credits.values_mut().for_each(|c| up(&mut c.txid));
        p.redemptions.values_mut().for_each(|r| up(&mut r.txid));
        p.pending_a.values_mut().flatten().for_each(|a| up(&mut a.txid));
        p.pending_b.values_mut().flatten().for_each(|b| up(&mut b.txid));
        p.completed.values_mut().for_each(|c| {
            up(&mut c.txid_a);
            up(&mut c.txid_b);
        });
        p.lots.values_mut().for_each(|l| {
            up(&mut l.txid);
            if let Some(c) = &mut l.claim {
                up(&mut c.txid);
            }
        });
        p.pending_claims.iter_mut().for_each(|c| up(&mut c.txid));
        p.open_tokens.values_mut().for_each(|t| up(&mut t.txid));
        assert_ne!(p.notes[&[0x31; 32]].txid, base.notes[&[0x31; 32]].txid);
        assert_eq!(p.state_sections(), base.state_sections());
        // texts the core writes itself are taken as they are
        let mut q = base.clone();
        up(&mut q.notes.get_mut(&[0x31; 32]).unwrap().owner);
        assert_eq!(differing(&base, &q), BTreeSet::from(["notes"]));
    }

    /// Building the same state twice gives the same hash, and the hash is the hash of the section hashes.
    #[test]
    fn the_same_state_has_the_same_hash() {
        let (a, b) = (sample(), sample());
        assert_eq!(a.state_sections(), b.state_sections());
        assert_eq!(a.state_hash(), b.state_hash());
        assert_eq!(a.state_hash(), state_total(&a.state_sections()));
        assert_eq!(a.clone().state_hash(), a.state_hash());
        let counts: Vec<u64> = a.state_sections().iter().map(|s| s.count).collect();
        assert_eq!(counts, [1, 1, 2, 2, 2, 2, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 2, 2]);
    }

    /// Every field of every section counts: one change moves the state hash and the hash of exactly the section it is in.
    #[test]
    fn every_field_changes_exactly_its_section() {
        let base = sample();
        type M = Box<dyn Fn(&mut Pool)>;
        let note = |f: fn(&mut PublicNote)| -> M { Box::new(move |p| f(p.notes.get_mut(&[0x32; 32]).unwrap())) };
        let lot = |f: fn(&mut Lot)| -> M { Box::new(move |p| f(p.lots.get_mut(&[0x71; 32]).unwrap())) };
        let token = |f: fn(&mut OpenToken)| -> M { Box::new(move |p| f(p.open_tokens.get_mut(&hx(0xa2)).unwrap())) };
        let credit = |f: fn(&mut Credit)| -> M { Box::new(move |p| f(p.credits.get_mut(&[0x41; 32]).unwrap())) };
        let redemption = |f: fn(&mut Redemption)| -> M { Box::new(move |p| f(p.redemptions.get_mut(&[0x51; 32]).unwrap())) };
        let done = |f: fn(&mut Completed)| -> M { Box::new(move |p| f(p.completed.get_mut(&[0x63; 32]).unwrap())) };
        let part_a = |f: fn(&mut StoredA)| -> M { Box::new(move |p| f(&mut p.pending_a.get_mut(&[0x61; 32]).unwrap()[0])) };
        let part_b = |f: fn(&mut StoredB)| -> M { Box::new(move |p| f(&mut p.pending_b.get_mut(&[0x62; 32]).unwrap()[0])) };
        let cases: Vec<(&str, M)> = vec![
            ("domain", Box::new(|p| p.ledger.domain[31] ^= 1)),
            ("shielded-root", Box::new(|p| {
                p.ledger.tree.insert(Witness::Keep, StateCommitment(Fq::from(99u64))).unwrap();
            })),
            ("nullifiers", Box::new(|p| {
                p.ledger.nullifiers.insert([0x22; 32]);
            })),
            ("nullifiers", Box::new(|p| {
                p.ledger.nullifiers.remove(&[0x21; 32]);
            })),
            ("roots", Box::new(|p| {
                p.ledger.roots.insert([0x23; 32]);
            })),
            ("history", Box::new(|p| p.ledger.history[0].ciphertext[111] ^= 1)),
            ("history", Box::new(|p| p.ledger.history[1].ephemeral_key.0[0] ^= 1)),
            ("history", Box::new(|p| p.ledger.history[1].note_commitment = StateCommitment(Fq::from(77u64)))),
            ("history", Box::new(|p| p.ledger.history.swap(0, 1))),
            ("notes", note(|n| n.asset = hx(0xa9))),
            ("notes", note(|n| n.amount += 1)),
            ("notes", note(|n| n.owner = hx(0xb9))),
            ("notes", note(|n| n.height += 1)),
            ("notes", note(|n| n.txid = hx(0xc0))),
            ("notes", note(|n| n.anchor = None)),
            ("notes", note(|n| n.anchor = Some(hx(0xd2)))),
            ("notes", Box::new(|p| {
                let n = p.notes.remove(&[0x31; 32]).unwrap();
                p.notes.insert([0x30; 32], n);
            })),
            ("notes", Box::new(|p| {
                p.notes.remove(&[0x31; 32]);
            })),
            ("spent-notes", Box::new(|p| {
                p.spent_notes.insert([0x34; 32]);
            })),
            ("minted", Box::new(|p| *p.minted.get_mut(&hx(0xa1)).unwrap() += 1 << 64)),
            ("minted", Box::new(|p| {
                let v = p.minted.remove(&hx(0xa2)).unwrap();
                p.minted.insert(hx(0xa4), v);
            })),
            ("burned", Box::new(|p| *p.burned.get_mut(&hx(0xa1)).unwrap() += 1)),
            ("shielded-in", Box::new(|p| *p.shielded_in.get_mut(&hx(0xa1)).unwrap() += 1)),
            ("shielded-out", Box::new(|p| *p.shielded_out.get_mut(&hx(0xa1)).unwrap() += 1)),
            ("credits", credit(|c| c.kind = 2)),
            ("credits", credit(|c| c.asset = hx(0xa9))),
            ("credits", credit(|c| c.amount += 1)),
            ("credits", credit(|c| c.owner = hx(0xb9))),
            ("credits", credit(|c| c.txid = hx(0xc0))),
            ("credits", credit(|c| c.height += 1)),
            ("credits", Box::new(|p| {
                let c = p.credits.remove(&[0x41; 32]).unwrap();
                p.credits.insert([0x42; 32], c);
            })),
            ("redemptions", redemption(|r| r.asset = hx(0xa9))),
            ("redemptions", redemption(|r| r.amount += 1)),
            ("redemptions", redemption(|r| r.binding = hx(0x53))),
            ("redemptions", redemption(|r| r.owner = hx(0xb9))),
            ("redemptions", redemption(|r| r.txid = hx(0xc0))),
            ("redemptions", redemption(|r| r.height += 1)),
            ("redemptions", Box::new(|p| {
                let r = p.redemptions.remove(&[0x51; 32]).unwrap();
                p.redemptions.insert([0x50; 32], r);
            })),
            ("pending-a", part_a(|a| a.part.inputs[2].proof[0] ^= 1)),
            ("pending-a", part_a(|a| a.part.auth = [10u8; 64].into())),
            ("pending-a", part_a(|a| a.part.op[0] ^= 1)),
            ("pending-a", part_a(|a| a.hash[0] ^= 1)),
            ("pending-a", part_a(|a| a.txid = hx(0xc0))),
            ("pending-a", part_a(|a| a.height += 1)),
            ("pending-a", Box::new(|p| {
                let v = p.pending_a.remove(&[0x61; 32]).unwrap();
                p.pending_a.insert([0x60; 32], v);
            })),
            ("pending-a", Box::new(|p| {
                let v = p.pending_a.get_mut(&[0x61; 32]).unwrap();
                let mut again = v[0].clone();
                again.txid = hx(0xc0);
                v.push(again);
            })),
            ("pending-b", part_b(|b| b.part.outputs[1].payload.ciphertext[0] ^= 1)),
            ("pending-b", part_b(|b| b.part.binding = [10u8; 64].into())),
            ("pending-b", part_b(|b| b.hash[31] ^= 1)),
            ("pending-b", part_b(|b| b.txid = hx(0xc0))),
            ("pending-b", part_b(|b| b.height += 1)),
            ("pending-b", Box::new(|p| {
                p.pending_b.clear();
            })),
            ("completed", done(|c| c.part_a = hx(0x66))),
            ("completed", done(|c| c.part_b = hx(0x66))),
            ("completed", done(|c| c.txid_a = hx(0xc0))),
            ("completed", done(|c| c.txid_b = hx(0xc0))),
            ("completed", done(|c| c.height += 1)),
            ("completed", Box::new(|p| {
                let c = p.completed.remove(&[0x63; 32]).unwrap();
                p.completed.insert([0x67; 32], c);
            })),
            ("lots", lot(|l| l.asset = hx(0xa9))),
            ("lots", lot(|l| l.ticker = "XMR21".into())),
            ("lots", lot(|l| l.amount += 1)),
            ("lots", lot(|l| l.price += 1)),
            ("lots", lot(|l| l.seller.sub = true)),
            ("lots", lot(|l| l.seller.spend[0] ^= 1)),
            ("lots", lot(|l| l.seller.view[0] ^= 1)),
            ("lots", lot(|l| l.until += 1)),
            ("lots", lot(|l| l.height += 1)),
            ("lots", lot(|l| l.txid = hx(0xc0))),
            ("lots", lot(|l| l.note[0] ^= 1)),
            ("lots", lot(|l| l.status = LotStatus::Open)),
            ("lots", lot(|l| l.status = LotStatus::Cancelled)),
            ("lots", lot(|l| l.reservations[0].buyer.view[5] ^= 1)),
            ("lots", lot(|l| l.reservations[0].height += 1)),
            ("lots", lot(|l| l.reservations[0].pay_by += 1)),
            ("lots", lot(|l| l.reservations[0].pay += 1)),
            ("lots", lot(|l| l.reservations[0].record[0] ^= 1)),
            ("lots", lot(|l| l.reservations.clear())),
            ("lots", lot(|l| {
                let again = l.reservations[0].clone();
                l.reservations.push(again);
            })),
            ("lots", lot(|l| l.claim = None)),
            ("lots", lot(|l| l.claim.as_mut().unwrap().buyer.sub = false)),
            ("lots", lot(|l| l.claim.as_mut().unwrap().payment[0] ^= 1)),
            ("lots", lot(|l| l.claim.as_mut().unwrap().payment_height += 1)),
            ("lots", lot(|l| l.claim.as_mut().unwrap().height += 1)),
            ("lots", lot(|l| l.claim.as_mut().unwrap().txid = hx(0xc0))),
            ("lots", Box::new(|p| {
                p.lots.remove(&[0x76; 32]);
            })),
            ("used-payments", Box::new(|p| {
                p.used_payments.insert([0x82; 32]);
            })),
            ("pending-claims", Box::new(|p| p.pending_claims[0].wire.push(4))),
            ("pending-claims", Box::new(|p| p.pending_claims[0].txid = hx(0xc0))),
            ("pending-claims", Box::new(|p| p.pending_claims[0].height += 1)),
            ("pending-claims", Box::new(|p| p.pending_claims.clear())),
            ("open-tokens", token(|t| t.id[0] ^= 1)),
            ("open-tokens", token(|t| t.number += 1)),
            ("open-tokens", token(|t| t.text.tick = "PEPF".into())),
            ("open-tokens", token(|t| t.text.name = None)),
            ("open-tokens", token(|t| t.text.name = Some("Pepe".into()))),
            ("open-tokens", token(|t| t.text.max += 1)),
            ("open-tokens", token(|t| t.text.col = Some("x".into()))),
            ("open-tokens", token(|t| t.text.lim = None)),
            ("open-tokens", token(|t| t.text.lim = Some(1001))),
            ("open-tokens", token(|t| t.text.pre = Some(0))),
            ("open-tokens", token(|t| t.creator.sub = true)),
            ("open-tokens", token(|t| t.creator.spend[0] ^= 1)),
            ("open-tokens", token(|t| t.left -= 1)),
            ("open-tokens", token(|t| t.mints += 1)),
            ("open-tokens", token(|t| t.height += 1)),
            ("open-tokens", token(|t| t.txid = hx(0xc0))),
            ("open-tokens", Box::new(|p| {
                let t = p.open_tokens.remove(&hx(0xa3)).unwrap();
                p.open_tokens.insert(hx(0xa4), t);
            })),
            ("open-ids", Box::new(|p| {
                p.open_ids.insert([0x91; 32], hx(0xa4));
            })),
            ("open-ids", Box::new(|p| {
                p.open_ids.remove(&[0x94; 32]);
            })),
        ];
        let mut seen = BTreeSet::new();
        for (i, (name, change)) in cases.iter().enumerate() {
            let mut p = base.clone();
            change(&mut p);
            assert_ne!(p.state_hash(), base.state_hash(), "case {i} ({name}) did not change the state hash");
            assert_eq!(differing(&base, &p), BTreeSet::from([*name]), "case {i} ({name})");
            seen.insert(*name);
        }
        assert_eq!(seen, SECTIONS.into_iter().collect::<BTreeSet<_>>(), "a case for every section");
    }

    /// Lengths are part of the encoding: moving a character from one text to the next one is another state.
    #[test]
    fn neighbouring_texts_do_not_run_together() {
        let mut a = sample();
        let mut b = sample();
        for (p, part_a, part_b) in [(&mut a, "ab", "c"), (&mut b, "a", "bc")] {
            let c = p.completed.get_mut(&[0x63; 32]).unwrap();
            c.part_a = part_a.into();
            c.part_b = part_b.into();
        }
        assert_ne!(a.state_hash(), b.state_hash());
        // an empty map and a map of one empty-keyed zero are different states
        let mut c = Pool::new([0x11; 32]);
        let empty = c.state_hash();
        c.burned.insert(String::new(), 0);
        assert_ne!(c.state_hash(), empty);
    }

    /// What the module note lists as not covered does not move the hash.
    #[test]
    fn settings_and_counters_are_not_part_of_the_state_hash() {
        let base = sample();
        let mut p = base.clone();
        p.accepted += 5;
        p.rejected += 7;
        p.pending_records += 1;
        p.market_from = Some(10);
        p.address_moves = Some(crate::address::Activation { from: 3, net: crate::address::STAGENET });
        p.trades = Some(crate::address::Activation { from: 4, net: crate::address::MAINNET });
        p.open = Some(open::Activation { from: 5, net: crate::address::MAINNET, inscriptions: [1; 32] });
        assert_eq!(p.state_sections(), base.state_sections());
    }
}
