//! Trades by Monero address: XT1 rules, offline. trade_fixtures.json holds records signed by wallet2 itself and real wallet2 payments with
//! their transaction keys (made on a private fakechain with monero-wallet-rpc), so these
//! tests prove the core renders the same texts, accepts the signatures and reads payments exactly as Feather and Cake Wallet make
//! them. Run: cargo test --release --offline trade_tests
use super::*;
use crate::address::{self, Address, MAINNET};
use crate::penumbra::{self as pz, Circuit};
use crate::pool::{LotStatus, Pool, Vks};
use crate::trade::{self, Body, PaymentFacts, PaymentOutput, Terms, Trade};
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT as G, edwards::CompressedEdwardsY, scalar::Scalar, EdwardsPoint};
use decaf377_rdsa::{SigningKey, SpendAuth, VerificationKey};
use rand_core::{OsRng, RngCore};
use serde_json::Value as J;
use sha3::{Digest, Keccak256};
use std::collections::BTreeMap;

fn rnd() -> [u8; 32] {
    let mut r = [0u8; 32];
    OsRng.fill_bytes(&mut r);
    r
}
fn h32(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}
fn fixtures() -> J {
    serde_json::from_str(include_str!("trade_fixtures.json")).unwrap()
}
fn keys_of(tx_key: &str) -> Vec<[u8; 32]> {
    (0..tx_key.len() / 64).map(|i| h32(&tx_key[i * 64..i * 64 + 64])).collect()
}
fn outputs_of(p: &J) -> Vec<PaymentOutput> {
    p["outputs"].as_array().unwrap().iter().map(|o| PaymentOutput { key: h32(o["key"].as_str().unwrap()), ecdh: hex::decode(o["ecdh"].as_str().unwrap()).unwrap().try_into().unwrap(), commitment: h32(o["commitment"].as_str().unwrap()) }).collect()
}

#[test]
fn wallet2_records_render_the_same_texts_and_verify() {
    let f = fixtures();
    let domain = h32(f["domain"].as_str().unwrap());
    for r in f["records"].as_array().unwrap() {
        let wire = hex::decode(r["wire"].as_str().unwrap()).unwrap();
        let t = Trade::decode(&wire).unwrap();
        assert_eq!(t.encode(), wire, "{}", r["op"]);
        let terms = r.get("terms").map(|x| Terms {
            amount: x["amount"].as_str().unwrap().parse().unwrap(),
            price: x["price"].as_str().unwrap().parse().unwrap(),
            ticker: x["ticker"].as_str().unwrap().to_string(),
            seller: Address::decode(x["seller"].as_str().unwrap(), MAINNET).unwrap(),
        });
        if r["op"] == "claim" {
            assert!(matches!(t.body, Body::Claim { .. }));
            continue;
        }
        assert_eq!(t.body.text(&domain, MAINNET, terms.as_ref()).unwrap(), r["text"].as_str().unwrap(), "{}", r["op"]);
        t.verify_sig(&domain, MAINNET, terms.as_ref()).unwrap();
        // Another ledger: refused (the code pins the domain).
        let mut other = domain;
        other[0] ^= 1;
        assert!(t.verify_sig(&other, MAINNET, terms.as_ref()).is_err(), "{}", r["op"]);
        if let Some(t2) = &terms {
            assert_eq!(t.body.pay_amount(t2.price, &domain).unwrap().to_string(), r["pay"].as_str().unwrap());
            // The same signature over other lot terms: refused.
            let mut t3 = t2.clone();
            t3.price += 1;
            assert!(t.verify_sig(&domain, MAINNET, Some(&t3)).is_err());
        }
    }
}

#[test]
fn wallet2_payments_read_like_check_tx_key() {
    let f = fixtures();
    for p in f["payments"].as_array().unwrap() {
        let to = Address::decode(p["address"].as_str().unwrap(), MAINNET).unwrap();
        let outs = outputs_of(p);
        let keys = keys_of(p["txKey"].as_str().unwrap());
        assert_eq!(trade::paid_to(&to, &keys, &outs).unwrap().to_string(), p["amount"].as_str().unwrap(), "{}", p["txid"]);
        // Another address sees nothing; a forged amount field is refused by its commitment.
        let other = Address { sub: false, spend: (Scalar::from_bytes_mod_order(rnd()) * G).compress().0, view: (Scalar::from_bytes_mod_order(rnd()) * G).compress().0 };
        assert_eq!(trade::paid_to(&other, &keys, &outs).unwrap(), 0);
        let mut forged = outs.clone();
        for o in forged.iter_mut() {
            o.ecdh[0] ^= 1;
        }
        assert!(trade::paid_to(&to, &keys, &forged).is_err());
    }
}

// ---------------------------------------------------------------- pool rules with test signers and test payments
struct Signer {
    secret: Scalar,
    view_secret: Scalar,
    addr: Address,
}
fn signer() -> Signer {
    let secret = Scalar::from_bytes_mod_order(rnd());
    let view_secret = Scalar::from_bytes_mod_order(rnd());
    Signer { secret, view_secret, addr: Address { sub: false, spend: (secret * G).compress().0, view: (view_secret * G).compress().0 } }
}
fn sign(text: &str, s: &Signer, mode: u8) -> ([u8; 32], [u8; 32]) {
    let k = Scalar::from_bytes_mod_order_wide(&{
        let mut b = [0u8; 64];
        OsRng.fill_bytes(&mut b);
        b
    });
    let h = address::message_hash(text.as_bytes(), &s.addr.spend, &s.addr.view, mode);
    let rp = (k * G).compress();
    let mut kk = Keccak256::new();
    kk.update(h);
    kk.update(s.addr.spend);
    kk.update(rp.as_bytes());
    let c = Scalar::from_bytes_mod_order(kk.finalize().into());
    let x = if mode == 0 { s.secret } else { s.view_secret };
    (c.to_bytes(), (k - c * x).to_bytes())
}
fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut k = Keccak256::new();
    for p in parts {
        k.update(p);
    }
    k.finalize().into()
}
/// A payment as a sending wallet builds it: one output of `amount` to `to` (index 0) and one decoy output; returns the facts and
/// the transaction key.
fn payment(to: &Address, amount: u64, height: u64) -> (PaymentFacts, [u8; 32]) {
    let r = Scalar::from_bytes_mod_order(rnd());
    let v = CompressedEdwardsY(to.view).decompress().unwrap();
    let b = CompressedEdwardsY(to.spend).decompress().unwrap();
    let h: EdwardsPoint = CompressedEdwardsY(h32("8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94")).decompress().unwrap();
    let d = (r * v).mul_by_cofactor().compress();
    let s = Scalar::from_bytes_mod_order(keccak(&[d.as_bytes(), &[0u8]]));
    let pad = keccak(&[b"amount", s.as_bytes()]);
    let mut ecdh = amount.to_le_bytes();
    for j in 0..8 {
        ecdh[j] ^= pad[j];
    }
    let mask = Scalar::from_bytes_mod_order(keccak(&[b"commitment_mask", s.as_bytes()]));
    let out = PaymentOutput { key: (s * G + b).compress().0, ecdh, commitment: (mask * G + Scalar::from(amount) * h).compress().0 };
    let decoy = PaymentOutput { key: (Scalar::from_bytes_mod_order(rnd()) * G).compress().0, ecdh: [7; 8], commitment: (Scalar::from_bytes_mod_order(rnd()) * G).compress().0 };
    (PaymentFacts { txid: rnd(), height, outputs: vec![out, decoy] }, r.to_bytes())
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
impl W {
    fn new(active: Option<u64>) -> Self {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../params/test-v2/manifest.json");
        let m: J = serde_json::from_slice(&std::fs::read(p).expect("test-v2 manifest")).unwrap();
        let (s, o) = (m["config"]["spend_vk"].as_str().unwrap().to_string(), m["config"]["output_vk"].as_str().unwrap().to_string());
        let issuer = SigningKey::<SpendAuth>::new(OsRng);
        let mut cfg = Config { chain: hex::encode([7u8; 32]), domain: String::new(), spend_vk: s.clone(), output_vk: o.clone(), issuer_vk: hex::encode(VerificationKey::from(&issuer).to_bytes()) };
        cfg.domain = hex::encode(cfg.computed_domain().unwrap());
        let domain = cfg.domain().unwrap();
        let vks = Vks { spend: pz::read_vk(Circuit::Spend, &s).unwrap(), output: pz::read_vk(Circuit::Output, &o).unwrap(), issuer: VerificationKey::from(&issuer) };
        let mut pool = Pool::new(domain);
        pool.market_from = Some(0);
        pool.address_moves = Some(address::Activation { from: 0, net: MAINNET });
        pool.trades = active.map(|from| address::Activation { from, net: MAINNET });
        Self { pool, vks, domain, issuer, asset: asset_for_mint("TestMint1111111111111111111111111111111111").unwrap(), height: 1, binding: 0 }
    }
    /// One record in its own block (claims settle at the end of it, with `payments`).
    fn block(&mut self, wire: &[u8], payments: &[PaymentFacts]) -> J {
        let framed = transport::frame(wire, &[9u8; 32]).unwrap();
        assert!(framed.len() <= transport::EXTRA_LIMIT);
        self.height += 1;
        let r = self.pool.apply_carrier(Some(wire), &hex::encode(rnd()), self.height, &[rnd()], &self.vks);
        if self.pool.pending_claims.is_empty() {
            return r;
        }
        let map: BTreeMap<[u8; 32], PaymentFacts> = payments.iter().map(|p| (p.txid, p.clone())).collect();
        self.pool.resolve_claims(self.height, &map).into_iter().next().unwrap()
    }
    fn credit(&mut self, owner: [u8; 32], amount: u64) {
        self.binding += 1;
        let c = public::Credit::build(public::KIND_DEPOSIT, self.asset, amount, owner, [self.binding; 32], &self.issuer, &self.domain).unwrap();
        assert_eq!(self.block(&c.encode(), &[])["record"], "accepted");
    }
    fn balance(&self, owner: &[u8; 32]) -> u128 {
        self.pool.public_balances(owner).values().sum()
    }
    fn signed(&self, body: Body, s: &Signer, terms: Option<&Terms>, mode: u8) -> Vec<u8> {
        let (c, r) = sign(&body.text(&self.domain, MAINNET, terms).unwrap(), s, mode);
        Trade { body, variant: 0, c, r }.encode()
    }
    fn list(&self, s: &Signer, amount: u64, price: u64, until: u64) -> Vec<u8> {
        let notes: Vec<[u8; 32]> = self.pool.notes.iter().filter(|(_, n)| n.owner == hex::encode(s.addr.owner())).map(|(id, _)| *id).collect();
        self.signed(Body::List { asset: self.asset, until: until as u32, inputs: notes, amount, price, ticker: "XMR20".into(), seller: s.addr }, s, None, 0)
    }
    fn terms(&self, lot: &[u8; 32]) -> Terms {
        let l = &self.pool.lots[lot];
        Terms { amount: l.amount, price: l.price, ticker: l.ticker.clone(), seller: l.seller }
    }
    fn reserve(&self, b: &Signer, lot: [u8; 32], pay_by: u64) -> (Vec<u8>, u64) {
        let body = Body::Reserve { lot, pay_by: pay_by as u32, buyer: b.addr };
        let t = self.terms(&lot);
        let pay = body.pay_amount(t.price, &self.domain).unwrap();
        (self.signed(body, b, Some(&t), 0), pay)
    }
}
fn ok(r: &J) {
    assert!(r["record"] == "accepted" || r["record"] == "pending", "{r}");
}
fn refused(r: &J, why: &str) {
    assert_eq!(r["record"], "rejected", "{r}");
    assert!(r["error"].as_str().unwrap().contains(why), "expected '{why}' in {r}");
}
fn claim(lot: [u8; 32], f: &PaymentFacts, key: [u8; 32]) -> Vec<u8> {
    Body::Claim { lot, txid: f.txid, keys: vec![key] }.bytes()
}

#[test]
fn list_reserve_pay_claim_moves_the_lot_to_the_buyer() {
    let mut w = W::new(Some(0));
    let (s, b) = (signer(), signer());
    w.credit(s.addr.owner(), 5_000_000_000);
    let list = w.list(&s, 1_000_000_000, 300_000_000_000, 1000);
    let r = w.block(&list, &[]);
    ok(&r);
    let lot = public::record_id(&list);
    assert_eq!(w.balance(&s.addr.owner()), 4_000_000_000);
    assert_eq!(w.balance(&trade::lot_owner(&lot)), 1_000_000_000, "the lot holds the listed amount");
    let (res, pay) = w.reserve(&b, lot, w.height + 10);
    ok(&w.block(&res, &[]));
    assert!(pay > 300_000_000_000 && pay < 300_001_000_000);
    // Paid at once: the payment in the same block as the reservation counts.
    let (f, key) = payment(&s.addr, pay, w.height);
    let r = w.block(&claim(lot, &f, key), &[f.clone()]);
    assert_eq!(r["record"], "accepted", "{r}");
    assert_eq!(w.balance(&b.addr.owner()), 1_000_000_000);
    assert_eq!(w.balance(&trade::lot_owner(&lot)), 0);
    assert_eq!(w.pool.lots[&lot].status, LotStatus::Sold);
    assert!(w.pool.invariant().0);
    // The same payment never claims again, here or for another lot.
    refused(&w.block(&claim(lot, &f, key), &[f.clone()]), "already sold");
}

#[test]
fn refused_trades() {
    let mut w = W::new(Some(0));
    let (s, b, o) = (signer(), signer(), signer());
    w.credit(s.addr.owner(), 5_000_000_000);
    // A view-key signature and another wallet's signature never list.
    let notes: Vec<[u8; 32]> = w.pool.notes.keys().copied().collect();
    let body = Body::List { asset: w.asset, until: 1000, inputs: notes.clone(), amount: 1_000_000, price: 1000, ticker: "XMR20".into(), seller: s.addr };
    refused(&w.block(&w.signed(body.clone(), &s, None, 1), &[]), "Invalid trade signature");
    refused(&w.block(&w.signed(body.clone(), &o, None, 0), &[]), "Invalid trade signature");
    let mut taken = body.clone();
    if let Body::List { seller, .. } = &mut taken {
        *seller = o.addr;
    }
    refused(&w.block(&w.signed(taken, &o, None, 0), &[]), "do not belong to the signing address");
    let list = w.list(&s, 1_000_000_000, 100_000_000, w.height + 100);
    ok(&w.block(&list, &[]));
    let lot = public::record_id(&list);
    // The seller cannot reserve; a reservation must be short and in the future.
    refused(&w.block(&w.reserve(&s, lot, w.height + 5).0, &[]), "cannot reserve their own lot");
    refused(&w.block(&w.reserve(&b, lot, w.height + 40).0, &[]), "at most 30 blocks");
    refused(&w.block(&w.reserve(&b, lot, w.height).0, &[]), "ran out before it was posted");
    let (res, pay) = w.reserve(&b, lot, w.height + 6);
    ok(&w.block(&res, &[]));
    let reserved_at = w.height;
    // While it runs: nobody else reserves, the seller cannot cancel.
    refused(&w.block(&w.reserve(&o, lot, w.height + 5).0, &[]), "reserved by someone else");
    let cancel = w.signed(Body::Cancel { lot, seller: s.addr }, &s, None, 0);
    refused(&w.block(&cancel, &[]), "reserved until block");
    // Payment before the reservation, wrong amount, wrong key, missing payment.
    let (short, k2) = payment(&s.addr, 100_000_000, w.height);
    refused(&w.block(&claim(lot, &short, k2), &[short.clone()]), "needs exactly");
    let (good, k3) = payment(&s.addr, pay, w.height);
    refused(&w.block(&claim(lot, &good, Scalar::from_bytes_mod_order(rnd()).to_bytes()), &[good.clone()]), "does not show a payment");
    refused(&w.block(&claim(lot, &good, [0xff; 32]), &[good.clone()]), "not a valid transaction key");
    refused(&w.block(&claim(lot, &good, k3), &[]), "not on this chain");
    let (other_addr, k4) = payment(&o.addr, pay, w.height);
    refused(&w.block(&claim(lot, &other_addr, k4), &[other_addr.clone()]), "does not show a payment");
    // A late payment for a lapsed reservation never claims for the NEXT reservation (the exact amount differs).
    while w.height <= reserved_at + 6 {
        w.height += 1;
    }
    let (res2, pay2) = w.reserve(&o, lot, w.height + 5);
    ok(&w.block(&res2, &[]));
    assert_ne!(pay, pay2);
    let (late, k5) = payment(&s.addr, pay, w.height + 1);
    refused(&w.block(&claim(lot, &late, k5), &[late.clone()]), "needs exactly");
    // After the second reservation lapses, the seller cancels; the tokens return; nothing can be claimed any more.
    w.height += 6;
    let cancel = w.signed(Body::Cancel { lot, seller: s.addr }, &s, None, 0);
    ok(&w.block(&cancel, &[]));
    assert_eq!(w.balance(&s.addr.owner()), 5_000_000_000);
    let (g2, k6) = payment(&s.addr, pay2, w.height);
    refused(&w.block(&claim(lot, &g2, k6), &[g2.clone()]), "was cancelled");
    assert!(w.pool.invariant().0);
}

#[test]
fn a_late_payment_claims_when_nobody_reserved_since_and_two_claims_in_one_block_settle_in_order() {
    let mut w = W::new(Some(0));
    let (s, b, o) = (signer(), signer(), signer());
    w.credit(s.addr.owner(), 2_000_000_000);
    let list = w.list(&s, 1_000_000_000, 5_000, w.height + 100);
    ok(&w.block(&list, &[]));
    let lot = public::record_id(&list);
    let (res, pay) = w.reserve(&b, lot, w.height + 2);
    ok(&w.block(&res, &[]));
    w.height += 5;
    let (late, k) = payment(&s.addr, pay, w.height);
    assert_eq!(w.block(&claim(lot, &late, k), &[late.clone()])["record"], "accepted");
    assert_eq!(w.balance(&b.addr.owner()), 1_000_000_000);
    // Second lot: two claims in one block — the first settles, the second finds the lot sold.
    let list2 = w.list(&s, 1_000_000_000, 7_000, w.height + 100);
    ok(&w.block(&list2, &[]));
    let lot2 = public::record_id(&list2);
    let (res2, pay2) = w.reserve(&o, lot2, w.height + 5);
    ok(&w.block(&res2, &[]));
    let (p1, k1) = payment(&s.addr, pay2, w.height + 1);
    let (p2, k2) = payment(&s.addr, pay2, w.height + 1);
    w.height += 1;
    let mut payments = BTreeMap::new();
    payments.insert(p1.txid, p1.clone());
    payments.insert(p2.txid, p2.clone());
    let h = w.height;
    assert_eq!(w.pool.apply_carrier(Some(&claim(lot2, &p1, k1)), "aa", h, &[rnd()], &w.vks)["record"], "pending");
    assert_eq!(w.pool.apply_carrier(Some(&claim(lot2, &p2, k2)), "bb", h, &[rnd()], &w.vks)["record"], "pending");
    let out = w.pool.resolve_claims(h, &payments);
    assert_eq!(out[0]["record"], "accepted");
    assert_eq!(out[1]["record"], "rejected");
    assert!(out[1]["error"].as_str().unwrap().contains("already sold"));
    assert_eq!(w.balance(&o.addr.owner()), 1_000_000_000);
    assert!(w.pool.invariant().0);
}

#[test]
fn xt1_is_ignored_until_activation_and_lot_notes_move_only_by_xt1() {
    let mut w = W::new(Some(10));
    let s = signer();
    w.credit(s.addr.owner(), 1_000_000);
    let list = w.list(&s, 1_000_000, 1000, 500);
    assert_eq!(w.block(&list, &[])["record"], "ignored");
    w.height = 20;
    ok(&w.block(&w.list(&s, 1_000_000, 1000, 500), &[]));
    // The lot note's owner is no address: an XW1 move signed by the seller cannot take it.
    let lot_note = *w.pool.lots.values().next().map(|l| &l.note).unwrap();
    let mv = address::Move { asset: w.asset, until: 500, inputs: vec![lot_note], to: vec![(address::Recipient::Address(s.addr), 1_000_000)], fee_owner: [0; 32], fee: 0, change: 0, flags: address::FLAG_FEE_IN_XMR, signer: s.addr, ticker: "XMR20".into(), variant: 0, c: [0; 32], r: [0; 32] };
    let (c, r) = sign(&mv.text(&w.domain, MAINNET), &s, 0);
    let mut mv = mv;
    mv.c = c;
    mv.r = r;
    refused(&w.block(&mv.encode(), &[]), "do not belong to the signing address");
    let none = W::new(None);
    assert!(none.pool.trades.is_none());
}

#[test]
fn records_fit_one_carrier() {
    let w = W::new(Some(0));
    let s = signer();
    let list = w.signed(Body::List { asset: w.asset, until: 1, inputs: vec![rnd(), rnd(), rnd(), rnd()], amount: 1, price: 1, ticker: "ABCDEFGHIJKL".into(), seller: s.addr }, &s, None, 0);
    let claim = Body::Claim { lot: rnd(), txid: rnd(), keys: (0..17).map(|_| rnd()).collect() }.bytes();
    for wire in [list, claim] {
        assert!(transport::frame(&wire, &[9u8; 32]).unwrap().len() <= transport::EXTRA_LIMIT, "{} bytes", wire.len());
        assert_eq!(Trade::decode(&wire).unwrap().encode(), wire);
    }
}

// ---------------------------------------------------------------- state hash over trade records
/// One record in its own block with the payments its reader fetched.
struct Step {
    wire: Vec<u8>,
    txid: String,
    height: u64,
    native: [u8; 32],
    payments: Vec<PaymentFacts>,
}
/// The block as a reader applies it: the record, then the end of the block (claims settle).
fn run(pool: &mut Pool, vks: &Vks, s: &Step) {
    pool.apply_carrier(Some(&s.wire), &s.txid, s.height, &[s.native], vks);
    let map: BTreeMap<[u8; 32], PaymentFacts> = s.payments.iter().map(|p| (p.txid, p.clone())).collect();
    pool.resolve_claims(s.height, &map);
}
fn changed(a: &[pool::StateSection], b: &[pool::StateSection]) -> Vec<&'static str> {
    a.iter().zip(b).filter(|(x, y)| x != y).map(|(x, _)| x.name).collect()
}

/// A lot listed, reserved, paid and claimed: every block moves exactly the sections it touches, a claim is part of the state
/// only between its record and the end of its block, and a pool built again from the same blocks (all of them, or only the
/// first few, as after a restart or a reorganisation) has the same state hash at every block.
#[test]
fn state_hash_follows_trades_and_every_replay_agrees() {
    let mut w = W::new(Some(0));
    let (s, b) = (signer(), signer());
    let fresh = |w: &W| {
        let mut p = Pool::new(w.domain);
        p.market_from = w.pool.market_from;
        p.address_moves = w.pool.address_moves;
        p.trades = w.pool.trades;
        p
    };
    let mut log: Vec<Step> = vec![];
    let mut seen = vec![w.pool.state_sections()];
    let mut block = |w: &mut W, wire: Vec<u8>, payments: Vec<PaymentFacts>, expect: &[&str]| {
        w.height += 1;
        let st = Step { wire, txid: hex::encode(rnd()), height: w.height, native: rnd(), payments };
        run(&mut w.pool, &w.vks, &st);
        log.push(st);
        let now = w.pool.state_sections();
        assert_eq!(changed(seen.last().unwrap(), &now), expect, "block {}", w.height);
        seen.push(now);
    };
    let credit = public::Credit::build(public::KIND_DEPOSIT, w.asset, 5_000_000_000, s.addr.owner(), [1; 32], &w.issuer, &w.domain).unwrap().encode();
    block(&mut w, credit.clone(), vec![], &["notes", "minted", "credits"]);
    let list = w.list(&s, 1_000_000_000, 300_000_000_000, 1000);
    let lot = public::record_id(&list);
    block(&mut w, list, vec![], &["notes", "spent-notes", "lots"]);
    let (res, pay) = w.reserve(&b, lot, w.height + 10);
    block(&mut w, res, vec![], &["lots"]);
    // a refused record (the credit again) leaves the state hash as it was
    block(&mut w, credit, vec![], &[]);
    let (f, key) = payment(&s.addr, pay, w.height);
    let claim_wire = claim(lot, &f, key);
    // inside the block the claim waits; the hash a reader publishes is taken after the block's end
    let mut inside = w.pool.clone();
    inside.apply_carrier(Some(&claim_wire), &hex::encode(rnd()), w.height + 1, &[rnd()], &w.vks);
    assert_eq!(changed(&w.pool.state_sections(), &inside.state_sections()), ["pending-claims"]);
    block(&mut w, claim_wire, vec![f], &["notes", "spent-notes", "lots", "used-payments"]);
    assert_eq!(w.pool.lots[&lot].status, LotStatus::Sold);
    assert_eq!(w.balance(&b.addr.owner()), 1_000_000_000);
    // every prefix of the blocks, replayed into a new pool, gives the hash the first pool had at that block
    for n in 0..=log.len() {
        let mut p = fresh(&w);
        for st in &log[..n] {
            run(&mut p, &w.vks, st);
        }
        assert_eq!(p.state_sections(), seen[n], "after {n} blocks");
        assert_eq!(hex::encode(p.state_hash()), hex::encode(pool::state_total(&seen[n])));
    }
    // without the payment the claim is refused and the state is the one before it
    let mut p = fresh(&w);
    for st in &log[..4] {
        run(&mut p, &w.vks, st);
    }
    run(&mut p, &w.vks, &Step { wire: log[4].wire.clone(), txid: log[4].txid.clone(), height: log[4].height, native: log[4].native, payments: vec![] });
    assert_eq!(p.state_sections(), seen[4]);
}

// ---------------------------------------------------------------- a trade for the reader's tests
/// trade_claim_fixture.json: one lot listed, reserved and paid on the offline test ledger (params/test-v2) whose issuer key
/// is the scalar 7, with the block of each record. The reader's tests need signed trade records and a payment and cannot
/// make them (the signing helpers are in this file), so they read this file. Signatures are made with fresh randomness: the
/// file is written once, with XMR20_WRITE_TRADE_FIXTURE=1, and this test checks that the kept one still settles.
const CLAIM_FIXTURE: &str = include_str!("trade_claim_fixture.json");
fn fixture_ledger() -> (Pool, Vks, [u8; 32], SigningKey<SpendAuth>) {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../params/test-v2/manifest.json");
    let m: J = serde_json::from_slice(&std::fs::read(p).expect("test-v2 manifest")).unwrap();
    let mut cfg: Config = serde_json::from_value(m["config"].clone()).unwrap();
    let issuer = SigningKey::<SpendAuth>::from(decaf377::Fr::from(7u64));
    cfg.issuer_vk = hex::encode(VerificationKey::from(&issuer).to_bytes());
    cfg.domain = hex::encode(cfg.computed_domain().unwrap());
    let domain = cfg.domain().unwrap();
    let vks = Vks { spend: pz::read_vk(Circuit::Spend, &cfg.spend_vk).unwrap(), output: pz::read_vk(Circuit::Output, &cfg.output_vk).unwrap(), issuer: VerificationKey::from(&issuer) };
    let mut pool = Pool::new(domain);
    pool.market_from = market::activation("offline-fakechain");
    pool.address_moves = address::activation("offline-fakechain");
    pool.trades = trade::activation("offline-fakechain");
    (pool, vks, domain, issuer)
}
/// Apply the fixture as a reader does and return the result of its claim.
fn settle_fixture(f: &J) -> J {
    let (mut pool, vks, domain, _) = fixture_ledger();
    assert_eq!(f["domain"], hex::encode(domain));
    for k in ["credit", "list", "reserve"] {
        let r = pool.apply_carrier(Some(&hex::decode(f[k]["wire"].as_str().unwrap()).unwrap()), &hex::encode([f[k]["height"].as_u64().unwrap() as u8; 32]), f[k]["height"].as_u64().unwrap(), &[], &vks);
        assert_eq!(r["record"], "accepted", "{k}: {r}");
    }
    let facts = trade::facts_from_json(&f["payment"]).unwrap();
    let keys: Vec<[u8; 32]> = f["claimKeys"].as_array().unwrap().iter().map(|k| h32(k.as_str().unwrap())).collect();
    let lot = h32(f["lot"].as_str().unwrap());
    assert_eq!(pool.lots[&lot].reservations[0].pay.to_string(), f["pay"].as_str().unwrap());
    let wire = Body::Claim { lot, txid: facts.txid, keys }.bytes();
    let h = f["claimHeight"].as_u64().unwrap();
    assert_eq!(pool.apply_carrier(Some(&wire), &hex::encode([9u8; 32]), h, &[], &vks)["record"], "pending");
    let r = pool.resolve_claims(h, &BTreeMap::from([(facts.txid, facts)])).remove(0);
    if r["record"] == "accepted" {
        assert_eq!(pool.lots[&lot].status, LotStatus::Sold);
        assert_eq!(pool.public_balances(&h32(f["buyerOwner"].as_str().unwrap())).values().sum::<u128>().to_string(), f["amount"].as_str().unwrap());
    }
    r
}
#[test]
fn the_trade_fixture_of_the_reader_tests_settles() {
    if std::env::var("XMR20_WRITE_TRADE_FIXTURE").as_deref() == Ok("1") {
        let (mut pool, vks, domain, issuer) = fixture_ledger();
        let (s, b) = (signer(), signer());
        let asset = asset_for_mint("TestMint1111111111111111111111111111111111").unwrap();
        let (amount, price) = (1_000_000_000u64, 300_000_000_000u64);
        let credit = public::Credit::build(public::KIND_DEPOSIT, asset, 5_000_000_000, s.addr.owner(), [1; 32], &issuer, &domain).unwrap().encode();
        assert_eq!(pool.apply_carrier(Some(&credit), &hex::encode([1u8; 32]), 718, &[], &vks)["record"], "accepted");
        let inputs: Vec<[u8; 32]> = pool.notes.keys().copied().collect();
        let body = Body::List { asset, until: 5000, inputs, amount, price, ticker: "XMR20".into(), seller: s.addr };
        let (c, r) = sign(&body.text(&domain, MAINNET, None).unwrap(), &s, 0);
        let list = Trade { body, variant: 0, c, r }.encode();
        let lot = public::record_id(&list);
        let body = Body::Reserve { lot, pay_by: 745, buyer: b.addr };
        let terms = Terms { amount, price, ticker: "XMR20".into(), seller: s.addr };
        let pay = body.pay_amount(price, &domain).unwrap();
        let (c, r) = sign(&body.text(&domain, MAINNET, Some(&terms)).unwrap(), &b, 0);
        let reserve = Trade { body, variant: 0, c, r }.encode();
        let (facts, key) = payment(&s.addr, pay, 720);
        let made = serde_json::json!({
            "about": "A lot listed, reserved and paid on the offline test ledger (params/test-v2 with the issuer key of scalar 7), for the reader's tests. Written by core/src/trade_tests.rs.",
            "domain": hex::encode(domain),
            "credit": {"height": 718, "wire": hex::encode(&credit)},
            "list": {"height": 719, "wire": hex::encode(&list)},
            "reserve": {"height": 719, "wire": hex::encode(&reserve)},
            "lot": hex::encode(lot),
            "pay": pay.to_string(),
            "amount": amount.to_string(),
            "buyerOwner": hex::encode(b.addr.owner()),
            "claimKeys": [hex::encode(key)],
            "claimHeight": 720,
            "payment": trade::facts_to_json(&facts),
        });
        assert_eq!(settle_fixture(&made)["record"], "accepted");
        std::fs::write(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/trade_claim_fixture.json"), serde_json::to_string_pretty(&made).unwrap() + "\n").unwrap();
        return;
    }
    let f: J = serde_json::from_str(CLAIM_FIXTURE).unwrap();
    let r = settle_fixture(&f);
    assert_eq!(r["record"], "accepted", "{r}");
    // the same claim without its payment is refused
    let mut none = f.clone();
    none["payment"]["outputs"] = serde_json::json!([]);
    assert_eq!(settle_fixture(&none)["record"], "rejected");
}
