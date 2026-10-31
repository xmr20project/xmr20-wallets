//! MONERO MARKET candidate (29 Oct 2026): engine-level market operations. EXPERIMENTAL, UNREVIEWED.
//! Real trading is disabled: this candidate refuses every network but the offline fakechain (marketGuard).
//!
//! Wallet-owned: lot selection, anchors, token and native signatures, the seller's payout check, the buyer's
//! funding and change, the CLSAGs. The host (and through it a website) only sees public data plus, for the
//! buyer, a PRIVATE continuation that belongs in the wallet's own journal and nowhere else.
//!
//! Ops: marketProfile · marketStatus · marketPrepare · marketCancelLot · marketOuts · marketCancel · marketSign
//!      marketOffer · marketCheckOffer · marketWithdraw · marketCheckWithdraw · marketRing · marketBuy
//!      marketBuyDraft · marketSellerApprove · marketBuyerFinish · marketCheckSale
use super::*;
use crate::native::market::{decoys_from_hex, swap_record, AnchorChoice, Foreign, Purpose, ANCHOR_AMOUNT};
use monero_wallet::{address::{AddressType, MoneroAddress, Network}, ed25519::{Point, Scalar}, transaction::Transaction};
use rand_core::OsRng;
use std::collections::BTreeSet;
use xmr20_unshielded_core::market::{self as mk, Anchored, AnchoredOutput, Offer, Sale, Withdraw, NO_ANCHOR};

pub const MARKET_PROTOCOL_INFO: &str = "XMR20-MARKET-v1-experimental: anchored lots XA1, whole-lot sale XL1, offers XK1/XK2; anchors on a dedicated anchor key (option C); real trading disabled";
/// Default finality depth D (blocks): a lot is only bought (ring, purchase, seller approval) once its creating transaction has
/// D confirmations. Since 30 Oct 2026 (owner: show lots from 1 confirmation) it may be LISTED once that transaction is in a
/// block, so buyers see it while it matures; every step that moves value still waits for D.
/// Owner decisions: 29 Oct 2026 30 confirmations; 30 Oct 2026 lowered to 25 (about 50 minutes). The lab's tests run with 10.
pub const DEFAULT_FINALITY: u64 = 25;
pub const MIN_FINALITY: u64 = 10;

pub enum Pending {
    Prepare { asset: asset::Id, inputs: Vec<[u8; 32]>, total: u64, quantity: u64 },
    CancelLot { asset: asset::Id, lot: [u8; 32], amount: u64 },
    Ring { lot: [u8; 32] },
    Buy { offer: Offer, max_fee: u64 },
    Spare,
    // Anchored NFT sales (nft_ops.rs).
    NftAnchor { token: String, prev: String },
    NftBuy { listing: J, token: String, prev: String, seller: String, seller_anchor: [u8; 32], max_fee: u64 },
}
pub struct MarketState {
    pub finality: u64,
    pub pending: BTreeMap<String, Pending>,
    /// Lots whose sale signature this engine released (session view; the host journal is the durable record).
    pub released: BTreeSet<[u8; 32]>,
}
impl Default for MarketState {
    fn default() -> Self {
        Self { finality: DEFAULT_FINALITY, pending: BTreeMap::new(), released: BTreeSet::new() }
    }
}
fn fee_rate(q: &J) -> Result<monero_wallet::interface::FeeRate> {
    let per = q["feeRate"]["perWeight"].as_str().context("feeRate.perWeight")?.parse::<u64>()?;
    let mask = q["feeRate"]["mask"].as_str().context("feeRate.mask")?.parse::<u64>()?;
    monero_wallet::interface::FeeRate::new(per, mask).context("Invalid fee rate")
}
fn dist(q: &J) -> Result<Vec<u64>> {
    q["distribution"].as_array().context("distribution")?.iter().map(|v| v.as_u64().context("distribution entry")).collect()
}
fn scalar_hex(s: &Scalar) -> String {
    let mut v = vec![];
    s.write(&mut v).unwrap();
    hex::encode(v)
}
fn decimal(q: &J, k: &str) -> Result<u64> {
    let s = txt(q, k)?;
    ensure!(!s.is_empty() && s.len() <= 20 && s.bytes().all(|c| c.is_ascii_digit()) && (s == "0" || !s.starts_with('0')), "{k}: canonical decimal string required");
    Ok(s.parse()?)
}
fn tx_of(h: &str) -> Result<Transaction> {
    ensure!(h.len() <= 200_000, "Transaction too large");
    let b = hex::decode(h)?;
    let t = Transaction::read(&mut b.as_slice()).map_err(|e| anyhow::anyhow!("Transaction: {e}"))?;
    ensure!(t.serialize() == b, "Non-canonical transaction");
    Ok(t)
}
impl Engine {
    fn network(&self) -> Result<Network> {
        Ok(match self.params()?.manifest.network.kind.as_str() {
            "stagenet" => Network::Stagenet,
            _ => Network::Mainnet,
        })
    }
    fn genesis(&self) -> Result<[u8; 32]> {
        bytes32(&self.params()?.manifest.network.genesis)
    }
    /// Market operations that create or release signatures run on the offline fakechain and, since 29 Oct 2026 (owner:
    /// stagenet test deployment), on STAGENET (test funds). On mainnet they wait for the activation height built into this
    /// engine (`mk::MAINNET_ACTIVATION`, None until the reviewed activation build): every reader applies XA1/XL1 from there.
    pub(crate) fn market_guard(&self) -> Result<()> {
        let kind = &self.params()?.manifest.network.kind;
        match mk::activation(kind) {
            Some(h) => ensure!(self.tip + 1 >= h, "Market trading starts at block {h} on {kind}; this wallet has synced to block {}", self.tip),
            None => anyhow::bail!("Market trading is disabled on {kind}: settlement is experimental and unreviewed (offline fakechain and stagenet test funds only)"),
        }
        Ok(())
    }
    /// Native key images that anchor this holder's live notes: never funding inputs.
    pub fn anchors_in_use(&self) -> BTreeSet<[u8; 32]> {
        let (Some(pool), Some(me)) = (self.pool.as_ref(), self.owner_key) else { return BTreeSet::new() };
        pool.notes_of_owner(&me).into_iter().filter_map(|(_, n)| n.anchor.as_deref().and_then(|a| bytes32(a).ok())).collect()
    }
    fn my_lot(&self, lot: &[u8; 32]) -> Result<(pool::PublicNote, [u8; 32])> {
        let n = self.pool()?.notes.get(lot).cloned().context("Lot is not an unspent note")?;
        ensure!(n.owner == hex::encode(self.owner_key()?), "Lot belongs to another owner");
        let a = bytes32(n.anchor.as_deref().context("Note is not an anchored lot")?)?;
        ensure!(self.native.as_ref().context("No native wallet")?.owns_unspent(&a), "This wallet does not hold the lot's anchor output (restored elsewhere, or spent outside the protocol)");
        Ok((n, a))
    }
    fn confirmations(&self, height: u64) -> u64 {
        if height > self.tip { 0 } else { self.tip + 1 - height }
    }
    fn mined(&self, n: &pool::PublicNote) -> Result<()> {
        ensure!(self.confirmations(n.height) >= 1, "Lot is not in a block yet; it can be listed after its first confirmation");
        Ok(())
    }
    fn seasoned(&self, n: &pool::PublicNote) -> Result<()> {
        let c = self.confirmations(n.height);
        ensure!(c >= self.market.finality, "Lot has {c} confirmations; trading needs {} (finality depth)", self.market.finality);
        Ok(())
    }
    /// The anchor of a new lot (seller) or of a bought lot (buyer). Spare anchors (31 Oct 2026, DECISION-ANCHOR-PRIVACY.md):
    /// name a spare made earlier in a plain payment, so the later spend hides among 16 ordinary ring members. `q.anchor`:
    /// "spare" (required), "inline" (a new 0 XMR output inside this transaction, option A; never on mainnet), or absent
    /// (a spare when one is ready, else inline where allowed). `q.excludeAnchors`: spares named by records not yet mined.
    fn anchor_for_new(&self, q: &J) -> Result<Option<[u8; 32]>> {
        let kind = self.params()?.manifest.network.kind.clone();
        let mut ex = hexset(&q["excludeAnchors"])?;
        ex.extend(self.anchors_in_use());
        let ready = self.native.as_ref().context("No native wallet")?.spares(&ex).0;
        // A host that earmarks spares for waiting operations names the one it wants (`anchorKeyImage`).
        let spare = match q["anchorKeyImage"].as_str() {
            Some(k) => {
                let k = bytes32(k)?;
                Some(ready.iter().find(|(r, _)| *r == k).map(|(r, _)| *r).context("The chosen spare anchor is not ready, already named or not this wallet's")?)
            }
            None => ready.first().map(|(k, _)| *k),
        };
        match q["anchor"].as_str() {
            Some("spare") => Ok(Some(spare.context("No spare anchor is ready (make one first; it is usable after 10 blocks)")?)),
            Some("inline") => {
                ensure!(kind != "mainnet", "Anchors inside market transactions are not used on mainnet (spare anchors only)");
                Ok(None)
            }
            None => match spare {
                Some(a) => Ok(Some(a)),
                None if kind != "mainnet" => Ok(None),
                None => anyhow::bail!("No spare anchor is ready (make one first; it is usable after 10 blocks)"),
            },
            Some(other) => anyhow::bail!("anchor: 'spare' or 'inline', not {other}"),
        }
    }
    /// Decoy height for spending an anchor: the block that named it (a spare is older than that block, so the ring hides it
    /// among outputs at least as old); an inline anchor sits in that block, so its ring is sampled once it was spendable.
    fn anchor_as_of(&self, n: &pool::PublicNote, a: &[u8; 32]) -> usize {
        let out = self.native.as_ref().and_then(|w| w.output_height(a)).unwrap_or(0);
        (n.height as usize).max(out + native::DEFAULT_LOCK).min(self.tip as usize)
    }
    fn payout_ok(&self, s: &str) -> Result<MoneroAddress> {
        let a = MoneroAddress::from_str(self.network()?, s).map_err(|e| anyhow::anyhow!("Payout address: {e:?}"))?;
        ensure!(*a.kind() == AddressType::Legacy, "Payout must be a standard (primary) Monero address: subaddress and integrated payouts are not supported by this record framing");
        Ok(a)
    }
    fn native_mut(&mut self) -> Result<&mut native::NativeWallet> {
        self.native.as_mut().context("No native wallet")
    }
    /// Local admission of a record with its carrier's key images, on a copy of the pool.
    fn admit(&self, wire: &[u8], kis: &[[u8; 32]]) -> Result<J> {
        let p = self.params()?;
        let mut c = self.pool()?.clone();
        let r = c.apply_carrier(Some(wire), &hex::encode([0u8; 32]), self.tip + 1, kis, &p.vks);
        ensure!(r["record"] == "accepted", "Record fails local admission: {}", r["error"]);
        Ok(r)
    }
    fn offer_check(&self, wire: &[u8], now: u64) -> Result<(Offer, pool::PublicNote)> {
        let o = Offer::decode(wire)?;
        o.verify(&self.genesis()?, &self.params()?.domain, now)?;
        let n = self.pool()?.notes.get(&o.lot).cloned().context("Listed lot is not an unspent note on this chain")?;
        ensure!(n.asset == hex::encode(o.asset), "Listed lot is another asset");
        ensure!(n.owner == hex::encode(o.seller), "Listed lot belongs to another owner");
        ensure!(n.amount == o.quantity, "Listed quantity differs from the lot");
        ensure!(n.anchor.as_deref() == Some(hex::encode(o.anchor).as_str()), "Listed anchor differs from the lot");
        self.payout_ok(&o.payout)?;
        Ok((o, n))
    }
    fn lot_json(&self, id: &str, n: &pool::PublicNote) -> J {
        let anchor = n.anchor.as_deref().and_then(|a| bytes32(a).ok());
        let held = anchor.is_some_and(|a| self.native.as_ref().is_some_and(|w| w.owns_unspent(&a)));
        let c = self.confirmations(n.height);
        json!({"id":id,"asset":n.asset,"amount":n.amount.to_string(),"height":n.height,"txid":n.txid,"confirmations":c,"tradable":held && c>=self.market.finality,"anchorHeld":held,"released":anchor.is_some_and(|_| self.market.released.contains(&bytes32(id).unwrap_or([0;32])))})
    }
    pub fn market_call(&mut self, op: &str, q: &J) -> Result<J> {
        match op {
            "marketProfile" => {
                if let Some(d) = q["finalityDepth"].as_u64() {
                    ensure!((MIN_FINALITY..=100_000).contains(&d), "Finality depth must be at least {MIN_FINALITY} blocks (the spendable age of a Monero output)");
                    self.market.finality = d;
                }
                // Activation (31 Oct 2026): the block from which lots count on this network (null = never), and whether this
                // wallet's chain has reached it — the wallet shows market actions only when `active`.
                let kind = self.params()?.manifest.network.kind.clone();
                let activation = mk::activation(&kind);
                Ok(json!({"protocol":mk::MARKET_PROTOCOL,"finalityDepth":self.market.finality,"anchorAmount":ANCHOR_AMOUNT.to_string(),"network":kind,"activationHeight":activation,"active":activation.is_some_and(|h| self.tip + 1 >= h),"realTradingEnabled":false,"records":{"anchored":"XA1","sale":"XL1","offer":"XK1","withdraw":"XK2"}}))
            }
            "marketStatus" => {
                let me = self.owner_key()?;
                let notes = self.pool()?.notes_of_owner(&me);
                let mut lots = vec![];
                let mut plain: BTreeMap<String, u128> = BTreeMap::new();
                let mut listed: BTreeMap<String, u128> = BTreeMap::new();
                for (id, n) in &notes {
                    if n.anchor.is_some() {
                        lots.push(self.lot_json(id, n));
                        *listed.entry(n.asset.clone()).or_default() += u128::from(n.amount);
                    } else {
                        *plain.entry(n.asset.clone()).or_default() += u128::from(n.amount);
                    }
                }
                let s = |m: &BTreeMap<String, u128>| m.iter().map(|(a, v)| (a.clone(), v.to_string())).collect::<BTreeMap<_, _>>();
                let (ready, maturing) = self.native.as_ref().map(|w| w.spares(&self.anchors_in_use())).unwrap_or_default();
                let sp = |v: &[([u8; 32], usize)]| v.iter().map(|(k, h)| json!({"keyImage":hex::encode(k),"height":h})).collect::<Vec<_>>();
                Ok(json!({"ownerKey":hex::encode(me),"tip":self.tip,"finalityDepth":self.market.finality,"lots":lots,"openBalances":s(&plain),"lotBalances":s(&listed),"anchorsInUse":self.anchors_in_use().len(),"spares":{"ready":sp(&ready),"maturing":sp(&maturing)}}))
            }
            // Seller: make an anchored lot of exactly `quantity` from Open (plain) notes only. Private balance never fills a lot.
            "marketPrepare" => {
                self.market_guard()?;
                let asset = asset_of(q)?;
                let quantity = decimal(q, "quantity")?;
                ensure!(quantity > 0, "Positive quantity required");
                let exclude = hexset(&q["excludeNotes"])?;
                let (inputs, total) = self.select_public(asset, u128::from(quantity), &exclude)?;
                let total = u64::try_from(total)?;
                let n_out = if total > quantity { 2 } else { 1 };
                let len = Anchored::wire_len(inputs.len(), n_out);
                let (rate, d) = (fee_rate(q)?, dist(q)?);
                let mut ex = hexset(&q["exclude"])?;
                ex.extend(self.anchors_in_use());
                let choice = match self.anchor_for_new(q)? { Some(a) => AnchorChoice::named(a), None => AnchorChoice::new_inline() };
                let r = self.native_mut()?.anchored_start(&[], choice, *mk::MAGIC_ANCHORED, len, rate, d, &ex)?;
                self.market.pending.insert(txt(&r, "buildId")?.to_string(), Pending::Prepare { asset, inputs, total, quantity });
                Ok(r)
            }
            // Spare anchor (31 Oct 2026): a plain payment of 0 XMR to this wallet's anchor key, made ahead of a lot or a purchase.
            "marketSpare" => {
                self.market_guard()?;
                let (rate, d) = (fee_rate(q)?, dist(q)?);
                let mut ex = hexset(&q["exclude"])?;
                ex.extend(self.anchors_in_use());
                let r = self.native_mut()?.spare_start(rate, d, &ex)?;
                self.market.pending.insert(txt(&r, "buildId")?.to_string(), Pending::Spare);
                Ok(r)
            }
            // Seller: cancel a lot NATIVELY (spend its anchor; the lot becomes an ordinary Open note). This is the only way to
            // revoke a released sale signature on the current chain; it can still be undone by a reorganisation below it.
            "marketCancelLot" => {
                let lot = bytes32(txt(q, "lot")?)?;
                let (n, anchor) = self.my_lot(&lot)?;
                let asset = asset_from(&n.asset)?;
                let (rate, d) = (fee_rate(q)?, dist(q)?);
                let mut ex = hexset(&q["exclude"])?;
                ex.extend(self.anchors_in_use());
                let choice = AnchorChoice::none().with_as_of(Some((anchor, self.anchor_as_of(&n, &anchor))));
                let r = self.native_mut()?.anchored_start(&[anchor], choice, *mk::MAGIC_ANCHORED, Anchored::wire_len(1, 1), rate, d, &ex)?;
                self.market.pending.insert(txt(&r, "buildId")?.to_string(), Pending::CancelLot { asset, lot, amount: n.amount });
                Ok(r)
            }
            "marketOuts" => {
                let id = txt(q, "buildId")?.to_string();
                let mut outs = vec![];
                for o in q["outs"].as_array().context("outs")? {
                    let index = o["index"].as_u64().context("index")?;
                    let unlocked = o["unlocked"].as_bool().unwrap_or(false);
                    let point = |k: &str| -> Result<Point> { monero_wallet::ed25519::CompressedPoint::from(bytes32(txt(o, k)?)?).decompress().context("Invalid point from daemon") };
                    outs.push((index, if unlocked { Some([point("key")?, point("mask")?]) } else { None }));
                }
                self.native_mut()?.market_outs(&id, &outs)
            }
            "marketCancel" => {
                let id = txt(q, "buildId")?;
                self.market.pending.remove(id);
                Ok(json!({"cancelled":self.native_mut()?.market_cancel(id)}))
            }
            // Single-party anchored carriers (prepare / cancel lot): record built with the new anchor's key image, then signed.
            "marketSign" => {
                self.market_guard()?;
                let id = txt(q, "buildId")?.to_string();
                if matches!(self.market.pending.get(&id), Some(Pending::Spare)) {
                    let signed = self.native_mut()?.spare_sign(&id)?;
                    self.market.pending.remove(&id);
                    return Ok(signed);
                }
                let (anchor, kis) = {
                    let b = self.native.as_ref().context("No native wallet")?.build_ready(&id)?;
                    let r = b.ready.as_ref().unwrap();
                    (r.anchor, r.key_images.clone())
                };
                let me = self.owner_key()?;
                let owner = self.owner()?.clone();
                let domain = self.params()?.domain;
                let (record, summary) = match self.market.pending.get(&id).context("Unknown market operation")? {
                    Pending::Prepare { asset, inputs, total, quantity } => {
                        let a = anchor.context("Prepared lot needs a new anchor")?;
                        let mut outs = vec![AnchoredOutput { owner: me, amount: *quantity, anchor: a }];
                        if total > quantity {
                            outs.push(AnchoredOutput { owner: me, amount: total - quantity, anchor: NO_ANCHOR });
                        }
                        (Anchored::unsigned(*asset, inputs.clone(), outs)?.sign(&owner, &domain).encode(), json!({"kind":"prepare-lot","quantity":quantity.to_string()}))
                    }
                    Pending::CancelLot { asset, lot, amount } => (Anchored::unsigned(*asset, vec![*lot], vec![AnchoredOutput { owner: me, amount: *amount, anchor: NO_ANCHOR }])?.sign(&owner, &domain).encode(), json!({"kind":"cancel-lot","lot":hex::encode(lot),"quantity":amount.to_string()})),
                    _ => anyhow::bail!("Not a single-party market operation"),
                };
                let admitted = self.admit(&record, &kis)?;
                let mut signed = self.native_mut()?.anchored_sign(&id, &record)?;
                self.market.pending.remove(&id);
                signed["wire"] = json!(hex::encode(&record));
                signed["recordId"] = json!(hex::encode(core::hash(&record)));
                signed["notes"] = admitted["detail"]["outputs"].clone();
                signed["summary"] = summary;
                Ok(signed)
            }
            // Seller: sign a public listing of one of its lots once the lot is in a block (buyers wait for D). Payout = this wallet's own primary Monero address.
            "marketOffer" => {
                self.market_guard()?;
                let lot = bytes32(txt(q, "lot")?)?;
                let (n, anchor) = self.my_lot(&lot)?;
                self.mined(&n)?;
                let price = decimal(q, "price")?;
                let (created, expires) = (q["now"].as_u64().context("now")?, q["expires"].as_u64().context("expires")?);
                // Payout: this wallet's own primary address, or (30 Oct 2026, Monero accounts) another standard address
                // of this network named by the caller — the account service's market wallet pays sales into its XMR wallet.
                let payout = match q["payout"].as_str() {
                    Some(p) => { self.payout_ok(p)?; p.to_string() }
                    None => self.native.as_ref().context("No native wallet")?.address_for(&self.params()?.manifest.network.kind),
                };
                let o = Offer::build(self.genesis()?, self.params()?.domain, bytes32(&n.asset)?, lot, anchor, self.owner()?, n.amount, price, created, expires, payout)?;
                Ok(json!({"offerId":hex::encode(o.id()),"wire":hex::encode(o.encode()),"quantity":n.amount.to_string(),"price":price.to_string(),"payout":o.payout,"expires":expires}))
            }
            // MONERO ACCOUNTS (30 Oct 2026): the service's XMR wallet (address + private VIEW key) that this wallet's listings
            // pay; needed so the seller can see the buyer's payment to it. Never a spend key.
            "marketPayoutView" => {
                let address = txt(q, "address")?.to_string();
                let view = bytes32(txt(q, "viewKey")?)?;
                let net = self.network()?;
                self.native_mut()?.set_payout_view(net, &address, view)?;
                Ok(json!({"address":address}))
            }
            // Anyone (order book, buyer): verify an offer against this engine's chain view.
            "marketCheckOffer" => {
                let wire = hex::decode(txt(q, "wire")?)?;
                let (o, n) = self.offer_check(&wire, q["now"].as_u64().context("now")?)?;
                let c = self.confirmations(n.height);
                Ok(json!({"valid":true,"offerId":hex::encode(o.id()),"asset":hex::encode(o.asset),"lot":hex::encode(o.lot),"anchor":hex::encode(o.anchor),"seller":hex::encode(o.seller),"quantity":o.quantity.to_string(),"price":o.price.to_string(),"created":o.created,"expires":o.expires,"payout":o.payout,"lotHeight":n.height,"lotTxid":n.txid,"confirmations":c,"final":c>=self.market.finality}))
            }
            "marketWithdraw" => {
                let o = Offer::decode(&hex::decode(txt(q, "offer")?)?)?;
                let w = Withdraw::build(&o, self.owner()?, q["now"].as_u64().context("now")?)?;
                Ok(json!({"offerId":hex::encode(o.id()),"wire":hex::encode(w.encode())}))
            }
            "marketCheckWithdraw" => {
                let o = Offer::decode(&hex::decode(txt(q, "offer")?)?)?;
                let w = Withdraw::decode(&hex::decode(txt(q, "wire")?)?)?;
                w.verify(&o)?;
                Ok(json!({"valid":true,"offerId":hex::encode(o.id()),"created":w.created}))
            }
            // Seller: the public ring for its lot anchor (no signature; nothing is released).
            "marketRing" => {
                self.market_guard()?;
                let lot = bytes32(txt(q, "lot")?)?;
                let (n, anchor) = self.my_lot(&lot)?;
                self.seasoned(&n)?;
                let (rate, d) = (fee_rate(q)?, dist(q)?);
                let as_of = self.anchor_as_of(&n, &anchor);
                let r = self.native_mut()?.ring_start(&anchor, Some(as_of), d, rate)?;
                self.market.pending.insert(txt(&r, "buildId")?.to_string(), Pending::Ring { lot });
                Ok(r)
            }
            // Buyer: start the sale transaction for a verified, final offer.
            "marketBuy" => {
                self.market_guard()?;
                let wire = hex::decode(txt(q, "offer")?)?;
                let (o, n) = self.offer_check(&wire, q["now"].as_u64().context("now")?)?;
                ensure!(o.seller != self.owner_key()?, "This is your own lot");
                self.seasoned(&n)?;
                let ring = &q["sellerRing"];
                let ki = bytes32(txt(ring, "keyImage")?)?;
                ensure!(ki == o.anchor, "Seller ring is for another key image than the lot anchor");
                let decoys = decoys_from_hex(txt(ring, "decoys")?)?;
                let amount = decimal(ring, "amount")?;
                let max_fee = decimal(q, "maxFee")?;
                let payout = self.payout_ok(&o.payout)?;
                let (rate, d) = (fee_rate(q)?, dist(q)?);
                let mut ex = hexset(&q["exclude"])?;
                ex.extend(self.anchors_in_use());
                let buyer_anchor = self.anchor_for_new(q)?;
                let r = self.native_mut()?.buy_start(payout, o.price, Foreign { key_image: ki, decoys, amount }, buyer_anchor, Sale::BYTES, rate, d, &ex)?;
                self.market.pending.insert(txt(&r, "buildId")?.to_string(), Pending::Buy { offer: o, max_fee });
                Ok(r)
            }
            // Buyer: public draft for the seller + private continuation for this wallet's journal.
            "marketBuyDraft" => {
                self.market_guard()?;
                let id = txt(q, "buildId")?.to_string();
                let Some(Pending::Buy { offer, max_fee }) = self.market.pending.get(&id) else { anyhow::bail!("Unknown purchase") };
                let (offer, max_fee) = (offer.clone(), *max_fee);
                let (fee, anchor) = {
                    let b = self.native.as_ref().context("No native wallet")?.build_ready(&id)?;
                    ensure!(b.purpose == Purpose::Buy, "Not a purchase");
                    let r = b.ready.as_ref().unwrap();
                    (r.fee, r.anchor.context("Buyer anchor")?)
                };
                if fee > max_fee {
                    self.native_mut()?.market_cancel(&id);
                    self.market.pending.remove(&id);
                    anyhow::bail!("Network fee {fee} exceeds the approved ceiling {max_fee}; nothing reserved");
                }
                let me = self.owner_key()?;
                let domain = self.params()?.domain;
                let terms = mk::terms_digest(&domain, &o_id(&offer), &offer.lot, offer.quantity, offer.price, &offer.payout, &me, &anchor, fee, &offer.anchor);
                let record = Sale::unsigned(asset_from(&hex::encode(offer.asset))?, offer.lot, offer.quantity, me, anchor, o_id(&offer), terms)?.encode();
                let xs = Scalar::random(&mut OsRng);
                let (mut public, mut private) = self.native_mut()?.buy_draft(&id, &record, xs)?;
                for (k, v) in [("offerId", json!(hex::encode(o_id(&offer)))), ("lot", json!(hex::encode(offer.lot))), ("quantity", json!(offer.quantity.to_string())), ("price", json!(offer.price.to_string())), ("payout", json!(offer.payout)), ("buyer", json!(hex::encode(me))), ("buyerAnchor", json!(hex::encode(anchor))), ("terms", json!(hex::encode(terms))), ("total", json!((u128::from(offer.price) + u128::from(fee)).to_string())), ("record", json!(hex::encode(&record)))] {
                    public[k] = v.clone();
                    private[k] = v;
                }
                private["offer"] = json!(hex::encode(offer.encode()));
                // The construction is now owned by the continuation; the funding input stays reserved.
                self.native_mut()?.forget_build(&id);
                self.market.pending.remove(&id);
                Ok(json!({"draft":public,"continuation":private}))
            }
            // Seller: verify the proposed sale transaction with its own keys, then sign the XL1 record and ONE CLSAG.
            "marketSellerApprove" => {
                self.market_guard()?;
                let wire = hex::decode(txt(q, "offer")?)?;
                let (o, n) = self.offer_check(&wire, q["now"].as_u64().context("now")?)?;
                ensure!(o.seller == self.owner_key()?, "Not this wallet's offer");
                let (_, anchor) = self.my_lot(&o.lot)?;
                self.seasoned(&n)?;
                let d = &q["draft"];
                let mut tx = tx_of(txt(d, "unsignedTx")?)?;
                let decoys = decoys_from_hex(txt(d, "sellerDecoys")?)?;
                let mask = Scalar::read(&mut hex::decode(txt(d, "sellerMask")?)?.as_slice())?;
                let own = self.native.as_ref().context("No native wallet")?.address_for(&self.params()?.manifest.network.kind);
                let external = (o.payout != own).then(|| o.payout.clone());
                let (paid, fee) = self.native_mut()?.seller_check(&tx, &anchor, &decoys, external.as_deref())?;
                ensure!(paid == o.price, "The transaction pays this wallet {paid} piconero, not the agreed {}", o.price);
                let record = transport::unframe(&tx.prefix().extra)?.context("No sale record")?;
                ensure!(record.len() == Sale::BYTES && record.starts_with(mk::MAGIC_SALE), "Not a sale record");
                let buyer = bytes32(&hex::encode(&record[4 + 32 + 32 + 8..4 + 32 + 32 + 8 + 32]))?;
                let buyer_anchor = bytes32(&hex::encode(&record[4 + 32 + 32 + 8 + 32..4 + 32 + 32 + 8 + 64]))?;
                let domain = self.params()?.domain;
                let terms = mk::terms_digest(&domain, &o.id(), &o.lot, o.quantity, o.price, &o.payout, &buyer, &buyer_anchor, fee, &anchor);
                let unsigned = Sale::unsigned(asset_from(&hex::encode(o.asset))?, o.lot, o.quantity, buyer, buyer_anchor, o.id(), terms)?;
                ensure!(record == unsigned.encode(), "The sale record differs from this offer's terms");
                if let Some(cap) = q["maxFee"].as_str() {
                    ensure!(fee <= cap.parse::<u64>()?, "Fee above the offer's ceiling");
                }
                let signed = unsigned.sign(self.owner()?, &domain).encode();
                let kis = native::key_images(&tx);
                let admitted = self.admit(&signed, &kis)?;
                tx.prefix_mut().extra = swap_record(&tx.prefix().extra, &record, &signed)?;
                let (clsag, pseudo) = self.native.as_ref().context("No native wallet")?.seller_clsag(&tx, &anchor, decoys, mask)?;
                let mut cb = vec![];
                clsag.write(&mut cb)?;
                self.market.released.insert(o.lot);
                Ok(json!({"offerId":hex::encode(o.id()),"signedRecord":hex::encode(&signed),"clsag":hex::encode(cb),"pseudoOut":hex::encode(pseudo.to_bytes()),"paid":paid.to_string(),"fee":fee.to_string(),"buyer":hex::encode(buyer),"buyerNote":admitted["detail"]["outputs"][0],"terms":hex::encode(terms)}))
            }
            // Buyer: check the seller's signatures against the exact draft, sign the buyer's inputs, return the final bytes.
            "marketBuyerFinish" => {
                self.market_guard()?;
                let c = &q["continuation"];
                let signed = hex::decode(txt(q, "signedRecord")?)?;
                let record = hex::decode(txt(c, "record")?)?;
                ensure!(signed.len() == Sale::BYTES && signed[..Sale::BYTES - 64] == record[..Sale::BYTES - 64], "Seller changed the sale record");
                let clsag = hex::decode(txt(q, "clsag")?)?;
                let pseudo = bytes32(txt(q, "pseudoOut")?)?;
                let tx = self.native.as_ref().context("No native wallet")?.buy_finish(c, &signed, &clsag, &pseudo)?;
                let kis = native::key_images(&tx);
                let admitted = self.admit(&signed, &kis)?;
                let me = hex::encode(self.owner_key()?);
                ensure!(admitted["detail"]["buyer"].as_str() == Some(me.as_str()), "Sale would not deliver to this wallet");
                let fee = native::market::fee_of(&tx)?;
                ensure!(fee.to_string() == txt(c, "fee")?, "Fee changed");
                let blob = tx.serialize();
                Ok(json!({"txid":hex::encode(tx.hash()),"blob":hex::encode(&blob),"fee":fee.to_string(),"keyImages":kis.iter().map(hex::encode).collect::<Vec<_>>(),"buyerNote":admitted["detail"]["outputs"][0],"nativeBytes":blob.len()}))
            }
            // Anyone: what would this signed sale transaction deliver on the current chain view (no state change)?
            "marketCheckSale" => {
                let tx = tx_of(txt(q, "blob")?)?;
                let record = transport::unframe(&tx.prefix().extra)?.context("No record")?;
                let p = self.params()?;
                let mut c = self.pool()?.clone();
                Ok(c.apply_carrier(Some(&record), &hex::encode(tx.hash()), self.tip + 1, &native::key_images(&tx), &p.vks))
            }
            // Public (no wallet needed): market records the pool applied, newest first, with depth. For an order book.
            "marketRecords" => {
                let mut out: Vec<J> = self.records.iter().filter(|(_, r)| matches!(r.kind.as_str(), Some("lot-sale") | Some("anchored-transfer"))).map(|(id, r)| json!({"recordId":id,"kind":r.kind,"status":r.status,"error":r.error,"txid":r.txid,"height":r.height,"confirmations":self.confirmations(r.height),"detail":r.detail})).collect();
                out.sort_by_key(|r| std::cmp::Reverse(r["height"].as_u64().unwrap_or(0)));
                let lots: Vec<J> = self.pool()?.notes.iter().filter(|(_, n)| n.anchor.is_some()).map(|(id, n)| json!({"id":hex::encode(id),"asset":n.asset,"amount":n.amount.to_string(),"owner":n.owner,"height":n.height,"txid":n.txid,"confirmations":self.confirmations(n.height)})).collect();
                Ok(json!({"tip":self.tip,"finalityDepth":self.market.finality,"records":out,"lots":lots,"invariant":self.pool()?.invariant().0}))
            }
            "marketRecoverReserve" => {
                let kis = hexlist(&q["keyImages"])?;
                let n = self.native_mut()?;
                for k in &kis {
                    n.reserve_one(*k);
                }
                Ok(json!({"reserved":kis.len()}))
            }
            // Off-chain market messages only, SigV2 with the account's Monero spend key: NFT listings and withdrawals
            // (XMR20-MARKET-NFT-*-V1) and, since 30 Oct 2026, the relay-key attestation of one listing
            // (XMR20-MARKET-RELAY-KEY-V1: domain line + a 64-hex digest, nothing else).
            "marketSignMessage" => {
                self.market_guard()?;
                let data = txt(q, "message")?;
                let relay_key = data.strip_prefix("XMR20-MARKET-RELAY-KEY-V1\n").is_some_and(|d| d.len() == 64 && d.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')));
                ensure!(data.starts_with("XMR20-MARKET-NFT-LISTING-V1\n") || data.starts_with("XMR20-MARKET-NFT-WITHDRAW-V1\n") || relay_key, "Only market NFT listing, withdrawal and relay-key messages are signed");
                ensure!(data.len() <= 4096, "Message too long");
                let w = self.native.as_ref().context("No native wallet")?;
                let kind = self.params()?.manifest.network.kind.clone();
                Ok(json!({"signature":w.sign_message(data.as_bytes())?,"address":w.address_for(&kind)}))
            }
            #[cfg(feature = "lab-adversary")]
            "marketLabAdversary" => self.lab_adversary(q),
            other => anyhow::bail!("Unknown market op {other}"),
        }
    }
}
fn o_id(o: &Offer) -> [u8; 32] {
    o.id()
}
fn asset_from(h: &str) -> Result<asset::Id> {
    core::asset_from_bytes(&hex::decode(h)?)
}

// ---------------------------------------------------------------- TEST-ONLY attacker operations (feature lab-adversary)
#[cfg(feature = "lab-adversary")]
impl Engine {
    fn lab_adversary(&mut self, q: &J) -> Result<J> {
        self.market_guard()?;
        match txt(q, "action")? {
            // An owner-signed XP1 over ANY inputs, including an anchored lot (a dishonest seller's other installation).
            "signXp1" => {
                let asset = asset_of(q)?;
                let inputs = hexlist(&q["inputs"])?;
                let outs: Vec<PublicOutput> = q["outputs"].as_array().context("outputs")?.iter().map(|o| Ok(PublicOutput { owner: bytes32(txt(o, "owner")?)?, amount: decimal(o, "amount")? })).collect::<Result<_>>()?;
                Ok(json!({"wire":hex::encode(public::Transfer::build(asset, inputs, outs, self.owner()?, &self.params()?.domain)?.encode())}))
            }
            // A carrier for ANY record bytes, spending the given anchor key images, with NO local admission check.
            "forceStart" => {
                let anchors = hexlist(&q["anchors"])?;
                let len = q["wireLen"].as_u64().context("wireLen")? as usize;
                let magic: [u8; 4] = hex::decode(txt(q, "magic")?)?.try_into().map_err(|_| anyhow::anyhow!("magic"))?;
                let (rate, d) = (fee_rate(q)?, dist(q)?);
                let ex = hexset(&q["exclude"])?;
                self.native_mut()?.lab_force_start(&anchors, magic, len, rate, d, &ex)
            }
            "forceSign" => {
                let wire = hex::decode(txt(q, "wire")?)?;
                self.native_mut()?.anchored_sign(txt(q, "buildId")?, &wire)
            }
            // Ring control: sample decoys at or below this height (null clears).
            "decoyCap" => {
                let cap = q["height"].as_u64().map(|h| h as usize);
                self.native_mut()?.decoy_cap = cap;
                Ok(json!({"decoyCap":cap}))
            }
            other => anyhow::bail!("Unknown lab action {other}"),
        }
    }
}
