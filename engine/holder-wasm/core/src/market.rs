//! MONERO MARKET candidate records (29 Oct 2026). EXPERIMENTAL, UNREVIEWED. Real trading is disabled.
//!
//! Anchored Open notes. An anchored note names one native key image (its ANCHOR). The pool accepts a
//! record that consumes an anchored note only when the record's own native carrier spends that key
//! image (pool.rs `take_inputs`, the single input-resolution path used by XP1, XR1, XS1, XA1 and XL1).
//! Native consensus admits a key image at most once per chain, so on any one chain at most one
//! transaction can consume a given anchored note. A competing token spend of a listed lot therefore
//! conflicts NATIVELY with the sale transaction instead of only in the token ledger.
//!
//!   XA1 anchored transfer: magic4 asset32 nIn1 nOut1 inputs(nIn x noteId32)
//!                          outputs(nOut x (owner32 amount8 anchor32)) sig64
//!       anchor = 32 zero bytes means a plain (unanchored) output. Used to prepare a lot (plain -> anchored),
//!       to cancel one natively (anchored -> plain, spending the anchor) and for anchored sends/splits/merges.
//!   XL1 whole-lot sale:    magic4 asset32 lot32 quantity8 buyer32 buyerAnchor32 offer32 terms32 sig64
//!       lot = one anchored note of exactly `quantity`; the seller signs; the buyer's note may be anchored.
//!
//! DISCLOSURE (explicit deviation from rule R-F, for owner review): anchored outputs carry a native KEY
//! IMAGE in the record. When the anchor is spent, the record links that key image to the note, and because
//! the anchor output is created by the note's own carrier, observers can tell which ring member was the
//! real anchor input. Anchors carry 0 XMR. Plain notes and every existing record are unchanged.
//!
//! What this does NOT do: it does not make a lot's ANCESTRY native. A note's creation can still become
//! token-invalid, or be replaced by a look-alike output, on a reorganisation that reaches below it. The
//! market therefore only trades lots whose creation is FINAL under an explicit depth assumption (wallet and
//! order-book policy, see ../SETTLEMENT.md). The pool itself has no depth rule.
use anyhow::{ensure, Context, Result};
use decaf377_rdsa::{Signature, SigningKey, SpendAuth, VerificationKey};
use penumbra_sdk_asset::asset;
use rand_core::OsRng;

use crate::{asset_from_bytes, message, sum_amounts, Reader};

pub const MAGIC_ANCHORED: &[u8; 4] = b"XA1\xfe";
pub const MAGIC_SALE: &[u8; 4] = b"XL1\xfe";
pub const MARKET_PROTOCOL: &str = "XMR20-MARKET-v1-experimental";
pub const ANCHOR_LABEL: &[u8] = b"XMR20-MARKET-ANCHOR-AUTH-v1\0";
pub const SALE_LABEL: &[u8] = b"XMR20-MARKET-SALE-AUTH-v1\0";
pub const MAX_IO: usize = 4;
pub const NO_ANCHOR: [u8; 32] = [0; 32];
/// The block from which every reader applies XA1/XL1 (one coordinated switch, ACTIVATION.md). Below it, and when it is None,
/// the records are ignored exactly as a reader without the market rules ignores them, so old and new readers agree.
/// Test chains are on from the start. Mainnet: set at BUILD time with XMR20_MARKET_MAINNET_ACTIVATION=<block height> (the
/// activation build; every reader built with the same value), else None (owner, 31 Oct 2026: XMR20 lots first).
pub const MAINNET_ACTIVATION: Option<u64> = parse_height(option_env!("XMR20_MARKET_MAINNET_ACTIVATION"));
const fn parse_height(v: Option<&str>) -> Option<u64> {
    let Some(s) = v else { return None };
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 12 {
        panic!("XMR20_MARKET_MAINNET_ACTIVATION must be a block height");
    }
    let mut n: u64 = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] < b'0' || b[i] > b'9' {
            panic!("XMR20_MARKET_MAINNET_ACTIVATION must be a block height");
        }
        n = n * 10 + (b[i] - b'0') as u64;
        i += 1;
    }
    Some(n)
}
pub fn activation(network_kind: &str) -> Option<u64> {
    match network_kind {
        "offline-fakechain" | "stagenet" => Some(0),
        "mainnet" => MAINNET_ACTIVATION,
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnchoredOutput {
    pub owner: [u8; 32],
    pub amount: u64,
    pub anchor: [u8; 32],
}
impl AnchoredOutput {
    pub const BYTES: usize = 72;
    pub fn anchor(&self) -> Option<[u8; 32]> {
        (self.anchor != NO_ANCHOR).then_some(self.anchor)
    }
    fn encode(&self, b: &mut Vec<u8>) {
        b.extend(self.owner);
        b.extend(self.amount.to_le_bytes());
        b.extend(self.anchor);
    }
    fn decode(r: &mut Reader) -> Result<Self> {
        Ok(Self { owner: r.take32()?, amount: r.u64()?, anchor: r.take32()? })
    }
}
fn check_owner(k: &[u8; 32]) -> Result<()> {
    VerificationKey::<SpendAuth>::try_from(*k).map_err(|_| anyhow::anyhow!("Invalid owner key"))?;
    Ok(())
}

// ---------------------------------------------------------------- XA1
#[derive(Clone, Debug)]
pub struct Anchored {
    pub asset: asset::Id,
    pub inputs: Vec<[u8; 32]>,
    pub outputs: Vec<AnchoredOutput>,
    pub sig: Signature<SpendAuth>,
}
impl Anchored {
    pub fn body(&self) -> Vec<u8> {
        let mut b = MAGIC_ANCHORED.to_vec();
        b.extend(self.asset.to_bytes());
        b.push(self.inputs.len() as u8);
        b.push(self.outputs.len() as u8);
        for i in &self.inputs {
            b.extend(i);
        }
        for o in &self.outputs {
            o.encode(&mut b);
        }
        b
    }
    pub fn message(&self, domain: &[u8; 32]) -> [u8; 32] {
        message(ANCHOR_LABEL, domain, &self.body())
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.body();
        b.extend(self.sig.to_bytes());
        b
    }
    pub fn wire_len(n_in: usize, n_out: usize) -> usize {
        4 + 32 + 2 + 32 * n_in + AnchoredOutput::BYTES * n_out + 64
    }
    fn check(&self) -> Result<()> {
        ensure!(!self.inputs.is_empty() && self.inputs.len() <= MAX_IO, "One to four inputs required");
        ensure!(!self.outputs.is_empty() && self.outputs.len() <= MAX_IO, "One to four outputs required");
        let mut seen = std::collections::BTreeSet::new();
        for i in &self.inputs {
            ensure!(seen.insert(*i), "Duplicate input");
        }
        // Duplicate anchors are deliberately NOT refused: refusing them would let anyone who saw a buyer's
        // anchor in a waiting sale front-run it with a squatting record and turn the sale token-invalid.
        for o in &self.outputs {
            ensure!(o.amount > 0, "Zero-value output");
            check_owner(&o.owner)?;
        }
        Ok(())
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(b.len() >= 4 && &b[..4] == MAGIC_ANCHORED, "XA1 magic");
        let mut r = Reader::new(b, 4);
        let asset = asset_from_bytes(r.take(32)?)?;
        let n_in = r.u8()? as usize;
        let n_out = r.u8()? as usize;
        ensure!((1..=MAX_IO).contains(&n_in) && (1..=MAX_IO).contains(&n_out), "Input/output count");
        let mut inputs = vec![];
        for _ in 0..n_in {
            inputs.push(r.take32()?);
        }
        let mut outputs = vec![];
        for _ in 0..n_out {
            outputs.push(AnchoredOutput::decode(&mut r)?);
        }
        let sig = Signature::try_from(r.take(64)?)?;
        r.done()?;
        let t = Self { asset, inputs, outputs, sig };
        ensure!(t.encode() == b, "Canonical record");
        t.check()?;
        Ok(t)
    }
    pub fn total_out(&self) -> Result<u128> {
        sum_amounts(self.outputs.iter().map(|o| &o.amount))
    }
    pub fn verify_sig(&self, owner: &VerificationKey<SpendAuth>, domain: &[u8; 32]) -> Result<()> {
        owner.verify(&self.message(domain), &self.sig).context("Owner signature rejected")
    }
    pub fn unsigned(asset: asset::Id, inputs: Vec<[u8; 32]>, outputs: Vec<AnchoredOutput>) -> Result<Self> {
        let t = Self { asset, inputs, outputs, sig: [0u8; 64].into() };
        t.check()?;
        Ok(t)
    }
    pub fn sign(mut self, owner: &SigningKey<SpendAuth>, domain: &[u8; 32]) -> Self {
        self.sig = owner.sign(OsRng, &self.message(domain));
        self
    }
}

// ---------------------------------------------------------------- XL1
#[derive(Clone, Debug)]
pub struct Sale {
    pub asset: asset::Id,
    pub lot: [u8; 32],
    pub quantity: u64,
    pub buyer: [u8; 32],
    pub buyer_anchor: [u8; 32],
    pub offer: [u8; 32],
    pub terms: [u8; 32],
    pub sig: Signature<SpendAuth>,
}
impl Sale {
    pub const BYTES: usize = 4 + 32 + 32 + 8 + 32 + 32 + 32 + 32 + 64;
    pub fn body(&self) -> Vec<u8> {
        let mut b = MAGIC_SALE.to_vec();
        b.extend(self.asset.to_bytes());
        b.extend(self.lot);
        b.extend(self.quantity.to_le_bytes());
        b.extend(self.buyer);
        b.extend(self.buyer_anchor);
        b.extend(self.offer);
        b.extend(self.terms);
        b
    }
    pub fn message(&self, domain: &[u8; 32]) -> [u8; 32] {
        message(SALE_LABEL, domain, &self.body())
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.body();
        b.extend(self.sig.to_bytes());
        b
    }
    fn check(&self) -> Result<()> {
        ensure!(self.quantity > 0, "Positive lot quantity required");
        ensure!(self.offer != [0; 32] && self.terms != [0; 32], "Offer and terms digests required");
        check_owner(&self.buyer)?;
        Ok(())
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(b.len() == Self::BYTES && &b[..4] == MAGIC_SALE, "XL1 size/magic");
        let mut r = Reader::new(b, 4);
        let asset = asset_from_bytes(r.take(32)?)?;
        let s = Self { asset, lot: r.take32()?, quantity: r.u64()?, buyer: r.take32()?, buyer_anchor: r.take32()?, offer: r.take32()?, terms: r.take32()?, sig: Signature::try_from(r.take(64)?)? };
        r.done()?;
        ensure!(s.encode() == b, "Canonical record");
        s.check()?;
        Ok(s)
    }
    pub fn buyer_anchor(&self) -> Option<[u8; 32]> {
        (self.buyer_anchor != NO_ANCHOR).then_some(self.buyer_anchor)
    }
    pub fn verify_sig(&self, owner: &VerificationKey<SpendAuth>, domain: &[u8; 32]) -> Result<()> {
        owner.verify(&self.message(domain), &self.sig).context("Seller signature rejected")
    }
    pub fn unsigned(asset: asset::Id, lot: [u8; 32], quantity: u64, buyer: [u8; 32], buyer_anchor: [u8; 32], offer: [u8; 32], terms: [u8; 32]) -> Result<Self> {
        let s = Self { asset, lot, quantity, buyer, buyer_anchor, offer, terms, sig: [0u8; 64].into() };
        s.check()?;
        Ok(s)
    }
    pub fn sign(mut self, owner: &SigningKey<SpendAuth>, domain: &[u8; 32]) -> Self {
        self.sig = owner.sign(OsRng, &self.message(domain));
        self
    }
}

// ---------------------------------------------------------------- terms digest
pub const TERMS_LABEL: &[u8] = b"XMR20-MARKET-TERMS-v1\0";
/// Economic terms the seller's XL1 signature commits to. The native CLSAGs bind the exact transaction; this
/// digest lets anyone audit which offer, payout and fee the seller agreed to.
#[allow(clippy::too_many_arguments)]
pub fn terms_digest(domain: &[u8; 32], offer: &[u8; 32], lot: &[u8; 32], quantity: u64, price: u64, payout: &str, buyer: &[u8; 32], buyer_anchor: &[u8; 32], fee: u64, seller_anchor: &[u8; 32]) -> [u8; 32] {
    let mut b = offer.to_vec();
    b.extend(lot);
    b.extend(quantity.to_le_bytes());
    b.extend(price.to_le_bytes());
    b.push(payout.len() as u8);
    b.extend(payout.as_bytes());
    b.extend(buyer);
    b.extend(buyer_anchor);
    b.extend(fee.to_le_bytes());
    b.extend(seller_anchor);
    message(TERMS_LABEL, domain, &b)
}

// ---------------------------------------------------------------- XK1 offer / XK2 withdrawal (off chain)
pub const MAGIC_OFFER: &[u8; 4] = b"XK1\xfe";
pub const MAGIC_WITHDRAW: &[u8; 4] = b"XK2\xfe";
pub const OFFER_LABEL: &[u8] = b"XMR20-MARKET-OFFER-AUTH-v1\0";
pub const OFFER_ID_LABEL: &[u8] = b"XMR20-MARKET-OFFER-ID-v1\0";
pub const WITHDRAW_LABEL: &[u8] = b"XMR20-MARKET-WITHDRAW-AUTH-v1\0";
pub const MAX_OFFER_SECONDS: u64 = 7 * 24 * 3600;
/// A signed public listing of ONE anchored lot at a total XMR price. Never on chain; the order book stores it.
#[derive(Clone, Debug)]
pub struct Offer {
    pub genesis: [u8; 32],
    pub domain: [u8; 32],
    pub asset: [u8; 32],
    pub lot: [u8; 32],
    pub anchor: [u8; 32],
    pub seller: [u8; 32],
    pub quantity: u64,
    pub price: u64,
    pub created: u64,
    pub expires: u64,
    pub nonce: [u8; 32],
    pub payout: String,
    pub sig: Signature<SpendAuth>,
}
impl Offer {
    pub fn body(&self) -> Vec<u8> {
        let mut b = MAGIC_OFFER.to_vec();
        for x in [&self.genesis, &self.domain, &self.asset, &self.lot, &self.anchor, &self.seller] {
            b.extend(x);
        }
        for n in [self.quantity, self.price, self.created, self.expires] {
            b.extend(n.to_le_bytes());
        }
        b.extend(self.nonce);
        b.push(self.payout.len() as u8);
        b.extend(self.payout.as_bytes());
        b
    }
    pub fn id(&self) -> [u8; 32] {
        let mut b = OFFER_ID_LABEL.to_vec();
        b.extend(self.body());
        crate::hash(&b)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.body();
        b.extend(self.sig.to_bytes());
        b
    }
    fn check(&self) -> Result<()> {
        ensure!(self.quantity > 0 && self.price > 0, "Positive quantity and price required");
        ensure!(self.expires > self.created && self.expires - self.created <= MAX_OFFER_SECONDS, "Offer lifetime must be positive and at most seven days");
        ensure!(self.anchor != NO_ANCHOR, "Offer must name the lot anchor");
        ensure!((95..=106).contains(&self.payout.len()) && self.payout.bytes().all(|c| c.is_ascii_alphanumeric()), "Payout address encoding");
        check_owner(&self.seller)
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(b.len() <= 512 && b.len() > 4 && &b[..4] == MAGIC_OFFER, "XK1 size/magic");
        let mut r = Reader::new(b, 4);
        let (genesis, domain, asset, lot, anchor, seller) = (r.take32()?, r.take32()?, r.take32()?, r.take32()?, r.take32()?, r.take32()?);
        let (quantity, price, created, expires) = (r.u64()?, r.u64()?, r.u64()?, r.u64()?);
        let nonce = r.take32()?;
        let n = r.u8()? as usize;
        let payout = String::from_utf8(r.take(n)?.to_vec()).map_err(|_| anyhow::anyhow!("Payout address encoding"))?;
        let sig = Signature::try_from(r.take(64)?)?;
        r.done()?;
        let o = Self { genesis, domain, asset, lot, anchor, seller, quantity, price, created, expires, nonce, payout, sig };
        ensure!(o.encode() == b, "Canonical offer");
        o.check()?;
        Ok(o)
    }
    /// Signature, ledger pins and the time window. The lot's existence/depth is checked against the pool by the caller.
    pub fn verify(&self, genesis: &[u8; 32], domain: &[u8; 32], now: u64) -> Result<()> {
        ensure!(&self.genesis == genesis, "Offer is for another chain");
        ensure!(&self.domain == domain, "Offer is for another ledger domain");
        ensure!(self.created <= now + 300, "Offer created in the future");
        ensure!(now < self.expires, "Offer expired");
        let vk = VerificationKey::<SpendAuth>::try_from(self.seller).map_err(|_| anyhow::anyhow!("Invalid seller key"))?;
        vk.verify(&message(OFFER_LABEL, domain, &self.body()), &self.sig).context("Offer signature rejected")
    }
    #[allow(clippy::too_many_arguments)]
    pub fn build(genesis: [u8; 32], domain: [u8; 32], asset: [u8; 32], lot: [u8; 32], anchor: [u8; 32], seller: &SigningKey<SpendAuth>, quantity: u64, price: u64, created: u64, expires: u64, payout: String) -> Result<Self> {
        let mut nonce = [0u8; 32];
        rand_core::RngCore::fill_bytes(&mut OsRng, &mut nonce);
        let mut o = Self { genesis, domain, asset, lot, anchor, seller: VerificationKey::from(seller).to_bytes(), quantity, price, created, expires, nonce, payout, sig: [0u8; 64].into() };
        o.check()?;
        o.sig = seller.sign(OsRng, &message(OFFER_LABEL, &domain, &o.body()));
        Ok(o)
    }
}
#[derive(Clone, Debug)]
pub struct Withdraw {
    pub genesis: [u8; 32],
    pub domain: [u8; 32],
    pub offer: [u8; 32],
    pub seller: [u8; 32],
    pub created: u64,
    pub sig: Signature<SpendAuth>,
}
impl Withdraw {
    pub const BYTES: usize = 4 + 32 * 4 + 8 + 64;
    pub fn body(&self) -> Vec<u8> {
        let mut b = MAGIC_WITHDRAW.to_vec();
        for x in [&self.genesis, &self.domain, &self.offer, &self.seller] {
            b.extend(x);
        }
        b.extend(self.created.to_le_bytes());
        b
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.body();
        b.extend(self.sig.to_bytes());
        b
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(b.len() == Self::BYTES && &b[..4] == MAGIC_WITHDRAW, "XK2 size/magic");
        let mut r = Reader::new(b, 4);
        let w = Self { genesis: r.take32()?, domain: r.take32()?, offer: r.take32()?, seller: r.take32()?, created: r.u64()?, sig: Signature::try_from(r.take(64)?)? };
        r.done()?;
        ensure!(w.encode() == b, "Canonical withdrawal");
        Ok(w)
    }
    pub fn verify(&self, offer: &Offer) -> Result<()> {
        ensure!(self.genesis == offer.genesis && self.domain == offer.domain && self.offer == offer.id() && self.seller == offer.seller, "Withdrawal does not match the offer");
        let vk = VerificationKey::<SpendAuth>::try_from(self.seller).map_err(|_| anyhow::anyhow!("Invalid seller key"))?;
        vk.verify(&message(WITHDRAW_LABEL, &self.domain, &self.body()), &self.sig).context("Withdrawal signature rejected")
    }
    pub fn build(offer: &Offer, seller: &SigningKey<SpendAuth>, created: u64) -> Result<Self> {
        ensure!(VerificationKey::from(seller).to_bytes() == offer.seller, "Only the seller can withdraw the offer");
        let mut w = Self { genesis: offer.genesis, domain: offer.domain, offer: offer.id(), seller: offer.seller, created, sig: [0u8; 64].into() };
        w.sig = seller.sign(OsRng, &message(WITHDRAW_LABEL, &w.domain, &w.body()));
        Ok(w)
    }
}
