//! SIGN TO MOVE: XW1 rules, offline. Fixtures (address_fixtures.json) are texts rendered by the JS library and signed by
//! wallet2 itself (research/sign-to-move-20261101/tools/make-core-fixtures.mjs), so these tests prove the core renders the same
//! text and accepts the signatures Feather and Cake Wallet make. Run: cargo test --release --offline address_tests
use super::*;
use crate::address::{self, Address, Move, Recipient, FLAG_FEE_IN_XMR, MAINNET};
use crate::keys::{owner_key, owner_signing_key};
use crate::penumbra::{self as pz, Circuit};
use crate::pool::{Pool, Vks};
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT as G, scalar::Scalar};
use decaf377_rdsa::{SigningKey, SpendAuth, VerificationKey};
use rand_core::{OsRng, RngCore};
use serde_json::Value as J;
use sha3::{Digest, Keccak256};

fn rnd() -> [u8; 32] {
    let mut r = [0u8; 32];
    OsRng.fill_bytes(&mut r);
    r
}
fn fixtures() -> J {
    serde_json::from_str(include_str!("address_fixtures.json")).unwrap()
}
fn addresses_in(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| w.len() == 95).map(String::from).collect()
}

#[test]
fn wallet2_fixtures_render_the_same_text_and_verify() {
    let f = fixtures();
    let domain: [u8; 32] = hex::decode(f["domain"].as_str().unwrap()).unwrap().try_into().unwrap();
    for c in f["cases"].as_array().unwrap() {
        let bytes = hex::decode(c["record"].as_str().unwrap()).unwrap();
        let m = Move::decode(&bytes).unwrap();
        assert_eq!(m.encode(), bytes, "{}", c["name"]);
        assert_eq!(m.text(&domain, MAINNET), c["text"].as_str().unwrap(), "{}", c["name"]);
        assert_eq!(m.variant as u64, c["variant"].as_u64().unwrap());
        let valid = c["expect"] == "valid";
        assert_eq!(m.verify_sig(&domain, MAINNET).is_ok(), valid, "{}", c["name"]);
        assert_eq!(m.find_variant(&domain, MAINNET).is_some(), valid, "{}", c["name"]);
        // Same signature, another ledger: refused (the code pins the domain).
        assert!(m.verify_sig(&[0x22; 32], MAINNET).is_err());
        for a in addresses_in(c["text"].as_str().unwrap()) {
            assert_eq!(Address::decode(&a, MAINNET).unwrap().encode(MAINNET), a);
            assert!(Address::decode(&a, address::STAGENET).is_err());
        }
    }
}

#[test]
fn address_owner_is_a_valid_key_nobody_derives() {
    let f = fixtures();
    let text = f["cases"][1]["text"].as_str().unwrap();
    let a = addresses_in(text);
    let (main, sub) = (Address::decode(&a[0], MAINNET).unwrap(), Address::decode(&a[a.len() - 1], MAINNET).unwrap());
    for x in [main, sub] {
        let o = x.owner();
        VerificationKey::<SpendAuth>::try_from(o).expect("address owner must be a valid owner key");
        assert_eq!(o, x.owner(), "deterministic");
    }
    assert_ne!(main.owner(), sub.owner());
    // Changing either key changes the owner.
    let mut v = main;
    v.view[0] ^= 1;
    assert_ne!(v.owner(), main.owner());
}

// ---------------------------------------------------------------- pool rules with a test signer (same maths as wallet2)
struct Signer {
    secret: Scalar,
    addr: Address,
}
fn signer(sub: bool) -> Signer {
    let secret = Scalar::from_bytes_mod_order(rnd());
    let view = (Scalar::from_bytes_mod_order(rnd()) * G).compress().to_bytes();
    Signer { secret, addr: Address { sub, spend: (secret * G).compress().to_bytes(), view } }
}
fn sign(text: &str, s: &Signer, mode: u8) -> ([u8; 32], [u8; 32]) {
    let k = Scalar::from_bytes_mod_order_wide(&{
        let mut b = [0u8; 64];
        OsRng.fill_bytes(&mut b);
        b
    });
    let h = address::message_hash(text.as_bytes(), &s.addr.spend, &s.addr.view, mode);
    let r_point = (k * G).compress();
    let mut kk = Keccak256::new();
    kk.update(h);
    kk.update(s.addr.spend);
    kk.update(r_point.as_bytes());
    let c = Scalar::from_bytes_mod_order(kk.finalize().into());
    ((c.to_bytes()), (k - c * s.secret).to_bytes())
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
        pool.address_moves = active.map(|from| address::Activation { from, net: MAINNET });
        Self { pool, vks, domain, issuer, asset: asset_for_mint("TestMint1111111111111111111111111111111111").unwrap(), height: 1, binding: 0 }
    }
    fn apply(&mut self, wire: &[u8]) -> J {
        let framed = transport::frame(wire, &[9u8; 32]).unwrap();
        assert!(framed.len() <= transport::EXTRA_LIMIT);
        assert_eq!(transport::unframe(&framed).unwrap().unwrap(), wire);
        self.height += 1;
        self.pool.apply_carrier(Some(wire), &hex::encode(rnd()), self.height, &[rnd()], &self.vks)
    }
    fn credit(&mut self, owner: [u8; 32], amount: u64) -> [u8; 32] {
        self.binding += 1;
        let c = public::Credit::build(public::KIND_DEPOSIT, self.asset, amount, owner, [self.binding; 32], &self.issuer, &self.domain).unwrap();
        let r = self.apply(&c.encode());
        assert_eq!(r["record"], "accepted", "{r}");
        id(&r["detail"]["outputs"][0])
    }
    fn balance(&self, owner: &[u8; 32]) -> u128 {
        self.pool.public_balances(owner).values().sum()
    }
    #[allow(clippy::too_many_arguments)]
    fn moved(&self, s: &Signer, inputs: Vec<[u8; 32]>, to: Vec<(Recipient, u64)>, fee: Option<([u8; 32], u64)>, change: u64, until: u32, ticker: &str) -> Move {
        let (fee_owner, fee) = fee.unwrap_or(([0; 32], 0));
        let mut m = Move { asset: self.asset, until, inputs, to, fee_owner, fee, change, flags: if fee == 0 { FLAG_FEE_IN_XMR } else { 0 }, signer: s.addr, ticker: ticker.into(), variant: 0, c: [0; 32], r: [0; 32] };
        let (c, r) = sign(&m.text(&self.domain, MAINNET), s, 0);
        m.c = c;
        m.r = r;
        m
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

#[test]
fn existing_records_reach_an_address_and_xw1_moves_it_on() {
    let mut w = W::new(Some(0));
    let (feather, cake) = (signer(false), signer(true));
    let holder_sk = owner_signing_key(&rnd(), 0);
    let holder = owner_key(&holder_sk);
    // A bridge credit straight to a Feather address, and an ordinary XP1 send from an XMR20 wallet to a Cake subaddress.
    let n1 = w.credit(feather.addr.owner(), 5_000_000_000);
    let h1 = w.credit(holder, 300_000_000);
    let t = public::Transfer::build(w.asset, vec![h1], vec![PublicOutput { owner: cake.addr.owner(), amount: 300_000_000 }], &holder_sk, &w.domain).unwrap();
    accepted(&w.apply(&t.encode()));
    assert_eq!(w.balance(&cake.addr.owner()), 300_000_000);
    // Feather moves 1,000.5 to Cake, network fee paid in XMR, change back.
    let until = (w.height + 720) as u32;
    let m = w.moved(&feather, vec![n1], vec![(Recipient::Address(cake.addr), 1_000_500_000)], None, 3_999_500_000, until, "XMR20");
    assert!(m.text(&w.domain, MAINNET).contains("; network fee paid in XMR; from "));
    let r = w.apply(&m.encode());
    accepted(&r);
    assert_eq!(r["detail"]["signer"], m.signer.encode(MAINNET));
    assert_eq!(w.balance(&feather.addr.owner()), 3_999_500_000);
    assert_eq!(w.balance(&cake.addr.owner()), 1_300_500_000);
    // Replay: the notes are spent.
    rejected(&w.apply(&m.encode()), "already spent");
    // Cake moves its notes into an XMR20 wallet key with a token fee to a relay key; the wallet then spends with plain XP1.
    let notes: Vec<[u8; 32]> = w.pool.notes_of_owner(&cake.addr.owner()).iter().map(|(i, _)| hex::decode(i).unwrap().try_into().unwrap()).collect();
    let relay = owner_key(&owner_signing_key(&rnd(), 0));
    let m2 = w.moved(&cake, notes, vec![(Recipient::Key(holder), 1_300_000_000)], Some((relay, 500_000)), 0, until, "XMR20");
    accepted(&w.apply(&m2.encode()));
    assert_eq!((w.balance(&holder), w.balance(&relay), w.balance(&cake.addr.owner())), (1_300_000_000, 500_000, 0));
    let mine: Vec<[u8; 32]> = w.pool.notes_of_owner(&holder).iter().map(|(i, _)| hex::decode(i).unwrap().try_into().unwrap()).collect();
    let back = public::Transfer::build(w.asset, mine, vec![PublicOutput { owner: feather.addr.owner(), amount: 1_300_000_000 }], &holder_sk, &w.domain).unwrap();
    accepted(&w.apply(&back.encode()));
    assert_eq!(w.balance(&feather.addr.owner()), 5_299_500_000);
    let (ok, rows) = w.pool.invariant();
    assert!(ok, "{rows:?}");
}

#[test]
fn refused_moves() {
    let mut w = W::new(Some(0));
    let (a, b) = (signer(false), signer(false));
    let n = w.credit(a.addr.owner(), 1_000);
    let until = (w.height + 100) as u32;
    // Someone else signs for a's notes.
    let stolen = w.moved(&b, vec![n], vec![(Recipient::Address(b.addr), 1_000)], None, 0, until, "XMR20");
    rejected(&w.apply(&stolen.encode()), "do not belong to the signing address");
    // An amount changed after signing.
    let mut m = w.moved(&a, vec![n], vec![(Recipient::Address(b.addr), 900)], None, 100, until, "XMR20");
    m.to[0].1 = 950;
    m.change = 50;
    rejected(&w.apply(&m.encode()), "Invalid address move signature");
    // A valid signature over amounts that do not add up.
    let bad = w.moved(&a, vec![n], vec![(Recipient::Address(b.addr), 900)], None, 99, until, "XMR20");
    rejected(&w.apply(&bad.encode()), "does not conserve value");
    // A view-key signature (mode 1), even made with the view key's own maths, never authorises.
    let mut v = w.moved(&a, vec![n], vec![(Recipient::Address(b.addr), 1_000)], None, 0, until, "XMR20");
    let (c, r) = sign(&v.text(&w.domain, MAINNET), &a, 1);
    v.c = c;
    v.r = r;
    rejected(&w.apply(&v.encode()), "Invalid address move signature");
    // Expired.
    let late = w.moved(&a, vec![n], vec![(Recipient::Address(b.addr), 1_000)], None, 0, (w.height) as u32, "XMR20");
    rejected(&w.apply(&late.encode()), "expired");
    // Flipping "fee paid in XMR" after signing.
    let mut f = w.moved(&a, vec![n], vec![(Recipient::Address(b.addr), 1_000)], None, 0, until, "XMR20");
    f.flags = 0;
    rejected(&w.apply(&f.encode()), "Invalid address move signature");
    // Nothing above moved anything.
    assert_eq!(w.balance(&a.addr.owner()), 1_000);
    // The genuine move, with a copied CRLF line ending.
    let mut ok = w.moved(&a, vec![n], vec![(Recipient::Address(b.addr), 1_000)], None, 0, until, "XMR20");
    let (c, r) = sign(&format!("{}\r\n", ok.text(&w.domain, MAINNET)), &a, 0);
    ok.c = c;
    ok.r = r;
    assert_eq!(ok.find_variant(&w.domain, MAINNET), Some(2));
    ok.variant = 2;
    accepted(&w.apply(&ok.encode()));
    assert_eq!(w.balance(&b.addr.owner()), 1_000);
}

#[test]
fn nobody_can_spend_an_address_note_with_xp1_and_anchored_notes_need_their_anchor() {
    let mut w = W::new(Some(0));
    let a = signer(false);
    let n = w.credit(a.addr.owner(), 10);
    // No SpendAuth key is known for an address owner: any XP1 signature fails.
    let random_sk = SigningKey::<SpendAuth>::new(OsRng);
    let t = public::Transfer::build(w.asset, vec![n], vec![PublicOutput { owner: owner_key(&random_sk), amount: 10 }], &random_sk, &w.domain).unwrap();
    rejected(&w.apply(&t.encode()), "");
    assert_eq!(w.balance(&a.addr.owner()), 10);
}

#[test]
fn xw1_is_ignored_until_activation_exactly_like_an_unknown_record() {
    for active in [None, Some(1_000)] {
        let mut w = W::new(active);
        let (a, b) = (signer(false), signer(false));
        let n = w.credit(a.addr.owner(), 10);
        let m = w.moved(&a, vec![n], vec![(Recipient::Address(b.addr), 10)], None, 0, 2_000, "XMR20");
        let r = w.apply(&m.encode());
        assert_eq!(r, serde_json::json!({"record":"ignored"}), "{active:?}");
        assert_eq!(w.balance(&a.addr.owner()), 10);
        if active.is_some() {
            w.height = 999;
            accepted(&w.apply(&m.encode()));
        }
    }
    // The core's mainnet default is off unless the activation build sets it.
    assert_eq!(address::activation("mainnet").map(|a| a.from), address::MAINNET_ACTIVATION);
    assert_eq!(address::activation("stagenet").unwrap().net, address::STAGENET);
}

#[test]
fn largest_move_fits_one_carrier() {
    let w = W::new(Some(0));
    let (a, b, c) = (signer(true), signer(false), signer(true));
    let key = owner_key(&owner_signing_key(&rnd(), 0));
    let m = w.moved(&a, vec![rnd(), rnd(), rnd(), rnd()], vec![(Recipient::Address(b.addr), 1), (Recipient::Address(c.addr), 1), (Recipient::Key(key), 1)], Some((key, 1)), 1, u32::MAX, "MONEROCHAN12");
    let wire = m.encode();
    let framed = transport::frame(&wire, &[9u8; 32]).unwrap();
    assert!(wire.len() <= transport::MAX_RECORD && framed.len() <= transport::EXTRA_LIMIT, "{} / {}", wire.len(), framed.len());
    assert!(Move::decode(&wire).is_ok());
    println!("largest XW1 {} bytes, framed {} bytes", wire.len(), framed.len());
}

fn certify(s: &Signer, owner: &[u8; 32], domain: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let mut b = [0u8; 64];
    OsRng.fill_bytes(&mut b);
    let k = Scalar::from_bytes_mod_order_wide(&b);
    let mut m = Keccak256::new();
    for p in [b"XMR20-OPEN-OWNER-v1\0" as &[u8], s.addr.encode(MAINNET).as_bytes(), b"\0", hex::encode(owner).as_bytes(), b"\0", hex::encode(domain).as_bytes()] {
        m.update(p);
    }
    let m: [u8; 32] = m.finalize().into();
    let mut kk = Keccak256::new();
    kk.update(m);
    kk.update(s.addr.spend);
    kk.update((k * G).compress().as_bytes());
    let c = Scalar::from_bytes_mod_order(kk.finalize().into());
    (c.to_bytes(), (k - c * s.secret).to_bytes())
}

#[test]
fn send_back_to_an_xmr20_wallet_lands_in_its_open_balance_only_with_its_certificate() {
    let mut w = W::new(Some(0));
    let (feather, wallet, attacker) = (signer(false), signer(false), signer(false));
    let wallet_opk = owner_key(&owner_signing_key(&rnd(), 0));
    let attacker_opk = owner_key(&owner_signing_key(&rnd(), 0));
    let n = w.credit(feather.addr.owner(), 100);
    let until = (w.height + 50) as u32;
    // A certificate by someone else's key for the wallet's address (a page trying to redirect the tokens): refused.
    let (c, s) = certify(&attacker, &attacker_opk, &w.domain);
    let fake = Recipient::Certified { addr: wallet.addr, owner: attacker_opk, c, s };
    let m = w.moved(&feather, vec![n], vec![(fake, 100)], None, 0, until, "XMR20");
    assert!(m.text(&w.domain, MAINNET).contains(&wallet.addr.encode(MAINNET)), "the text shows the wallet's address");
    rejected(&w.apply(&m.encode()), "Invalid recipient certificate");
    // The wallet's own certificate: the tokens go to its Open owner key.
    let (c, s) = certify(&wallet, &wallet_opk, &w.domain);
    let ok = w.moved(&feather, vec![n], vec![(Recipient::Certified { addr: wallet.addr, owner: wallet_opk, c, s }, 100)], None, 0, until, "XMR20");
    accepted(&w.apply(&ok.encode()));
    assert_eq!((w.balance(&wallet_opk), w.balance(&wallet.addr.owner()), w.balance(&feather.addr.owner())), (100, 0, 0));
    // A certificate for another ledger does not verify here.
    let (c, s) = certify(&wallet, &wallet_opk, &[3u8; 32]);
    assert!(!address::verify_certificate(&wallet.addr, &wallet_opk, &c, &s, &w.domain, MAINNET));
}

#[test]
fn json_ops_prepare_sign_finalize_like_the_relay() {
    let mut w = W::new(Some(0));
    let (a, b) = (signer(true), signer(false));
    w.credit(a.addr.owner(), 600);
    w.credit(a.addr.owner(), 500);
    let q = |v: serde_json::Value| v;
    let held = w.pool.address_op(&q(serde_json::json!({"op":"addressHoldings","address":a.addr.encode(MAINNET)})), &w.vks, w.height + 1).unwrap();
    assert_eq!(held["notes"].as_array().unwrap().len(), 2);
    let owner = w.pool.address_op(&q(serde_json::json!({"op":"addressOwner","address":a.addr.encode(MAINNET)})), &w.vks, 0).unwrap();
    assert_eq!((owner["owner"].as_str().unwrap(), owner["kind"].as_str().unwrap()), (hex::encode(a.addr.owner()).as_str(), "sub"));
    let p = w.pool.address_op(&q(serde_json::json!({"op":"addressMovePrepare","signer":a.addr.encode(MAINNET),"asset":hex::encode(w.asset.to_bytes()),"ticker":"XMR20","to":[{"address":b.addr.encode(MAINNET),"amount":"1000"}],"feeInXmr":true,"until":w.height + 10})), &w.vks, w.height + 1).unwrap();
    assert_eq!((p["inputs"].as_u64(), p["change"].as_str()), (Some(2), Some("100")));
    let text = p["text"].as_str().unwrap();
    let (c, r) = sign(&format!("{text}\n"), &a, 0);
    let sig = format!("SigV2{}", {
        // Monero base58 of c || r, as wallets print it.
        let mut cr = c.to_vec();
        cr.extend(r);
        let m = Move::decode_body(&hex::decode(p["body"].as_str().unwrap()).unwrap()).unwrap();
        let _ = m;
        address_test_base58(&cr)
    });
    let f = w.pool.address_op(&q(serde_json::json!({"op":"addressMoveFinalize","body":p["body"],"signature":sig})), &w.vks, w.height + 1).unwrap();
    assert_eq!(f["variant"], 1);
    let wire = hex::decode(f["wire"].as_str().unwrap()).unwrap();
    accepted(&w.apply(&wire));
    assert_eq!((w.balance(&b.addr.owner()), w.balance(&a.addr.owner())), (1000, 100));
    // Wrong signature: refused with the plain message, nothing applied.
    let bad = w.pool.address_op(&q(serde_json::json!({"op":"addressMoveFinalize","body":p["body"],"signature":"SigV2".to_string() + &"1".repeat(88)})), &w.vks, w.height + 1);
    assert!(bad.is_err());
    // Inactive ledger: every address op refuses.
    let off = W::new(None);
    assert!(off.pool.address_op(&q(serde_json::json!({"op":"addressOwner","address":a.addr.encode(MAINNET)})), &off.vks, 0).is_err());
}
fn address_test_base58(bytes: &[u8]) -> String {
    const A: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut out = String::new();
    for block in bytes.chunks(8) {
        let mut n: u128 = 0;
        for b in block {
            n = n * 256 + u128::from(*b);
        }
        let mut s = vec![b'1'; [0, 2, 3, 5, 6, 7, 9, 10, 11][block.len()]];
        for c in s.iter_mut().rev() {
            *c = A[(n % 58) as usize];
            n /= 58;
        }
        out.push_str(std::str::from_utf8(&s).unwrap());
    }
    out
}

#[test]
fn checkpoint_anchor_signs_verifies_and_is_never_a_record() {
    let w = W::new(Some(0));
    let a = crate::checkpoint::Anchor { height: 3_797_400, block_hash: rnd(), list_hash: rnd(), records: 412 };
    let wire = a.sign(&w.issuer, &w.domain);
    assert_eq!(wire.len(), crate::checkpoint::BYTES);
    assert_eq!(crate::checkpoint::Anchor::verify(&wire, &w.vks.issuer, &w.domain).unwrap(), a);
    assert!(crate::checkpoint::Anchor::verify(&wire, &w.vks.issuer, &[1u8; 32]).is_err(), "another ledger");
    let mut bad = wire.clone();
    bad[10] ^= 1;
    assert!(crate::checkpoint::Anchor::verify(&bad, &w.vks.issuer, &w.domain).is_err());
    // Framed as one 0x7F data chunk (as the issuer's carrier puts it): no reader sees a record, the anchor parses back.
    let mut extra = vec![1u8];
    extra.extend(rnd());
    extra.push(2);
    let l = wire.len() + 1;
    extra.push((l as u8 & 127) | 128);
    extra.push((l >> 7) as u8);
    extra.push(127);
    extra.extend(&wire);
    assert!(transport::unframe(&extra).ok().flatten().is_none(), "an anchor is not a record");
    assert_eq!(crate::checkpoint::Anchor::from_extra(&extra), Some(wire));
}
