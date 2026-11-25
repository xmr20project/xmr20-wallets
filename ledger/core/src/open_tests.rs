//! Open tokens: the rules of open.rs, offline. open_fixtures.json holds mint records made and signed by the XMR721
//! repository's own rule library (xmr20-tokens/tools/open-fixtures.mjs there), so these tests prove the core reads the same
//! records as open deploys, with the same ids and signed texts, and passes over the same ones.
//! Run: cargo test --release --offline open_tests
use super::*;
use crate::address::{self, Address, Recipient, MAINNET};
use crate::open::{self, Deploy, Mint, Text};
use crate::penumbra::{self as pz, Circuit};
use crate::pool::{Pool, Vks};
use crate::trade::{self, Trade};
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT as G, scalar::Scalar};
use decaf377_rdsa::{SigningKey, SpendAuth, VerificationKey};
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value as J};
use sha3::{Digest, Keccak256};

fn rnd() -> [u8; 32] {
    let mut r = [0u8; 32];
    OsRng.fill_bytes(&mut r);
    r
}
fn h32(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}
fn fixtures() -> J {
    serde_json::from_str(include_str!("open_fixtures.json")).unwrap()
}
struct Signer {
    secret: Scalar,
    addr: Address,
}
fn signer() -> Signer {
    let secret = Scalar::from_bytes_mod_order(rnd());
    Signer { secret, addr: Address { sub: false, spend: (secret * G).compress().0, view: (Scalar::from_bytes_mod_order(rnd()) * G).compress().0 } }
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
const INSCRIPTIONS: [u8; 32] = [0x51; 32];
struct W {
    pool: Pool,
    vks: Vks,
    domain: [u8; 32],
    issuer: SigningKey<SpendAuth>,
    height: u64,
    salt: u64,
}
impl W {
    fn new(from: u64, inscriptions: [u8; 32]) -> Self {
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
        pool.trades = Some(address::Activation { from: 0, net: MAINNET });
        pool.open = Some(open::Activation { from, net: MAINNET, inscriptions });
        Self { pool, vks, domain, issuer, height: 10, salt: 0 }
    }
    fn apply(&mut self, wire: &[u8]) -> J {
        let r = self.pool.apply_carrier(Some(wire), &hex::encode(rnd()), self.height, &[], &self.vks);
        assert!(self.pool.invariant().0, "supply invariant");
        r
    }
    fn text(tick: &str, max: u64, lim: Option<u64>, pre: Option<u64>) -> Text {
        Text { tick: tick.to_string(), name: None, max, col: None, lim, pre }
    }
    fn deploy_record(&self, who: &Signer, text: Text) -> (Vec<u8>, [u8; 32]) {
        let mut d = Deploy { creator: who.addr, text, variant: 0, c: [0; 32], r: [0; 32] };
        let (c, r) = sign(&d.signed_text(&INSCRIPTIONS, MAINNET).unwrap(), who);
        d.c = c;
        d.r = r;
        (d.encode().unwrap(), d.id(&INSCRIPTIONS).unwrap())
    }
    fn deploy(&mut self, who: &Signer, text: Text) -> ([u8; 32], asset::Id) {
        let (wire, id) = self.deploy_record(who, text);
        let r = self.apply(&wire);
        assert_eq!(r["record"], "accepted", "{r}");
        assert_eq!(r["kind"], "open-deploy");
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
    fn balance(&self, owner: &[u8; 32], asset: asset::Id) -> u128 {
        self.pool.public_balances(owner).get(&hex::encode(asset.to_bytes())).copied().unwrap_or(0)
    }
    /// A signed move of `amount` from `who` to `to`, the text naming the token as `label` says (None: by the ticker field).
    fn move_record(&self, who: &Signer, asset: asset::Id, ticker: &str, to: &Address, amount: u64, label: Option<&str>) -> Vec<u8> {
        let mut m = self.pool.prepare_address_move(who.addr, asset, ticker, vec![(Recipient::Address(*to), amount)], None, true, 1000).unwrap();
        let (c, r) = sign(&m.text_as(&self.domain, MAINNET, label), who);
        m.c = c;
        m.r = r;
        m.encode()
    }
}
const T: u64 = open::UNIT;

#[test]
fn the_text_is_written_one_way_and_only_that_is_read() {
    let t = W::text("PEPE", 21_000_000, Some(1000), None);
    assert_eq!(t.write().unwrap(), r#"{"p":"xmr20","op":"deploy","tick":"PEPE","max":"21000000","dec":"6","mode":"open","lim":"1000"}"#);
    assert_eq!(Text::read(t.write().unwrap().as_bytes()), Some(t.clone()));
    let full = Text { tick: "ペペ".into(), name: Some("Pepe \"two\"".into()), max: open::MAX_WHOLE, col: Some("ab".repeat(32)), lim: Some(5), pre: Some(7) };
    assert_eq!(Text::read(full.write().unwrap().as_bytes()), Some(full));
    assert!(W::text("A", 10, None, Some(10)).write().is_ok());
    for bad in [W::text("A", 10, None, None), W::text("A", 10, Some(1), Some(10)), W::text("A", 10, Some(11), None), W::text("A", 10, Some(1), Some(11)), W::text("A", 10, Some(1), Some(0)), W::text("", 10, Some(1), None), W::text(" A", 10, Some(1), None), W::text("A\u{200b}", 10, Some(1), None), W::text("A", 0, Some(1), None), W::text("A", open::MAX_WHOLE + 1, Some(1), None), W::text(&"A".repeat(33), 10, Some(1), None)] {
        assert!(bad.write().is_err(), "{bad:?}");
    }
    assert_eq!(open::ticker_field("PEPE"), "PEPE");
    assert_eq!(open::ticker_field("ABCDEFGHIJKL"), "ABCDEFGHIJKL");
    for odd in ["ABCDEFGHIJKLM", "ペペ", "a b", "a-b", ""] {
        assert_eq!(open::ticker_field(odd), "TOKEN");
    }
    // An open token's asset is never the asset of a Solana mint, and differs from token to token.
    let (a, b) = (open::asset_for_open(&[1; 32]).unwrap(), open::asset_for_open(&[2; 32]).unwrap());
    assert_ne!(a, b);
    assert_ne!(a, asset_for_mint(&hex::encode([1u8; 32])).unwrap());
}

#[test]
fn records_of_the_rule_library_are_read_the_same_way() {
    let f = fixtures();
    let inscriptions = h32(f["domain"].as_str().unwrap());
    let (mut deploys, mut others) = (0, 0);
    for c in f["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let wire = hex::decode(c["record"].as_str().unwrap()).unwrap();
        let mut w = W::new(0, inscriptions);
        let r = w.apply(&wire);
        if c["expect"] == "deploy" {
            deploys += 1;
            let d = Deploy::decode(&wire).unwrap();
            assert_eq!(d.encode().unwrap(), wire, "{name}");
            assert_eq!(hex::encode(d.id(&inscriptions).unwrap()), c["id"].as_str().unwrap(), "{name}");
            assert_eq!(d.signed_text(&inscriptions, MAINNET).unwrap(), c["signedText"].as_str().unwrap(), "{name}");
            assert_eq!(d.variant as u64, c["variant"].as_u64().unwrap(), "{name}");
            assert_eq!(d.creator.encode(MAINNET), c["creator"].as_str().unwrap(), "{name}");
            assert_eq!(d.text.write().unwrap(), c["content"].as_str().unwrap(), "{name}");
            assert_eq!(open::ticker_field(&d.text.tick), c["tickerField"].as_str().unwrap(), "{name}");
            assert_eq!(open::label(&d.text.tick, &d.id(&inscriptions).unwrap()), c["label"].as_str().unwrap(), "{name}");
            assert_eq!(r["record"], "accepted", "{name}: {r}");
            assert_eq!(w.pool.open_tokens.len(), 1);
            // The same record on another XMR721 ledger is not this record: the signed code names the ledger.
            let mut other = W::new(0, [9; 32]);
            assert_eq!(other.apply(&wire)["record"], "ignored", "{name}");
        } else {
            others += 1;
            assert_eq!(r["record"], "ignored", "{name}: {r}");
            assert!(w.pool.open_tokens.is_empty() && w.pool.rejected == 0 && w.pool.accepted == 0, "{name}");
        }
    }
    assert!(deploys >= 5 && others >= 20);
}

#[test]
fn the_creator_share_and_mints_make_the_supply_and_nothing_else_does() {
    let mut w = W::new(0, INSCRIPTIONS);
    let (alice, bob) = (signer(), signer());
    let (id, asset) = w.deploy(&alice, W::text("PEPE", 100, Some(30), Some(25)));
    assert_eq!(w.balance(&alice.addr.owner(), asset), u128::from(25 * T));
    assert!(w.pool.notes.contains_key(&public::note_id(&id, 0)));
    let owner = bob.addr.owner();
    // More than one mint can take, and nothing: refused.
    assert_eq!(w.mint(asset, 30 * T + 1, owner)["record"], "rejected");
    assert!(Mint::decode(&Mint { asset, amount: 0, owner, salt: [0; 8] }.encode()).is_err());
    // Two full mints, then the last one gets what is left (15 of the 30 asked).
    assert_eq!(w.mint(asset, 30 * T, owner)["record"], "accepted");
    let again = w.mint_record(asset, 30 * T, owner);
    assert_eq!(w.apply(&again)["record"], "accepted");
    // The same bytes again count once; another salt is another mint.
    assert_eq!(w.apply(&again)["record"], "rejected");
    let last = w.mint(asset, 30 * T, owner);
    assert_eq!(last["detail"]["amount"], (15 * T).to_string());
    assert_eq!(last["detail"]["left"], "0");
    assert_eq!(w.mint(asset, 1, owner)["record"], "rejected");
    assert_eq!(w.balance(&owner, asset), u128::from(75 * T));
    assert_eq!(w.pool.outstanding()[&hex::encode(asset.to_bytes())], u128::from(100 * T));
    let v = &w.pool.open_view()[0];
    assert_eq!((v["minted"].as_str().unwrap(), v["left"].as_str().unwrap(), v["mints"].as_u64().unwrap()), ((100 * T).to_string().as_str(), "0", 3));
    // The issuer cannot credit an open token, before or after it is minted out.
    let credit = public::Credit::build(public::KIND_DEPOSIT, asset, 5, owner, [3; 32], &w.issuer, &w.domain).unwrap().encode();
    let r = w.apply(&credit);
    assert_eq!((r["record"].as_str().unwrap(), r["error"].as_str().unwrap()), ("rejected", "An open token takes no credits"));
    // Nobody mints a bridged token, or a token nobody deployed.
    let bridged = asset_for_mint("TestMint1111111111111111111111111111111111").unwrap();
    let c2 = public::Credit::build(public::KIND_DEPOSIT, bridged, 5, owner, [4; 32], &w.issuer, &w.domain).unwrap().encode();
    assert_eq!(w.apply(&c2)["record"], "accepted");
    assert_eq!(w.mint(bridged, 1, owner)["record"], "rejected");
    assert_eq!(w.mint(open::asset_for_open(&[5; 32]).unwrap(), 1, owner)["record"], "rejected");
    assert_eq!(w.balance(&owner, bridged), 5);
}

#[test]
fn a_token_is_deployed_once_and_a_mint_counts_only_after_its_deploy() {
    let mut w = W::new(0, INSCRIPTIONS);
    let alice = signer();
    let text = W::text("ONCE", 10, Some(10), None);
    let (wire, id) = w.deploy_record(&alice, text.clone());
    let asset = open::asset_for_open(&id).unwrap();
    let owner = alice.addr.owner();
    // A mint before the deploy is nothing; the same record after the deploy mints.
    let early = w.mint_record(asset, 4 * T, owner);
    assert_eq!(w.apply(&early)["record"], "rejected");
    assert_eq!(w.apply(&wire)["record"], "accepted");
    assert_eq!(w.apply(&early)["record"], "accepted");
    // The same deploy again, also signed anew, is the same token: refused, and nothing changes.
    assert_eq!(w.apply(&wire)["record"], "rejected");
    let (resigned, id2) = w.deploy_record(&alice, text.clone());
    assert_eq!(id, id2);
    assert_ne!(wire, resigned);
    assert_eq!(w.apply(&resigned)["record"], "rejected");
    assert_eq!((w.pool.open_tokens.len(), w.balance(&owner, asset)), (1, u128::from(4 * T)));
    // The same fields by another address, or with a name, are other tokens with the same ticker.
    let bob = signer();
    let (id3, _) = w.deploy(&bob, text.clone());
    let (id4, _) = w.deploy(&alice, Text { name: Some("Once more".into()), ..text });
    assert!(id3 != id && id4 != id && id3 != id4);
    assert_eq!(w.pool.open_tokens.values().filter(|t| t.text.tick == "ONCE").count(), 3);
}

#[test]
fn a_credit_made_for_the_asset_before_the_deploy_stops_the_deploy_not_the_supply_rule() {
    let mut w = W::new(0, INSCRIPTIONS);
    let alice = signer();
    let (wire, id) = w.deploy_record(&alice, W::text("RACE", 10, Some(1), None));
    let asset = open::asset_for_open(&id).unwrap();
    let credit = public::Credit::build(public::KIND_DEPOSIT, asset, 5, alice.addr.owner(), [8; 32], &w.issuer, &w.domain).unwrap().encode();
    assert_eq!(w.apply(&credit)["record"], "accepted");
    let r = w.apply(&wire);
    assert_eq!((r["record"].as_str().unwrap(), r["error"].as_str().unwrap()), ("rejected", "The asset of this token is in use"));
    assert!(w.pool.open_tokens.is_empty());
}

#[test]
fn nothing_counts_before_the_opening_block() {
    let mut w = W::new(100, INSCRIPTIONS);
    let alice = signer();
    let (wire, id) = w.deploy_record(&alice, W::text("EARLY", 10, Some(10), Some(1)));
    let asset = open::asset_for_open(&id).unwrap();
    let before = w.pool.summary();
    w.height = 99;
    assert_eq!(w.apply(&wire), json!({"record":"ignored"}));
    let m = w.mint_record(asset, T, alice.addr.owner());
    assert_eq!(w.apply(&m), json!({"record":"ignored"}));
    assert_eq!(w.pool.summary(), before);
    // A reader without these rules: the same answers at any height.
    let mut old = W::new(0, INSCRIPTIONS);
    old.pool.open = None;
    old.height = 500;
    assert_eq!(old.apply(&wire), json!({"record":"ignored"}));
    assert_eq!(old.apply(&m), json!({"record":"ignored"}));
    // From the opening block on the record carried again is the deploy.
    w.height = 100;
    assert_eq!(w.apply(&wire)["record"], "accepted");
    assert_eq!(w.apply(&m)["record"], "accepted");
    assert_eq!(w.balance(&alice.addr.owner(), asset), u128::from(2 * T));
}

#[test]
fn a_signed_move_names_an_open_token_by_ticker_and_id() {
    let mut w = W::new(0, INSCRIPTIONS);
    let (alice, bob) = (signer(), signer());
    let (id, asset) = w.deploy(&alice, W::text("PEPE", 100, None, Some(100)));
    let label = open::label("PEPE", &id);
    assert_eq!(label, format!("PEPE (token {})", &hex::encode(id)[..16]));
    // The text as it was before open tokens (the ticker alone) is not the text of this record.
    let plain = w.move_record(&alice, asset, "PEPE", &bob.addr, 5 * T, None);
    let r = w.apply(&plain);
    assert_eq!((r["record"].as_str().unwrap(), r["error"].as_str().unwrap()), ("rejected", "Invalid address move signature"));
    // Another ticker in the field is refused whatever was signed.
    let lie = w.move_record(&alice, asset, "XMR20", &bob.addr, 5 * T, Some("XMR20"));
    assert_eq!(w.apply(&lie)["error"], "The ticker field of an open token is PEPE");
    let good = w.move_record(&alice, asset, "PEPE", &bob.addr, 5 * T, Some(&label));
    let text = address::Move::decode(&good).unwrap().text_as(&w.domain, MAINNET, Some(&label));
    assert!(text.starts_with(&format!("XMR20 move: send 5 {label} to {}; network fee paid in XMR; from ", bob.addr.encode(MAINNET))), "{text}");
    assert_eq!(w.apply(&good)["record"], "accepted");
    assert_eq!((w.balance(&bob.addr.owner(), asset), w.balance(&alice.addr.owner(), asset)), (u128::from(5 * T), u128::from(95 * T)));
    // The relay's helpers give the same text and take the same signature.
    let q = json!({"op":"addressMovePrepare","signer":bob.addr.encode(MAINNET),"asset":hex::encode(asset.to_bytes()),"ticker":"PEPE","to":[{"address":alice.addr.encode(MAINNET),"amount":T.to_string()}],"feeInXmr":true,"until":1000});
    let p = w.pool.address_op(&q, &w.vks, w.height).unwrap();
    assert!(p["text"].as_str().unwrap().contains(&label));
    let mut wrong = q.clone();
    wrong["ticker"] = json!("OTHER");
    assert!(w.pool.address_op(&wrong, &w.vks, w.height).is_err());

    // A ticker the field cannot hold is written TOKEN, with the id.
    let (id2, asset2) = w.deploy(&alice, W::text("ペペ", 100, None, Some(100)));
    let label2 = open::label("ペペ", &id2);
    assert!(label2.starts_with("TOKEN (token "));
    assert_eq!(w.apply(&w.move_record(&alice, asset2, "PEPE", &bob.addr, T, Some(&label2)))["record"], "rejected");
    assert_eq!(w.apply(&w.move_record(&alice, asset2, "TOKEN", &bob.addr, T, Some(&label2)))["record"], "accepted");

    // A bridged token's text is what it always was.
    let bridged = asset_for_mint("TestMint1111111111111111111111111111111111").unwrap();
    let credit = public::Credit::build(public::KIND_DEPOSIT, bridged, 9 * T, alice.addr.owner(), [4; 32], &w.issuer, &w.domain).unwrap().encode();
    assert_eq!(w.apply(&credit)["record"], "accepted");
    assert_eq!(w.apply(&w.move_record(&alice, bridged, "ANY", &bob.addr, T, None))["record"], "accepted");
}

#[test]
fn a_listing_and_its_reservation_name_an_open_token_by_ticker_and_id() {
    let mut w = W::new(0, INSCRIPTIONS);
    let (alice, bob) = (signer(), signer());
    let (id, asset) = w.deploy(&alice, W::text("PEPE", 100, None, Some(100)));
    let label = open::label("PEPE", &id);
    let q = json!({"op":"tradeListPrepare","seller":alice.addr.encode(MAINNET),"asset":hex::encode(asset.to_bytes()),"ticker":"PEPE","amount":(10 * T).to_string(),"price":"1000000000000","until":1000});
    let p = w.pool.trade_op(&q, &w.vks, w.height).unwrap();
    let text = p["text"].as_str().unwrap();
    assert!(text.starts_with(&format!("XMR20 list: sell 10 {label} for 1 XMR paid to ")), "{text}");
    let body = Trade::decode_body(&hex::decode(p["body"].as_str().unwrap()).unwrap()).unwrap();
    // Signed over the old wording: refused. Signed over the text that names the token: listed.
    let old = body.text(&w.domain, MAINNET, None).unwrap();
    assert_ne!(old, text);
    let (c, r) = sign(&old, &alice);
    assert_eq!(w.apply(&Trade { body: body.clone(), variant: 0, c, r }.encode())["record"], "rejected");
    let (c, r) = sign(text, &alice);
    let listed = w.apply(&Trade { body, variant: 0, c, r }.encode());
    assert_eq!(listed["record"], "accepted", "{listed}");
    let lot = listed["detail"]["lot"].as_str().unwrap().to_string();
    let q = json!({"op":"tradeReservePrepare","buyer":bob.addr.encode(MAINNET),"lot":lot,"payBy":w.height + 5});
    let p = w.pool.trade_op(&q, &w.vks, w.height).unwrap();
    let text = p["text"].as_str().unwrap();
    assert!(text.starts_with(&format!("XMR20 reserve: buy 10 {label} for 1 XMR; pay exactly ")), "{text}");
    let body = Trade::decode_body(&hex::decode(p["body"].as_str().unwrap()).unwrap()).unwrap();
    let (c, r) = sign(text, &bob);
    assert_eq!(w.apply(&Trade { body, variant: 0, c, r }.encode())["record"], "accepted");
    // A listing with another ticker in its field is refused.
    let mut q2 = json!({"op":"tradeListPrepare","seller":alice.addr.encode(MAINNET),"asset":hex::encode(asset.to_bytes()),"ticker":"XMR20","amount":T.to_string(),"price":"1000000000000","until":1000});
    assert!(w.pool.trade_op(&q2, &w.vks, w.height).is_err());
    q2["ticker"] = json!("PEPE");
    assert!(w.pool.trade_op(&q2, &w.vks, w.height).is_ok());
    let _ = trade::MAX_INPUTS;
}

#[test]
fn a_mint_can_go_to_a_wallet_key_and_is_spent_like_any_note() {
    let mut w = W::new(0, INSCRIPTIONS);
    let alice = signer();
    let (_, asset) = w.deploy(&alice, W::text("KEY", 10, Some(10), None));
    let sk = SigningKey::<SpendAuth>::new(OsRng);
    let owner = VerificationKey::from(&sk).to_bytes();
    let wire = w.mint_record(asset, 10 * T, owner);
    let r = w.apply(&wire);
    assert_eq!(r["record"], "accepted");
    let note = public::note_id(&public::record_id(&wire), 0);
    let to = signer().addr.owner();
    let t = public::Transfer::build(asset, vec![note], vec![PublicOutput { owner: to, amount: 10 * T }], &sk, &w.domain).unwrap().encode();
    assert_eq!(w.apply(&t)["record"], "accepted");
    assert_eq!(w.balance(&to, asset), u128::from(10 * T));
    // The mint record carried again after its note was spent is still the same record: refused.
    assert_eq!(w.apply(&wire)["record"], "rejected");
    // An owner that is no key is refused.
    let mut bad = Mint { asset, amount: 1, owner: [0xff; 32], salt: [1; 8] }.encode();
    assert!(Mint::decode(&bad).is_err());
    bad.push(0);
    assert!(Mint::decode(&bad).is_err());
}

/// Values other implementations check themselves against (the XMR721 wallet's carrier tool does).
#[test]
fn vectors_for_other_implementations() {
    let id = h32("5f92229b4507fd196051e64a5b8af2bc00112233445566778899aabbccddeeff");
    let (spend, view) = ((Scalar::from(7u64) * G).compress().0, (Scalar::from(11u64) * G).compress().0);
    let asset = hex::encode(open::asset_for_open(&id).unwrap().to_bytes());
    let owner = hex::encode(Address { sub: false, spend, view }.owner());
    let mint = hex::encode(Mint { asset: open::asset_for_open(&id).unwrap(), amount: 1_000_000_000, owner: Address { sub: false, spend, view }.owner(), salt: [1, 2, 3, 4, 5, 6, 7, 8] }.encode());
    assert_eq!(hex::encode(spend), "b862409fb5c4c4123df2abf7462b88f041ad36dd6864ce872fd5472be363c5b1");
    assert_eq!(hex::encode(view), "1337036ac32d8f30d4589c3c1c595812ce0fff40e37c6f5a97ab213f318290ad");
    assert_eq!(asset, "0c042cf95628c99c19d3a686b9d43957d60669ba1555640d5d07a3180777090f");
    assert_eq!(owner, "22c3a5926232f2f1d394b49295cdab8d8c0af663edaa7c44d0f622deb8c46b04");
    assert_eq!(mint, "584f31fe0c042cf95628c99c19d3a686b9d43957d60669ba1555640d5d07a3180777090f00ca9a3b0000000022c3a5926232f2f1d394b49295cdab8d8c0af663edaa7c44d0f622deb8c46b040102030405060708");
}
