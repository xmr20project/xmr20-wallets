//! MONERO MARKET candidate: anchored-note admission rules, offline and without a native chain.
//! The carrier's key images are supplied explicitly here; the actual-daemon tests (../../tests/) check
//! that native consensus really refuses the conflicting carriers these rules depend on.
//! Run: cargo test --release --offline market_tests
use super::*;
use crate::keys::{owner_key, owner_signing_key, shielded_address, token_spend_key};
use crate::market::{Anchored, AnchoredOutput, Sale, NO_ANCHOR};
use crate::penumbra::{self as pz, Circuit};
use crate::pool::{Pool, Vks};
use decaf377_rdsa::{SigningKey, SpendAuth, VerificationKey};
use rand_core::{OsRng, RngCore};
use serde_json::Value as J;
use std::sync::OnceLock;

fn vk_hex() -> &'static (String, String) {
    static V: OnceLock<(String, String)> = OnceLock::new();
    V.get_or_init(|| {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../params/test-v2/manifest.json");
        let m: J = serde_json::from_slice(&std::fs::read(p).expect("test-v2 manifest")).unwrap();
        (m["config"]["spend_vk"].as_str().unwrap().into(), m["config"]["output_vk"].as_str().unwrap().into())
    })
}
fn output_pk() -> &'static ark_groth16::ProvingKey<decaf377::Bls12_377> {
    static K: OnceLock<ark_groth16::ProvingKey<decaf377::Bls12_377>> = OnceLock::new();
    K.get_or_init(|| {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../params/test-v2/output_pk.bin");
        pz::load_pk(Circuit::Output, &std::fs::read(p).expect("output_pk.bin")).unwrap()
    })
}
fn rnd() -> [u8; 32] {
    let mut r = [0u8; 32];
    OsRng.fill_bytes(&mut r);
    r
}
struct W {
    pool: Pool,
    vks: Vks,
    domain: [u8; 32],
    issuer: SigningKey<SpendAuth>,
    asset: penumbra_sdk_asset::asset::Id,
    height: u64,
    binding: u8,
}
struct Holder {
    sk: SigningKey<SpendAuth>,
    key: [u8; 32],
    root: [u8; 32],
}
fn holder() -> Holder {
    let root = rnd();
    let sk = owner_signing_key(&root, 0);
    Holder { key: owner_key(&sk), sk, root }
}
impl W {
    fn new() -> Self {
        let (s, o) = vk_hex();
        let issuer = SigningKey::<SpendAuth>::new(OsRng);
        let mut cfg = Config { chain: hex::encode([7u8; 32]), domain: String::new(), spend_vk: s.clone(), output_vk: o.clone(), issuer_vk: hex::encode(VerificationKey::from(&issuer).to_bytes()) };
        cfg.domain = hex::encode(cfg.computed_domain().unwrap());
        let domain = cfg.domain().unwrap();
        let vks = Vks { spend: pz::read_vk(Circuit::Spend, s).unwrap(), output: pz::read_vk(Circuit::Output, o).unwrap(), issuer: VerificationKey::from(&issuer) };
        let mut pool = Pool::new(domain);
        pool.market_from = Some(0);
        Self { pool, vks, domain, issuer, asset: asset_for_mint("TestMint1111111111111111111111111111111111").unwrap(), height: 1, binding: 0 }
    }
    /// Apply as the chain would, with the carrier's native input key images.
    fn apply(&mut self, wire: &[u8], native: &[[u8; 32]]) -> J {
        let framed = transport::frame(wire, &[9u8; 32]).unwrap();
        assert!(framed.len() <= transport::EXTRA_LIMIT);
        assert_eq!(transport::unframe(&framed).unwrap().unwrap(), wire);
        self.height += 1;
        self.pool.apply_carrier(Some(wire), &hex::encode(rnd()), self.height, native, &self.vks)
    }
    fn credit(&mut self, owner: [u8; 32], amount: u64) -> [u8; 32] {
        self.binding += 1;
        let c = public::Credit::build(public::KIND_DEPOSIT, self.asset, amount, owner, [self.binding; 32], &self.issuer, &self.domain).unwrap();
        let r = self.apply(&c.encode(), &[rnd()]);
        assert_eq!(r["record"], "accepted", "{r}");
        id(&r["detail"]["outputs"][0])
    }
    fn invariant(&self) {
        let (ok, rows) = self.pool.invariant();
        assert!(ok, "supply invariant: {rows:?}");
    }
    fn note(&self, id: &[u8; 32]) -> Option<pool::PublicNote> {
        self.pool.notes.get(id).cloned()
    }
}
fn id(v: &J) -> [u8; 32] {
    hex::decode(v.as_str().unwrap()).unwrap().try_into().unwrap()
}
fn accepted(r: &J) {
    assert_eq!(r["record"], "accepted", "{r}");
}
fn rejected(r: &J, why: &str) {
    assert_eq!(r["record"], "rejected", "{r}");
    assert!(r["error"].as_str().unwrap().contains(why), "expected '{why}' in {r}");
}
/// Prepare a lot: plain note -> anchored lot of `qty` (+ plain change).
fn prepare(w: &mut W, h: &Holder, note: [u8; 32], total: u64, qty: u64, anchor: [u8; 32]) -> (J, [u8; 32]) {
    let mut outs = vec![AnchoredOutput { owner: h.key, amount: qty, anchor }];
    if total > qty {
        outs.push(AnchoredOutput { owner: h.key, amount: total - qty, anchor: NO_ANCHOR });
    }
    let t = Anchored::unsigned(w.asset, vec![note], outs).unwrap().sign(&h.sk, &w.domain);
    let r = w.apply(&t.encode(), &[rnd()]);
    let lot = id(&r["detail"]["outputs"][0]);
    (r, lot)
}
fn sale(w: &W, seller: &Holder, lot: [u8; 32], qty: u64, buyer: [u8; 32], buyer_anchor: [u8; 32]) -> Vec<u8> {
    Sale::unsigned(w.asset, lot, qty, buyer, buyer_anchor, [5u8; 32], [6u8; 32]).unwrap().sign(&seller.sk, &w.domain).encode()
}

#[test]
fn plain_notes_and_existing_records_are_unchanged() {
    let mut w = W::new();
    let (a, b) = (holder(), holder());
    let n = w.credit(a.key, 1_000);
    assert!(w.note(&n).unwrap().anchor.is_none());
    // XP1 needs no native input of any kind (existing behaviour), via the legacy apply() too.
    let t = public::Transfer::build(w.asset, vec![n], vec![PublicOutput { owner: b.key, amount: 1_000 }], &a.sk, &w.domain).unwrap();
    let r = w.pool.apply(Some(&t.encode()), &hex::encode(rnd()), 9, &w.vks);
    accepted(&r);
    w.invariant();
}

#[test]
fn market_records_wait_for_the_activation_height() {
    // One coordinated switch (ACTIVATION.md, owner 31 Oct 2026): before the height, and when none is set, XA1 and XL1 are
    // ignored exactly as a reader without the market rules ignores them, so the note stays plain and old readers agree.
    let mut w = W::new();
    let a = holder();
    let n = w.credit(a.key, 1_000);
    let t = Anchored::unsigned(w.asset, vec![n], vec![AnchoredOutput { owner: a.key, amount: 1_000, anchor: rnd() }]).unwrap().sign(&a.sk, &w.domain);
    w.pool.market_from = None;
    let r = w.apply(&t.encode(), &[rnd()]);
    assert_eq!(r["record"], "ignored", "{r}");
    w.pool.market_from = Some(w.height + 3);
    let r = w.apply(&t.encode(), &[rnd()]);
    assert_eq!(r["record"], "ignored", "{r}");
    let r = w.apply(&sale(&w, &a, n, 1_000, a.key, rnd()), &[rnd()]);
    assert_eq!(r, serde_json::json!({"record":"ignored"}), "exactly what a reader without the market rules answers");
    assert!(w.note(&n).unwrap().anchor.is_none(), "below the height the note is untouched");
    let r = w.apply(&t.encode(), &[rnd()]);
    accepted(&r);
    assert!(w.note(&n).is_none(), "at the height the record applies");
    w.invariant();
    assert_eq!(market::activation("stagenet"), Some(0));
    assert_eq!(market::activation("offline-fakechain"), Some(0));
    assert_eq!(market::activation("mainnet"), market::MAINNET_ACTIVATION);
    assert_eq!(market::activation("testnet"), None);
}

#[test]
fn prepare_lot_creates_an_anchored_note_and_plain_change() {
    let mut w = W::new();
    let a = holder();
    let n = w.credit(a.key, 1_000);
    let ki = rnd();
    let (r, lot) = prepare(&mut w, &a, n, 1_000, 300, ki);
    accepted(&r);
    assert_eq!(r["kind"], "anchored-transfer");
    let lot_note = w.note(&lot).unwrap();
    assert_eq!(lot_note.anchor.as_deref(), Some(hex::encode(ki).as_str()));
    assert_eq!(lot_note.amount, 300);
    let change = w.note(&id(&r["detail"]["outputs"][1])).unwrap();
    assert!(change.anchor.is_none());
    assert_eq!(change.amount, 700);
    w.invariant();
}

/// Every record kind that can consume a public note must present the anchor key image.
#[test]
fn every_consumption_path_requires_the_anchor_key_image() {
    let mut w = W::new();
    let (a, b) = (holder(), holder());
    let ki = rnd();
    let other = rnd();
    let n = w.credit(a.key, 1_000);
    let (_, lot) = prepare(&mut w, &a, n, 1_000, 1_000, ki);
    // XP1 (ordinary Open send) — the dishonest-seller equivocation path of the retained witness 1
    let xp1 = public::Transfer::build(w.asset, vec![lot], vec![PublicOutput { owner: b.key, amount: 1_000 }], &a.sk, &w.domain).unwrap().encode();
    rejected(&w.apply(&xp1, &[]), "anchor key image");
    rejected(&w.apply(&xp1, &[other]), "anchor key image");
    // XR1 (burn / redemption)
    let xr1 = public::Burn::build(w.asset, vec![lot], 400, PublicOutput { owner: a.key, amount: 600 }, [3u8; 32], &a.sk, &w.domain).unwrap().encode();
    rejected(&w.apply(&xr1, &[other]), "anchor key image");
    // XS1 (Make private)
    let key = token_spend_key(&a.root, 0);
    let (xs1, _) = shield::Shield::build(w.asset, vec![lot], 1_000, 1_000, &shielded_address(&key), &a.sk, output_pk(), &w.domain).unwrap();
    rejected(&w.apply(&xs1.encode(), &[other]), "anchor key image");
    // XA1 (cancel / re-anchor / split)
    let xa1 = Anchored::unsigned(w.asset, vec![lot], vec![AnchoredOutput { owner: a.key, amount: 1_000, anchor: NO_ANCHOR }]).unwrap().sign(&a.sk, &w.domain).encode();
    rejected(&w.apply(&xa1, &[other]), "anchor key image");
    // XL1 (sale)
    let xl1 = sale(&w, &a, lot, 1_000, b.key, rnd());
    rejected(&w.apply(&xl1, &[other]), "anchor key image");
    // Nothing above changed the lot.
    assert!(w.note(&lot).is_some());
    w.invariant();
    // Each path IS admissible with the key image (each on a fresh copy of the pool).
    for (wire, kind) in [(xp1, "public-transfer"), (xr1, "public-burn"), (xs1.encode(), "shield"), (xa1, "anchored-transfer"), (xl1, "lot-sale")] {
        let mut copy = W { pool: w.pool.clone(), vks: Vks { spend: w.vks.spend.clone(), output: w.vks.output.clone(), issuer: w.vks.issuer }, domain: w.domain, issuer: w.issuer.clone(), asset: w.asset, height: w.height, binding: w.binding };
        let r = copy.apply(&wire, &[other, ki]);
        accepted(&r);
        assert_eq!(r["kind"], kind);
        assert!(copy.note(&lot).is_none());
        copy.invariant();
    }
}

#[test]
fn whole_lot_sale_rules() {
    let mut w = W::new();
    let (s, b, x) = (holder(), holder(), holder());
    let ki = rnd();
    let n = w.credit(s.key, 1_000);
    let (_, lot) = prepare(&mut w, &s, n, 1_000, 250, ki);
    let plain_change = w.pool.notes_of_owner(&s.key).into_iter().find(|(_, n)| n.anchor.is_none()).map(|(i, _)| i).unwrap();
    let plain = id(&J::String(plain_change));
    // a plain (unanchored) note can never be sold as a lot, whatever key images the carrier holds
    rejected(&w.apply(&sale(&w, &s, plain, 750, b.key, rnd()), &[ki, rnd()]), "not an anchored note");
    // whole lot only
    rejected(&w.apply(&sale(&w, &s, lot, 249, b.key, rnd()), &[ki]), "Whole lot only");
    rejected(&w.apply(&sale(&w, &s, lot, 251, b.key, rnd()), &[ki]), "Whole lot only");
    // wrong signer
    rejected(&w.apply(&sale(&w, &x, lot, 250, b.key, rnd()), &[ki]), "Seller signature rejected");
    // buyer must differ from the seller
    rejected(&w.apply(&sale(&w, &s, lot, 250, s.key, rnd()), &[ki]), "Buyer must differ");
    // wrong ledger domain
    let foreign = Sale::unsigned(w.asset, lot, 250, b.key, rnd(), [5u8; 32], [6u8; 32]).unwrap().sign(&s.sk, &[1u8; 32]).encode();
    rejected(&w.apply(&foreign, &[ki]), "Seller signature rejected");
    // malformed: zero offer / terms digests and truncated bytes are refused by the decoder
    assert!(Sale::unsigned(w.asset, lot, 250, b.key, rnd(), [0u8; 32], [6u8; 32]).is_err());
    let good = sale(&w, &s, lot, 250, b.key, rnd());
    rejected(&w.apply(&good[..good.len() - 1], &[ki]), "XL1 size/magic");
    // honest sale
    let buyer_anchor = rnd();
    let wire = sale(&w, &s, lot, 250, b.key, buyer_anchor);
    let r = w.apply(&wire, &[rnd(), ki]);
    accepted(&r);
    let got = w.note(&id(&r["detail"]["outputs"][0])).unwrap();
    assert_eq!((got.owner.as_str(), got.amount, got.anchor.as_deref()), (hex::encode(b.key).as_str(), 250, Some(hex::encode(buyer_anchor).as_str())));
    // replay of the identical record (even with the key image) cannot deliver twice
    rejected(&w.apply(&wire, &[ki]), "Lot already spent");
    w.invariant();
}

/// A sale record copied into a carrier WITHOUT the seller's anchor (front-running with the exact bytes)
/// is rejected and leaves no trace that could block the genuine carrier.
#[test]
fn front_run_copy_of_the_sale_record_is_rejected_and_does_not_block() {
    let mut w = W::new();
    let (s, b) = (holder(), holder());
    let ki = rnd();
    let n = w.credit(s.key, 900);
    let (_, lot) = prepare(&mut w, &s, n, 900, 900, ki);
    let wire = sale(&w, &s, lot, 900, b.key, rnd());
    rejected(&w.apply(&wire, &[rnd()]), "anchor key image");
    accepted(&w.apply(&wire, &[ki]));
    w.invariant();
}

/// Duplicate anchors are allowed: a squatter who copies the buyer's anchor key image into its own record
/// (e.g. after seeing the sale waiting in the pool) must not be able to make the sale token-invalid.
#[test]
fn anchor_squatting_cannot_invalidate_a_sale() {
    let mut w = W::new();
    let (s, b, q) = (holder(), holder(), holder());
    let (ki, buyer_anchor) = (rnd(), rnd());
    let n = w.credit(s.key, 500);
    let (_, lot) = prepare(&mut w, &s, n, 500, 500, ki);
    let nq = w.credit(q.key, 10);
    // squatter anchors its own note to the buyer's future anchor key image, mined first
    let squat = Anchored::unsigned(w.asset, vec![nq], vec![AnchoredOutput { owner: q.key, amount: 10, anchor: buyer_anchor }]).unwrap().sign(&q.sk, &w.domain).encode();
    accepted(&w.apply(&squat, &[rnd()]));
    // and also squats the SELLER's anchor
    let nq2 = w.credit(q.key, 10);
    let squat2 = Anchored::unsigned(w.asset, vec![nq2], vec![AnchoredOutput { owner: q.key, amount: 10, anchor: ki }]).unwrap().sign(&q.sk, &w.domain).encode();
    accepted(&w.apply(&squat2, &[rnd()]));
    let r = w.apply(&sale(&w, &s, lot, 500, b.key, buyer_anchor), &[ki]);
    accepted(&r);
    w.invariant();
}

/// Split and merge of anchored notes: every anchored input's key image is required.
#[test]
fn anchored_split_and_merge() {
    let mut w = W::new();
    let a = holder();
    let (k1, k2, k3) = (rnd(), rnd(), rnd());
    let n1 = w.credit(a.key, 100);
    let n2 = w.credit(a.key, 200);
    let (_, l1) = prepare(&mut w, &a, n1, 100, 100, k1);
    let (_, l2) = prepare(&mut w, &a, n2, 200, 200, k2);
    let merge = Anchored::unsigned(w.asset, vec![l1, l2], vec![AnchoredOutput { owner: a.key, amount: 120, anchor: k3 }, AnchoredOutput { owner: a.key, amount: 80, anchor: NO_ANCHOR }, AnchoredOutput { owner: a.key, amount: 100, anchor: rnd() }]).unwrap().sign(&a.sk, &w.domain).encode();
    rejected(&w.apply(&merge, &[k1]), "anchor key image");
    rejected(&w.apply(&merge, &[k2]), "anchor key image");
    let r = w.apply(&merge, &[k2, k1]);
    accepted(&r);
    assert_eq!(r["detail"]["anchored"], 2);
    // conservation is enforced
    let ids: Vec<[u8; 32]> = w.pool.notes_of_owner(&a.key).iter().filter(|(_, n)| n.anchor.is_none()).map(|(i, _)| id(&J::String(i.clone()))).collect();
    let bad = Anchored::unsigned(w.asset, ids, vec![AnchoredOutput { owner: a.key, amount: 81, anchor: NO_ANCHOR }]).unwrap().sign(&a.sk, &w.domain).encode();
    rejected(&w.apply(&bad, &[]), "conserve");
    w.invariant();
}

/// Old/new version separation: an XP1 signature cannot be re-labelled as XA1 or XL1 authority, and the
/// new labels differ from every legacy label (legacy labels are untouched protocol bytes).
#[test]
fn signatures_do_not_cross_record_versions() {
    let mut w = W::new();
    let (a, b) = (holder(), holder());
    let n = w.credit(a.key, 50);
    let xp1 = public::Transfer::build(w.asset, vec![n], vec![PublicOutput { owner: b.key, amount: 50 }], &a.sk, &w.domain).unwrap();
    let mut forged = Anchored::unsigned(w.asset, vec![n], vec![AnchoredOutput { owner: b.key, amount: 50, anchor: NO_ANCHOR }]).unwrap();
    forged.sig = xp1.sig;
    rejected(&w.apply(&forged.encode(), &[]), "Owner signature rejected");
    for l in [market::ANCHOR_LABEL, market::SALE_LABEL] {
        assert_ne!(l, public::AUTH_LABEL);
        assert_ne!(l, public::ISSUER_LABEL);
    }
    assert_eq!(public::AUTH_LABEL, b"XMR20-UNSHIELDED-AUTH-v1\0", "legacy signing domain unchanged");
    accepted(&w.apply(&xp1.encode(), &[]));
}

/// The record sizes fit one carrier.
#[test]
fn market_record_sizes() {
    assert_eq!(Sale::BYTES, 268);
    assert_eq!(Anchored::wire_len(1, 2), 4 + 32 + 2 + 32 + 144 + 64);
    assert!(transport::framed_extra_len(Anchored::wire_len(4, 4)) <= transport::EXTRA_LIMIT);
    assert!(transport::framed_extra_len(Sale::BYTES) <= transport::EXTRA_LIMIT);
}

/// Offers: signature, ledger pins, time window, canonical bytes and withdrawal binding.
#[test]
fn offer_and_withdrawal_validation() {
    let w = W::new();
    let (s, x) = (holder(), holder());
    let genesis = [7u8; 32];
    let payout = "4".to_string() + &"A".repeat(94);
    let o = market::Offer::build(genesis, w.domain, w.asset.to_bytes(), rnd(), rnd(), &s.sk, 250, 120_000_000_000, 1_000, 2_000, payout.clone()).unwrap();
    let wire = o.encode();
    let back = market::Offer::decode(&wire).unwrap();
    assert_eq!(back.id(), o.id());
    back.verify(&genesis, &w.domain, 1_500).unwrap();
    assert!(back.verify(&genesis, &w.domain, 2_000).unwrap_err().to_string().contains("expired"));
    assert!(back.verify(&genesis, &w.domain, 600).unwrap_err().to_string().contains("future"));
    assert!(back.verify(&[8u8; 32], &w.domain, 1_500).unwrap_err().to_string().contains("another chain"));
    assert!(back.verify(&genesis, &[1u8; 32], 1_500).unwrap_err().to_string().contains("another ledger"));
    // tampered price
    let mut t = wire.clone();
    t[4 + 32 * 6 + 8] ^= 1;
    assert!(market::Offer::decode(&t).unwrap().verify(&genesis, &w.domain, 1_500).is_err());
    // trailing / truncated bytes
    let mut long = wire.clone();
    long.push(0);
    assert!(market::Offer::decode(&long).is_err());
    assert!(market::Offer::decode(&wire[..wire.len() - 1]).is_err());
    // lifetime limit and positivity
    assert!(market::Offer::build(genesis, w.domain, w.asset.to_bytes(), rnd(), rnd(), &s.sk, 1, 1, 0, market::MAX_OFFER_SECONDS + 1, payout.clone()).is_err());
    assert!(market::Offer::build(genesis, w.domain, w.asset.to_bytes(), rnd(), rnd(), &s.sk, 0, 1, 0, 10, payout.clone()).is_err());
    // withdrawal: only the seller, only this offer
    let wd = market::Withdraw::build(&o, &s.sk, 1_600).unwrap();
    market::Withdraw::decode(&wd.encode()).unwrap().verify(&o).unwrap();
    assert!(market::Withdraw::build(&o, &x.sk, 1_600).is_err());
    let o2 = market::Offer::build(genesis, w.domain, w.asset.to_bytes(), rnd(), rnd(), &s.sk, 250, 1, 1_000, 2_000, payout).unwrap();
    assert!(wd.verify(&o2).is_err());
}
