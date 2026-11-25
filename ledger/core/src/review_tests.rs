//! Adversarial tests (ledger and supply): checks of the open-token rules (open.rs, pool.rs) from the money side.
//! Every test passes. A test whose name starts with `finding_` passes WHILE the behaviour it describes exists and says so.
//! Run: cargo test --release --offline review_tests
use super::*;
use crate::address::{self, Address, Recipient, MAINNET};
use crate::keys::{owner_key, owner_signing_key, shielded_address, token_spend_key};
use crate::market::{Anchored, AnchoredOutput, Sale, NO_ANCHOR};
use crate::open::{self, Deploy, Mint, Text};
use crate::penumbra::{self as pz, Circuit};
use crate::pool::{LotStatus, Pool, Vks};
use crate::trade::{self, Body, PaymentFacts, PaymentOutput, Trade};
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT as G, edwards::CompressedEdwardsY, scalar::Scalar, EdwardsPoint};
use decaf377_rdsa::{SigningKey, SpendAuth, VerificationKey};
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value as J};
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
/// A small deterministic generator, so a failing stream can be replayed from its seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}
struct Signer {
    secret: Scalar,
    addr: Address,
}
fn signer_kind(sub: bool) -> Signer {
    let secret = Scalar::from_bytes_mod_order(rnd());
    Signer { secret, addr: Address { sub, spend: (secret * G).compress().0, view: (Scalar::from_bytes_mod_order(rnd()) * G).compress().0 } }
}
fn signer() -> Signer {
    signer_kind(false)
}
fn sign(text: &str, s: &Signer) -> ([u8; 32], [u8; 32]) {
    let k = Scalar::from_bytes_mod_order(rnd());
    let h = address::message_hash(text.as_bytes(), &s.addr.spend, &s.addr.view, 0);
    let mut kk = Keccak256::new();
    kk.update(h);
    kk.update(s.addr.spend);
    kk.update((k * G).compress().as_bytes());
    let c = Scalar::from_bytes_mod_order(kk.finalize().into());
    (c.to_bytes(), (k - c * s.secret).to_bytes())
}
fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut k = Keccak256::new();
    for p in parts {
        k.update(p);
    }
    k.finalize().into()
}
/// Monero base58 (as wallets print "SigV2…").
fn base58(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const ENCODED: [usize; 9] = [0, 2, 3, 5, 6, 7, 9, 10, 11];
    let mut out = String::new();
    for block in bytes.chunks(8) {
        let mut n: u128 = 0;
        for b in block {
            n = n * 256 + u128::from(*b);
        }
        let mut s = vec![b'1'; ENCODED[block.len()]];
        for c in s.iter_mut().rev() {
            *c = ALPHABET[(n % 58) as usize];
            n /= 58;
        }
        out.push_str(std::str::from_utf8(&s).unwrap());
    }
    out
}
fn sigv2(c: [u8; 32], r: [u8; 32]) -> String {
    let mut cr = c.to_vec();
    cr.extend(r);
    format!("SigV2{}", base58(&cr))
}
/// A payment as a sending wallet builds it (copied from trade_tests.rs).
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

const INSCRIPTIONS: [u8; 32] = [0x51; 32];
const T: u64 = open::UNIT;
/// Where the content length of a deploy record sits: magic 4, op 1, collection and edition 36, creator 65, flags, name length, type.
const CONTENT_LEN_AT: usize = 4 + 1 + 36 + 65 + 3;
struct W {
    pool: Pool,
    vks: Vks,
    domain: [u8; 32],
    issuer: SigningKey<SpendAuth>,
    height: u64,
    salt: u64,
    binding: u64,
}
impl W {
    fn new(from: u64) -> Self {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../params/test-v2/manifest.json");
        let m: J = serde_json::from_slice(&std::fs::read(p).expect("test-v2 manifest")).unwrap();
        Self::with_vks(from, m["config"]["spend_vk"].as_str().unwrap(), m["config"]["output_vk"].as_str().unwrap())
    }
    fn with_vks(from: u64, s: &str, o: &str) -> Self {
        let issuer = SigningKey::<SpendAuth>::new(OsRng);
        let mut cfg = Config { chain: hex::encode([7u8; 32]), domain: String::new(), spend_vk: s.to_string(), output_vk: o.to_string(), issuer_vk: hex::encode(VerificationKey::from(&issuer).to_bytes()) };
        cfg.domain = hex::encode(cfg.computed_domain().unwrap());
        let domain = cfg.domain().unwrap();
        let vks = Vks { spend: pz::read_vk(Circuit::Spend, s).unwrap(), output: pz::read_vk(Circuit::Output, o).unwrap(), issuer: VerificationKey::from(&issuer) };
        let mut pool = Pool::new(domain);
        pool.market_from = Some(0);
        pool.address_moves = Some(address::Activation { from: 0, net: MAINNET });
        pool.trades = Some(address::Activation { from: 0, net: MAINNET });
        pool.open = Some(open::Activation { from, net: MAINNET, inscriptions: INSCRIPTIONS });
        Self { pool, vks, domain, issuer, height: 10, salt: 0, binding: 0 }
    }
    fn apply_native(&mut self, wire: &[u8], native: &[[u8; 32]]) -> J {
        let r = self.pool.apply_carrier(Some(wire), &hex::encode(rnd()), self.height, native, &self.vks);
        let (ok, rows) = self.pool.invariant();
        assert!(ok, "supply invariant: {rows:?}");
        self.check_open_supply();
        r
    }
    fn apply(&mut self, wire: &[u8]) -> J {
        self.apply_native(wire, &[])
    }
    /// For every open token: what exists (public + shielded) plus what was burned is exactly max - left, and never above max.
    fn check_open_supply(&self) {
        let (pub_s, sh) = (self.pool.public_supply(), self.pool.shielded_supply());
        for (asset, t) in &self.pool.open_tokens {
            let max = u128::from(t.text.max_units());
            let minted = self.pool.minted.get(asset).copied().unwrap_or(0);
            let burned = self.pool.burned.get(asset).copied().unwrap_or(0);
            let exists = pub_s.get(asset).copied().unwrap_or(0) as i128 + sh.get(asset).copied().unwrap_or(0);
            assert!(minted <= max, "minted above max");
            assert_eq!(minted, max - u128::from(t.left), "minted == max - left");
            assert_eq!(exists, minted as i128 - burned as i128, "what exists == minted - burned");
            assert!(!self.pool.credits.values().any(|c| &c.asset == asset), "a credit for an open token");
        }
    }
    fn text(tick: &str, max: u64, lim: Option<u64>, pre: Option<u64>) -> Text {
        Text { tick: tick.to_string(), name: None, max, col: None, lim, pre }
    }
    fn deploy_record_variant(&self, who: &Signer, text: Text, variant: u8) -> (Vec<u8>, [u8; 32]) {
        let mut d = Deploy { creator: who.addr, text, variant, c: [0; 32], r: [0; 32] };
        let (c, r) = sign(&format!("{}{}", d.signed_text(&INSCRIPTIONS, MAINNET).unwrap(), address::SUFFIX[variant as usize]), who);
        d.c = c;
        d.r = r;
        (d.encode().unwrap(), d.id(&INSCRIPTIONS).unwrap())
    }
    fn deploy_record(&self, who: &Signer, text: Text) -> (Vec<u8>, [u8; 32]) {
        self.deploy_record_variant(who, text, 0)
    }
    fn deploy(&mut self, who: &Signer, text: Text) -> ([u8; 32], asset::Id) {
        let (wire, id) = self.deploy_record(who, text);
        let r = self.apply(&wire);
        assert_eq!(r["record"], "accepted", "{r}");
        (id, open::asset_for_open(&id).unwrap())
    }
    fn mint_record(&mut self, asset: asset::Id, amount: u64, owner: [u8; 32]) -> Vec<u8> {
        self.salt += 1;
        Mint { asset, amount, owner, salt: self.salt.to_le_bytes() }.encode()
    }
    fn mint(&mut self, asset: asset::Id, amount: u64, owner: [u8; 32]) -> J {
        let w = self.mint_record(asset, amount, owner);
        self.apply(&w)
    }
    fn credit_record(&mut self, asset: asset::Id, amount: u64, owner: [u8; 32]) -> Vec<u8> {
        self.binding += 1;
        let mut b = [0xc0u8; 32];
        b[..8].copy_from_slice(&self.binding.to_le_bytes());
        public::Credit::build(public::KIND_DEPOSIT, asset, amount, owner, b, &self.issuer, &self.domain).unwrap().encode()
    }
    fn balance(&self, owner: &[u8; 32], asset: asset::Id) -> u128 {
        self.pool.public_balances(owner).get(&hex::encode(asset.to_bytes())).copied().unwrap_or(0)
    }
    fn notes_of(&self, owner: &[u8; 32], asset: asset::Id) -> Vec<([u8; 32], u64)> {
        let a = hex::encode(asset.to_bytes());
        self.pool.notes_of_owner(owner).into_iter().filter(|(_, n)| n.asset == a).map(|(id, n)| (h32(&id), n.amount)).collect()
    }
    #[allow(clippy::too_many_arguments)]
    fn move_record(&self, who: &Signer, asset: asset::Id, ticker: &str, to: Recipient, amount: u64, fee: Option<([u8; 32], u64)>, label: Option<&str>) -> Vec<u8> {
        let mut m = self.pool.prepare_address_move(who.addr, asset, ticker, vec![(to, amount)], fee, fee.is_none(), 100_000).unwrap();
        let (c, r) = sign(&m.text_as(&self.domain, MAINNET, label), who);
        m.c = c;
        m.r = r;
        m.encode()
    }
    fn label(&self, asset: asset::Id) -> String {
        let t = &self.pool.open_tokens[&hex::encode(asset.to_bytes())];
        open::label(&t.text.tick, &t.id)
    }
}

// ------------------------------------------------------------------------------------------------ supply

/// Random streams of deploys, mints (replayed, above the limit, for assets that are not open tokens), issuer credits for open
/// tokens, transfers and burns, against a model. After every record: the pool's invariant, minted == max - left <= max, and
/// what exists == minted - burned (W::apply). At the end the model's numbers are the pool's.
#[test]
fn random_streams_keep_the_supply_at_or_below_max_and_equal_to_a_model() {
    struct Model {
        asset: asset::Id,
        max: u64,
        lim: u64,
        left: u64,
        burned: u64,
        mints: u64,
    }
    for seed in [1u64, 2, 3, 0xfeed, 0xdead_beef] {
        let mut g = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let mut w = W::new(0);
        let keys: Vec<SigningKey<SpendAuth>> = (0..3).map(|_| SigningKey::<SpendAuth>::new(OsRng)).collect();
        let owners: Vec<[u8; 32]> = keys.iter().map(|k| VerificationKey::from(k).to_bytes()).collect();
        let creators: Vec<Signer> = (0..2).map(|_| signer()).collect();
        let mut model: Vec<Model> = vec![];
        let mut seen_mints: Vec<Vec<u8>> = vec![];
        let mut deploys: Vec<Vec<u8>> = vec![];
        for step in 0..260 {
            w.height += g.below(2);
            match g.below(12) {
                0 if model.len() < 5 => {
                    let max = match g.below(4) {
                        0 => open::MAX_WHOLE,
                        1 => 1,
                        _ => 1 + g.below(50),
                    };
                    let pre = match g.below(4) {
                        0 => Some(max),
                        1 if max > 1 => Some(1 + g.below(max - 1)),
                        _ => None,
                    };
                    let lim = if pre == Some(max) { None } else { Some(if g.below(3) == 0 { max } else { 1 + g.below(max.min(7)) }) };
                    let text = Text { tick: "RND".into(), name: Some(format!("s{seed} n{step}")), max, col: None, lim, pre };
                    let (wire, id) = w.deploy_record(&creators[g.below(2) as usize], text.clone());
                    let r = w.apply(&wire);
                    assert_eq!(r["record"], "accepted", "{r}");
                    deploys.push(wire);
                    model.push(Model { asset: open::asset_for_open(&id).unwrap(), max: max * T, lim: lim.unwrap_or(0) * T, left: (max - pre.unwrap_or(0)) * T, burned: 0, mints: 0 });
                }
                1..=5 if !model.is_empty() => {
                    let i = g.below(model.len() as u64) as usize;
                    let m = &mut model[i];
                    let amount = match g.below(6) {
                        0 => m.lim.saturating_add(1 + g.below(3)),
                        1 => u64::MAX,
                        2 => 1,
                        3 => m.lim.max(1),
                        _ => 1 + g.below(m.lim.max(1)),
                    };
                    let wire = w.mint_record(m.asset, amount, owners[g.below(3) as usize]);
                    let r = w.apply(&wire);
                    let expect = m.left > 0 && amount <= m.lim;
                    assert_eq!(r["record"] == "accepted", expect, "seed {seed} step {step}: {r}");
                    if expect {
                        let got = amount.min(m.left);
                        assert_eq!(r["detail"]["amount"], got.to_string());
                        m.left -= got;
                        m.mints += 1;
                        seen_mints.push(wire);
                    }
                }
                // A mint record carried again (also after its note moved on) never counts twice.
                6 if !seen_mints.is_empty() => {
                    let wire = seen_mints[g.below(seen_mints.len() as u64) as usize].clone();
                    let r = w.apply(&wire);
                    assert!(r["error"] == "This mint record was applied already" || r["error"] == "This token is minted out", "seed {seed} step {step}: {r}");
                }
                // A deploy carried again never makes a second creator share.
                7 if !deploys.is_empty() => {
                    let wire = deploys[g.below(deploys.len() as u64) as usize].clone();
                    assert_eq!(w.apply(&wire)["error"], "This token is deployed already");
                }
                // The issuer's credit for an open token, and a mint of an asset nobody deployed or of a bridged one.
                8 if !model.is_empty() => {
                    let a = model[g.below(model.len() as u64) as usize].asset;
                    let c = w.credit_record(a, 1 + g.below(1000), owners[0]);
                    assert_eq!(w.apply(&c)["error"], "An open token takes no credits");
                    let bridged = asset_for_mint("TestMint1111111111111111111111111111111111").unwrap();
                    let c = w.credit_record(bridged, 5, owners[0]);
                    assert_eq!(w.apply(&c)["record"], "accepted");
                    assert_eq!(w.mint(bridged, 1, owners[0])["error"], "Not an open token");
                    assert_eq!(w.mint(open::asset_for_open(&rnd()).unwrap(), 1, owners[0])["error"], "Not an open token");
                }
                // Move some notes on (so later replays meet spent notes), or burn part of them.
                9 | 10 if !model.is_empty() => {
                    let i = g.below(model.len() as u64) as usize;
                    let k = g.below(3) as usize;
                    let notes = w.notes_of(&owners[k], model[i].asset);
                    if notes.is_empty() {
                        continue;
                    }
                    let take: Vec<([u8; 32], u64)> = notes.into_iter().take(1 + g.below(4) as usize).collect();
                    let total: u128 = take.iter().map(|n| u128::from(n.1)).sum();
                    if total > u128::from(u64::MAX) {
                        continue;
                    }
                    let total = total as u64;
                    let ids: Vec<[u8; 32]> = take.iter().map(|n| n.0).collect();
                    if g.below(2) == 0 {
                        let to = owners[(k + 1) % 3];
                        let t = public::Transfer::build(model[i].asset, ids, vec![PublicOutput { owner: to, amount: total }], &keys[k], &w.domain).unwrap().encode();
                        assert_eq!(w.apply(&t)["record"], "accepted");
                    } else {
                        let burn = 1 + g.below(total);
                        let x = public::Burn::build(model[i].asset, ids, burn, PublicOutput { owner: owners[k], amount: total - burn }, rnd(), &keys[k], &w.domain).unwrap().encode();
                        let r = w.apply(&x);
                        assert_eq!(r["record"], "accepted", "{r}");
                        model[i].burned += burn;
                    }
                }
                _ => {}
            }
        }
        assert_eq!(w.pool.open_tokens.len(), model.len());
        for m in &model {
            let a = hex::encode(m.asset.to_bytes());
            let t = &w.pool.open_tokens[&a];
            assert_eq!((t.left, t.mints), (m.left, m.mints), "seed {seed}");
            assert_eq!(w.pool.outstanding()[&a], u128::from(m.max - m.left - m.burned), "seed {seed}");
        }
    }
}

/// The largest numbers the text allows: max * UNIT, left and the sums of a move stay inside u64 / u128 (no wrap in a release build).
#[test]
fn the_largest_supply_does_not_overflow() {
    assert!(u128::from(open::MAX_WHOLE) * u128::from(T) <= u128::from(u64::MAX));
    assert!(Text::read(br#"{"p":"xmr20","op":"deploy","tick":"A","max":"18446744073710","dec":"6","mode":"open","lim":"1"}"#).is_none());
    assert!(Text::read(br#"{"p":"xmr20","op":"deploy","tick":"A","max":"18446744073709","dec":"6","mode":"open","lim":"18446744073710"}"#).is_none());
    assert!(Text::read(br#"{"p":"xmr20","op":"deploy","tick":"A","max":"18446744073709","dec":"6","mode":"open","pre":"18446744073710"}"#).is_none());
    assert!(Text::read(br#"{"p":"xmr20","op":"deploy","tick":"A","max":"18446744073709","dec":"6","mode":"open","lim":"18446744073709"}"#).is_some());
    let mut w = W::new(0);
    let (alice, bob) = (signer(), signer());
    let big = open::MAX_WHOLE;
    // All of it to the creator; nothing to mint and no limit written.
    let (_, a1) = w.deploy(&alice, W::text("ALL", big, None, Some(big)));
    assert_eq!(w.balance(&alice.addr.owner(), a1), u128::from(big) * u128::from(T));
    assert_eq!(w.mint(a1, 1, bob.addr.owner())["error"], "This token is minted out");
    // All but one token to the creator, a limit as large as max: one mint of the limit gets the last token.
    let (_, a2) = w.deploy(&alice, W::text("ONE", big, Some(big), Some(big - 1)));
    assert_eq!(w.mint(a2, u64::MAX, bob.addr.owner())["error"], "More than one mint can take");
    let r = w.mint(a2, big * T, bob.addr.owner());
    assert_eq!((r["detail"]["amount"].as_str().unwrap(), r["detail"]["left"].as_str().unwrap()), (T.to_string().as_str(), "0"));
    // Nothing to the creator: one mint takes everything.
    let (_, a3) = w.deploy(&alice, W::text("MINT", big, Some(big), None));
    assert_eq!(w.mint(a3, big * T, bob.addr.owner())["detail"]["amount"], (big * T).to_string());
    assert_eq!(w.mint(a3, 1, bob.addr.owner())["error"], "This token is minted out");
    // The whole supply moves in one signed move and the text spells the number out.
    let label = w.label(a1);
    let m = w.move_record(&alice, a1, "ALL", Recipient::Address(bob.addr), big * T, None, Some(&label));
    assert!(address::Move::decode(&m).unwrap().text_as(&w.domain, MAINNET, Some(&label)).contains(&format!("send {big} {label} to ")));
    assert_eq!(w.apply(&m)["record"], "accepted");
    assert_eq!(w.balance(&bob.addr.owner(), a1), u128::from(big) * u128::from(T));
    let v = w.pool.open_view();
    assert!(v.iter().all(|t| t["left"] == "0" && t["minted"] == (big * T).to_string()));
}

/// The same deploy in every form it can be carried in: another signature, another line ending (variant), after the creator's
/// note was spent, and with the creator's address as a subaddress (another id, another token: both signed by the creator).
#[test]
fn a_deploy_counts_once_whatever_carries_it() {
    let mut w = W::new(0);
    let (alice, bob) = (signer(), signer());
    let text = W::text("ONCE", 100, Some(10), Some(40));
    let (wire, id) = w.deploy_record(&alice, text.clone());
    let asset = open::asset_for_open(&id).unwrap();
    assert_eq!(w.apply(&wire)["record"], "accepted");
    for v in 0..3u8 {
        let (other, id2) = w.deploy_record_variant(&alice, text.clone(), v);
        assert_eq!(id, id2);
        assert_ne!(other, wire);
        assert_eq!(w.apply(&other)["error"], "This token is deployed already");
    }
    // The creator's share moves away; the note id note_id(token id, 0) is now a spent note. Carried again: still nothing.
    let label = w.label(asset);
    assert_eq!(w.apply(&w.move_record(&alice, asset, "ONCE", Recipient::Address(bob.addr), 40 * T, None, Some(&label)))["record"], "accepted");
    assert!(w.pool.spent_notes.contains(&public::note_id(&id, 0)));
    assert_eq!(w.apply(&wire)["error"], "This token is deployed already");
    assert_eq!((w.balance(&alice.addr.owner(), asset), w.balance(&bob.addr.owner(), asset)), (0, u128::from(40 * T)));
    // Somebody else cannot sign the creator's record: a record with the creator's keys and another signer's signature is nothing.
    let mut forged = Deploy::decode(&wire).unwrap();
    forged.text.name = Some("x".into());
    let (c, r) = sign(&forged.signed_text(&INSCRIPTIONS, MAINNET).unwrap(), &bob);
    forged.c = c;
    forged.r = r;
    assert_eq!(w.apply(&forged.encode().unwrap()), json!({"record":"ignored"}));
    // A subaddress creator: the share goes to owner(B, A) of the subaddress and its signature moves it.
    let sub = signer_kind(true);
    let (id3, a3) = w.deploy(&sub, W::text("SUB", 5, None, Some(5)));
    assert_eq!(w.balance(&sub.addr.owner(), a3), u128::from(5 * T));
    let l3 = open::label("SUB", &id3);
    assert_eq!(w.apply(&w.move_record(&sub, a3, "SUB", Recipient::Address(bob.addr), 5 * T, None, Some(&l3)))["record"], "accepted");
    assert_eq!(w.pool.open_tokens.len(), 2);
}

/// A burn destroys for good: what is left to mint does not grow, the record carried again does nothing.
#[test]
fn a_burn_does_not_give_back_room_to_mint() {
    let mut w = W::new(0);
    let alice = signer();
    let (_, asset) = w.deploy(&alice, W::text("BURN", 10, Some(4), None));
    let sk = SigningKey::<SpendAuth>::new(OsRng);
    let owner = VerificationKey::from(&sk).to_bytes();
    let first = w.mint_record(asset, 4 * T, owner);
    assert_eq!(w.apply(&first)["record"], "accepted");
    let note = public::note_id(&public::record_id(&first), 0);
    let burn = public::Burn::build(asset, vec![note], 3 * T, PublicOutput { owner, amount: T }, [9; 32], &sk, &w.domain).unwrap().encode();
    assert_eq!(w.apply(&burn)["record"], "accepted");
    let a = hex::encode(asset.to_bytes());
    assert_eq!((w.pool.open_tokens[&a].left, w.pool.outstanding()[&a]), (6 * T, u128::from(T)));
    // The mint whose note was burned, carried again: refused (its note id is a spent note).
    assert_eq!(w.apply(&first)["error"], "This mint record was applied already");
    assert_eq!(w.mint(asset, 4 * T, owner)["record"], "accepted");
    let last = w.mint(asset, 4 * T, owner);
    assert_eq!((last["detail"]["amount"].as_str().unwrap(), last["detail"]["left"].as_str().unwrap()), ((2 * T).to_string().as_str(), "0"));
    assert_eq!(w.mint(asset, 1, owner)["error"], "This token is minted out");
    assert_eq!(w.pool.outstanding()[&a], u128::from(7 * T));
}

/// NOTE for whoever reads `redemptions` (pool.summary()): a burn of an open token is listed there like a bridged token's burn,
/// with the binding its holder chose. Nothing in the core marks it as an open token's. A bridge that pays out on a redemption
/// must look the asset up among BRIDGED tokens only. This test passes while that is so.
#[test]
fn finding_a_burn_of_an_open_token_is_listed_among_the_redemptions() {
    let mut w = W::new(0);
    let (_, asset) = w.deploy(&signer(), W::text("BURN", 10, Some(10), None));
    let sk = SigningKey::<SpendAuth>::new(OsRng);
    let owner = VerificationKey::from(&sk).to_bytes();
    let m = w.mint_record(asset, 10 * T, owner);
    w.apply(&m);
    let burn = public::Burn::build(asset, vec![public::note_id(&public::record_id(&m), 0)], 10 * T, PublicOutput { owner, amount: 0 }, [9; 32], &sk, &w.domain).unwrap().encode();
    assert_eq!(w.apply(&burn)["record"], "accepted");
    let s = w.pool.summary();
    assert_eq!(s["redemptions"][0]["asset"], hex::encode(asset.to_bytes()));
    assert_eq!(s["redemptions"][0]["amount"], (10 * T).to_string());
}

// ------------------------------------------------------------------------------------------------ the asset in use, the issuer

/// The issuer gets a credit in first. The deploy is refused then and whenever it is carried again; the asset stays a plain
/// asset (no label, no XO1), so no supply rule is bent. A credit AFTER the deploy is refused and its binding stays usable.
/// Nobody but the issuer can put a deploy's asset in use: every other record needs notes of the asset to exist.
#[test]
fn only_the_issuer_can_hold_up_a_deploy_and_the_asset_then_is_not_open() {
    let mut w = W::new(0);
    let (alice, bob) = (signer(), signer());
    let (wire, id) = w.deploy_record(&alice, W::text("RACE", 10, Some(1), Some(2)));
    let asset = open::asset_for_open(&id).unwrap();
    // Without a credit: records naming the asset before its deploy change nothing that the deploy looks at.
    assert_eq!(w.mint(asset, T, bob.addr.owner())["error"], "Not an open token");
    let sk = SigningKey::<SpendAuth>::new(OsRng);
    let ghost = public::Transfer::build(asset, vec![rnd()], vec![PublicOutput { owner: bob.addr.owner(), amount: 1 }], &sk, &w.domain).unwrap().encode();
    assert_eq!(w.apply(&ghost)["record"], "rejected");
    let ghost_burn = public::Burn::build(asset, vec![rnd()], 1, PublicOutput { owner: VerificationKey::from(&sk).to_bytes(), amount: 0 }, [1; 32], &sk, &w.domain).unwrap().encode();
    assert_eq!(w.apply(&ghost_burn)["record"], "rejected");
    assert!(!w.pool.minted.contains_key(&hex::encode(asset.to_bytes())) && w.pool.notes.is_empty());
    // On a copy: the deploy goes in; a credit after it is refused, and the binding was not used up by the refusal.
    let mut fork = w.pool.clone();
    assert_eq!(fork.apply_carrier(Some(&wire), &hex::encode(rnd()), w.height, &[], &w.vks)["record"], "accepted");
    let credit = public::Credit::build(public::KIND_DEPOSIT, asset, 5 * T, alice.addr.owner(), [8; 32], &w.issuer, &w.domain).unwrap().encode();
    assert_eq!(fork.apply_carrier(Some(&credit), &hex::encode(rnd()), w.height, &[], &w.vks)["error"], "An open token takes no credits");
    assert!(!fork.credits.contains_key(&[8u8; 32]) && fork.invariant().0);
    // The issuer first.
    assert_eq!(w.apply(&credit)["record"], "accepted");
    for _ in 0..2 {
        assert_eq!(w.apply(&wire)["error"], "The asset of this token is in use");
    }
    assert!(w.pool.open_tokens.is_empty() && w.pool.open_ids.is_empty());
    assert_eq!(w.mint(asset, T, bob.addr.owner())["error"], "Not an open token");
    // The credited notes are a plain asset's: the old text moves them, whatever the ticker field says.
    assert_eq!(w.apply(&w.move_record(&alice, asset, "ANY", Recipient::Address(bob.addr), T, None, None))["record"], "accepted");
    assert_eq!(w.balance(&alice.addr.owner(), asset) + w.balance(&bob.addr.owner(), asset), u128::from(5 * T));
}

// ------------------------------------------------------------------------------------------------ before the opening block

/// One stream of records applied to a reader without the rules (open = None) and to one with them below its opening block:
/// every answer, the summary (counters included) and the notes are the same. Then, from the opening block on, records of the
/// other ledger (MD1 that is not an open deploy) still change nothing, counters included.
#[test]
fn below_the_opening_block_a_reader_with_the_rules_answers_as_one_without() {
    let mut w = W::new(1000);
    let mut old = w.pool.clone();
    old.open = None;
    let (alice, bob) = (signer(), signer());
    let sk = SigningKey::<SpendAuth>::new(OsRng);
    let key = VerificationKey::from(&sk).to_bytes();
    let bridged = asset_for_mint("TestMint1111111111111111111111111111111111").unwrap();
    let (deploy, id) = w.deploy_record(&alice, W::text("EARLY", 10, Some(5), Some(1)));
    let asset = open::asset_for_open(&id).unwrap();
    let (deploy2, id2) = w.deploy_record(&bob, W::text("LATER", 10, Some(5), Some(1)));
    let mut stream: Vec<Vec<u8>> = vec![];
    stream.push(w.credit_record(bridged, 50, key));
    stream.push(deploy.clone());
    stream.push(w.mint_record(asset, T, key));
    stream.push(w.mint_record(bridged, 1, key));
    stream.push(w.credit_record(bridged, 70, alice.addr.owner()));
    // Shapes that are not records of either kind.
    stream.push(open::MAGIC_MINT.to_vec());
    stream.push(open::MAGIC_INSCRIPTION.to_vec());
    stream.push([open::MAGIC_INSCRIPTION.as_slice(), &[8u8; 300]].concat());
    stream.push([open::MAGIC_MINT.as_slice(), &[0u8; 80]].concat());
    stream.push(deploy[..deploy.len() - 1].to_vec());
    // A credit for the asset of the deploy that was seen waiting (the issuer's hold-up), and an invalid credit (counts as rejected).
    stream.push(w.credit_record(asset, 9, key));
    let mut bad = w.credit_record(bridged, 9, key);
    let n = bad.len();
    bad[n - 1] ^= 1;
    stream.push(bad);
    stream.push(deploy2.clone());
    let mut results = vec![];
    for (i, wire) in stream.iter().enumerate() {
        let (txid, h) = (hex::encode([i as u8 + 1; 32]), 10 + i as u64);
        let a = old.apply_carrier(Some(wire), &txid, h, &[], &w.vks);
        let b = w.pool.apply_carrier(Some(wire), &txid, h, &[], &w.vks);
        assert_eq!(a, b, "record {i}");
        assert_eq!(old.summary(), w.pool.summary(), "record {i}");
        results.push(b["record"].as_str().unwrap().to_string());
    }
    assert_eq!(results, ["accepted", "ignored", "ignored", "ignored", "accepted", "ignored", "ignored", "ignored", "ignored", "ignored", "accepted", "rejected", "ignored"]);
    // Records that need existing notes, signed over what both readers hold: the same on both.
    let note = public::note_id(&public::record_id(&stream[0]), 0);
    let xp = public::Transfer::build(bridged, vec![note], vec![PublicOutput { owner: alice.addr.owner(), amount: 50 }], &sk, &w.domain).unwrap().encode();
    let xw = {
        let mut m = old.prepare_address_move(alice.addr, bridged, "XMR20", vec![(Recipient::Address(bob.addr), 60)], None, true, 100_000).unwrap();
        let (c, r) = sign(&m.text(&w.domain, MAINNET), &alice);
        m.c = c;
        m.r = r;
        m.encode()
    };
    for (i, wire) in [xp, xw].iter().enumerate() {
        let (txid, h) = (hex::encode([0x80 + i as u8; 32]), 999);
        let a = old.apply_carrier(Some(wire), &txid, h, &[], &w.vks);
        let b = w.pool.apply_carrier(Some(wire), &txid, h, &[], &w.vks);
        assert_eq!(a["record"], "accepted", "{a}");
        assert_eq!(a, b);
    }
    assert_eq!(old.summary(), w.pool.summary());
    assert_eq!(old.notes.keys().collect::<Vec<_>>(), w.pool.notes.keys().collect::<Vec<_>>());
    assert!(w.pool.open_tokens.is_empty() && w.pool.open_ids.is_empty());
    // The helpers answer the same too (no open token: no label).
    let q = json!({"op":"addressMovePrepare","signer":bob.addr.encode(MAINNET),"asset":hex::encode(bridged.to_bytes()),"ticker":"XMR20","to":[{"address":alice.addr.encode(MAINNET),"amount":"7"}],"feeInXmr":true,"until":5000});
    assert_eq!(old.address_op(&q, &w.vks, 999).unwrap(), w.pool.address_op(&q, &w.vks, 999).unwrap());

    // From the opening block: MD1 records that are not open deploys are nothing, also for the counters.
    w.height = 1000;
    let before = w.pool.summary();
    let mut flipped = deploy2.clone();
    let n = flipped.len();
    flipped[n - 1] ^= 1;
    let mut nft = deploy2.clone();
    nft[4] = 7;
    for wire in [flipped, nft, open::MAGIC_INSCRIPTION.to_vec(), [open::MAGIC_INSCRIPTION.as_slice(), &[8u8; 996]].concat(), [open::MAGIC_INSCRIPTION.as_slice(), &[8u8; 1100]].concat()] {
        assert_eq!(w.apply(&wire), json!({"record":"ignored"}));
    }
    assert_eq!(w.pool.summary(), before);
    // The deploy the issuer's credit got ahead of (below the opening block, too) is refused; the other one is the token's deploy.
    assert_eq!(w.apply(&deploy)["error"], "The asset of this token is in use");
    assert_eq!(w.apply(&deploy2)["record"], "accepted");
    assert_eq!(old.apply_carrier(Some(&deploy2), &hex::encode([0x99; 32]), 1000, &[], &w.vks), json!({"record":"ignored"}));
    assert!(w.pool.open_ids.contains_key(&id2));
}

/// The hosts consult `transport::known_magic` and `transport::unframe` BEFORE the pool sees a record (the engine's record list
/// and checkpoint counts are written on them). If they knew the two open-token magics at every height, an engine
/// built on this core would count every MD1 transaction of the XMR721 ledger as an XMR20 record. They answer for
/// those magics what they always answered; open records are asked for by name (`unframe_open`, `Pool::open_record`).
#[test]
fn the_old_transport_functions_do_not_know_the_new_magics() {
    let mut w = W::new(1_000_000);
    let (deploy, _) = w.deploy_record(&signer(), W::text("EARLY", 10, Some(5), None));
    let mint = Mint { asset: open::asset_for_open(&[1; 32]).unwrap(), amount: 1, owner: signer().addr.owner(), salt: [0; 8] }.encode();
    let nft = [open::MAGIC_INSCRIPTION.as_slice(), &[1u8; 200]].concat();
    for wire in [&deploy, &mint, &nft] {
        assert!(!transport::known_magic(wire));
        assert!(transport::parts(wire).is_err());
        let framed = transport::frame_open(wire, &[9u8; 32]).unwrap();
        assert!(!matches!(transport::unframe(&framed), Ok(Some(_))));
        assert_eq!(transport::unframe_open(&framed).unwrap().as_deref(), Some(wire.as_slice()));
        // Below the opening block nothing is a record of open tokens.
        assert!(!w.pool.open_record(wire, 999_999));
    }
    // From it on: a mint, and an MD1 record only when it is an open deploy.
    assert!(w.pool.open_record(&deploy, 1_000_000) && w.pool.open_record(&mint, 1_000_000) && !w.pool.open_record(&nft, 1_000_000));
    w.pool.open = None;
    assert!(!w.pool.open_record(&mint, 2_000_000));
}

/// XMR721's RULES.md section 8 takes the tx_extra fields in one order only. If transport::unframe took them in any order,
/// a deploy carried with its chunks before the transaction public key would be a token here and no inscription
/// there. transport.rs therefore reads an MD1 record in that one order only; this test
/// holds that behaviour: public key, then the payment id if there is one, then the chunks, and nothing else.
#[test]
fn a_deploy_is_read_only_from_an_extra_the_inscription_ledger_reads() {
    let mut w = W::new(0);
    let (deploy, _) = w.deploy_record(&signer(), W::text("ORDER", 10, Some(5), None));
    let framed = transport::frame_open(&deploy, &[9u8; 32]).unwrap();
    let pid: Vec<u8> = [&[2u8, 9, 1][..], &[7u8; 8]].concat();
    let chunks_first = [&framed[33..], &framed[..33]].concat();
    let pid_last = [&framed[..], &pid].concat();
    let pid_first = [&pid[..], &framed[..]].concat();
    for odd in [chunks_first, pid_last, pid_first] {
        assert!(!matches!(transport::unframe_open(&odd), Ok(Some(_))));
    }
    let with_pid = [&framed[..33], &pid, &framed[33..]].concat();
    for good in [framed, with_pid] {
        assert_eq!(transport::unframe_open(&good).unwrap().unwrap(), deploy);
    }
    // XO1 is a record of the token ledger alone and keeps the token ledger's framing (any order), like XP1 and the others.
    let mint = Mint { asset: open::asset_for_open(&[1; 32]).unwrap(), amount: 1, owner: signer().addr.owner(), salt: [0; 8] }.encode();
    let f = transport::frame_open(&mint, &[9u8; 32]).unwrap();
    assert_eq!(transport::unframe_open(&[&f[33..], &f[..33]].concat()).unwrap().unwrap(), mint);
    assert_eq!(w.apply(&deploy)["record"], "accepted");
}

// ------------------------------------------------------------------------------------------------ panics

/// The deploy check runs BEFORE the pool's catch_unwind (pool.rs, apply_carrier), on bytes anyone can put in a block. Damaged
/// copies of a valid deploy (bytes flipped, cut, extended, lengths rewritten) and arbitrary MD1 bytes: no panic, every answer
/// is "ignored", nothing counts. (A panic here would stop the test.)
#[test]
fn damaged_deploys_and_mints_never_panic_and_never_count() {
    let mut g = Rng(0x1234_5678_9abc_def1);
    let mut w = W::new(0);
    let alice = signer();
    let full = Text { tick: "ペペ\"\\".into(), name: Some("Pepe \"two\" \\ ü".into()), max: open::MAX_WHOLE, col: Some("ab".repeat(32)), lim: Some(5), pre: Some(7) };
    let seeds = [w.deploy_record(&alice, W::text("PEPE", 100, Some(10), Some(1))).0, w.deploy_record_variant(&alice, full, 2).0];
    for s in &seeds {
        let n = u16::from_le_bytes([s[CONTENT_LEN_AT], s[CONTENT_LEN_AT + 1]]) as usize;
        assert_eq!(s.len(), CONTENT_LEN_AT + 2 + n + 65);
    }
    for i in 0..30_000u32 {
        let mut b = seeds[(i % 2) as usize].clone();
        match g.below(6) {
            0 => {
                let n = g.below(b.len() as u64) as usize;
                b.truncate(n);
            }
            1 => b.extend((0..g.below(40)).map(|_| g.next() as u8)),
            2 => {
                b[CONTENT_LEN_AT] = g.next() as u8;
                b[CONTENT_LEN_AT + 1] = g.next() as u8;
            }
            3 => {
                let at = CONTENT_LEN_AT + 2 + g.below((b.len() - CONTENT_LEN_AT - 2 - 65) as u64) as usize;
                b[at] = g.next() as u8;
            }
            _ => {
                for _ in 0..1 + g.below(3) {
                    let at = g.below(b.len() as u64) as usize;
                    b[at] ^= 1 << g.below(8);
                }
            }
        }
        if seeds.contains(&b) || !b.starts_with(open::MAGIC_INSCRIPTION) {
            continue;
        }
        assert_eq!(w.pool.apply_carrier(Some(&b), &hex::encode([1u8; 32]), 10, &[], &w.vks), json!({"record":"ignored"}), "{}", hex::encode(&b));
    }
    for _ in 0..5_000 {
        let n = g.below(1011) as usize;
        let mut b = open::MAGIC_INSCRIPTION.to_vec();
        b.extend((0..n).map(|_| g.next() as u8));
        assert_eq!(w.pool.apply_carrier(Some(&b), &hex::encode([1u8; 32]), 10, &[], &w.vks), json!({"record":"ignored"}));
    }
    assert_eq!((w.pool.accepted, w.pool.rejected, w.pool.open_tokens.len(), w.pool.notes.len()), (0, 0, 0, 0));
    // XO1 of every damaged shape: refused (it counts as rejected from the opening block on), never applied, never a panic.
    let (_, asset) = w.deploy(&alice, W::text("PEPE", 100, Some(10), None));
    let good = Mint { asset, amount: T, owner: alice.addr.owner(), salt: [0; 8] }.encode();
    for _ in 0..5_000 {
        let mut b = good.clone();
        match g.below(3) {
            0 => {
                let n = 4 + g.below(b.len() as u64 - 4) as usize;
                b.truncate(n);
            }
            1 => b.push(g.next() as u8),
            _ => {
                // Asset or owner bytes: mostly not field elements or keys; the amount: often above the limit.
                let at = 4 + g.below(80) as usize;
                b[at] = g.next() as u8;
            }
        }
        let r = w.apply(&b);
        if r["record"] == "accepted" {
            let m = Mint::decode(&b).unwrap();
            assert!(m.asset == asset && m.amount <= 10 * T);
        } else {
            assert_eq!(r["record"], "rejected");
        }
    }
    assert!(w.pool.open_tokens[&hex::encode(asset.to_bytes())].left <= 100 * T);
}

// ------------------------------------------------------------------------------------------------ every other record kind

/// XW1 with a token fee, to a wallet key and with change; the label is in every amount of the text. The helpers' finalize
/// takes a pasted signature over the labelled text and no other.
#[test]
fn a_signed_move_of_an_open_token_with_a_token_fee_and_the_finalize_helper() {
    let mut w = W::new(0);
    let (alice, bob) = (signer(), signer());
    let (_, asset) = w.deploy(&alice, W::text("PEPE", 100, Some(50), Some(50)));
    assert_eq!(w.mint(asset, 30 * T, alice.addr.owner())["record"], "accepted");
    let label = w.label(asset);
    let relay = VerificationKey::from(&SigningKey::<SpendAuth>::new(OsRng)).to_bytes();
    let key = VerificationKey::from(&SigningKey::<SpendAuth>::new(OsRng)).to_bytes();
    // Two inputs (the creator's share and a mint), a key recipient, a fee note, change.
    let m = w.move_record(&alice, asset, "PEPE", Recipient::Key(key), 60 * T, Some((relay, 2 * T)), Some(&label));
    let text = address::Move::decode(&m).unwrap().text_as(&w.domain, MAINNET, Some(&label));
    assert!(text.contains(&format!("send 60 {label} to XMR20 key ")) && text.contains(&format!("; fee 2 {label}; from ")), "{text}");
    // The same record signed over the text with the ticker alone, or a label of another token: refused.
    let plain = w.move_record(&alice, asset, "PEPE", Recipient::Key(key), 60 * T, Some((relay, 2 * T)), None);
    assert_eq!(w.apply(&plain)["error"], "Invalid address move signature");
    let other = w.move_record(&alice, asset, "PEPE", Recipient::Key(key), 60 * T, Some((relay, 2 * T)), Some("PEPE (token 0000000000000000)"));
    assert_eq!(w.apply(&other)["error"], "Invalid address move signature");
    assert_eq!(w.apply(&m)["record"], "accepted");
    assert_eq!((w.balance(&key, asset), w.balance(&relay, asset), w.balance(&alice.addr.owner(), asset)), (u128::from(60 * T), u128::from(2 * T), u128::from(18 * T)));
    // Finalize: the helper finds the line ending and refuses a signature over the unlabelled text.
    let q = json!({"op":"addressMovePrepare","signer":alice.addr.encode(MAINNET),"asset":hex::encode(asset.to_bytes()),"ticker":"PEPE","to":[{"address":bob.addr.encode(MAINNET),"amount":(3 * T).to_string()}],"feeInXmr":true,"until":5000});
    let p = w.pool.address_op(&q, &w.vks, w.height).unwrap();
    let body = address::Move::decode_body(&hex::decode(p["body"].as_str().unwrap()).unwrap()).unwrap();
    let (c, r) = sign(&body.text(&w.domain, MAINNET), &alice);
    assert!(w.pool.address_op(&json!({"op":"addressMoveFinalize","body":p["body"],"signature":sigv2(c, r)}), &w.vks, w.height).is_err());
    let (c, r) = sign(&format!("{}\r\n", p["text"].as_str().unwrap()), &alice);
    let f = w.pool.address_op(&json!({"op":"addressMoveFinalize","body":p["body"],"signature":sigv2(c, r)}), &w.vks, w.height).unwrap();
    assert_eq!((f["variant"].as_u64(), f["text"].as_str()), (Some(2), p["text"].as_str()));
    assert_eq!(w.apply(&hex::decode(f["wire"].as_str().unwrap()).unwrap())["record"], "accepted");
    assert_eq!(w.balance(&bob.addr.owner(), asset), u128::from(3 * T));
    // A body whose ticker field is not the deploy's: the helper refuses it before any signature.
    let mut lie = body.clone();
    lie.ticker = "XMR20".into();
    let e = w.pool.address_op(&json!({"op":"addressMoveFinalize","body":hex::encode(lie.body()),"signature":sigv2(c, r)}), &w.vks, w.height).unwrap_err();
    assert_eq!(e.to_string(), "The ticker field of an open token is PEPE");
}

/// XT1 on an open token, the whole way: list (change back), reserve, pay, claim; and list, cancel. The lot's note belongs to
/// nobody's key; minting to a lot's owner key adds a note no record can take (the lot moves one named note).
#[test]
fn listing_reserving_claiming_and_cancelling_an_open_token() {
    let mut w = W::new(0);
    let (alice, bob) = (signer(), signer());
    let (_, asset) = w.deploy(&alice, W::text("PEPE", 100, Some(50), Some(40)));
    let label = w.label(asset);
    let list = |w: &W, amount: u64, ticker: &str, label: Option<&str>| -> Vec<u8> {
        let inputs: Vec<[u8; 32]> = w.notes_of(&alice.addr.owner(), asset).into_iter().map(|n| n.0).collect();
        let body = Body::List { asset, until: 1000, inputs, amount, price: 1_000_000_000_000, ticker: ticker.into(), seller: alice.addr };
        let (c, r) = sign(&body.text_as(&w.domain, MAINNET, None, label).unwrap(), &alice);
        Trade { body, variant: 0, c, r }.encode()
    };
    let wire = list(&w, 10 * T, "PEPE", None);
    assert_eq!(w.apply(&wire)["error"], "Invalid trade signature");
    let wire = list(&w, 10 * T, "XMR20", Some(&label));
    assert_eq!(w.apply(&wire)["error"], "The ticker field of an open token is PEPE");
    let wire = list(&w, 41 * T, "PEPE", Some(&label));
    assert_eq!(w.apply(&wire)["record"], "rejected");
    let wire = list(&w, 10 * T, "PEPE", Some(&label));
    let r = w.apply(&wire);
    assert_eq!(r["record"], "accepted", "{r}");
    let lot = h32(r["detail"]["lot"].as_str().unwrap());
    assert_eq!(w.balance(&alice.addr.owner(), asset), u128::from(30 * T));
    assert_eq!(w.balance(&trade::lot_owner(&lot), asset), u128::from(10 * T));
    // A mint to the lot's owner key: a second note there; it is not the lot's note and the buyer gets the listed amount only.
    assert_eq!(w.mint(asset, 5 * T, trade::lot_owner(&lot))["record"], "accepted");
    // Reserve: signed over the lot's terms with the label; the old wording is refused.
    let l = w.pool.lots[&lot].clone();
    let body = Body::Reserve { lot, pay_by: (w.height + 5) as u32, buyer: bob.addr };
    let pay = body.pay_amount(l.price, &w.domain).unwrap();
    let terms = |ticker: String| trade::Terms { amount: l.amount, price: l.price, ticker, seller: l.seller };
    let (c, r) = sign(&body.text(&w.domain, MAINNET, Some(&terms("PEPE".into()))).unwrap(), &bob);
    assert_eq!(w.apply(&Trade { body: body.clone(), variant: 0, c, r }.encode())["error"], "Invalid trade signature");
    let (c, r) = sign(&body.text(&w.domain, MAINNET, Some(&terms(label.clone()))).unwrap(), &bob);
    assert_eq!(w.apply(&Trade { body, variant: 0, c, r }.encode())["record"], "accepted");
    // Pay and claim.
    w.height += 1;
    let (facts, tx_key) = payment(&alice.addr, pay, w.height);
    let claim = Body::Claim { lot, txid: facts.txid, keys: vec![tx_key] }.bytes();
    assert_eq!(w.apply(&claim)["record"], "pending");
    let mut payments = BTreeMap::new();
    payments.insert(facts.txid, facts);
    let out = w.pool.resolve_claims(w.height, &payments);
    assert_eq!(out[0]["record"], "accepted", "{}", out[0]);
    assert!(w.pool.invariant().0);
    w.check_open_supply();
    assert_eq!(w.pool.lots[&lot].status, LotStatus::Sold);
    assert_eq!((w.balance(&bob.addr.owner(), asset), w.balance(&trade::lot_owner(&lot), asset)), (u128::from(10 * T), u128::from(5 * T)));
    // The buyer moves what was bought, by the label.
    assert_eq!(w.apply(&w.move_record(&bob, asset, "PEPE", Recipient::Address(alice.addr), 10 * T, None, Some(&label)))["record"], "accepted");
    // List and cancel: all of it comes back, once.
    let wire = list(&w, 40 * T, "PEPE", Some(&label));
    let r = w.apply(&wire);
    assert_eq!(r["record"], "accepted", "{r}");
    let lot2 = h32(r["detail"]["lot"].as_str().unwrap());
    assert_eq!(w.balance(&alice.addr.owner(), asset), 0);
    let body = Body::Cancel { lot: lot2, seller: alice.addr };
    let (c, r) = sign(&body.text(&w.domain, MAINNET, None).unwrap(), &alice);
    let cancel = Trade { body, variant: 0, c, r }.encode();
    assert_eq!(w.apply(&cancel)["record"], "accepted");
    assert_eq!(w.apply(&cancel)["record"], "rejected");
    assert_eq!(w.balance(&alice.addr.owner(), asset), u128::from(40 * T));
    // The trade helper's finalize takes the labelled listing text only.
    let q = json!({"op":"tradeListPrepare","seller":alice.addr.encode(MAINNET),"asset":hex::encode(asset.to_bytes()),"ticker":"PEPE","amount":T.to_string(),"price":"1000000000000","until":1000});
    let p = w.pool.trade_op(&q, &w.vks, w.height).unwrap();
    let body = Trade::decode_body(&hex::decode(p["body"].as_str().unwrap()).unwrap()).unwrap();
    let (c, r) = sign(&body.text(&w.domain, MAINNET, None).unwrap(), &alice);
    assert!(w.pool.trade_op(&json!({"op":"tradeFinalize","body":p["body"],"signature":sigv2(c, r)}), &w.vks, w.height).is_err());
    let (c, r) = sign(&format!("{}\n", p["text"].as_str().unwrap()), &alice);
    let f = w.pool.trade_op(&json!({"op":"tradeFinalize","body":p["body"],"signature":sigv2(c, r)}), &w.vks, w.height).unwrap();
    assert_eq!(w.apply(&hex::decode(f["wire"].as_str().unwrap()).unwrap())["record"], "accepted");
}

/// XA1 / XL1 (coin-anchored lots) take an open token's asset as any other: value is conserved, the anchor rule holds, and the
/// mint whose note went into the lot does not count again.
#[test]
fn anchored_lots_of_an_open_token() {
    let mut w = W::new(0);
    let (_, asset) = w.deploy(&signer(), W::text("LOT", 100, Some(60), None));
    let (seller_root, buyer_root) = (rnd(), rnd());
    let (sk, bk) = (owner_signing_key(&seller_root, 0), owner_signing_key(&buyer_root, 0));
    let (seller, buyer) = (owner_key(&sk), owner_key(&bk));
    let mint = w.mint_record(asset, 60 * T, seller);
    assert_eq!(w.apply(&mint)["record"], "accepted");
    let note = public::note_id(&public::record_id(&mint), 0);
    let (anchor, buyer_anchor) = (rnd(), rnd());
    let outs = vec![AnchoredOutput { owner: seller, amount: 25 * T, anchor }, AnchoredOutput { owner: seller, amount: 35 * T, anchor: NO_ANCHOR }];
    let t = Anchored::unsigned(asset, vec![note], outs).unwrap().sign(&sk, &w.domain).encode();
    let r = w.apply_native(&t, &[rnd()]);
    assert_eq!(r["record"], "accepted", "{r}");
    let lot = h32(r["detail"]["outputs"][0].as_str().unwrap());
    let sale = Sale::unsigned(asset, lot, 25 * T, buyer, buyer_anchor, [5; 32], [6; 32]).unwrap().sign(&sk, &w.domain).encode();
    // Without the anchor coin's key image the lot does not move; with it, it moves once.
    assert_eq!(w.apply_native(&sale, &[rnd()])["record"], "rejected");
    assert_eq!(w.apply_native(&sale, &[anchor])["record"], "accepted");
    assert_eq!(w.apply_native(&sale, &[anchor])["record"], "rejected");
    assert_eq!((w.balance(&buyer, asset), w.balance(&seller, asset)), (u128::from(25 * T), u128::from(35 * T)));
    assert_eq!(w.apply(&mint)["error"], "This mint record was applied already");
    assert_eq!(w.pool.open_tokens[&hex::encode(asset.to_bytes())].left, 40 * T);
}

/// XS1 / XU1 with Penumbra's published keys: an open token is shielded and unshielded like any asset; minted and left do not
/// move, an unshield is not a mint, and what exists stays minted - burned (checked after every record).
#[test]
fn shielding_and_unshielding_an_open_token() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../params/penumbra-2.1.1");
    let spend_pk = pz::load_pk(Circuit::Spend, &std::fs::read(dir.join("spend_pk.bin")).expect("spend_pk.bin")).unwrap();
    let output_pk = pz::load_pk(Circuit::Output, &std::fs::read(dir.join("output_pk.bin")).expect("output_pk.bin")).unwrap();
    let svk = pz::vk_hex(&pz::load_vk_param(Circuit::Spend, &std::fs::read(dir.join("spend_vk.param")).unwrap()).unwrap());
    let ovk = pz::vk_hex(&pz::load_vk_param(Circuit::Output, &std::fs::read(dir.join("output_vk.param")).unwrap()).unwrap());
    let mut w = W::with_vks(0, &svk, &ovk);
    let (_, asset) = w.deploy(&signer(), W::text("DARK", 20, Some(10), None));
    let root = rnd();
    let (sk, key) = (owner_signing_key(&root, 0), token_spend_key(&root, 0));
    let owner = owner_key(&sk);
    let mint = w.mint_record(asset, 10 * T, owner);
    assert_eq!(w.apply(&mint)["record"], "accepted");
    let note = public::note_id(&public::record_id(&mint), 0);
    let (s, _) = shield::Shield::build(asset, vec![note], 10 * T, 7 * T, &shielded_address(&key), &sk, &output_pk, &w.domain).unwrap();
    let r = w.apply(&s.encode());
    assert_eq!(r["record"], "accepted", "{r}");
    let a = hex::encode(asset.to_bytes());
    assert_eq!((w.balance(&owner, asset), w.pool.shielded_balances(key.full_viewing_key())[&a]), (u128::from(3 * T), u128::from(7 * T)));
    // The mint record again while its tokens are shielded: nothing.
    assert_eq!(w.apply(&mint)["error"], "This mint record was applied already");
    let owned = w.pool.ledger.unspent_notes(key.full_viewing_key());
    let (u, _) = shield::Unshield::build(&w.pool.ledger, &key, &owned[0], 2 * T, owner, &spend_pk, &output_pk, &w.domain).unwrap();
    let uw = u.encode();
    assert_eq!(w.apply(&uw)["record"], "accepted");
    assert_eq!(w.apply(&uw)["record"], "rejected");
    assert_eq!((w.balance(&owner, asset), w.pool.shielded_balances(key.full_viewing_key())[&a]), (u128::from(5 * T), u128::from(5 * T)));
    let t = &w.pool.open_tokens[&a];
    assert_eq!((t.left, t.mints, w.pool.minted[&a]), (10 * T, 1, u128::from(10 * T)));
    // The rest is still there to mint, and no more.
    assert_eq!(w.mint(asset, 10 * T, owner)["detail"]["left"], "0");
    assert_eq!(w.mint(asset, 1, owner)["error"], "This token is minted out");
    assert_eq!(w.pool.outstanding()[&a], u128::from(20 * T));
}

/// A pool whose `open` was taken away while it holds open tokens (a host that loads a state under another setting): the
/// label rule and the credit refusal still hold for the tokens it has, new deploys and mints are ignored, nothing panics.
#[test]
fn tokens_without_an_activation_keep_their_rules() {
    let mut w = W::new(0);
    let (alice, bob) = (signer(), signer());
    let (_, asset) = w.deploy(&alice, W::text("PEPE", 10, Some(5), Some(5)));
    let label = w.label(asset);
    w.pool.open = None;
    assert_eq!(w.pool.open_view().len(), 1);
    assert_eq!(w.mint(asset, T, bob.addr.owner()), json!({"record":"ignored"}));
    let later = w.deploy_record(&bob, W::text("NEW", 10, Some(5), None)).0;
    assert_eq!(w.apply(&later), json!({"record":"ignored"}));
    let c = w.credit_record(asset, 5, bob.addr.owner());
    assert_eq!(w.apply(&c)["error"], "An open token takes no credits");
    assert_eq!(w.apply(&w.move_record(&alice, asset, "PEPE", Recipient::Address(bob.addr), T, None, None))["error"], "Invalid address move signature");
    assert_eq!(w.apply(&w.move_record(&alice, asset, "PEPE", Recipient::Address(bob.addr), T, None, Some(&label)))["record"], "accepted");
}

// ------------------------------------------------------------------------------------------------ the label

/// A creator anyone can rebuild (fixed secrets), so the pair found by the search below can be signed again in a test.
fn label_creator() -> Signer {
    let secret = Scalar::from_bytes_mod_order([7u8; 32]);
    Signer { secret, addr: Address { sub: false, spend: (secret * G).compress().0, view: (Scalar::from_bytes_mod_order([9u8; 32]) * G).compress().0 } }
}
fn label_text(name: &str) -> Text {
    Text { tick: "PEPE".into(), name: Some(name.into()), max: 21_000_000, col: None, lim: Some(1000), pre: Some(21_000) }
}
fn hex16(x: u64) -> [u8; 16] {
    const D: &[u8; 16] = b"0123456789abcdef";
    let mut o = [0u8; 16];
    for (i, b) in x.to_be_bytes().iter().enumerate() {
        o[2 * i] = D[(b >> 4) as usize];
        o[2 * i + 1] = D[(b & 15) as usize];
    }
    o
}
/// The search that found the pair in `finding_two_tokens_of_one_creator_share_one_label` (about 2^33 hashes; minutes on a
/// laptop). Two deploys by one address that differ in `name` only and whose ids start with the same 16 hex characters.
/// Run: cargo test --release --offline review_tests::search_two_tokens_with_one_label -- --ignored --nocapture
#[test]
#[ignore]
fn search_two_tokens_with_one_label() {
    use sha2::{Digest as _, Sha256};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    let who = label_creator();
    let d = Deploy { creator: who.addr, text: label_text("0000000000000000"), variant: 0, c: [0; 32], r: [0; 32] };
    let mut full = open::ID_TAG.to_vec();
    full.extend(INSCRIPTIONS);
    full.extend(d.body().unwrap());
    let at = full.windows(16).position(|w| w == b"0000000000000000").unwrap();
    let mut pre = Sha256::new();
    pre.update(&full[..at]);
    let tail = full[at + 16..].to_vec();
    let f = move |x: u64| -> u64 {
        let mut h = pre.clone();
        h.update(hex16(x));
        h.update(&tail);
        let o: [u8; 32] = h.finalize().into();
        u64::from_be_bytes(o[..8].try_into().unwrap())
    };
    const DP_BITS: u32 = 20;
    let trails: Arc<Mutex<HashMap<u64, (u64, u64)>>> = Arc::new(Mutex::new(HashMap::new()));
    let done = Arc::new(AtomicBool::new(false));
    let out: Arc<Mutex<Option<(u64, u64)>>> = Arc::new(Mutex::new(None));
    let work = Arc::new(AtomicU64::new(0));
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mut handles = vec![];
    for _ in 0..threads {
        let (f, trails, done, out, work) = (f.clone(), trails.clone(), done.clone(), out.clone(), work.clone());
        handles.push(std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                let start = OsRng.next_u64();
                let (mut x, mut len) = (start, 0u64);
                while x >> (64 - DP_BITS) != 0 && len < 1 << (DP_BITS + 5) {
                    x = f(x);
                    len += 1;
                }
                work.fetch_add(len, Ordering::Relaxed);
                if x >> (64 - DP_BITS) != 0 {
                    continue;
                }
                let other = {
                    let mut m = trails.lock().unwrap();
                    match m.get(&x) {
                        Some(o) => Some(*o),
                        None => {
                            m.insert(x, (start, len));
                            None
                        }
                    }
                };
                let Some((s2, l2)) = other else { continue };
                // Two trails that end in one point: walk the longer one ahead, then both until they meet.
                let (mut a, mut la, mut b, mut lb) = (start, len, s2, l2);
                while la > lb {
                    a = f(a);
                    la -= 1;
                }
                while lb > la {
                    b = f(b);
                    lb -= 1;
                }
                if a == b {
                    continue;
                }
                while la > 0 {
                    let (na, nb) = (f(a), f(b));
                    if na == nb {
                        *out.lock().unwrap() = Some((a, b));
                        done.store(true, Ordering::Relaxed);
                        break;
                    }
                    a = na;
                    b = nb;
                    la -= 1;
                }
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    let (a, b) = out.lock().unwrap().unwrap();
    let (na, nb) = (String::from_utf8(hex16(a).to_vec()).unwrap(), String::from_utf8(hex16(b).to_vec()).unwrap());
    let id = |n: &str| Deploy { creator: who.addr, text: label_text(n), variant: 0, c: [0; 32], r: [0; 32] }.id(&INSCRIPTIONS).unwrap();
    println!("hashes: {}", work.load(Ordering::Relaxed));
    println!("name A {na} id {}", hex::encode(id(&na)));
    println!("name B {nb} id {}", hex::encode(id(&nb)));
    assert_ne!(na, nb);
    assert_eq!(id(&na)[..8], id(&nb)[..8]);
}

/// OPEN.md section 7 shows 16 hex characters of the token id "so that nobody can make a second token whose id
/// starts the same way". Sixteen characters are 64 bits: two ids of one's OWN that start the same way take about 2^32 tries
/// (the search above: 4.0 billion hashes, 87 seconds on a laptop), because only `name` has to change and no signature is
/// needed while searching. These are two open deploys by one address, on this file's test ledger, that would be two tokens with
/// two assets and ONE label. Every text a person signs for either of them (a move, a listing, a reservation) names the token
/// with the same words; only the code at the end differs. Whoever deploys such a pair can sell the one as the other.
/// (Matching the label of somebody ELSE's token takes about 2^64 hashes: out of a laptop's reach, not out of reach.)
#[test]
fn no_two_tokens_share_the_characters_a_signed_text_shows() {
    let mut w = W::new(0);
    let (who, bob) = (label_creator(), signer());
    let (id_a, a) = w.deploy(&who, label_text("031c837f89239add"));
    // The second deploy is refused, so no two tokens share the 16 characters a signed text shows.
    let (wire_b, id_b) = w.deploy_record(&who, label_text("d5465c93f5e9b2d7"));
    assert_eq!(hex::encode(id_a), "7dbc1e4c34a553cc139ec780dba73c96814ae30d3a904fd31bdb2b84ea76ec44");
    assert_eq!(hex::encode(id_b), "7dbc1e4c34a553cc3e78caf9e1e1e09039787145add656021d8618adf57bd8fe");
    let r = w.apply(&wire_b);
    assert_eq!((r["record"].as_str().unwrap(), r["error"].as_str().unwrap()), ("rejected", "Another token's id starts with the same 16 characters"));
    assert_eq!(w.pool.open_tokens.len(), 1);
    assert_eq!(w.label(a), "PEPE (token 7dbc1e4c34a553cc)");
    let _ = bob;
}
