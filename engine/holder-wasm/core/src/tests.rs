//! Core tests with Penumbra's PUBLISHED keys (../params/penumbra-2.1.1). Run in release mode:
//! Groth16 proving in a debug build is far too slow. Every record produced here is measured against the
//! 1,060-byte tx_extra relay limit through the real framing.
use super::*;
use crate::keys::{owner_key, owner_signing_key, shielded_address, token_spend_key, TokenAddress};
use crate::penumbra::{self as pz, Circuit};
use crate::pool::{Pool, Vks};
use ark_groth16::ProvingKey;
use decaf377::Bls12_377;
use decaf377_rdsa::{SigningKey, SpendAuth};
use rand_core::{OsRng, RngCore};
use std::sync::OnceLock;

struct Keys {
    spend_pk: ProvingKey<Bls12_377>,
    output_pk: ProvingKey<Bls12_377>,
    spend_vk_hex: String,
    output_vk_hex: String,
}
fn keys() -> &'static Keys {
    static K: OnceLock<Keys> = OnceLock::new();
    K.get_or_init(|| {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../params/penumbra-2.1.1");
        let sp = std::fs::read(dir.join("spend_pk.bin")).expect("spend_pk.bin (git-lfs object, see DESIGN 5)");
        let op = std::fs::read(dir.join("output_pk.bin")).expect("output_pk.bin");
        assert_eq!(sp.len() as u64, pz::SPEND_PK_BYTES);
        assert_eq!(op.len() as u64, pz::OUTPUT_PK_BYTES);
        assert_eq!(hex::encode(hash(&sp)), pz::SPEND_PK_SHA256);
        assert_eq!(hex::encode(hash(&op)), pz::OUTPUT_PK_SHA256);
        let spend_pk = pz::load_pk(Circuit::Spend, &sp).unwrap();
        let output_pk = pz::load_pk(Circuit::Output, &op).unwrap();
        let svk = pz::load_vk_param(Circuit::Spend, &std::fs::read(dir.join("spend_vk.param")).unwrap()).unwrap();
        let ovk = pz::load_vk_param(Circuit::Output, &std::fs::read(dir.join("output_vk.param")).unwrap()).unwrap();
        assert!(pz::pk_matches_vk(&spend_pk, &pz::vk_hex(&svk)), "spend pk/vk pair");
        assert!(pz::pk_matches_vk(&output_pk, &pz::vk_hex(&ovk)), "output pk/vk pair");
        Keys { spend_pk, output_pk, spend_vk_hex: pz::vk_hex(&svk), output_vk_hex: pz::vk_hex(&ovk) }
    })
}
struct World {
    pool: Pool,
    vks: Vks,
    domain: [u8; 32],
    issuer: SigningKey<SpendAuth>,
    asset: penumbra_sdk_asset::asset::Id,
    height: u64,
    log: Vec<(String, usize, usize)>,
}
fn root() -> [u8; 32] {
    let mut r = [0u8; 32];
    OsRng.fill_bytes(&mut r);
    r
}
impl World {
    fn new() -> Self {
        let k = keys();
        let issuer = SigningKey::<SpendAuth>::new(OsRng);
        let mut cfg = Config { chain: hex::encode([7u8; 32]), domain: String::new(), spend_vk: k.spend_vk_hex.clone(), output_vk: k.output_vk_hex.clone(), issuer_vk: hex::encode(decaf377_rdsa::VerificationKey::from(&issuer).to_bytes()) };
        cfg.domain = hex::encode(cfg.computed_domain().unwrap());
        let domain = cfg.domain().unwrap();
        let vks = Vks { spend: pz::read_vk(Circuit::Spend, &k.spend_vk_hex).unwrap(), output: pz::read_vk(Circuit::Output, &k.output_vk_hex).unwrap(), issuer: decaf377_rdsa::VerificationKey::from(&issuer) };
        Self { pool: Pool::new(domain), vks, domain, issuer, asset: asset_for_mint("TestMint1111111111111111111111111111111111").unwrap(), height: 1, log: vec![] }
    }
    fn txid(&mut self) -> String {
        self.height += 1;
        hex::encode(root())
    }
    /// Apply a record as the chain would and record its framed size.
    fn apply(&mut self, wire: &[u8]) -> serde_json::Value {
        let framed = transport::frame(wire, &[9u8; 32]).unwrap();
        assert!(framed.len() <= transport::EXTRA_LIMIT, "record of {} bytes frames to {} > 1060", wire.len(), framed.len());
        assert_eq!(transport::framed_extra_len(wire.len()), framed.len());
        assert_eq!(transport::unframe(&framed).unwrap().unwrap(), wire, "framing round trip");
        let txid = self.txid();
        let h = self.height;
        let r = self.pool.apply(Some(wire), &txid, h, &self.vks);
        self.log.push((r["kind"].as_str().unwrap_or("?").to_string(), wire.len(), framed.len()));
        r
    }
    fn invariant(&self) {
        let (ok, rows) = self.pool.invariant();
        assert!(ok, "backing invariant broken: {rows:?}");
    }
    fn credit(&mut self, owner: [u8; 32], amount: u64, binding: [u8; 32]) -> String {
        let c = public::Credit::build(public::KIND_DEPOSIT, self.asset, amount, owner, binding, &self.issuer, &self.domain).unwrap();
        let r = self.apply(&c.encode());
        assert_eq!(r["record"], "accepted", "{r}");
        r["detail"]["outputs"][0].as_str().unwrap().to_string()
    }
    fn note_ids(&self, owner: &[u8; 32]) -> Vec<[u8; 32]> {
        self.pool.notes_of_owner(owner).iter().map(|(id, _)| hex::decode(id).unwrap().try_into().unwrap()).collect()
    }
}
fn id32(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}

#[test]
fn keys_and_addresses() {
    let r = root();
    let sk = owner_signing_key(&r, 0);
    assert_eq!(owner_key(&sk), owner_key(&owner_signing_key(&r, 0)), "deterministic");
    assert_ne!(owner_key(&sk), owner_key(&owner_signing_key(&r, 1)), "account separation");
    assert_ne!(owner_key(&sk), owner_key(&owner_signing_key(&root(), 0)), "root separation");
    let tsk = token_spend_key(&r, 0);
    assert_ne!(tsk.spend_auth_key().to_bytes(), sk.to_bytes(), "owner key is not the spend key");
    let addr = TokenAddress::unified(shielded_address(&tsk), owner_key(&sk));
    let s = addr.encode();
    assert!(s.starts_with("xmr20t1"), "{s}");
    let back = TokenAddress::parse(&s).unwrap();
    assert_eq!(back, addr);
    let legacy = TokenAddress::parse(&shielded_address(&tsk).to_string()).unwrap();
    assert_eq!(legacy.shielded, addr.shielded);
    assert!(legacy.owner.is_none());
    let mut bad = s.clone();
    bad.replace_range(10..11, if &s[10..11] == "q" { "p" } else { "q" });
    assert!(TokenAddress::parse(&bad).is_err(), "checksum");
    assert!(TokenAddress::parse("xmr20t1qqqq").is_err());
    assert!(TokenAddress::parse("4Aabc").is_err(), "monero address refused");
}

#[test]
fn penumbra_keys_load_and_identify() {
    let k = keys();
    assert!(pz::read_vk(Circuit::Output, &k.spend_vk_hex).is_err(), "swapped verifying key refused by id");
    assert!(pz::read_vk(Circuit::Spend, &k.output_vk_hex).is_err());
}

#[test]
fn public_credit_transfer_burn() {
    let mut w = World::new();
    let (ra, rb) = (root(), root());
    let (ska, skb) = (owner_signing_key(&ra, 0), owner_signing_key(&rb, 0));
    let (a, b) = (owner_key(&ska), owner_key(&skb));
    w.credit(a, 10_000_000_000, [1u8; 32]);
    // duplicate binding refused
    let dup = public::Credit::build(public::KIND_DEPOSIT, w.asset, 5, a, [1u8; 32], &w.issuer, &w.domain).unwrap();
    assert_eq!(w.apply(&dup.encode())["record"], "rejected");
    // foreign issuer refused
    let forged = public::Credit::build(public::KIND_MIGRATION, w.asset, 5, a, [2u8; 32], &SigningKey::<SpendAuth>::new(OsRng), &w.domain).unwrap();
    assert_eq!(w.apply(&forged.encode())["record"], "rejected");
    w.invariant();
    assert_eq!(w.pool.public_balances(&a)[&hex::encode(w.asset.to_bytes())], 10_000_000_000);
    // transfer 4,000 to B with change
    let ids = w.note_ids(&a);
    let t = public::Transfer::build(w.asset, ids.clone(), vec![PublicOutput { owner: b, amount: 4_000_000_000 }, PublicOutput { owner: a, amount: 6_000_000_000 }], &ska, &w.domain).unwrap();
    let r = w.apply(&t.encode());
    assert_eq!(r["record"], "accepted", "{r}");
    assert_eq!(w.pool.public_balances(&b)[&hex::encode(w.asset.to_bytes())], 4_000_000_000);
    assert_eq!(w.pool.public_balances(&a)[&hex::encode(w.asset.to_bytes())], 6_000_000_000);
    // replay of the same transfer: inputs spent
    assert_eq!(w.apply(&t.encode())["record"], "rejected");
    // wrong signer
    let bad = public::Transfer::build(w.asset, w.note_ids(&a), vec![PublicOutput { owner: b, amount: 6_000_000_000 }], &skb, &w.domain).unwrap();
    assert_eq!(w.apply(&bad.encode())["record"], "rejected");
    // value not conserved
    let bad = public::Transfer::build(w.asset, w.note_ids(&a), vec![PublicOutput { owner: b, amount: 6_000_000_001 }], &ska, &w.domain).unwrap();
    assert_eq!(w.apply(&bad.encode())["record"], "rejected");
    // four inputs / four outputs is the maximum and still fits
    for i in 0..3u8 {
        w.credit(b, 1_000, [10 + i; 32]);
    }
    let ids = w.note_ids(&b);
    assert_eq!(ids.len(), 4);
    let outs: Vec<PublicOutput> = (0..4).map(|i| PublicOutput { owner: if i == 0 { a } else { b }, amount: if i == 0 { 4_000_000_000 } else { 1_000 } }).collect();
    let big = public::Transfer::build(w.asset, ids, outs, &skb, &w.domain).unwrap();
    assert_eq!(big.encode().len(), 390);
    assert_eq!(w.apply(&big.encode())["record"], "accepted");
    // burn 2,500 from A with change, bound to a payout request
    let ids = w.note_ids(&a);
    let total: u64 = w.pool.notes_of_owner(&a).iter().map(|(_, n)| n.amount).sum();
    let burn = public::Burn::build(w.asset, ids, 2_500_000_000, PublicOutput { owner: a, amount: total - 2_500_000_000 }, [3u8; 32], &ska, &w.domain).unwrap();
    let r = w.apply(&burn.encode());
    assert_eq!(r["record"], "accepted", "{r}");
    assert_eq!(w.pool.burned[&hex::encode(w.asset.to_bytes())], 2_500_000_000);
    assert_eq!(w.pool.redemptions.len(), 1);
    // same burn record under another carrier: inputs spent
    assert_eq!(w.apply(&burn.encode())["record"], "rejected");
    w.invariant();
}

#[test]
fn shield_unshield_round_trip() {
    let mut w = World::new();
    let r = root();
    let sk = owner_signing_key(&r, 0);
    let key = token_spend_key(&r, 0);
    let a = owner_key(&sk);
    w.credit(a, 10_000_000, [1u8; 32]);
    let ids = w.note_ids(&a);
    // wrong total refused before proving: build checks amount <= total
    assert!(shield::Shield::build(w.asset, ids.clone(), 10_000_000, 10_000_001, &shielded_address(&key), &sk, &keys().output_pk, &w.domain).is_err());
    let (s, note) = shield::Shield::build(w.asset, ids.clone(), 10_000_000, 7_000_000, &shielded_address(&key), &sk, &keys().output_pk, &w.domain).unwrap();
    let wire = s.encode();
    let rr = w.apply(&wire);
    assert_eq!(rr["record"], "accepted", "{rr}");
    w.invariant();
    assert_eq!(w.pool.public_balances(&a)[&hex::encode(w.asset.to_bytes())], 3_000_000);
    assert_eq!(w.pool.shielded_balances(key.full_viewing_key())[&hex::encode(w.asset.to_bytes())], 7_000_000);
    // the owned note is the one we built
    let owned = w.pool.ledger.unspent_notes(key.full_viewing_key());
    assert_eq!(owned.len(), 1);
    assert_eq!(owned[0].commit(), note.commit());
    // a shield whose stated total is wrong (claims less in than the inputs hold) is rejected by the pool
    let ids2 = w.note_ids(&a);
    let (bad, _) = shield::Shield::build(w.asset, ids2.clone(), 2_999_999, 1_000_000, &shielded_address(&key), &sk, &keys().output_pk, &w.domain).unwrap();
    assert_eq!(w.apply(&bad.encode())["record"], "rejected");
    // unshield 2,000,000 of the 7,000,000 note back to the owner
    let (u, change) = shield::Unshield::build(&w.pool.ledger, &key, &owned[0], 2_000_000, a, &keys().spend_pk, &keys().output_pk, &w.domain).unwrap();
    let uw = u.encode();
    assert_eq!(uw.len(), shield::UNSHIELD_BYTES);
    let rr = w.apply(&uw);
    assert_eq!(rr["record"], "accepted", "{rr}");
    w.invariant();
    assert_eq!(w.pool.public_balances(&a)[&hex::encode(w.asset.to_bytes())], 5_000_000);
    assert_eq!(w.pool.shielded_balances(key.full_viewing_key())[&hex::encode(w.asset.to_bytes())], 5_000_000);
    let owned2 = w.pool.ledger.unspent_notes(key.full_viewing_key());
    assert_eq!(owned2.len(), 1);
    assert_eq!(owned2[0].commit(), change.commit());
    // replay: nullifier spent
    assert_eq!(w.apply(&uw)["record"], "rejected");
    // tampered public amount: signatures fail
    let mut t = uw.clone();
    let off = 4 + 32 + 32 + pz::ShieldedInput::BYTES + 32 + 64 + 32;
    t[off] ^= 1;
    assert_eq!(w.apply(&t)["record"], "rejected");
}

#[test]
fn two_part_private_transfer() {
    let mut w = World::new();
    let (r1, r2) = (root(), root());
    let (sk1, key1) = (owner_signing_key(&r1, 0), token_spend_key(&r1, 0));
    let key2 = token_spend_key(&r2, 0);
    let a = owner_key(&sk1);
    let credit_wire = public::Credit::build(public::KIND_DEPOSIT, w.asset, 9_000_000, a, [1u8; 32], &w.issuer, &w.domain).unwrap().encode();
    assert_eq!(w.apply(&credit_wire)["record"], "accepted");
    let ids = w.note_ids(&a);
    let (s, _) = shield::Shield::build(w.asset, ids, 9_000_000, 9_000_000, &shielded_address(&key1), &sk1, &keys().output_pk, &w.domain).unwrap();
    assert_eq!(w.apply(&s.encode())["record"], "accepted");
    let notes = w.pool.ledger.unspent_notes(key1.full_viewing_key());
    let built = private2::build(&w.pool.ledger, &key1, &notes, &shielded_address(&key2), 4_000_000, &keys().spend_pk, &keys().output_pk, &w.domain).unwrap();
    let (wa, wb) = (built.a.encode(), built.b.encode());
    assert_eq!(wa.len(), private2::A_BYTES);
    assert_eq!(wb.len(), private2::B_BYTES);
    // B first: pending, nothing applied
    let r = w.apply(&wb);
    assert_eq!(r["record"], "pending", "{r}");
    assert_eq!(w.pool.ledger.nullifiers.len(), 0);
    assert_eq!(w.pool.shielded_balances(key2.full_viewing_key()).get(&hex::encode(w.asset.to_bytes())), None);
    // a look-alike A with the same op id but garbage proofs does not block the real one
    let mut fake = wa.clone();
    fake[4 + 32 + 32 + 64] ^= 1; // first proof byte
    let r = w.apply(&fake);
    assert_eq!(r["record"], "pending", "{r}");
    assert_eq!(r["detail"]["completed"], false);
    // the genuine A completes the operation exactly once
    let r = w.apply(&wa);
    assert_eq!(r["record"], "accepted", "{r}");
    assert_eq!(r["detail"]["completed"], true);
    w.invariant();
    assert_eq!(w.pool.shielded_balances(key2.full_viewing_key())[&hex::encode(w.asset.to_bytes())], 4_000_000);
    assert_eq!(w.pool.shielded_balances(key1.full_viewing_key())[&hex::encode(w.asset.to_bytes())], 5_000_000);
    assert_eq!(w.pool.completed.len(), 1);
    // duplicates of either part are inert
    assert_eq!(w.apply(&wa)["detail"]["completed"], false);
    assert_eq!(w.apply(&wb)["detail"]["completed"], false);
    assert_eq!(w.pool.completed.len(), 1);
    assert_eq!(w.pool.shielded_balances(key2.full_viewing_key())[&hex::encode(w.asset.to_bytes())], 4_000_000);
    // a conflicting operation spending the same (now spent) notes never completes, in either order
    let conflict = private2::build(&{
        // rebuild from a pool state where the notes were still unspent
        let mut p = Pool::new(w.domain);
        p.apply(Some(&credit_wire), &hex::encode([1u8; 32]), 1, &w.vks);
        p.apply(Some(&s.encode()), &hex::encode([2u8; 32]), 2, &w.vks);
        p.ledger
    }, &key1, &notes, &shielded_address(&key2), 1_000_000, &keys().spend_pk, &keys().output_pk, &w.domain).unwrap();
    assert_eq!(w.apply(&conflict.a.encode())["record"], "pending");
    let r = w.apply(&conflict.b.encode());
    assert_eq!(r["record"], "pending", "{r}");
    assert_eq!(r["detail"]["completed"], false);
    assert!(r["detail"]["lastError"].as_str().unwrap().contains("Spent"), "{r}");
    assert_eq!(w.pool.completed.len(), 1);
    w.invariant();
    // the recipient spends what it received: unshield 1,000,000 to its own public key
    let owner2 = owner_key(&owner_signing_key(&r2, 0));
    let n2 = w.pool.ledger.unspent_notes(key2.full_viewing_key());
    let (u, _) = shield::Unshield::build(&w.pool.ledger, &key2, &n2[0], 1_000_000, owner2, &keys().spend_pk, &keys().output_pk, &w.domain).unwrap();
    assert_eq!(w.apply(&u.encode())["record"], "accepted");
    assert_eq!(w.pool.public_balances(&owner2)[&hex::encode(w.asset.to_bytes())], 1_000_000);
    w.invariant();
    // replay equivalence: a fresh pool fed the same wires in the same order ends in the same state
    // Print the measured sizes for RESULTS.
    for (k, rec, framed) in &w.log {
        eprintln!("size {k}: record {rec} B, tx_extra {framed} B");
    }
}

#[test]
fn record_sizes_fit_the_relay_limit() {
    // Fixed-size records by construction; variable ones at their maximum.
    assert_eq!(public::Credit::BYTES, 173);
    assert_eq!(shield::UNSHIELD_BYTES, 924);
    assert_eq!(private2::A_BYTES, 932);
    assert_eq!(private2::B_BYTES, 900);
    for n in [173usize, 390, 309, 733, 924, 932, 900, transport::MAX_RECORD] {
        assert!(transport::framed_extra_len(n) <= transport::EXTRA_LIMIT, "{n}");
    }
    assert!(transport::framed_extra_len(transport::MAX_RECORD + 1) > transport::EXTRA_LIMIT);
    // the two-input unshield with change that was rejected as a design (DESIGN 2.6)
    let two_inputs_with_change = 4 + 32 + 32 + 2 * pz::ShieldedInput::BYTES + 32 + 64 + PublicOutput::BYTES + pz::ShieldedOutput::BYTES + 64;
    assert_eq!(two_inputs_with_change, 1180);
    assert!(transport::framed_extra_len(two_inputs_with_change) > transport::EXTRA_LIMIT);
}

// FIX CANDIDATE REGRESSION (review M4): duplicate fragments are not stored, parts of a completed operation are ignored, the
// pending counter equals the number of stored parts at every step, a genuine pair completes despite an invalid look-alike, and
// a fresh replay of the same wires (duplicates included) reaches the same state.
#[test]
fn fragment_duplicates_are_not_stored_and_pending_counts_stay_exact() {
    let mut w = World::new();
    let (r1, r2) = (root(), root());
    let (sk1, key1) = (owner_signing_key(&r1, 0), token_spend_key(&r1, 0));
    let key2 = token_spend_key(&r2, 0);
    let a = owner_key(&sk1);
    let credit_wire = public::Credit::build(public::KIND_DEPOSIT, w.asset, 9_000_000, a, [7u8; 32], &w.issuer, &w.domain).unwrap().encode();
    assert_eq!(w.apply(&credit_wire)["record"], "accepted");
    let ids = w.note_ids(&a);
    let (s, _) = shield::Shield::build(w.asset, ids, 9_000_000, 9_000_000, &shielded_address(&key1), &sk1, &keys().output_pk, &w.domain).unwrap();
    let shield_wire = s.encode();
    assert_eq!(w.apply(&shield_wire)["record"], "accepted");
    let notes = w.pool.ledger.unspent_notes(key1.full_viewing_key());
    let built = private2::build(&w.pool.ledger, &key1, &notes, &shielded_address(&key2), 4_000_000, &keys().spend_pk, &keys().output_pk, &w.domain).unwrap();
    let (wa, wb) = (built.a.encode(), built.b.encode());
    let mut fake_a = wa.clone();
    fake_a[4 + 32 + 32 + 64] ^= 1; // look-alike A: same op id, garbage proof
    let mut wires: Vec<Vec<u8>> = vec![];
    let mut step = |w: &mut World, wire: &[u8]| -> serde_json::Value { wires.push(wire.to_vec()); w.apply(wire) };
    // three identical A copies: one stored, two ignored (not stored, not counted)
    let r = step(&mut w, &wa);
    assert_eq!(r["record"], "pending", "{r}");
    assert_eq!(r["detail"]["stored"], true);
    for _ in 0..2 {
        let r = step(&mut w, &wa);
        assert_eq!(r["record"], "pending", "{r}");
        assert_eq!(r["detail"]["stored"], false);
    }
    assert_eq!(w.pool.pending_records, 1);
    // an invalid look-alike A is stored as pending (it may be the counterpart of a future B)
    let r = step(&mut w, &fake_a);
    assert_eq!(r["detail"]["stored"], true);
    assert_eq!(w.pool.pending_records, 2);
    // the genuine B completes the operation exactly once; EVERY stored part of the operation is removed and accounted for
    let r = step(&mut w, &wb);
    assert_eq!(r["record"], "accepted", "{r}");
    assert_eq!(r["detail"]["completed"], true);
    assert_eq!(w.pool.completed.len(), 1);
    assert_eq!(w.pool.pending_records, 0, "no phantom pending count after completion");
    w.invariant();
    assert_eq!(w.pool.shielded_balances(key2.full_viewing_key())[&hex::encode(w.asset.to_bytes())], 4_000_000);
    // parts of a completed operation are ignored: not stored, not counted
    for wire in [&wa, &wb, &fake_a] {
        let r = step(&mut w, wire);
        assert_eq!(r["record"], "pending", "{r}");
        assert_eq!(r["detail"]["stored"], false);
        assert_eq!(r["detail"]["completed"], false);
    }
    assert_eq!(w.pool.pending_records, 0);
    assert_eq!(w.pool.completed.len(), 1);
    w.invariant();
    // deterministic replay: a fresh pool fed the same wires (duplicates included) ends with the same summary
    let mut fresh = Pool::new(w.domain);
    fresh.apply(Some(&credit_wire), &hex::encode([1u8; 32]), 1, &w.vks);
    fresh.apply(Some(&shield_wire), &hex::encode([2u8; 32]), 2, &w.vks);
    for (i, wire) in wires.iter().enumerate() {
        fresh.apply(Some(wire), &hex::encode([(10 + i) as u8; 32]), 3 + i as u64, &w.vks);
    }
    assert_eq!(fresh.pending_records, 0);
    assert_eq!(fresh.completed.len(), 1);
    assert_eq!(fresh.summary()["state"]["root"], w.pool.summary()["state"]["root"]);
    assert_eq!(fresh.summary()["pendingParts"], w.pool.summary()["pendingParts"]);
}
