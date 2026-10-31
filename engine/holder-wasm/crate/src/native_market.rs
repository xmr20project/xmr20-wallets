//! MONERO MARKET candidate (29 Oct 2026), native side. EXPERIMENTAL, UNREVIEWED, offline fakechain only.
//!
//! Three constructions, all inside the holder's wasm memory (secrets never leave):
//!
//! * Anchored carrier (one party): the holder's funding input plus every anchor input the record consumes;
//!   outputs = optional NEW ANCHOR (0 XMR to the holder's dedicated ANCHOR address, option C) + change. The record is placed into the
//!   unsigned transaction's extra only after the outputs exist, so the new anchor's key image can be written
//!   into the record (a same-length placeholder fixes the fee first).
//! * Seller ring: decoys for the seller's anchor output. Public data only (ring members are chain outputs).
//! * Whole-lot sale (two parties): ONE native transaction with the buyer's funding input(s) and the seller's
//!   anchor input. Outputs: price to the seller's payout address, the buyer's new anchor (0 XMR), buyer change.
//!   The buyer builds it from the seller's public ring; the seller checks the payout with its own view key,
//!   signs the XL1 record and ONE CLSAG for its anchor input with a pseudo-output mask the buyer chose; the
//!   buyer then signs its own CLSAG(s) with the remaining mask and publishes. Neither party can complete or
//!   alter the other's signature: every CLSAG signs the whole transaction (prefix incl. extra, outputs, fee).
use super::*;
use monero_wallet::{
    ed25519::{Commitment, CompressedPoint},
    ringct::{
        clsag::{Clsag, ClsagContext, Decoys},
        RctPrunable,
    },
};

pub const ANCHOR_AMOUNT: u64 = 0;

/// How the record is framed in tx_extra: XMR20 token records (monero-oxide arbitrary data) or XMR20-NFT-V2 carriers
/// ("XM2" fragments written in place of a fixed-size placeholder after construction; nft_v2.rs).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Frame {
    Token,
    Nft,
    /// No XMR20 data at all: a spare-anchor payment looks like any other wallet transaction.
    Plain,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Purpose {
    Anchored,
    Buy,
    Ring,
    /// Spare anchor (31 Oct 2026): a plain payment from this wallet to its anchor key (0 XMR) plus change.
    Spare,
}
pub struct Foreign {
    pub key_image: [u8; 32],
    pub decoys: Decoys,
    pub amount: u64,
}
pub struct Ready {
    pub signable: Vec<u8>,
    pub unsigned: Transaction,
    pub mask_sum: Scalar,
    pub key_images: Vec<[u8; 32]>,
    pub anchor: Option<[u8; 32]>,
    pub fee: u64,
    pub mine: Vec<OutputWithDecoys>,
}
pub struct Building {
    pub purpose: Purpose,
    pub frame: Frame,
    seed: [u8; 32],
    fee_rate: FeeRate,
    pub record_magic: [u8; 4],
    pub record_len: usize,
    distribution: Vec<u64>,
    outs: BTreeMap<u64, Option<[Point; 2]>>,
    pub mine: Vec<[u8; 32]>,
    new_anchor: bool,
    /// An existing spare anchor this construction names (lot or buyer anchor) instead of creating one inside it.
    named_anchor: Option<[u8; 32]>,
    /// Decoys for these inputs are sampled as of the given height (an anchor: the block that named it), else at the tip.
    as_of: BTreeMap<[u8; 32], usize>,
    payments: Vec<(MoneroAddress, u64)>,
    pub foreign: Option<Foreign>,
    pub ready: Option<Ready>,
    pub ring: Option<OutputWithDecoys>,
    attempts: u32,
}

/// Where a construction's (new) anchor comes from, and the decoy height of the anchors it spends.
#[derive(Default)]
pub struct AnchorChoice {
    pub new: bool,
    pub named: Option<[u8; 32]>,
    pub as_of: BTreeMap<[u8; 32], usize>,
}
impl AnchorChoice {
    pub fn none() -> Self {
        Self::default()
    }
    pub fn new_inline() -> Self {
        Self { new: true, ..Self::default() }
    }
    pub fn named(a: [u8; 32]) -> Self {
        Self { named: Some(a), ..Self::default() }
    }
    pub fn with_as_of(mut self, entry: Option<([u8; 32], usize)>) -> Self {
        self.as_of.extend(entry);
        self
    }
}
pub fn placeholder(magic: &[u8; 4], len: usize) -> Vec<u8> {
    let mut p = vec![0u8; len];
    p[..4].copy_from_slice(magic);
    p
}
/// Replace the record bytes inside a framed extra with another record of the same length. Every other extra
/// field (tx pubkey, payment id) is kept byte for byte; the placeholder must be exactly what is there.
pub fn swap_record(extra: &[u8], old: &[u8], new: &[u8]) -> Result<Vec<u8>> {
    ensure!(old.len() == new.len(), "Record length changed");
    ensure!(transport::unframe(extra)?.as_deref() == Some(old), "Extra does not carry the expected record");
    let mut out = extra.to_vec();
    let mut at = 0usize;
    let mut done = 0usize;
    while at < extra.len() {
        let tag = extra[at];
        at += 1;
        match tag {
            1 => at += 32,
            2 => {
                let mut len = 0usize;
                let mut shift = 0;
                loop {
                    let n = extra[at];
                    at += 1;
                    len |= ((n & 127) as usize) << shift;
                    if n < 128 {
                        break;
                    }
                    shift += 7;
                }
                if extra[at] == 127 {
                    let n = len - 1;
                    out[at + 1..at + 1 + n].copy_from_slice(&new[done..done + n]);
                    done += n;
                }
                at += len;
            }
            _ => anyhow::bail!("Unsupported extra field"),
        }
    }
    ensure!(done == new.len() && transport::unframe(&out)?.as_deref() == Some(new), "Record swap failed");
    Ok(out)
}
/// Placeholder CLSAGs and pseudo-outputs so an unsigned transaction can be serialized and parsed. The CLSAG message
/// (signature_hash) covers the prefix, the RingCT base and the range proof only, never these fields.
pub fn with_placeholders(tx: &mut Transaction) -> Result<()> {
    let n = key_images(tx).len();
    let (clsags, pseudo) = clsags_mut(tx)?;
    *clsags = (0..n).map(|_| Clsag { D: CompressedPoint::G, s: vec![Scalar::ZERO; RING as usize], c1: Scalar::ZERO }).collect();
    *pseudo = vec![CompressedPoint::G; n];
    Ok(())
}
fn record_of(tx: &Transaction) -> Result<Vec<u8>> {
    transport::unframe(&tx.prefix().extra)?.context("Transaction carries no record")
}
fn clsags_mut(tx: &mut Transaction) -> Result<(&mut Vec<Clsag>, &mut Vec<CompressedPoint>)> {
    let Transaction::V2 { proofs: Some(p), .. } = tx else { anyhow::bail!("RingCT required") };
    let RctPrunable::Clsag { clsags, pseudo_outs, .. } = &mut p.prunable else { anyhow::bail!("CLSAG required") };
    Ok((clsags, pseudo_outs))
}
fn scalar_hex(s: &Scalar) -> String {
    let mut v = vec![];
    s.write(&mut v).expect("vec write");
    hex::encode(v)
}
pub fn fee_of(tx: &Transaction) -> Result<u64> {
    match tx {
        Transaction::V2 { proofs: Some(p), .. } => Ok(p.base.fee),
        _ => anyhow::bail!("RingCT required"),
    }
}
/// A foreign input for construction only: real public ring and key, a zero key offset and mask (never used to
/// sign; the owner signs its CLSAG itself). Only the amount enters the fee/balance arithmetic.
fn foreign_output(f: &Foreign) -> Result<OutputWithDecoys> {
    let member = f.decoys.signer_ring_members();
    let mut b = member[0].compress().to_bytes().to_vec();
    Scalar::ZERO.write(&mut b)?;
    Commitment::new(Scalar::ZERO, f.amount).write(&mut b)?;
    f.decoys.write(&mut b)?;
    OutputWithDecoys::read(&mut b.as_slice()).map_err(|e| anyhow::anyhow!("Foreign input: {e}"))
}
pub fn decoys_from_hex(h: &str) -> Result<Decoys> {
    let b = hex::decode(h)?;
    ensure!(b.len() <= 4096, "Ring descriptor too large");
    let mut s = b.as_slice();
    let d = Decoys::read(&mut s).map_err(|e| anyhow::anyhow!("Ring descriptor: {e}"))?;
    ensure!(s.is_empty() && d.len() == RING as usize, "Ring descriptor must hold exactly {RING} members");
    Ok(d)
}
fn input_order(tx: &Transaction) -> Vec<[u8; 32]> {
    key_images(tx)
}
fn compressed(k: &[u8; 32]) -> Result<CompressedPoint> {
    Ok(CompressedPoint::read(&mut k.as_slice())?)
}
/// Sum of pseudo-outputs == sum of output commitments + fee * H (the RingCT balance rule), checked locally.
fn balanced(tx: &Transaction) -> Result<bool> {
    let Transaction::V2 { proofs: Some(p), .. } = tx else { anyhow::bail!("RingCT required") };
    let RctPrunable::Clsag { pseudo_outs, .. } = &p.prunable else { anyhow::bail!("CLSAG required") };
    let dec = |c: &CompressedPoint| -> Result<curve25519_dalek::EdwardsPoint> { Ok(c.decompress().context("point")?.into()) };
    let mut left = curve25519_dalek::EdwardsPoint::default();
    for c in pseudo_outs {
        left += dec(c)?;
    }
    let mut right: curve25519_dalek::EdwardsPoint = Commitment::new(Scalar::ZERO, p.base.fee).commit().into();
    for c in &p.base.commitments {
        right += dec(c)?;
    }
    Ok(left == right)
}

impl NativeWallet {
    /// Option C (30 Oct 2026): new anchors go to the dedicated anchor key pair, never to the wallet's ordinary address.
    fn anchor_address(&self) -> MoneroAddress {
        self.anchor_pair.legacy_address(Network::Mainnet)
    }
    pub fn owns_unspent(&self, ki: &[u8; 32]) -> bool {
        self.outputs.contains_key(ki) && !self.spent.contains_key(ki)
    }
    /// Height of the block that created an owned output (an anchor's depth = the anchoring transaction's depth).
    pub fn output_height(&self, ki: &[u8; 32]) -> Option<usize> {
        self.outputs.get(ki).map(|o| o.height)
    }
    pub fn anchor_spendable(&self, ki: &[u8; 32]) -> bool {
        self.outputs.get(ki).is_some_and(|o| !self.spent.contains_key(ki) && self.tip >= self.unlock_height(o))
    }
    fn funding(&self, need: u64, fee_rate: &FeeRate, exclude: &BTreeSet<[u8; 32]>) -> Result<[u8; 32]> {
        self.outputs
            .iter()
            .filter(|(ki, o)| self.spendable(ki, o, exclude) && Self::can_pay(o, fee_rate) && o.output.commitment().amount > need)
            .max_by_key(|(_, o)| o.output.commitment().amount)
            .map(|(ki, _)| *ki)
            .with_context(|| {
                let st = self.status(exclude);
                format!("No single spendable XMR output above {need} piconero: unlocked {}, locked {}, reserved {}", st["unlocked"].as_str().unwrap_or("?"), st["locked"].as_str().unwrap_or("?"), st["reserved"].as_str().unwrap_or("?"))
            })
    }
    #[allow(clippy::too_many_arguments)]
    fn start(&mut self, purpose: Purpose, frame: Frame, mine: Vec<[u8; 32]>, anchor: AnchorChoice, payments: Vec<(MoneroAddress, u64)>, foreign: Option<Foreign>, magic: [u8; 4], record_len: usize, fee_rate: FeeRate, distribution: Vec<u64>) -> Result<J> {
        ensure!(distribution.len() == self.tip + 1, "Distribution must cover heights 0..={} (got {} entries)", self.tip, distribution.len());
        ensure!(distribution.last().copied().unwrap_or(0) == self.rct_outputs, "Daemon RingCT output count differs from the local count");
        if purpose != Purpose::Ring && purpose != Purpose::Spare {
            ensure!(record_len > 0 && record_len <= transport::MAX_RECORD, "Record size out of range");
        }
        let AnchorChoice { new: new_anchor, named: named_anchor, as_of } = anchor;
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        let id = hex::encode(&seed[..8]);
        self.builds.insert(id.clone(), Building { purpose, frame, seed, fee_rate, record_magic: magic, record_len, distribution, outs: BTreeMap::new(), mine, new_anchor, named_anchor, as_of, payments, foreign, ready: None, ring: None, attempts: 0 });
        self.market_try(&id)
    }
    /// One party: funding input + the anchors the record consumes; the holder's anchor for a new lot is created inside the
    /// carrier (`new`, option A) or is an existing spare (`named`); consumed anchors' rings are sampled as of `as_of`.
    #[allow(clippy::too_many_arguments)]
    pub fn anchored_start(&mut self, anchors: &[[u8; 32]], anchor: AnchorChoice, magic: [u8; 4], record_len: usize, fee_rate: FeeRate, distribution: Vec<u64>, exclude: &BTreeSet<[u8; 32]>) -> Result<J> {
        for a in anchors {
            ensure!(self.anchor_spendable(a), "Anchor output is not owned, already spent or still locked");
        }
        if let Some(a) = anchor.named {
            self.spare_ok(&a)?;
        }
        let mut ex = exclude.clone();
        ex.extend(anchors.iter().copied());
        let funding = self.funding(0, &fee_rate, &ex)?;
        let mut mine = vec![funding];
        mine.extend(anchors.iter().copied());
        self.start(Purpose::Anchored, Frame::Token, mine, anchor, vec![], None, magic, record_len, fee_rate, distribution)
    }
    /// Spare anchor (31 Oct 2026): a plain payment of 0 XMR to this wallet's anchor key plus change, funded only by an output
    /// that did not come from an XMR20 transaction (publicly XMR20-related outputs would let an observer follow the spare).
    pub fn spare_start(&mut self, fee_rate: FeeRate, distribution: Vec<u64>, exclude: &BTreeSet<[u8; 32]>) -> Result<J> {
        let funding = self.funding_plain(&fee_rate, exclude)?;
        self.start(Purpose::Spare, Frame::Plain, vec![funding], AnchorChoice::new_inline(), vec![], None, [0; 4], 0, fee_rate, distribution)
    }
    fn funding_plain(&self, fee_rate: &FeeRate, exclude: &BTreeSet<[u8; 32]>) -> Result<[u8; 32]> {
        // Known ordinary outputs first; outputs saved before the carrier flag existed only if nothing better is there.
        let ok = |want: Option<bool>| {
            self.outputs
                .iter()
                .filter(|(ki, o)| o.carrier == want && !o.anchor_key && self.spendable(ki, o, exclude) && Self::can_pay(o, fee_rate) && o.output.commitment().amount > 0)
                .max_by_key(|(_, o)| o.output.commitment().amount)
                .map(|(ki, _)| *ki)
        };
        ok(Some(false)).or_else(|| ok(None)).context("A spare anchor needs XMR received in an ordinary payment (not change from an XMR20 transaction); none is spendable now")
    }
    /// A spare this wallet may name: its own anchor-key output of 0 XMR from a plain payment, unspent and past the spendable
    /// age (so its ring, sampled as of the naming block, is drawn from outputs at least as old).
    fn spare_ok(&self, a: &[u8; 32]) -> Result<()> {
        let o = self.outputs.get(a).context("Spare anchor is not this wallet's")?;
        ensure!(o.anchor_key && o.output.commitment().amount == ANCHOR_AMOUNT && o.carrier == Some(false), "Not a spare anchor (0 XMR to the anchor key from a plain payment)");
        ensure!(self.anchor_spendable(a), "Spare anchor is spent or not yet {DEFAULT_LOCK} blocks old");
        ensure!(!self.reserved.contains(a), "Spare anchor is reserved");
        Ok(())
    }
    /// Spare anchors: (ready, still maturing), each with its block height; `exclude` = named by a live note or a pending record.
    pub fn spares(&self, exclude: &BTreeSet<[u8; 32]>) -> (Vec<([u8; 32], usize)>, Vec<([u8; 32], usize)>) {
        let mut ready = vec![];
        let mut maturing = vec![];
        for (ki, o) in &self.outputs {
            if !o.anchor_key || o.output.commitment().amount != ANCHOR_AMOUNT || o.carrier != Some(false) || self.spent.contains_key(ki) || exclude.contains(ki) || self.reserved.contains(ki) {
                continue;
            }
            if self.anchor_spendable(ki) { ready.push((*ki, o.height)) } else { maturing.push((*ki, o.height)) }
        }
        ready.sort_by_key(|(_, h)| *h);
        (ready, maturing)
    }
    /// NFT (one party): funding input + the NFT's current anchor if it has one; always a new anchor (nft_anchor).
    pub fn nft_anchored_start(&mut self, anchors: &[[u8; 32]], fee_rate: FeeRate, distribution: Vec<u64>, exclude: &BTreeSet<[u8; 32]>) -> Result<J> {
        ensure!(anchors.len() <= 1, "An NFT has at most one anchor");
        for a in anchors {
            ensure!(self.anchor_spendable(a), "NFT anchor output is not owned, already spent or still locked");
        }
        let mut ex = exclude.clone();
        ex.extend(anchors.iter().copied());
        let funding = self.funding(0, &fee_rate, &ex)?;
        let mut mine = vec![funding];
        mine.extend(anchors.iter().copied());
        self.start(Purpose::Anchored, Frame::Nft, mine, AnchorChoice::new_inline(), vec![], None, [0; 4], crate::nft_v2::LIMIT, fee_rate, distribution)
    }
    /// Seller: ring for its anchor output (public), sampled as of `as_of` (the block that named the anchor) when given.
    pub fn ring_start(&mut self, anchor: &[u8; 32], as_of: Option<usize>, distribution: Vec<u64>, fee_rate: FeeRate) -> Result<J> {
        ensure!(self.anchor_spendable(anchor), "Anchor output is not owned, already spent or still locked");
        self.start(Purpose::Ring, Frame::Token, vec![*anchor], AnchorChoice::none().with_as_of(as_of.map(|h| (*anchor, h))), vec![], None, [0; 4], 0, fee_rate, distribution)
    }
    /// Buyer: funding for price + fee, the seller's anchor input, payout to the seller, the buyer's new anchor.
    #[allow(clippy::too_many_arguments)]
    pub fn buy_start(&mut self, payout: MoneroAddress, price: u64, foreign: Foreign, buyer_anchor: Option<[u8; 32]>, record_len: usize, fee_rate: FeeRate, distribution: Vec<u64>, exclude: &BTreeSet<[u8; 32]>) -> Result<J> {
        self.buy_start_framed(Frame::Token, payout, price, foreign, buyer_anchor, record_len, fee_rate, distribution, exclude)
    }
    #[allow(clippy::too_many_arguments)]
    /// `buyer_anchor`: a spare this wallet names as the anchor of the lot it buys (no anchor output in the sale), else a new
    /// 0 XMR anchor output inside the sale (option A; NFTs and test chains).
    pub fn buy_start_framed(&mut self, frame: Frame, payout: MoneroAddress, price: u64, foreign: Foreign, buyer_anchor: Option<[u8; 32]>, record_len: usize, fee_rate: FeeRate, distribution: Vec<u64>, exclude: &BTreeSet<[u8; 32]>) -> Result<J> {
        ensure!(!self.outputs.contains_key(&foreign.key_image), "The seller's input belongs to this wallet: self-trade refused");
        ensure!(foreign.amount == ANCHOR_AMOUNT, "Seller anchor input must carry exactly {ANCHOR_AMOUNT} piconero");
        let anchor = match buyer_anchor {
            Some(a) => {
                self.spare_ok(&a)?;
                AnchorChoice::named(a)
            }
            None => AnchorChoice::new_inline(),
        };
        let funding = self.funding(price, &fee_rate, exclude)?;
        self.start(Purpose::Buy, frame, vec![funding], anchor, vec![(payout, price)], Some(foreign), *xmr20_unshielded_core::market::MAGIC_SALE, record_len, fee_rate, distribution)
    }
    pub fn market_outs(&mut self, id: &str, outs: &[(u64, Option<[Point; 2]>)]) -> Result<J> {
        let b = self.builds.get_mut(id).context("Unknown or expired market construction")?;
        for (i, v) in outs {
            b.outs.insert(*i, *v);
        }
        self.market_try(id)
    }
    pub fn market_cancel(&mut self, id: &str) -> bool {
        match self.builds.remove(id) {
            Some(b) => {
                if b.ready.is_some() {
                    for k in &b.mine {
                        self.reserved.remove(k);
                    }
                }
                true
            }
            None => false,
        }
    }
    fn market_try(&mut self, id: &str) -> Result<J> {
        let b = self.builds.get(id).context("Unknown market construction")?;
        let rpc = CachedRpc { tip: self.tip, distribution: b.distribution.clone(), outs: b.outs.clone(), missing: std::sync::Mutex::new(vec![]) };
        let mut mine = vec![];
        let mut failed = None;
        for (i, ki) in b.mine.iter().enumerate() {
            let owned = self.outputs.get(ki).context("Selected input vanished")?;
            let mut seed = b.seed;
            seed[31] ^= i as u8 + 1;
            let mut rng = ChaCha20Rng::from_seed(seed);
            let at = self.decoy_cap.unwrap_or(self.tip);
            let at = b.as_of.get(ki).map_or(at, |h| (*h).min(at));
            match block_on(OutputWithDecoys::new(&mut rng, &rpc, RING, at, owned.output.clone())) {
                Ok(x) => mine.push(x),
                Err(e) => failed = Some(format!("{e:?}")),
            }
        }
        let mut missing = rpc.missing.into_inner().unwrap();
        // The buyer checks the seller's ring against its own node: every member must exist, be unlocked and match.
        if let Some(f) = &b.foreign {
            for (pos, member) in f.decoys.positions().iter().zip(f.decoys.ring()) {
                match b.outs.get(pos) {
                    None => missing.push(*pos),
                    Some(None) => anyhow::bail!("Seller ring member {pos} is locked or unknown to this node"),
                    Some(Some(pair)) => ensure!(pair[0] == member[0] && pair[1] == member[1], "Seller ring member {pos} differs from this node's output"),
                }
            }
        }
        if !missing.is_empty() {
            missing.sort_unstable();
            missing.dedup();
            return Ok(json!({"buildId":id,"ready":false,"need":missing}));
        }
        if let Some(e) = failed {
            // A fresh seed resamples the ring (the answers already fetched stay cached). Bounded; a short offline test chain,
            // whose blocks are seconds apart, otherwise intermittently exhausts monero-oxide's sampling rounds.
            let bm = self.builds.get_mut(id).unwrap();
            bm.attempts += 1;
            if bm.attempts < 12 && e.contains("round limit") {
                OsRng.fill_bytes(&mut bm.seed);
                return self.market_try(id);
            }
            self.builds.remove(id);
            anyhow::bail!("Decoy selection failed: {e}");
        }
        if b.purpose == Purpose::Ring {
            let r = mine.into_iter().next().unwrap();
            let out = json!({"buildId":id,"ready":true,"keyImage":hex32(b.mine[0]),"decoys":hex::encode(r.decoys().serialize()),"positions":r.decoys().positions(),"amount":r.commitment().amount.to_string()});
            self.builds.get_mut(id).unwrap().ring = Some(r);
            return Ok(out);
        }
        // Construct with a same-length placeholder record (the fee depends only on its size).
        let mut inputs = mine.clone();
        let mut kis = b.mine.clone();
        if let Some(f) = &b.foreign {
            inputs.push(foreign_output(f)?);
            kis.push(f.key_image);
        }
        let mut payments = b.payments.clone();
        // A new anchor output, else a dummy only where change alone would leave fewer than two outputs.
        if b.new_anchor {
            payments.push((self.anchor_address(), ANCHOR_AMOUNT));
        } else if payments.is_empty() {
            payments.push((dummy_address(), DUMMY_AMOUNT));
        }
        let data = match b.frame {
            Frame::Token => transport::parts(&placeholder(&b.record_magic, b.record_len))?,
            Frame::Nft => crate::nft_v2::placeholder_parts(),
            Frame::Plain => vec![],
        };
        let mut ovk = Zeroizing::new([0u8; 32]);
        ovk.copy_from_slice(&keccak256([b"xmr20-market-ovk".as_slice(), &b.seed].concat()));
        let signable = SignableTransaction::new(RctType::ClsagBulletproofPlus, ovk, inputs, payments, Change::new(self.pair.clone(), None), data, b.fee_rate).map_err(|e| anyhow::anyhow!("Construction failed: {e:?}"))?;
        let fee = signable.necessary_fee();
        let ser = signable.serialize();
        let compressed_kis = kis.iter().map(compressed).collect::<Result<Vec<_>>>()?;
        let (tx, mask_sum) = signable.unsigned_transaction_with_mask_sum(compressed_kis).context("Unsigned construction")?;
        // The new anchor: this wallet's zero-amount output to its ANCHOR key in the proposed transaction (option C).
        let anchor = if b.new_anchor {
            let found = self.anchor_scanner.scan_proposed(&tx).map_err(|e| anyhow::anyhow!("Scan proposed: {e:?}"))?.ignore_additional_timelock();
            let zero: Vec<_> = found.iter().filter(|o| o.commitment().amount == ANCHOR_AMOUNT).collect();
            ensure!(zero.len() == 1 && found.len() == 1, "Expected exactly one zero-amount anchor output, found {}", zero.len());
            Some(image(self.secret(zero[0], true)))
        } else {
            b.named_anchor
        };
        let order = input_order(&tx);
        let funding_amount = self.outputs[&b.mine[0]].output.commitment().amount;
        let out = json!({"buildId":id,"ready":true,"purpose":format!("{:?}",b.purpose),"fee":fee.to_string(),"keyImages":order.iter().map(|k|hex32(*k)).collect::<Vec<_>>(),"anchorKeyImage":anchor.map(hex32),"fundingAmount":funding_amount.to_string(),"inputs":order.len(),"outputs":tx.prefix().outputs.len(),"recordBytes":b.record_len});
        let mine_kis = b.mine.clone();
        let bm = self.builds.get_mut(id).unwrap();
        bm.ready = Some(Ready { signable: ser, unsigned: tx, mask_sum, key_images: order, anchor, fee, mine });
        self.reserved.extend(mine_kis);
        Ok(out)
    }
    fn contexts(&self, mine: &[OutputWithDecoys]) -> Result<Vec<([u8; 32], Zeroizing<Scalar>, ClsagContext)>> {
        let mut v = vec![];
        for input in mine {
            let ki = self.outputs.iter().find(|(_, o)| o.output.key() == input.key()).map(|(k, _)| *k).context("Input is not this wallet's")?;
            let o = &self.outputs[&ki];
            v.push((ki, Zeroizing::new(self.secret(&o.output, o.anchor_key)), ClsagContext::new(input.decoys().clone(), input.commitment().clone()).map_err(|e| anyhow::anyhow!("CLSAG context: {e:?}"))?));
        }
        Ok(v)
    }
    fn sign_inputs(&self, tx: &Transaction, mine: &[OutputWithDecoys], mask: Scalar) -> Result<Vec<([u8; 32], Clsag, CompressedPoint)>> {
        let msg = tx.signature_hash().context("Signature hash")?;
        let order = input_order(tx);
        let mut ctx = self.contexts(mine)?;
        ctx.sort_by_key(|(ki, _, _)| order.iter().position(|k| k == ki).unwrap_or(usize::MAX));
        let kis: Vec<[u8; 32]> = ctx.iter().map(|(k, _, _)| *k).collect();
        let res = Clsag::sign(&mut OsRng, ctx.into_iter().map(|(_, s, c)| (s, c)).collect(), mask, msg).map_err(|e| anyhow::anyhow!("CLSAG: {e:?}"))?;
        Ok(kis.into_iter().zip(res).map(|(k, (c, p))| (k, c, p.compress())).collect())
    }
    fn assemble(tx: &mut Transaction, parts: Vec<([u8; 32], Clsag, CompressedPoint)>) -> Result<()> {
        let order = input_order(tx);
        ensure!(parts.len() == order.len(), "Signature count differs from the input count");
        let (clsags, pseudo) = clsags_mut(tx)?;
        *clsags = vec![];
        *pseudo = vec![];
        for ki in &order {
            let (_, c, p) = parts.iter().find(|(k, _, _)| k == ki).context("Missing signature for an input")?;
            clsags.push(c.clone());
            pseudo.push(*p);
        }
        Ok(())
    }
    pub fn build_ready(&self, id: &str) -> Result<&Building> {
        let b = self.builds.get(id).context("Unknown or expired market construction")?;
        ensure!(b.ready.is_some(), "Construction not ready");
        Ok(b)
    }
    /// One party: sign an anchored carrier for the finished record (same length as quoted).
    pub fn anchored_sign(&mut self, id: &str, wire: &[u8]) -> Result<J> {
        let b = self.builds.get(id).context("Unknown or expired market construction")?;
        ensure!(b.purpose == Purpose::Anchored && b.frame == Frame::Token, "Not an anchored token carrier");
        let r = b.ready.as_ref().context("Construction not ready")?;
        ensure!(wire.len() == b.record_len && wire[..4] == b.record_magic, "Record differs from the quoted size/kind");
        for k in &r.key_images {
            ensure!(!self.spent.contains_key(k), "A quoted input was spent meanwhile");
        }
        let ph = placeholder(&b.record_magic, b.record_len);
        let mut tx = r.unsigned.clone();
        tx.prefix_mut().extra = swap_record(&tx.prefix().extra, &ph, wire)?;
        let parts = self.sign_inputs(&tx, &r.mine, r.mask_sum)?;
        Self::assemble(&mut tx, parts)?;
        ensure!(balanced(&tx)?, "Balance check failed");
        ensure!(record_of(&tx)? == wire, "Carrier does not carry the record");
        ensure!(fee_of(&tx)? == r.fee, "Fee changed");
        let blob = tx.serialize();
        let out = json!({"txid":hex32(tx.hash()),"blob":hex::encode(&blob),"nativeBytes":blob.len(),"fee":r.fee.to_string(),"keyImages":r.key_images.iter().map(|k|hex32(*k)).collect::<Vec<_>>(),"anchorKeyImage":r.anchor.map(hex32)});
        self.builds.remove(id);
        Ok(out)
    }
    /// Spare anchor: sign the plain payment (no record).
    pub fn spare_sign(&mut self, id: &str) -> Result<J> {
        let b = self.builds.get(id).context("Unknown or expired market construction")?;
        ensure!(b.purpose == Purpose::Spare && b.frame == Frame::Plain, "Not a spare-anchor payment");
        let r = b.ready.as_ref().context("Construction not ready")?;
        for k in &r.key_images {
            ensure!(!self.spent.contains_key(k), "A quoted input was spent meanwhile");
        }
        let mut tx = r.unsigned.clone();
        ensure!(matches!(transport::unframe(&tx.prefix().extra), Ok(None)), "A spare-anchor payment carries no XMR20 data");
        let parts = self.sign_inputs(&tx, &r.mine, r.mask_sum)?;
        Self::assemble(&mut tx, parts)?;
        ensure!(balanced(&tx)?, "Balance check failed");
        ensure!(fee_of(&tx)? == r.fee, "Fee changed");
        let blob = tx.serialize();
        let out = json!({"txid":hex32(tx.hash()),"blob":hex::encode(&blob),"nativeBytes":blob.len(),"fee":r.fee.to_string(),"keyImages":r.key_images.iter().map(|k|hex32(*k)).collect::<Vec<_>>(),"anchorKeyImage":r.anchor.map(hex32),"outputs":tx.prefix().outputs.len()});
        self.builds.remove(id);
        Ok(out)
    }
    /// NFT (one party): sign the anchoring carrier with the finished XMR20-NFT-V2 carrier in place of the placeholder.
    pub fn nft_sign(&mut self, id: &str, carrier: &[u8]) -> Result<J> {
        let b = self.builds.get(id).context("Unknown or expired market construction")?;
        ensure!(b.purpose == Purpose::Anchored && b.frame == Frame::Nft, "Not an NFT anchoring carrier");
        let r = b.ready.as_ref().context("Construction not ready")?;
        for k in &r.key_images {
            ensure!(!self.spent.contains_key(k), "A quoted input was spent meanwhile");
        }
        let mut tx = r.unsigned.clone();
        tx.prefix_mut().extra = crate::nft_v2::final_extra(&tx.prefix().extra, carrier)?;
        let parts = self.sign_inputs(&tx, &r.mine, r.mask_sum)?;
        Self::assemble(&mut tx, parts)?;
        ensure!(balanced(&tx)?, "Balance check failed");
        ensure!(fee_of(&tx)? == r.fee, "Fee changed");
        let blob = tx.serialize();
        let out = json!({"txid":hex32(tx.hash()),"blob":hex::encode(&blob),"nativeBytes":blob.len(),"extraBytes":tx.prefix().extra.len(),"fee":r.fee.to_string(),"keyImages":r.key_images.iter().map(|k|hex32(*k)).collect::<Vec<_>>(),"anchorKeyImage":r.anchor.map(hex32)});
        self.builds.remove(id);
        Ok(out)
    }
    /// NFT buyer: the public draft keeps the placeholder in tx_extra (the seller writes the signed carrier); the record JSON
    /// travels beside it. Private continuation as for tokens.
    pub fn nft_buy_draft(&mut self, id: &str, seller_mask: Scalar) -> Result<(J, J)> {
        let b = self.builds.get(id).context("Unknown or expired market construction")?;
        ensure!(b.purpose == Purpose::Buy && b.frame == Frame::Nft, "Not an NFT purchase");
        let r = b.ready.as_ref().context("Construction not ready")?;
        let f = b.foreign.as_ref().unwrap();
        let mut tx = r.unsigned.clone();
        with_placeholders(&mut tx)?;
        let public = json!({"unsignedTx":hex::encode(tx.serialize()),"sellerMask":scalar_hex(&seller_mask),"fee":r.fee.to_string(),"keyImages":r.key_images.iter().map(|k|hex32(*k)).collect::<Vec<_>>()});
        let private = json!({"frame":"nft","signable":hex::encode(&r.signable),"mine":r.mine.iter().map(|m|hex::encode(m.serialize())).collect::<Vec<_>>(),"mineKeyImages":b.mine.iter().map(|k|hex32(*k)).collect::<Vec<_>>(),"sellerKeyImage":hex32(f.key_image),"sellerDecoys":hex::encode(f.decoys.serialize()),"sellerAmount":f.amount.to_string(),"sellerMask":scalar_hex(&seller_mask),"fee":r.fee.to_string(),"anchor":r.anchor.map(hex32)});
        Ok((public, private))
    }
    /// Buyer: the public draft (to the seller) and the private continuation (this wallet's journal only).
    pub fn buy_draft(&mut self, id: &str, unsigned_record: &[u8], seller_mask: Scalar) -> Result<(J, J)> {
        let b = self.builds.get(id).context("Unknown or expired market construction")?;
        ensure!(b.purpose == Purpose::Buy, "Not a purchase");
        let r = b.ready.as_ref().context("Construction not ready")?;
        let f = b.foreign.as_ref().unwrap();
        let ph = placeholder(&b.record_magic, b.record_len);
        let mut tx = r.unsigned.clone();
        tx.prefix_mut().extra = swap_record(&tx.prefix().extra, &ph, unsigned_record)?;
        with_placeholders(&mut tx)?;
        let public = json!({"unsignedTx":hex::encode(tx.serialize()),"sellerMask":scalar_hex(&seller_mask),"fee":r.fee.to_string(),"keyImages":r.key_images.iter().map(|k|hex32(*k)).collect::<Vec<_>>()});
        let private = json!({"signable":hex::encode(&r.signable),"mine":r.mine.iter().map(|m|hex::encode(m.serialize())).collect::<Vec<_>>(),"mineKeyImages":b.mine.iter().map(|k|hex32(*k)).collect::<Vec<_>>(),"sellerKeyImage":hex32(f.key_image),"sellerDecoys":hex::encode(f.decoys.serialize()),"sellerAmount":f.amount.to_string(),"sellerMask":scalar_hex(&seller_mask),"recordLen":b.record_len,"fee":r.fee.to_string(),"anchor":r.anchor.map(hex32)});
        Ok((public, private))
    }
    /// Rebuild the exact unsigned transaction from a buyer continuation (after a restart too).
    pub fn rebuild(c: &J) -> Result<(Transaction, Scalar, Vec<OutputWithDecoys>, Foreign, Scalar)> {
        let sig_bytes = hex::decode(c["signable"].as_str().context("signable")?)?;
        let signable = SignableTransaction::read(&mut sig_bytes.as_slice()).map_err(|e| anyhow::anyhow!("Continuation: {e}"))?;
        let mine: Vec<OutputWithDecoys> = c["mine"].as_array().context("mine")?.iter().map(|m| { let b = hex::decode(m.as_str().unwrap_or(""))?; OutputWithDecoys::read(&mut b.as_slice()).map_err(|e| anyhow::anyhow!("{e}")) }).collect::<Result<_>>()?;
        let mut kis: Vec<[u8; 32]> = c["mineKeyImages"].as_array().context("mineKeyImages")?.iter().map(|k| unhex32(k)).collect::<Result<_>>()?;
        let seller = unhex32(&c["sellerKeyImage"])?;
        kis.push(seller);
        let foreign = Foreign { key_image: seller, decoys: decoys_from_hex(c["sellerDecoys"].as_str().context("sellerDecoys")?)?, amount: c["sellerAmount"].as_str().context("sellerAmount")?.parse()? };
        let mask = Scalar::read(&mut hex::decode(c["sellerMask"].as_str().context("sellerMask")?)?.as_slice())?;
        let compressed_kis = kis.iter().map(compressed).collect::<Result<Vec<_>>>()?;
        let (tx, mask_sum) = signable.unsigned_transaction_with_mask_sum(compressed_kis).context("Unsigned construction")?;
        Ok((tx, mask_sum, mine, foreign, mask))
    }
    /// Buyer: verify the seller's record signature placement and CLSAG, sign its own inputs, assemble.
    pub fn buy_finish(&self, c: &J, signed_record: &[u8], seller_clsag: &[u8], seller_pseudo: &[u8; 32]) -> Result<Transaction> {
        let len = c["recordLen"].as_u64().context("recordLen")? as usize;
        let ph = placeholder(xmr20_unshielded_core::market::MAGIC_SALE, len);
        self.finish_with(c, |extra| swap_record(extra, &ph, signed_record), seller_clsag, seller_pseudo)
    }
    /// NFT buyer: the same checks with the seller's signed carrier written in place of the placeholder.
    pub fn buy_finish_nft(&self, c: &J, carrier: &[u8], seller_clsag: &[u8], seller_pseudo: &[u8; 32]) -> Result<Transaction> {
        ensure!(c["frame"] == "nft", "Not an NFT purchase continuation");
        self.finish_with(c, |extra| crate::nft_v2::final_extra(extra, carrier), seller_clsag, seller_pseudo)
    }
    fn finish_with<F: FnOnce(&[u8]) -> Result<Vec<u8>>>(&self, c: &J, extra_of: F, seller_clsag: &[u8], seller_pseudo: &[u8; 32]) -> Result<Transaction> {
        let (unsigned, mask_sum, mine, foreign, xs) = Self::rebuild(c)?;
        ensure!(unsigned.prefix().additional_timelock == Timelock::None, "Timelocked construction refused");
        let mut tx = unsigned;
        tx.prefix_mut().extra = extra_of(&tx.prefix().extra)?;
        let msg = tx.signature_hash().context("Signature hash")?;
        let clsag = Clsag::read(RING as usize, &mut &seller_clsag[..]).map_err(|e| anyhow::anyhow!("Seller CLSAG: {e}"))?;
        let ring: Vec<[CompressedPoint; 2]> = foreign.decoys.ring().iter().map(|m| [m[0].compress(), m[1].compress()]).collect();
        let pseudo = compressed(seller_pseudo)?;
        clsag.verify(ring, &compressed(&foreign.key_image)?, &pseudo, &msg).map_err(|e| anyhow::anyhow!("Seller signature does not verify for this exact transaction: {e:?}"))?;
        // The seller's pseudo-output must carry the agreed mask (else the balance cannot close).
        ensure!(Commitment::new(xs, foreign.amount).commit().compress() == pseudo, "Seller pseudo-output does not use the agreed mask");
        let mine_mask = Scalar::from(mask_sum.into() - xs.into());
        let mut parts = self.sign_inputs(&tx, &mine, mine_mask)?;
        parts.push((foreign.key_image, clsag, pseudo));
        Self::assemble(&mut tx, parts)?;
        ensure!(balanced(&tx)?, "Balance check failed");
        Ok(tx)
    }
    /// Seller: the native checks of a proposed sale transaction. Returns (amount paid to the payout, fee). `external`: the
    /// listing pays another standard address (Monero accounts) — scanned with its view key set by `set_payout_view`.
    pub fn seller_check(&mut self, tx: &Transaction, anchor: &[u8; 32], decoys: &Decoys, external: Option<&str>) -> Result<(u64, u64)> {
        ensure!(self.anchor_spendable(anchor), "Lot anchor output is not owned, already spent or still locked");
        // Review finding: a buyer-built transaction could carry a timelock (consensus accepts it inside a block) so the
        // price is paid but unspendable for years. The seller only signs a transaction whose outputs are spendable normally.
        ensure!(tx.prefix().additional_timelock == Timelock::None, "Transaction carries a timelock: refused");
        let o = &self.outputs[anchor];
        let member = decoys.signer_ring_members();
        ensure!(member[0] == o.output.key() && member[1] == o.output.commitment().commit(), "Ring does not contain this wallet's anchor output as the signer");
        let mut seen = false;
        for i in &tx.prefix().inputs {
            let Input::ToKey { key_image, key_offsets, .. } = i else { anyhow::bail!("Unexpected input type") };
            if key_image.to_bytes() == *anchor {
                ensure!(key_offsets.as_slice() == decoys.offsets(), "Anchor input ring differs from the descriptor");
                seen = true;
            } else {
                ensure!(!self.outputs.contains_key(&key_image.to_bytes()), "Transaction spends another output of this wallet");
            }
        }
        ensure!(seen, "Transaction does not spend the lot anchor");
        let found = match external {
            None => self.scanner.scan_proposed(tx).map_err(|e| anyhow::anyhow!("Scan proposed: {e:?}"))?.ignore_additional_timelock(),
            Some(payout) => {
                let (address, scanner) = self.payout_view.as_mut().context("This listing pays another address and its view key is not set")?;
                ensure!(address.as_str() == payout, "This listing pays an address whose view key is not set");
                scanner.scan_proposed(tx).map_err(|e| anyhow::anyhow!("Scan proposed (payout): {e:?}"))?.ignore_additional_timelock()
            }
        };
        let mut paid = 0u64;
        for o in &found {
            // Review finding (burning bug): a payout whose one-time key repeats an output this wallet already holds would
            // never be credited by the scan (one key image, one spend). The seller refuses to be paid to a reused key.
            // (An external payout wallet is monero-wallet-rpc, which handles repeated keys itself.)
            ensure!(external.is_some() || !self.seen_keys.contains(&o.key().compress().to_bytes()), "Payout reuses an output key this wallet already holds (burning-bug): refused");
            paid = paid.checked_add(o.commitment().amount).context("overflow")?;
        }
        ensure!(found.len() == 1, "Exactly one payout output to {} expected, found {}", if external.is_some() { "the payout address" } else { "this wallet" }, found.len());
        Ok((paid, fee_of(tx)?))
    }
    /// Seller: ONE CLSAG for the anchor input of the exact transaction (record already signed and placed).
    pub fn seller_clsag(&self, tx: &Transaction, anchor: &[u8; 32], decoys: Decoys, mask: Scalar) -> Result<(Clsag, CompressedPoint)> {
        let o = &self.outputs[anchor];
        let msg = tx.signature_hash().context("Signature hash")?;
        let ctx = ClsagContext::new(decoys, o.output.commitment().clone()).map_err(|e| anyhow::anyhow!("CLSAG context: {e:?}"))?;
        let mut r = Clsag::sign(&mut OsRng, vec![(Zeroizing::new(self.secret(&o.output, o.anchor_key)), ctx)], mask, msg).map_err(|e| anyhow::anyhow!("CLSAG: {e:?}"))?;
        let (c, p) = r.remove(0);
        Ok((c, p.compress()))
    }
    pub fn reserve_one(&mut self, ki: [u8; 32]) {
        self.reserved.insert(ki);
    }
}
impl NativeWallet {
    /// Drop a construction whose continuation now lives in the wallet journal, KEEPING its input reservations.
    pub fn forget_build(&mut self, id: &str) {
        self.builds.remove(id);
    }
}

#[cfg(feature = "lab-adversary")]
impl NativeWallet {
    /// TEST ONLY: a carrier spending `anchors` (+ funding) for ANY record, without local admission (modified software).
    pub fn lab_force_start(&mut self, anchors: &[[u8; 32]], magic: [u8; 4], record_len: usize, fee_rate: FeeRate, distribution: Vec<u64>, exclude: &BTreeSet<[u8; 32]>) -> Result<J> {
        self.anchored_start(anchors, AnchorChoice::none(), magic, record_len, fee_rate, distribution, exclude)
    }
}
