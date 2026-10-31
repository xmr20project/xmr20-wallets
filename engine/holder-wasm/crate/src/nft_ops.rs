//! MONERO MARKET candidate (30 Oct 2026): engine operations for anchored NFT sales (XMR20-NFT-V2). EXPERIMENTAL,
//! UNREVIEWED, OFFLINE LAB ONLY (the NFT records use mainnet-format addresses, so these operations refuse every network
//! but the offline fakechain). The NFT ledger itself (who owns which NFT, its last event, its anchor) is reduced by the
//! wallet host from the chain (nft/market.mjs); the engine owns every key, both native signatures and the record
//! signature, and checks what it signs.
//!
//! Ops: nftAnchorStart · nftAnchorSign · nftRing · nftBuy · nftBuyDraft · nftSellerApprove · nftBuyerFinish · nftOpen
use super::*;
use crate::market_ops::Pending;
use crate::native::market::{decoys_from_hex, Foreign, Frame, Purpose, ANCHOR_AMOUNT};
use crate::nft_v2::{self as nv, Listing, SaleRecord};
use monero_wallet::ed25519::Scalar;
use rand_core::{OsRng, RngCore};

fn hex64(q: &J, k: &str) -> Result<String> {
    let s = txt(q, k)?;
    ensure!(nv::is_hex(s, 64), "{k}: 64 lowercase hex characters required");
    Ok(s.to_string())
}
fn nonce() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}
impl Engine {
    fn nft_guard(&self) -> Result<String> {
        let kind = self.params()?.manifest.network.kind.clone();
        ensure!(kind == "offline-fakechain", "Anchored NFT sales run on the offline lab chain only (XMR20-NFT-V2 records carry mainnet-format addresses)");
        Ok(self.native.as_ref().context("No native wallet")?.address_for(&kind))
    }
    fn nft_depth(&self, anchor: &[u8; 32]) -> Result<u64> {
        let w = self.native.as_ref().context("No native wallet")?;
        ensure!(w.owns_unspent(anchor), "This wallet does not hold the NFT's anchor output (spent, or restored elsewhere)");
        let h = w.output_height(anchor).context("Anchor height")? as u64;
        let c = if h > self.tip { 0 } else { self.tip + 1 - h };
        ensure!(c >= self.market.finality, "The NFT's anchor has {c} confirmations; trading needs {}", self.market.finality);
        ensure!(w.anchor_spendable(anchor), "The NFT's anchor output is still locked");
        Ok(c)
    }
    pub fn nft_call(&mut self, op: &str, q: &J) -> Result<J> {
        self.market_guard()?;
        let me = self.nft_guard()?;
        let rate = || -> Result<monero_wallet::interface::FeeRate> {
            let per = q["feeRate"]["perWeight"].as_str().context("feeRate.perWeight")?.parse::<u64>()?;
            let mask = q["feeRate"]["mask"].as_str().context("feeRate.mask")?.parse::<u64>()?;
            monero_wallet::interface::FeeRate::new(per, mask).context("Invalid fee rate")
        };
        let dist = || -> Result<Vec<u64>> { q["distribution"].as_array().context("distribution")?.iter().map(|v| v.as_u64().context("distribution entry")).collect() };
        match op {
            // Owner: bind an NFT this wallet owns (per the host's reduced ledger) to a NEW anchor on the anchor key. When the
            // NFT is already anchored, its current anchor is spent in the same carrier (re-anchoring = native cancel).
            "nftAnchorStart" => {
                let (token, prev) = (hex64(q, "token")?, hex64(q, "prev")?);
                let current = match q["anchor"].as_str() {
                    Some(a) => vec![bytes32(a)?],
                    None => vec![],
                };
                let mut ex = hexset(&q["exclude"])?;
                ex.extend(self.anchors_in_use());
                let r = self.native_mut_nft()?.nft_anchored_start(&current, rate()?, dist()?, &ex)?;
                self.market.pending.insert(txt(&r, "buildId")?.to_string(), Pending::NftAnchor { token, prev });
                Ok(r)
            }
            "nftAnchorSign" => {
                let id = txt(q, "buildId")?.to_string();
                let Some(Pending::NftAnchor { token, prev }) = self.market.pending.get(&id) else { anyhow::bail!("Unknown NFT anchoring") };
                let (token, prev) = (token.clone(), prev.clone());
                let anchor = {
                    let b = self.native.as_ref().context("No native wallet")?.build_ready(&id)?;
                    ensure!(b.frame == Frame::Nft, "Not an NFT construction");
                    b.ready.as_ref().unwrap().anchor.context("NFT anchoring needs a new anchor")?
                };
                let record = nv::anchor_json(&me, &nonce(), &token, &prev, &hex::encode(anchor))?;
                let w = self.native.as_ref().context("No native wallet")?;
                let signature = w.sign_message(nv::signing_message(&record).as_bytes())?;
                let env = nv::envelope(&record, &signature);
                let carrier = nv::carrier(&env)?;
                let mut signed = self.native_mut_nft()?.nft_sign(&id, &carrier)?;
                self.market.pending.remove(&id);
                signed["record"] = json!(record);
                signed["carrier"] = json!(hex::encode(&carrier));
                signed["carrierBytes"] = json!(carrier.len());
                signed["token"] = json!(token);
                Ok(signed)
            }
            // Owner: the public ring for the NFT's anchor (nothing signed).
            "nftRing" => {
                let anchor = bytes32(txt(q, "anchor")?)?;
                self.nft_depth(&anchor)?;
                let r = self.native_mut_nft()?.ring_start(&anchor, None, dist()?, rate()?)?;
                Ok(r)
            }
            // Buyer: start the sale transaction for a listing of a final, anchored NFT (state from the buyer's own reducer).
            "nftBuy" => {
                let l = Listing::from_json(&q["listing"])?;
                ensure!(l.genesis == hex::encode(self.genesis_bytes()?), "Listing is for another chain");
                let now = q["now"].as_u64().context("now")?;
                ensure!(now < l.expires && l.created <= now + 300, "Listing is not current");
                let nft = &q["nft"];
                let (token, prev, owner) = (hex64(nft, "token")?, hex64(nft, "prev")?, txt(nft, "owner")?.to_string());
                let anchor = bytes32(&hex64(nft, "anchor")?)?;
                ensure!(token == l.token && prev == l.last && owner == l.owner, "Listing does not match the NFT's current state");
                ensure!(owner != me, "This is your own NFT");
                let h = nft["anchorHeight"].as_u64().context("nft.anchorHeight")?;
                let c = if h > self.tip { 0 } else { self.tip + 1 - h };
                ensure!(c >= self.market.finality, "The NFT's anchor has {c} confirmations; trading needs {}", self.market.finality);
                let ring = &q["sellerRing"];
                ensure!(bytes32(txt(ring, "keyImage")?)? == anchor, "Seller ring is for another key image than the NFT anchor");
                let decoys = decoys_from_hex(txt(ring, "decoys")?)?;
                let amount: u64 = txt(ring, "amount")?.parse()?;
                ensure!(amount == ANCHOR_AMOUNT, "Seller anchor must carry exactly {ANCHOR_AMOUNT} piconero");
                let max_fee: u64 = txt(q, "maxFee")?.parse()?;
                let payout = nv::address(&l.owner)?;
                let mut ex = hexset(&q["exclude"])?;
                ex.extend(self.anchors_in_use());
                let r = self.native_mut_nft()?.buy_start_framed(Frame::Nft, payout, l.price, Foreign { key_image: anchor, decoys, amount }, None, nv::LIMIT, rate()?, dist()?, &ex)?;
                self.market.pending.insert(txt(&r, "buildId")?.to_string(), Pending::NftBuy { listing: q["listing"].clone(), token, prev, seller: owner, seller_anchor: anchor, max_fee });
                Ok(r)
            }
            "nftBuyDraft" => {
                let id = txt(q, "buildId")?.to_string();
                let Some(Pending::NftBuy { listing, token, prev, seller, seller_anchor, max_fee }) = self.market.pending.get(&id) else { anyhow::bail!("Unknown NFT purchase") };
                let (listing_json, token, prev, seller, seller_anchor, max_fee) = (listing.clone(), token.clone(), prev.clone(), seller.clone(), *seller_anchor, *max_fee);
                let (fee, anchor) = {
                    let b = self.native.as_ref().context("No native wallet")?.build_ready(&id)?;
                    ensure!(b.purpose == Purpose::Buy && b.frame == Frame::Nft, "Not an NFT purchase");
                    let r = b.ready.as_ref().unwrap();
                    (r.fee, r.anchor.context("Buyer anchor")?)
                };
                if fee > max_fee {
                    self.native_mut_nft()?.market_cancel(&id);
                    self.market.pending.remove(&id);
                    anyhow::bail!("Network fee {fee} exceeds the approved ceiling {max_fee}; nothing reserved");
                }
                let l = Listing::from_json(&listing_json)?;
                let lid = l.id();
                let (anchor_hex, sa) = (hex::encode(anchor), hex::encode(seller_anchor));
                let terms = nv::terms(&l.genesis, &lid, &token, &prev, l.price, &l.owner, &me, &anchor_hex, fee, &sa);
                let record = SaleRecord { owner: seller.clone(), nonce: nonce(), token: token.clone(), prev: prev.clone(), to: me.clone(), anchor: anchor_hex.clone(), offer: lid.clone(), terms: terms.clone() }.json()?;
                let xs = Scalar::random(&mut OsRng);
                let (mut public, mut private) = self.native_mut_nft()?.nft_buy_draft(&id, xs)?;
                for (k, v) in [("listingId", json!(lid)), ("token", json!(token)), ("prev", json!(prev)), ("seller", json!(seller)), ("price", json!(l.price.to_string())), ("buyer", json!(me)), ("buyerAnchor", json!(anchor_hex)), ("terms", json!(terms)), ("total", json!((u128::from(l.price) + u128::from(fee)).to_string())), ("record", json!(record))] {
                    public[k] = v.clone();
                    private[k] = v;
                }
                private["listing"] = listing_json;
                self.native_mut_nft()?.forget_build(&id);
                self.market.pending.remove(&id);
                Ok(json!({"draft":public,"continuation":private}))
            }
            // Seller: check the buyer-built transaction with its own keys and the sale record against its listing, then
            // sign the record (spend key, SigV2), write the carrier into tx_extra and sign ONE CLSAG for the anchor.
            "nftSellerApprove" => {
                let l = Listing::from_json(&q["listing"])?;
                ensure!(l.owner == me, "Not this wallet's listing");
                ensure!(l.genesis == hex::encode(self.genesis_bytes()?), "Listing is for another chain");
                let nft = &q["nft"];
                ensure!(hex64(nft, "token")? == l.token && hex64(nft, "prev")? == l.last, "The NFT moved since this listing was signed");
                let anchor = bytes32(&hex64(nft, "anchor")?)?;
                self.nft_depth(&anchor)?;
                let d = &q["draft"];
                let mut tx = tx_of_nft(txt(d, "unsignedTx")?)?;
                let decoys = decoys_from_hex(txt(d, "sellerDecoys")?)?;
                let mask = Scalar::read(&mut hex::decode(txt(d, "sellerMask")?)?.as_slice())?;
                let (paid, fee) = self.native_mut_nft()?.seller_check(&tx, &anchor, &decoys, None)?;
                ensure!(paid == l.price, "The transaction pays this wallet {paid} piconero, not the listed {}", l.price);
                if let Some(cap) = q["maxFee"].as_str() {
                    ensure!(fee <= cap.parse::<u64>()?, "Fee above the ceiling");
                }
                let record = txt(d, "record")?;
                let r = SaleRecord::parse(record)?;
                let lid = l.id();
                ensure!(r.owner == me && r.token == l.token && r.prev == l.last && r.offer == lid, "The sale record differs from this listing");
                let terms = nv::terms(&l.genesis, &lid, &l.token, &l.last, l.price, &l.owner, &r.to, &r.anchor, fee, &hex::encode(anchor));
                ensure!(r.terms == terms, "The sale terms differ from the transaction");
                let signature = self.native.as_ref().context("No native wallet")?.sign_message(nv::signing_message(record).as_bytes())?;
                let carrier = nv::carrier(&nv::envelope(record, &signature))?;
                tx.prefix_mut().extra = nv::final_extra(&tx.prefix().extra, &carrier)?;
                let (clsag, pseudo) = self.native.as_ref().context("No native wallet")?.seller_clsag(&tx, &anchor, decoys, mask)?;
                let mut cb = vec![];
                clsag.write(&mut cb)?;
                self.market.released.insert(anchor);
                Ok(json!({"listingId":lid,"carrier":hex::encode(&carrier),"clsag":hex::encode(cb),"pseudoOut":hex::encode(pseudo.to_bytes()),"paid":paid.to_string(),"fee":fee.to_string(),"buyer":r.to,"token":r.token}))
            }
            // Buyer: the record in the seller's carrier must be exactly the agreed one, validly signed by the seller; then the
            // seller's CLSAG must verify over the final transaction; then this wallet signs its inputs.
            "nftBuyerFinish" => {
                let c = &q["continuation"];
                let carrier = hex::decode(txt(q, "carrier")?)?;
                let env = nv::open(&carrier)?;
                let (rec, sig) = nv::split_envelope(&env)?;
                ensure!(rec == txt(c, "record")?, "Seller changed the sale record");
                ensure!(nv::envelope(rec, sig) == env, "Non-canonical envelope");
                let seller = txt(c, "seller")?;
                ensure!(nv::sigv2_verify(seller, nv::signing_message(rec).as_bytes(), sig)?, "The seller's record signature does not verify");
                let r = SaleRecord::parse(rec)?;
                ensure!(r.to == me && r.anchor == txt(c, "buyerAnchor")? && r.owner == seller, "Sale would not deliver to this wallet");
                let clsag = hex::decode(txt(q, "clsag")?)?;
                let pseudo = bytes32(txt(q, "pseudoOut")?)?;
                let tx = self.native.as_ref().context("No native wallet")?.buy_finish_nft(c, &carrier, &clsag, &pseudo)?;
                let fee = native::market::fee_of(&tx)?;
                ensure!(fee.to_string() == txt(c, "fee")?, "Fee changed");
                let blob = tx.serialize();
                Ok(json!({"txid":hex::encode(tx.hash()),"blob":hex::encode(&blob),"fee":fee.to_string(),"keyImages":native::key_images(&tx).iter().map(hex::encode).collect::<Vec<_>>(),"buyerAnchor":r.anchor,"token":r.token,"nativeBytes":blob.len()}))
            }
            // Anyone: the exact envelope JSON of a carrier, decompressed with the reader's rules (whole input consumed, at
            // most 16,384 bytes, UTF-8). The browser NFT ledger validates and reduces it (market-nft-ledger.js).
            "nftDecode" => Ok(json!({"envelope":nv::open(&hex::decode(txt(q, "carrier")?)?)?})),
            // Anyone: decode a carrier and verify its record signature (no state).
            "nftOpen" => {
                let env = nv::open(&hex::decode(txt(q, "carrier")?)?)?;
                let (rec, sig) = nv::split_envelope(&env)?;
                let v: serde_json::Value = serde_json::from_str(rec)?;
                let owner = v["owner"].as_str().context("owner")?;
                Ok(json!({"record":v,"signatureValid":nv::sigv2_verify(owner, nv::signing_message(rec).as_bytes(), sig)?}))
            }
            other => anyhow::bail!("Unknown NFT market op {other}"),
        }
    }
    fn native_mut_nft(&mut self) -> Result<&mut native::NativeWallet> {
        self.native.as_mut().context("No native wallet")
    }
    fn genesis_bytes(&self) -> Result<[u8; 32]> {
        bytes32(&self.params()?.manifest.network.genesis)
    }
}
fn tx_of_nft(h: &str) -> Result<monero_wallet::transaction::Transaction> {
    ensure!(h.len() <= 200_000, "Transaction too large");
    let b = hex::decode(h)?;
    let t = monero_wallet::transaction::Transaction::read(&mut b.as_slice()).map_err(|e| anyhow::anyhow!("Transaction: {e}"))?;
    ensure!(t.serialize() == b, "Non-canonical transaction");
    Ok(t)
}
