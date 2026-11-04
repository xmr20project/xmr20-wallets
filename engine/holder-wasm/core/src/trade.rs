//! SIGN TO TRADE (2 Nov 2026, research/sign-to-trade-20261102/DESIGN.md). EXPERIMENTAL, UNREVIEWED.
//!
//! The Monero Market from wallets that can only sign a message, send XMR and show a payment's transaction key (Feather, Cake
//! Wallet, any wallet2 wallet). Lots are listed and reserved with wallet2 "SigV2" message signatures (address.rs), paid with an
//! ordinary payment straight to the seller, and claimed with that payment's transaction key, which every reader checks itself.
//!
//!   XT1 record = "XT1\xfe" op1 body [variant1 c32 r32 for list / cancel / reserve]
//!     op 1 list     asset32 until4 nIn1 inputs(nIn x note32) amount8 price8(piconero) tickerLen1 ticker seller
//!     op 2 cancel   lot32 seller
//!     op 3 reserve  lot32 payBy4 buyer
//!     op 4 claim    lot32 paymentTxid32 nKeys1 keys(nKeys x 32)      (no signature: anyone may post a claim)
//!     seller / buyer = kind1 (0 main address, 1 subaddress) B32 A32;  lot = the list record's id (public::record_id)
//!   code = first 16 bytes of H("XMR20-TRADE-v1\0" || domain || magic || op || body)   (H = crate::message)
//!   texts (6-decimal token amounts, XMR with up to 12 decimals, no trailing zeros):
//!     list    "XMR20 list: sell <amount> <ticker> for <price> XMR paid to <seller>; valid until block <until>; code <code>"
//!     cancel  "XMR20 cancel listing <lot hex, 16 chars>; from <seller>; code <code>"
//!     reserve "XMR20 reserve: buy <amount> <ticker> for <price> XMR; pay exactly <pay> XMR to <seller> by block <payBy>;
//!              tokens to <buyer>; code <code>"            (one line; <amount>/<ticker>/<price>/<seller> are the lot's)
//!   pay = price + 1 + (big-endian u32 of code[0..4]) mod 999999: the exact payment that belongs to ONE reservation.
//!
//! RULES (every reader). list: inputs are the seller's plain Open notes; the listed amount moves into ONE lot note owned by
//! lot_owner(lot) (a key nobody can sign for, so only XT1 moves it); change returns to the seller. cancel: by the seller, while
//! no reservation is running (height <= its payBy); the lot note returns to the seller. reserve: lot open, height <= until, no
//! reservation running, buyer != seller, height < payBy <= min(height + 30, until). claim: for the lot's LATEST reservation,
//! settled at the END of its block with the payment transaction the reader fetched from its own node: the payment is in a block
//! not after the claim's (the same block as the reservation is fine: buyers pay at once), was never used before, and pays the
//! seller's address EXACTLY `pay` — the exact amount alone ties a payment to its reservation
//! (transaction-key derivation as wallet2's check_tx_key, plus the amount commitment). Then the lot note goes to the buyer.
use anyhow::{ensure, Context, Result};
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT as G, edwards::CompressedEdwardsY, scalar::Scalar, traits::IsIdentity, EdwardsPoint};
use decaf377::{Element, Fq};
use penumbra_sdk_asset::asset;
use sha3::{Digest, Keccak256};

use crate::address::{self, verify_spend_signature, Address, Net, SUFFIX};
use crate::{asset_from_bytes, message, Reader};

pub const MAGIC_TRADE: &[u8; 4] = b"XT1\xfe";
pub const TRADE_LABEL: &[u8] = b"XMR20-TRADE-v1\0";
pub const LOT_OWNER_LABEL: &[u8] = b"XMR20-TRADE-LOT-v1\0";
pub const OP_LIST: u8 = 1;
pub const OP_CANCEL: u8 = 2;
pub const OP_RESERVE: u8 = 3;
pub const OP_CLAIM: u8 = 4;
pub const MAX_RESERVE: u64 = 30;
pub const MAX_INPUTS: usize = 4;
pub const MAX_KEYS: usize = 17;
pub const MAX_TICKER: usize = 12;

/// Mainnet start block, set at BUILD time (XMR20_TRADES_MAINNET_ACTIVATION=<height>); test chains are on from the start.
pub const MAINNET_ACTIVATION: Option<u64> = parse_height(option_env!("XMR20_TRADES_MAINNET_ACTIVATION"));
const fn parse_height(v: Option<&str>) -> Option<u64> {
    let Some(s) = v else { return None };
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 12 {
        panic!("XMR20_TRADES_MAINNET_ACTIVATION must be a block height");
    }
    let mut n: u64 = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] < b'0' || b[i] > b'9' {
            panic!("XMR20_TRADES_MAINNET_ACTIVATION must be a block height");
        }
        n = n * 10 + (b[i] - b'0') as u64;
        i += 1;
    }
    Some(n)
}
pub fn activation(network_kind: &str) -> Option<address::Activation> {
    match network_kind {
        "offline-fakechain" => Some(address::Activation { from: 0, net: address::MAINNET }),
        "stagenet" => Some(address::Activation { from: 0, net: address::STAGENET }),
        "mainnet" => MAINNET_ACTIVATION.map(|from| address::Activation { from, net: address::MAINNET }),
        _ => None,
    }
}

/// The owner of a listed lot's note: a decaf377 key nobody can sign for (as address::owner_key, another label).
pub fn lot_owner(lot: &[u8; 32]) -> [u8; 32] {
    let h = blake2b_simd::Params::new().hash_length(64).to_state().update(LOT_OWNER_LABEL).update(lot).finalize();
    let b = h.as_bytes();
    Element::hash_to_curve(&Fq::from_le_bytes_mod_order(&b[..32]), &Fq::from_le_bytes_mod_order(&b[32..])).vartime_compress().0
}

pub fn token_amount(n: u64) -> String {
    let frac = format!("{:06}", n % 1_000_000);
    let frac = frac.trim_end_matches('0');
    if frac.is_empty() { (n / 1_000_000).to_string() } else { format!("{}.{}", n / 1_000_000, frac) }
}
pub fn xmr_amount(p: u64) -> String {
    let frac = format!("{:012}", p % 1_000_000_000_000);
    let frac = frac.trim_end_matches('0');
    if frac.is_empty() { (p / 1_000_000_000_000).to_string() } else { format!("{}.{}", p / 1_000_000_000_000, frac) }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Body {
    List { asset: asset::Id, until: u32, inputs: Vec<[u8; 32]>, amount: u64, price: u64, ticker: String, seller: Address },
    Cancel { lot: [u8; 32], seller: Address },
    Reserve { lot: [u8; 32], pay_by: u32, buyer: Address },
    Claim { lot: [u8; 32], txid: [u8; 32], keys: Vec<[u8; 32]> },
}
/// The lot terms a reservation's text names (the reader passes the lot it holds).
#[derive(Clone, Debug)]
pub struct Terms {
    pub amount: u64,
    pub price: u64,
    pub ticker: String,
    pub seller: Address,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Trade {
    pub body: Body,
    pub variant: u8,
    pub c: [u8; 32],
    pub r: [u8; 32],
}
fn party(a: &Address, b: &mut Vec<u8>) {
    b.push(u8::from(a.sub));
    b.extend(a.spend);
    b.extend(a.view);
}
fn read_party(r: &mut Reader) -> Result<Address> {
    let k = r.u8()?;
    ensure!(k <= 1, "Unknown address kind");
    Ok(Address { sub: k == 1, spend: r.take32()?, view: r.take32()? })
}
fn u32le(r: &mut Reader) -> Result<u32> {
    Ok(u32::from_le_bytes(r.take(4)?.try_into().unwrap()))
}
impl Body {
    pub fn op(&self) -> u8 {
        match self {
            Body::List { .. } => OP_LIST,
            Body::Cancel { .. } => OP_CANCEL,
            Body::Reserve { .. } => OP_RESERVE,
            Body::Claim { .. } => OP_CLAIM,
        }
    }
    pub fn signed(&self) -> bool {
        !matches!(self, Body::Claim { .. })
    }
    pub fn bytes(&self) -> Vec<u8> {
        let mut b = MAGIC_TRADE.to_vec();
        b.push(self.op());
        match self {
            Body::List { asset, until, inputs, amount, price, ticker, seller } => {
                b.extend(asset.to_bytes());
                b.extend(until.to_le_bytes());
                b.push(inputs.len() as u8);
                for i in inputs {
                    b.extend(i);
                }
                b.extend(amount.to_le_bytes());
                b.extend(price.to_le_bytes());
                b.push(ticker.len() as u8);
                b.extend(ticker.as_bytes());
                party(seller, &mut b);
            }
            Body::Cancel { lot, seller } => {
                b.extend(lot);
                party(seller, &mut b);
            }
            Body::Reserve { lot, pay_by, buyer } => {
                b.extend(lot);
                b.extend(pay_by.to_le_bytes());
                party(buyer, &mut b);
            }
            Body::Claim { lot, txid, keys } => {
                b.extend(lot);
                b.extend(txid);
                b.push(keys.len() as u8);
                for k in keys {
                    b.extend(k);
                }
            }
        }
        b
    }
    pub fn check(&self) -> Result<()> {
        match self {
            Body::List { inputs, amount, price, ticker, .. } => {
                ensure!((1..=MAX_INPUTS).contains(&inputs.len()), "One to four inputs required");
                let mut s = inputs.clone();
                s.sort();
                s.dedup();
                ensure!(s.len() == inputs.len(), "A note appears twice");
                ensure!(*amount > 0 && *price > 0, "Amount and price must be above 0");
                ensure!(!ticker.is_empty() && ticker.len() <= MAX_TICKER && ticker.bytes().all(|c| c.is_ascii_alphanumeric()), "Ticker: 1 to 12 letters or digits");
            }
            Body::Claim { keys, .. } => ensure!((1..=MAX_KEYS).contains(&keys.len()), "One to seventeen transaction keys"),
            _ => {}
        }
        Ok(())
    }
    pub fn signer(&self) -> Option<&Address> {
        match self {
            Body::List { seller, .. } | Body::Cancel { seller, .. } => Some(seller),
            Body::Reserve { buyer, .. } => Some(buyer),
            Body::Claim { .. } => None,
        }
    }
    pub fn lot(&self) -> Option<[u8; 32]> {
        match self {
            Body::List { .. } => None,
            Body::Cancel { lot, .. } | Body::Reserve { lot, .. } | Body::Claim { lot, .. } => Some(*lot),
        }
    }
    pub fn code(&self, domain: &[u8; 32]) -> [u8; 16] {
        message(TRADE_LABEL, domain, &self.bytes())[..16].try_into().unwrap()
    }
    /// The exact payment that belongs to a reservation with this body.
    pub fn pay_amount(&self, price: u64, domain: &[u8; 32]) -> Result<u64> {
        let c = self.code(domain);
        let tail = 1 + u64::from(u32::from_be_bytes(c[..4].try_into().unwrap()) % 999_999);
        price.checked_add(tail).context("Price too large")
    }
    /// The exact text the signer signs (without the variant's line ending). A reservation names the lot's terms.
    pub fn text(&self, domain: &[u8; 32], net: Net, terms: Option<&Terms>) -> Result<String> {
        let code = hex::encode(self.code(domain));
        Ok(match self {
            Body::List { until, amount, price, ticker, seller, .. } => format!(
                "XMR20 list: sell {} {} for {} XMR paid to {}; valid until block {}; code {}",
                token_amount(*amount), ticker, xmr_amount(*price), seller.encode(net), until, code
            ),
            Body::Cancel { lot, seller } => format!("XMR20 cancel listing {}; from {}; code {}", &hex::encode(lot)[..16], seller.encode(net), code),
            Body::Reserve { pay_by, buyer, .. } => {
                let t = terms.context("Unknown lot")?;
                format!(
                    "XMR20 reserve: buy {} {} for {} XMR; pay exactly {} XMR to {} by block {}; tokens to {}; code {}",
                    token_amount(t.amount), t.ticker, xmr_amount(t.price), xmr_amount(self.pay_amount(t.price, domain)?), t.seller.encode(net), pay_by, buyer.encode(net), code
                )
            }
            Body::Claim { .. } => anyhow::bail!("A claim is not signed"),
        })
    }
}
impl Trade {
    pub fn decode(b: &[u8]) -> Result<Self> {
        let mut r = Reader::new(b, 0);
        ensure!(r.take(4)? == MAGIC_TRADE, "Not a trade record");
        let body = match r.u8()? {
            OP_LIST => {
                let asset = asset_from_bytes(r.take(32)?)?;
                let until = u32le(&mut r)?;
                let n = r.u8()? as usize;
                ensure!((1..=MAX_INPUTS).contains(&n), "One to four inputs required");
                let inputs = (0..n).map(|_| r.take32()).collect::<Result<Vec<_>>>()?;
                let amount = r.u64()?;
                let price = r.u64()?;
                let tl = r.u8()? as usize;
                let ticker = String::from_utf8(r.take(tl)?.to_vec()).map_err(|_| anyhow::anyhow!("Bad ticker"))?;
                Body::List { asset, until, inputs, amount, price, ticker, seller: read_party(&mut r)? }
            }
            OP_CANCEL => Body::Cancel { lot: r.take32()?, seller: read_party(&mut r)? },
            OP_RESERVE => Body::Reserve { lot: r.take32()?, pay_by: u32le(&mut r)?, buyer: read_party(&mut r)? },
            OP_CLAIM => {
                let lot = r.take32()?;
                let txid = r.take32()?;
                let n = r.u8()? as usize;
                ensure!((1..=MAX_KEYS).contains(&n), "One to seventeen transaction keys");
                Body::Claim { lot, txid, keys: (0..n).map(|_| r.take32()).collect::<Result<Vec<_>>>()? }
            }
            _ => anyhow::bail!("Unknown trade operation"),
        };
        body.check()?;
        let (variant, c, rr) = if body.signed() {
            let v = r.u8()?;
            ensure!((v as usize) < SUFFIX.len(), "Unknown text variant");
            (v, r.take32()?, r.take32()?)
        } else {
            (0, [0u8; 32], [0u8; 32])
        };
        r.done()?;
        Ok(Self { body, variant, c, r: rr })
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.body.bytes();
        if self.body.signed() {
            b.push(self.variant);
            b.extend(self.c);
            b.extend(self.r);
        }
        b
    }
    pub fn verify_sig(&self, domain: &[u8; 32], net: Net, terms: Option<&Terms>) -> Result<()> {
        let Some(who) = self.body.signer() else { return Ok(()) };
        let mut text = self.body.text(domain, net, terms)?;
        text.push_str(SUFFIX[self.variant as usize]);
        ensure!(verify_spend_signature(text.as_bytes(), who, &self.c, &self.r), "Invalid trade signature");
        Ok(())
    }
    /// Relay helper: attach a pasted "SigV2…" signature, finding the line ending the copy added.
    pub fn attach(body: Body, signature: &str, domain: &[u8; 32], net: Net, terms: Option<&Terms>) -> Result<Self> {
        let (c, r) = address::parse_signature(signature)?;
        let who = *body.signer().context("A claim is not signed")?;
        let text = body.text(domain, net, terms)?;
        let variant = (0..SUFFIX.len() as u8)
            .find(|v| verify_spend_signature(format!("{}{}", text, SUFFIX[*v as usize]).as_bytes(), &who, &c, &r))
            .context("This signature is not for this text from this address. Sign the exact text with the address it names to sign.")?;
        Ok(Self { body, variant, c, r })
    }
    /// A prepared body (as Body::bytes returns it) read back.
    pub fn decode_body(bytes: &[u8]) -> Result<Body> {
        let mut b = bytes.to_vec();
        ensure!(b.len() > 5 && b[..4] == MAGIC_TRADE[..], "Not a trade record");
        if b[4] != OP_CLAIM {
            b.push(0);
            b.extend([0u8; 64]);
        }
        Ok(Self::decode(&b)?.body)
    }
}

// ---------------------------------------------------------------- payments (transaction key)
/// One output of a payment transaction as the reader's host extracted it from the transaction it fetched and id-checked:
/// the one-time key, the 8-byte encrypted amount and the amount commitment (RingCT types 4-6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentOutput {
    pub key: [u8; 32],
    pub ecdh: [u8; 8],
    pub commitment: [u8; 32],
}
/// What a reader's host knows about a payment: its id, its block and its outputs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentFacts {
    pub txid: [u8; 32],
    pub height: u64,
    pub outputs: Vec<PaymentOutput>,
}
fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut k = Keccak256::new();
    for p in parts {
        k.update(p);
    }
    k.finalize().into()
}
fn varint(mut n: usize) -> Vec<u8> {
    let mut out = vec![];
    loop {
        let b = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(b);
            return out;
        }
        out.push(b | 0x80);
    }
}
fn amount_h() -> EdwardsPoint {
    CompressedEdwardsY(hex::decode("8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94").unwrap().try_into().unwrap()).decompress().unwrap()
}
/// How much the outputs pay `to` according to the transaction keys (main key, then one additional key per output): wallet2's
/// check_tx_key, plus the commitment check, so a forged amount field is refused (an error) rather than counted.
pub fn paid_to(to: &Address, keys: &[[u8; 32]], outputs: &[PaymentOutput]) -> Result<u64> {
    let v = CompressedEdwardsY(to.view).decompress().context("The seller's address has an invalid view key")?;
    let b = CompressedEdwardsY(to.spend).decompress().context("The seller's address has an invalid spend key")?;
    ensure!(!keys.is_empty(), "No transaction key");
    let scalars = keys
        .iter()
        .map(|k| Option::<Scalar>::from(Scalar::from_canonical_bytes(*k)).filter(|s| *s != Scalar::ZERO).context("This is not a valid transaction key"))
        .collect::<Result<Vec<_>>>()?;
    let h = amount_h();
    let mut total: u64 = 0;
    for (i, o) in outputs.iter().enumerate() {
        let mut tries = vec![scalars[0]];
        if let Some(extra) = scalars.get(1 + i) {
            tries.push(*extra);
        }
        for r in tries {
            let d = (r * v).mul_by_cofactor().compress();
            let s = Scalar::from_bytes_mod_order(keccak(&[d.as_bytes(), &varint(i)]));
            if (s * G + b).compress().0 != o.key {
                continue;
            }
            let pad = keccak(&[b"amount", s.as_bytes()]);
            let mut a = [0u8; 8];
            for j in 0..8 {
                a[j] = o.ecdh[j] ^ pad[j];
            }
            let amount = u64::from_le_bytes(a);
            let mask = Scalar::from_bytes_mod_order(keccak(&[b"commitment_mask", s.as_bytes()]));
            let c = mask * G + Scalar::from(amount) * h;
            ensure!(c.compress().0 == o.commitment, "Output {i} pays this address but its amount does not match its commitment");
            total = total.checked_add(amount).context("Amount overflow")?;
            break;
        }
    }
    Ok(total)
}
/// A usable address for a seller or buyer (spend key on the curve, prime order, not the identity).
pub fn usable(a: &Address) -> bool {
    CompressedEdwardsY(a.spend).decompress().is_some_and(|p| !p.is_identity() && p.is_torsion_free())
}
/// Payment facts as JSON (saved state of the readers): {txid, height, outputs: [{key, ecdh, commitment}]}.
pub fn facts_to_json(f: &PaymentFacts) -> serde_json::Value {
    serde_json::json!({"txid":hex::encode(f.txid),"height":f.height,"outputs":f.outputs.iter().map(|o| serde_json::json!({"key":hex::encode(o.key),"ecdh":hex::encode(o.ecdh),"commitment":hex::encode(o.commitment)})).collect::<Vec<_>>()})
}
pub fn facts_from_json(v: &serde_json::Value) -> Result<PaymentFacts> {
    let h32 = |s: Option<&str>| -> Result<[u8; 32]> { hex::decode(s.context("hex field")?)?.try_into().map_err(|_| anyhow::anyhow!("32-byte field")) };
    let outputs = v["outputs"].as_array().context("payment outputs")?.iter().map(|o| -> Result<PaymentOutput> {
        Ok(PaymentOutput { key: h32(o["key"].as_str())?, ecdh: hex::decode(o["ecdh"].as_str().context("ecdh")?)?.try_into().map_err(|_| anyhow::anyhow!("ecdh"))?, commitment: h32(o["commitment"].as_str())? })
    }).collect::<Result<Vec<_>>>()?;
    Ok(PaymentFacts { txid: h32(v["txid"].as_str())?, height: v["height"].as_u64().context("payment height")?, outputs })
}
