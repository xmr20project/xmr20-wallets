//! Holder-side native Monero wallet for CARRIER transactions (stage 2 of the
//! 23 Oct 2026 handoff). The holder's own extension constructs and signs the
//! ordinary Monero transaction that carries a private-token record in tx_extra,
//! pays its network fee from the holder's own XMR, and publishes it to the
//! daemon directly. No relay is involved.
//!
//! Built on the same `monero-wallet` (monero-oxide 0.2.0, locally vendored) the
//! lab roles use. Everything that touches the Monero spend key, the view key,
//! owned outputs, key images, input selection and decoy sampling runs here, in
//! the holder's wasm memory. The host (worker) only performs the daemon RPC
//! calls this module asks for and never sees a secret:
//!
//!   scanning        the host feeds every block (blob + transaction blobs);
//!                   outputs are found with the view key, the RingCT output
//!                   index is counted LOCALLY (not trusted from the node),
//!                   spent status comes from key images seen in chain inputs;
//!   decoy sampling  monero-oxide's own gamma selection runs here against a
//!                   cached, replayable view of `get_output_distribution` /
//!                   `get_outs` answers (deterministic RNG per attempt, so a
//!                   replay after the host fetched missing outputs draws the
//!                   same candidates); the real output is requested together
//!                   with the decoys exactly as monero-oxide does;
//!   fee             computed with monero-oxide's weight model BEFORE the proof
//!                   is made, so the popup can show the exact XMR fee for
//!                   approval; the signed transaction must reproduce it;
//!   signing         CLSAG + Bulletproof+ with the holder's spend key.
//!
//! Privacy note (central requirement): the only association between the token
//! record and a native output is the ordinary Monero ring of the carrier. The
//! record bytes, the fee quote, the journal fields handed to the popup and the
//! daemon requests carry no extra source-output or key-image association beyond
//! what every Monero transaction already discloses (its key image and ring).
use xmr20_unshielded_core::transport;
use anyhow::{ensure, Context, Result};
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT as G, scalar::Scalar as DS};
use monero_wallet::{
    address::{AddressType, MoneroAddress, Network},
    block::Block,
    ed25519::{Point, Scalar},
    interface::{prelude::*, ProvidesUnvalidatedDecoys},
    primitives::keccak256,
    ringct::RctType,
    send::{Change, SignableTransaction},
    transaction::{Input, Pruned, Timelock, Transaction},
    OutputWithDecoys, Scanner, ViewPair, WalletOutput,
};
use rand_chacha::{rand_core::SeedableRng, ChaCha20Rng};
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value as J};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    ops::{Bound, RangeBounds},
    task::{Context as TaskContext, Poll, RawWaker, RawWakerVTable, Waker},
};
use zeroize::Zeroizing;

// MONERO MARKET candidate (29 Oct 2026): anchored carriers and the two-party whole-lot sale transaction.
#[path = "native_market.rs"]
pub mod market;

pub const RING: u8 = 16;
pub const COINBASE_LOCK: usize = 60; // CRYPTONOTE_MINED_MONEY_UNLOCK_WINDOW
pub const DEFAULT_LOCK: usize = 10; // CRYPTONOTE_DEFAULT_TX_SPENDABLE_AGE
// Monero requires two outputs. Like wallet2 for a one-output payment, the carrier adds a
// 0-amount dummy output to a fresh random one-time address (nobody can spend it, nothing is
// burned) instead of a self-payment that would accumulate dust in the holder's wallet.
pub const DUMMY_AMOUNT: u64 = 0;
// Outputs smaller than fee_rate x MIN_CARRIER_WEIGHT cannot pay for any carrier and are never
// candidates (a 1-input/2-output carrier with a 996-byte record weighs about 2,500 bytes).
pub const MIN_CARRIER_WEIGHT: u64 = 1_500;
pub const ILLUSTRATIVE_MAINNET_PER_BYTE: u64 = 20_000; // for the popup's "mainnet would be about" line only
// MONERO MARKET option C (30 Oct 2026): a dedicated ANCHOR key pair, derived one-way from the spend key under its own
// domains. New 0 XMR anchors are paid to this pair's address. An ordinary Monero wallet restored from the same seed scans
// with the standard view key and compares against the standard spend key (and its subaddresses), so it never detects an
// anchor and can never spend one by accident and freeze a lot (SETTLEMENT.md T7). Anchors are looked for only in blocks
// that carry an XA1/XL1 record or an NFT carrier (every anchor is created by one), so ordinary scanning costs nothing extra.
pub const ANCHOR_SPEND_DOMAIN: &[u8] = b"XMR20-MARKET-ANCHOR-SPEND-V1";
pub const ANCHOR_VIEW_DOMAIN: &[u8] = b"XMR20-MARKET-ANCHOR-VIEW-V1";
fn anchor_scalar(domain: &[u8], spend: &DS) -> DS {
    let mut b = Vec::with_capacity(domain.len() + 32);
    b.extend_from_slice(domain);
    b.extend_from_slice(&spend.to_bytes());
    DS::from_bytes_mod_order(keccak256(&b))
}
/// True when a transaction can create an anchor: it carries an XA1/XL1 token record or an XMR20-NFT-V2 carrier
/// (nft_anchor / nft_sale; NFT carriers are rare, so scanning every one costs little).
/// True when a transaction carries any XMR20 record (token framing) or an XMR20-NFT-V2 carrier: its outputs are publicly
/// XMR20-related (spare anchors are never funded from them).
pub fn carries_xmr20(tx: &Transaction) -> bool {
    let extra = &tx.prefix().extra;
    matches!(transport::unframe(extra), Ok(Some(_))) || matches!(crate::nft_v2::extract(extra), Ok(Some(_)))
}
pub fn carries_anchor_record(tx: &Transaction) -> bool {
    use xmr20_unshielded_core::market::{MAGIC_ANCHORED, MAGIC_SALE};
    let extra = &tx.prefix().extra;
    matches!(transport::unframe(extra), Ok(Some(r)) if r.len() >= 4 && (r[..4] == MAGIC_ANCHORED[..] || r[..4] == MAGIC_SALE[..]))
        || matches!(crate::nft_v2::extract(extra), Ok(Some(_)))
}

fn image(sk: Scalar) -> [u8; 32] {
    let s: DS = sk.into();
    Point::from(Point::biased_hash((G * s).compress().to_bytes()).into() * s).compress().to_bytes()
}
fn dummy_address() -> MoneroAddress {
    let mut wide = [0u8; 64];
    OsRng.fill_bytes(&mut wide);
    let s = DS::from_bytes_mod_order_wide(&wide);
    OsRng.fill_bytes(&mut wide);
    let v = DS::from_bytes_mod_order_wide(&wide);
    MoneroAddress::new(Network::Mainnet, AddressType::Legacy, Point::from(G * s), Point::from(G * v))
}
fn hex32(b: [u8; 32]) -> String {
    hex::encode(b)
}
/// The input key images of a transaction, in transaction order (the carrier's native inputs for the token pool).
pub fn key_images(tx: &Transaction) -> Vec<[u8; 32]> {
    tx.prefix().inputs.iter().filter_map(|i| match i { Input::ToKey { key_image, .. } => Some(key_image.to_bytes()), _ => None }).collect()
}

// Minimal executor: the cached RPC below never returns Pending, so one poll completes.
// A canonical block blob at `height` and exactly its transactions, in block order (hashes checked against the block).
pub fn parse_block(height: usize, block_hex: &str, txs: &[(String, String)]) -> Result<(Block, Vec<Transaction>)> {
    let raw = hex::decode(block_hex)?;
    let block = Block::read(&mut raw.as_slice()).map_err(|e| anyhow::anyhow!("Block: {e}"))?;
    ensure!(block.serialize() == raw, "Non-canonical block blob");
    ensure!(block.number() == height, "Block number {} != height {height}", block.number());
    ensure!(block.transactions.len() == txs.len(), "Block lists {} transactions, host supplied {}", block.transactions.len(), txs.len());
    let mut parsed = Vec::with_capacity(txs.len());
    for ((txid, hex_tx), expected) in txs.iter().zip(&block.transactions) {
        let b = hex::decode(hex_tx)?;
        let tx = Transaction::read(&mut b.as_slice()).map_err(|e| anyhow::anyhow!("Transaction: {e}"))?;
        ensure!(tx.serialize() == b, "Non-canonical transaction blob");
        ensure!(tx.hash() == *expected && hex32(tx.hash()) == *txid, "Transaction hash mismatch in block {height}");
        parsed.push(tx);
    }
    Ok((block, parsed))
}
fn unhex32(v: &J) -> Result<[u8; 32]> {
    hex::decode(v.as_str().context("hex field")?)?.try_into().map_err(|_| anyhow::anyhow!("32-byte field"))
}

fn block_on<F: Future>(f: F) -> F::Output {
    fn noop(_: *const ()) {}
    fn clone(p: *const ()) -> RawWaker {
        RawWaker::new(p, &VTABLE)
    }
    static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);
    let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
    let mut cx = TaskContext::from_waker(&waker);
    let mut f = std::pin::pin!(f);
    for _ in 0..10_000 {
        if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
    }
    panic!("cached RPC future did not complete");
}

// Replayable view of the daemon for decoy selection. Missing `get_outs`
// answers are reported through an InternalError the caller turns into a
// `need` list for the host.
struct CachedRpc {
    tip: usize,
    distribution: Vec<u64>, // cumulative RingCT outputs per height, index = height
    outs: BTreeMap<u64, Option<[Point; 2]>>,
    missing: std::sync::Mutex<Vec<u64>>,
}
impl ProvidesBlockchainMeta for CachedRpc {
    fn latest_block_number(&self) -> impl Send + Future<Output = Result<usize, InterfaceError>> {
        async move { Ok(self.tip) }
    }
}
impl ProvidesUnvalidatedDecoys for CachedRpc {
    fn ringct_output_distribution(&self, range: impl Send + RangeBounds<usize>) -> impl Send + Future<Output = Result<Vec<u64>, InterfaceError>> {
        let start = match range.start_bound() {
            Bound::Included(s) => *s,
            Bound::Excluded(s) => s + 1,
            Bound::Unbounded => 0,
        };
        let end = match range.end_bound() {
            Bound::Included(e) => e + 1,
            Bound::Excluded(e) => *e,
            Bound::Unbounded => self.distribution.len(),
        };
        async move {
            if start > end || end > self.distribution.len() {
                return Err(InterfaceError::InternalError(format!("distribution range {start}..{end} outside {}", self.distribution.len())));
            }
            Ok(self.distribution[start..end].to_vec())
        }
    }
    fn unlocked_ringct_outputs(&self, indexes: &[u64], _evaluate: EvaluateUnlocked) -> impl Send + Future<Output = Result<Vec<Option<[Point; 2]>>, TransactionsError>> {
        let mut res = Vec::with_capacity(indexes.len());
        let mut missing = vec![];
        for i in indexes {
            match self.outs.get(i) {
                Some(v) => res.push(*v),
                None => missing.push(*i),
            }
        }
        async move {
            if !missing.is_empty() {
                self.missing.lock().unwrap().extend(missing.iter().copied());
                return Err(InterfaceError::InternalError("need-outs".into()).into());
            }
            Ok(res)
        }
    }
}

pub struct Owned {
    pub output: WalletOutput,
    pub height: usize,
    pub coinbase: bool,
    pub txid: [u8; 32],
    // Option C: found with the dedicated anchor key (spent with the anchor spend key). Older anchors (option A) are false.
    pub anchor_key: bool,
    // Spare anchors (31 Oct 2026): whether the creating transaction carried an XMR20 record or NFT carrier. Such outputs are
    // publicly XMR20-related, so they never fund a spare anchor. None = saved before this field existed (unknown).
    pub carrier: Option<bool>,
}
struct PendingQuote {
    id: String,
    kind: String,
    wire_len: usize,
    fee_rate: FeeRate,
    seed: [u8; 32],
    key_image: [u8; 32],
    distribution: Vec<u64>,
    outs: BTreeMap<u64, Option<[Point; 2]>>,
    ready: Option<(OutputWithDecoys, u64, usize)>, // input with decoys, fee, weight
}
pub struct NativeWallet {
    spend: Zeroizing<Scalar>,
    pair: ViewPair,
    scanner: Scanner,
    // Option C: the dedicated anchor key pair and its scanner (run only on blocks carrying XA1/XL1).
    anchor_spend: Zeroizing<Scalar>,
    anchor_pair: ViewPair,
    anchor_scanner: Scanner,
    rct_outputs: u64,
    outputs: BTreeMap<[u8; 32], Owned>,
    spent: BTreeMap<[u8; 32], (usize, [u8; 32])>,
    seen_keys: BTreeSet<[u8; 32]>,
    reserved: BTreeSet<[u8; 32]>,
    quotes: BTreeMap<String, PendingQuote>,
    pub tip: usize,
    pub blocks: usize,
    // MARKET candidate: in-progress multi-input constructions (anchored carriers, sale drafts, seller rings).
    builds: BTreeMap<String, market::Building>,
    // Lab-adversary builds only: cap the height decoys are sampled at (ring control for deep-reorg tests).
    pub decoy_cap: Option<usize>,
    // MONERO ACCOUNTS (30 Oct 2026): the account service's market wallet lists lots whose price is paid to the service's XMR
    // wallet. To check a buyer's payment to THAT address the seller scans with its view key (it can see, not spend).
    payout_view: Option<(String, Scanner)>,
}
impl NativeWallet {
    // Standard Monero key schedule from the 32-byte private spend key: view = Hs(spend).
    pub fn from_root(root: &[u8; 32]) -> Result<Self> {
        // A wallet's private spend key is already reduced (the 25-word phrase encodes the reduced
        // scalar); reducing again is the identity for it and keeps synthetic test roots valid.
        let spend = Scalar::from(DS::from_bytes_mod_order(*root));
        let view = Scalar::from(DS::from_bytes_mod_order(keccak256(root)));
        let spend_pub: DS = spend.into();
        let pair = ViewPair::new(Point::from(G * spend_pub), Zeroizing::new(view)).map_err(|e| anyhow::anyhow!("View pair: {e:?}"))?;
        let a_spend = anchor_scalar(ANCHOR_SPEND_DOMAIN, &spend_pub);
        let a_view = anchor_scalar(ANCHOR_VIEW_DOMAIN, &spend_pub);
        ensure!(a_spend != DS::ZERO && a_view != DS::ZERO, "Degenerate anchor key");
        let anchor_pair = ViewPair::new(Point::from(G * a_spend), Zeroizing::new(Scalar::from(a_view))).map_err(|e| anyhow::anyhow!("Anchor view pair: {e:?}"))?;
        Ok(Self { spend: Zeroizing::new(spend), scanner: Scanner::new(pair.clone()), pair, anchor_spend: Zeroizing::new(Scalar::from(a_spend)), anchor_scanner: Scanner::new(anchor_pair.clone()), anchor_pair, rct_outputs: 0, outputs: BTreeMap::new(), spent: BTreeMap::new(), seen_keys: BTreeSet::new(), reserved: BTreeSet::new(), quotes: BTreeMap::new(), tip: 0, blocks: 0, builds: BTreeMap::new(), decoy_cap: None, payout_view: None })
    }
    /// MONERO ACCOUNTS: the view key of the standard address this wallet's listings may pay instead of its own.
    pub fn set_payout_view(&mut self, network: Network, address: &str, view: [u8; 32]) -> Result<()> {
        let a = MoneroAddress::from_str(network, address).map_err(|e| anyhow::anyhow!("Payout address: {e:?}"))?;
        ensure!(*a.kind() == AddressType::Legacy, "The payout must be a standard (primary) address");
        let v = Option::<DS>::from(DS::from_canonical_bytes(view)).context("The view key is not a canonical scalar")?;
        ensure!(Point::from(G * v).compress().to_bytes() == a.view().compress().to_bytes(), "This view key does not belong to the payout address");
        let pair = ViewPair::new(a.spend(), Zeroizing::new(Scalar::from(v))).map_err(|e| anyhow::anyhow!("View pair: {e:?}"))?;
        self.payout_view = Some((address.to_string(), Scanner::new(pair)));
        Ok(())
    }
    // Begin at `height` with `rct_outputs` RingCT outputs already on the chain (from the daemon's
    // cumulative distribution at height-1). Only valid before any block was applied.
    pub fn start_at(&mut self, height: usize, rct_outputs: u64) -> Result<()> {
        ensure!(self.blocks == 0 && self.outputs.is_empty(), "start_at is only valid on a fresh wallet");
        self.blocks = height;
        self.rct_outputs = rct_outputs;
        self.tip = height.saturating_sub(1);
        Ok(())
    }
    pub fn address(&self) -> String {
        self.pair.legacy_address(Network::Mainnet).to_string()
    }
    // Address for the explicitly selected network (stagenet prefix for "stagenet"; the regtest fakechain uses the mainnet format).
    pub fn address_for(&self, network: &str) -> String {
        self.pair.legacy_address(if network == "stagenet" { Network::Stagenet } else { Network::Mainnet }).to_string()
    }
    // MONERO MARKET candidate (29 Oct 2026): Monero wallet message signature, spend-key type ("SigV2"), as
    // wallet2::sign builds it: m = keccak("MoneroMessageSignature\0" || spend_pub || view_pub || 0 || varint(len) || data),
    // k random, c = Hs(m || spend_pub || kG), r = k - c*spend; text = "SigV2" + monero-base58(c || r). Used only for the
    // market's off-chain NFT listing/withdrawal messages (the host restricts the domains); the spend key never leaves here.
    pub fn sign_message(&self, data: &[u8]) -> Result<String> {
        let spend: DS = (*self.spend).into();
        let spend_pub = (G * spend).compress().to_bytes();
        let view_pub = self.pair.view().compress().to_bytes();
        let mut m = Vec::with_capacity(96 + data.len());
        m.extend_from_slice(b"MoneroMessageSignature\0");
        m.extend_from_slice(&spend_pub);
        m.extend_from_slice(&view_pub);
        m.push(0);
        let mut n = data.len();
        while n >= 128 { m.push(((n & 127) | 128) as u8); n >>= 7; }
        m.push(n as u8);
        m.extend_from_slice(data);
        let m = keccak256(&m);
        let mut seed = [0u8; 64];
        OsRng.fill_bytes(&mut seed);
        let k = DS::from_bytes_mod_order_wide(&seed);
        let k_g = (G * k).compress().to_bytes();
        let mut h = Vec::with_capacity(96);
        h.extend_from_slice(&m);
        h.extend_from_slice(&spend_pub);
        h.extend_from_slice(&k_g);
        let c = DS::from_bytes_mod_order(keccak256(&h));
        let r = k - c * spend;
        let mut sig = [0u8; 64];
        sig[..32].copy_from_slice(&c.to_bytes());
        sig[32..].copy_from_slice(&r.to_bytes());
        Ok(format!("SigV2{}", monero_base58(&sig)))
    }
    pub fn reset(&mut self) {
        self.scanner = Scanner::new(self.pair.clone());
        self.anchor_scanner = Scanner::new(self.anchor_pair.clone());
        self.rct_outputs = 0;
        self.outputs.clear();
        self.spent.clear();
        self.seen_keys.clear();
        self.quotes.clear();
        self.builds.clear();
        self.tip = 0;
        self.blocks = 0;
        // `reserved` is deliberately kept: a rollback can return an output a
        // saved carrier already uses; the journal decides when to release it.
    }
    // Saved scan progress (27 Oct 2026). Everything the scan accumulated; the keys are re-derived from the root and never
    // stored here. Quotes are in-flight state and are not kept (the journal recovers saved carriers).
    pub fn snapshot(&self) -> J {
        json!({
            "blocks": self.blocks, "tip": self.tip, "rctOutputs": self.rct_outputs,
            "outputs": self.outputs.iter().map(|(ki, o)| json!({"ki": hex32(*ki), "height": o.height, "coinbase": o.coinbase, "txid": hex32(o.txid), "output": hex::encode(o.output.serialize()), "anchorKey": o.anchor_key, "carrier": o.carrier})).collect::<Vec<_>>(),
            "spent": self.spent.iter().map(|(ki, (h, tx))| json!([hex32(*ki), h, hex32(*tx)])).collect::<Vec<_>>(),
            "seen": self.seen_keys.iter().map(|k| hex32(*k)).collect::<Vec<_>>(),
            "reserved": self.reserved.iter().map(|k| hex32(*k)).collect::<Vec<_>>(),
        })
    }
    // Only on a fresh wallet. Every saved output must belong to this wallet: its key image is recomputed from the spend key.
    // `rollback` = (height, RingCT outputs through that height): drop what came from blocks above it (chain reorganization);
    // the seen set is rebuilt from the kept outputs so an output re-mined in a different block is found again.
    pub fn restore(&mut self, v: &J, rollback: Option<(usize, u64)>) -> Result<()> {
        ensure!(self.blocks == 0 && self.outputs.is_empty(), "restore is only valid on a fresh wallet");
        let blocks = v["blocks"].as_u64().context("blocks")? as usize;
        let tip = v["tip"].as_u64().context("tip")? as usize;
        ensure!(blocks > 0 && tip + 1 == blocks, "Saved native progress is inconsistent");
        let mut outputs = BTreeMap::new();
        let mut seen = BTreeSet::new();
        for o in v["outputs"].as_array().context("outputs")? {
            let bytes = hex::decode(o["output"].as_str().context("output")?)?;
            let output = WalletOutput::read(&mut bytes.as_slice()).map_err(|e| anyhow::anyhow!("Saved output: {e}"))?;
            let ki = unhex32(&o["ki"])?;
            // Saved before option C: no flag, the standard spend key.
            let anchor_key = o["anchorKey"].as_bool().unwrap_or(false);
            ensure!(image(self.secret(&output, anchor_key)) == ki, "Saved output does not belong to this wallet");
            let height = o["height"].as_u64().context("height")? as usize;
            ensure!(height <= tip, "Saved output above the saved tip");
            seen.insert(output.key().compress().to_bytes());
            outputs.insert(ki, Owned { txid: unhex32(&o["txid"])?, coinbase: o["coinbase"].as_bool().context("coinbase")?, output, height, anchor_key, carrier: o["carrier"].as_bool() });
        }
        let mut spent = BTreeMap::new();
        for e in v["spent"].as_array().context("spent")? {
            let ki = unhex32(&e[0])?;
            ensure!(outputs.contains_key(&ki), "Saved spend of an unknown output");
            spent.insert(ki, (e[1].as_u64().context("spent height")? as usize, unhex32(&e[2])?));
        }
        let mut seen_keys = BTreeSet::new();
        for k in v["seen"].as_array().context("seen")? {
            seen_keys.insert(unhex32(k)?);
        }
        ensure!(seen.is_subset(&seen_keys), "Saved output keys missing from the seen set");
        let mut reserved = BTreeSet::new();
        for k in v["reserved"].as_array().context("reserved")? {
            reserved.insert(unhex32(k)?);
        }
        let mut rct_outputs = v["rctOutputs"].as_u64().context("rctOutputs")?;
        let (mut tip, mut blocks) = (tip, blocks);
        if let Some((h, rct)) = rollback {
            ensure!(h <= tip, "Rollback above the saved tip");
            outputs.retain(|_, o| o.height <= h);
            spent.retain(|_, (sh, _)| *sh <= h);
            seen_keys = outputs.values().map(|o| o.output.key().compress().to_bytes()).collect();
            ensure!(rct <= rct_outputs, "Rollback RingCT count above the saved count");
            rct_outputs = rct;
            tip = h;
            blocks = h + 1;
        }
        self.reserved.extend(reserved);
        self.rct_outputs = rct_outputs;
        self.outputs = outputs;
        self.spent = spent;
        self.seen_keys = seen_keys;
        self.tip = tip;
        self.blocks = blocks;
        Ok(())
    }
    fn secret(&self, o: &WalletOutput, anchor_key: bool) -> Scalar {
        let a: DS = if anchor_key { (*self.anchor_spend).into() } else { (*self.spend).into() };
        let b: DS = o.key_offset().into();
        Scalar::from(a + b)
    }
    // One block in canonical order. Returns each non-miner transaction's extra
    // bytes for the token pool and native scan statistics.
    pub fn apply_block(&mut self, height: usize, block_hex: &str, txs: &[(String, String)]) -> Result<(Vec<(String, Vec<u8>, Vec<[u8; 32]>)>, J)> {
        ensure!(height == self.blocks, "Blocks must be applied in order (expected {}, got {height})", self.blocks);
        let (block, parsed) = parse_block(height, block_hex, txs)?;
        let miner = block.miner_transaction();
        let miner_hash = miner.hash();
        let first_rct = if miner.version() == 2 { Some(self.rct_outputs) } else { None };
        // Local RingCT output count (never trusted from the node).
        if miner.version() == 2 {
            self.rct_outputs += miner.prefix().outputs.len() as u64;
        }
        let mut spent_now = 0;
        for tx in &parsed {
            if tx.version() == 2 {
                self.rct_outputs += tx.prefix().outputs.len() as u64;
            }
            for i in &tx.prefix().inputs {
                if let Input::ToKey { key_image, .. } = i {
                    let ki = key_image.to_bytes();
                    if self.outputs.contains_key(&ki) && !self.spent.contains_key(&ki) {
                        self.spent.insert(ki, (height, tx.hash()));
                        spent_now += 1;
                    }
                }
            }
        }
        let scannable = || ScannableBlock { block: block.clone(), transactions: parsed.iter().cloned().map(Transaction::<Pruned>::from).collect(), output_index_for_first_ringct_output: first_rct };
        let mut found: Vec<(WalletOutput, bool)> = self.scanner.scan(scannable()).map_err(|e| anyhow::anyhow!("Scan: {e:?}"))?.ignore_additional_timelock().into_iter().map(|o| (o, false)).collect();
        // Option C: anchors are created by transactions carrying XA1/XL1 (inline anchors) or, since 31 Oct 2026, by this
        // wallet's own spare-anchor payments; scan for the anchor key in blocks with such a record or with a spend of an
        // output this wallet holds (every spare is funded by one, also after a restore from the seed).
        let mut anchors = 0;
        if spent_now > 0 || parsed.iter().any(carries_anchor_record) {
            let a = self.anchor_scanner.scan(scannable()).map_err(|e| anyhow::anyhow!("Anchor scan: {e:?}"))?.ignore_additional_timelock();
            anchors = a.len();
            found.extend(a.into_iter().map(|o| (o, true)));
        }
        let carriers: BTreeSet<[u8; 32]> = parsed.iter().filter(|tx| carries_xmr20(tx)).map(|tx| tx.hash()).collect();
        let mut received = 0;
        for (o, anchor_key) in found {
            let key = o.key().compress().to_bytes();
            if !self.seen_keys.insert(key) {
                continue; // burning-bug duplicate: never spendable twice
            }
            let ki = image(self.secret(&o, anchor_key));
            let coinbase = o.transaction() == miner_hash;
            let carrier = Some(carriers.contains(&o.transaction()));
            self.outputs.insert(ki, Owned { txid: o.transaction(), output: o, height, coinbase, anchor_key, carrier });
            received += 1;
        }
        self.tip = height;
        self.blocks = height + 1;
        let extras = parsed.iter().map(|tx| (hex32(tx.hash()), tx.prefix().extra.clone(), key_images(tx))).collect();
        Ok((extras, json!({"received":received,"anchors":anchors,"spent":spent_now,"rctOutputs":self.rct_outputs})))
    }
    // First chain tip at which the output may be spent, following monerod's rules:
    // an output in block h is spendable once the chain height (tip + 1) reaches
    // h + 10; a coinbase unlock_time u (= h + 60) is satisfied once tip + 1 >= u.
    fn unlock_height(&self, o: &Owned) -> usize {
        let window = o.height + if o.coinbase { COINBASE_LOCK } else { DEFAULT_LOCK } - 1;
        let extra = match o.output.additional_timelock() {
            Timelock::None => 0,
            Timelock::Block(b) => b.saturating_sub(1),
            Timelock::Time(_) => usize::MAX / 2, // not expected on the test chain; treated as locked
        };
        window.max(extra)
    }
    fn spendable(&self, ki: &[u8; 32], o: &Owned, exclude: &BTreeSet<[u8; 32]>) -> bool {
        !self.spent.contains_key(ki) && !self.reserved.contains(ki) && !exclude.contains(ki) && self.tip >= self.unlock_height(o)
    }
    fn can_pay(o: &Owned, fee_rate: &FeeRate) -> bool {
        o.output.commitment().amount >= fee_rate.per_weight().saturating_mul(MIN_CARRIER_WEIGHT)
    }
    pub fn status(&self, exclude: &BTreeSet<[u8; 32]>) -> J {
        let mut unlocked = 0u128;
        let mut locked = 0u128;
        let mut reserved = 0u128;
        let mut list = vec![];
        for (ki, o) in &self.outputs {
            let amount = o.output.commitment().amount;
            let spent = self.spent.get(ki);
            let is_reserved = self.reserved.contains(ki) || exclude.contains(ki);
            let unlocked_at = self.unlock_height(o);
            if spent.is_none() {
                if is_reserved {
                    reserved += u128::from(amount);
                } else if self.tip >= unlocked_at {
                    unlocked += u128::from(amount);
                } else {
                    locked += u128::from(amount);
                }
            }
            list.push(json!({"keyImage":hex32(*ki),"amount":amount.to_string(),"height":o.height,"coinbase":o.coinbase,"unlockedAt":unlocked_at,"spent":spent.map(|(h,t)|json!({"height":h,"txid":hex32(*t)})),"reserved":is_reserved,"txid":hex32(o.txid),"anchorKey":o.anchor_key}));
        }
        json!({"address":self.address(),"tip":self.tip,"unlocked":unlocked.to_string(),"locked":locked.to_string(),"reserved":reserved.to_string(),"outputs":list,"rctOutputs":self.rct_outputs})
    }
    pub fn reserve(&mut self, kis: &[[u8; 32]]) {
        self.reserved.extend(kis.iter().copied());
    }
    pub fn release(&mut self, kis: &[[u8; 32]]) {
        for k in kis {
            self.reserved.remove(k);
        }
    }
    // Step 1 of a carrier quote: choose the native input and start decoy selection.
    pub fn quote(&mut self, kind: &str, wire_len: usize, fee_rate: FeeRate, distribution: Vec<u64>, exclude: &BTreeSet<[u8; 32]>) -> Result<J> {
        ensure!(wire_len > 0 && wire_len <= transport::MAX_RECORD, "Record size out of range for one carrier");
        ensure!(distribution.len() == self.tip + 1, "Distribution must cover heights 0..={} (got {} entries)", self.tip, distribution.len());
        ensure!(distribution.last().copied().unwrap_or(0) == self.rct_outputs, "Daemon RingCT output count {} differs from the local count {}", distribution.last().copied().unwrap_or(0), self.rct_outputs);
        // Largest spendable output. Report locked/reserved funds precisely when nothing qualifies.
        let candidate = self.outputs.iter().filter(|(ki, o)| self.spendable(ki, o, exclude) && Self::can_pay(o, &fee_rate)).max_by_key(|(_, o)| o.output.commitment().amount).map(|(ki, o)| (*ki, o.output.clone()));
        let Some((ki, output)) = candidate else {
            let st = self.status(exclude);
            let too_small: u128 = self.outputs.iter().filter(|(k, o)| self.spendable(k, o, exclude) && !Self::can_pay(o, &fee_rate)).map(|(_, o)| u128::from(o.output.commitment().amount)).sum();
            anyhow::bail!("No spendable XMR for the carrier fee: unlocked {} piconero (of which {} too small for any carrier at {} piconero/byte), locked {} (unlocks by block {}), reserved by pending carriers {}; chain tip {}", st["unlocked"].as_str().unwrap(), too_small, fee_rate.per_weight(), st["locked"].as_str().unwrap(), self.outputs.iter().filter(|(k,o)|!self.spent.contains_key(*k)&&self.tip<self.unlock_height(o)).map(|(_,o)|self.unlock_height(o)).max().unwrap_or(0), st["reserved"].as_str().unwrap(), self.tip);
        };
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        let id = hex::encode(&seed[..8]);
        let q = PendingQuote { id: id.clone(), kind: kind.into(), wire_len, fee_rate, seed, key_image: ki, distribution, outs: BTreeMap::new(), ready: None };
        self.quotes.insert(id.clone(), q);
        let _ = output;
        self.try_quote(&id)
    }
    // Step 2+: the host supplies the daemon's answers for the requested indexes.
    pub fn quote_outs(&mut self, id: &str, outs: &[(u64, Option<[Point; 2]>)]) -> Result<J> {
        let q = self.quotes.get_mut(id).context("Unknown or expired fee quote")?;
        for (i, v) in outs {
            q.outs.insert(*i, *v);
        }
        self.try_quote(id)
    }
    fn try_quote(&mut self, id: &str) -> Result<J> {
        let q = self.quotes.get(id).context("Unknown or expired fee quote")?;
        let owned = self.outputs.get(&q.key_image).context("Quoted input vanished")?;
        let rpc = CachedRpc { tip: self.tip, distribution: q.distribution.clone(), outs: q.outs.clone(), missing: std::sync::Mutex::new(vec![]) };
        let mut rng = ChaCha20Rng::from_seed(q.seed);
        let selected = block_on(OutputWithDecoys::new(&mut rng, &rpc, RING, self.tip, owned.output.clone()));
        match selected {
            Ok(input) => {
                // Fee for the exact structure: 1 input (16-ring), 2 outputs, extra = record chunks + tx pubkey.
                // Fee placeholder of the exact record length (the framing only needs the size; a known magic satisfies `parts`).
                let mut placeholder = vec![0u8; q.wire_len];
                placeholder[..4].copy_from_slice(xmr20_unshielded_core::public::MAGIC_TRANSFER);
                let amount = owned.output.commitment().amount;
                let signable = match SignableTransaction::new(RctType::ClsagBulletproofPlus, Zeroizing::new([1u8; 32]), vec![input.clone()], vec![(dummy_address(), DUMMY_AMOUNT)], Change::new(self.pair.clone(), None), transport::parts(&placeholder)?, q.fee_rate) {
                    Ok(s) => s,
                    Err(monero_wallet::send::SendError::NotEnoughFunds { necessary_fee: Some(fee), .. }) => {
                        self.quotes.remove(id);
                        anyhow::bail!("The largest spendable XMR output ({amount} piconero) does not cover the carrier fee of {fee} piconero; nothing was reserved")
                    }
                    Err(e) => {
                        self.quotes.remove(id);
                        anyhow::bail!("Carrier construction failed: {e:?}")
                    }
                };
                let fee = signable.necessary_fee();
                let weight = q.fee_rate.calculate_weight_from_fee(fee).unwrap_or(0);
                ensure!(amount > fee, "The largest spendable XMR output ({amount} piconero) does not cover the carrier fee {fee}");
                let ring: Vec<u64> = input.decoys().positions();
                let out = json!({"quoteId":id,"kind":q.kind,"keyImage":hex32(q.key_image),"inputAmount":amount.to_string(),"inputHeight":owned.height,"fee":fee.to_string(),"weight":weight,"feePerWeight":q.fee_rate.per_weight().to_string(),"recordBytes":q.wire_len,"ringSize":ring.len(),"illustrativeMainnetFee":(u64::try_from(weight).unwrap_or(0)*ILLUSTRATIVE_MAINNET_PER_BYTE).to_string(),"changeAmount":(amount-fee).to_string(),"ready":true});
                let q = self.quotes.get_mut(id).unwrap();
                q.ready = Some((input, fee, weight));
                Ok(out)
            }
            Err(e) => {
                let missing = rpc.missing.into_inner().unwrap();
                if !missing.is_empty() {
                    let mut need: Vec<u64> = missing;
                    need.sort_unstable();
                    need.dedup();
                    Ok(json!({"quoteId":id,"ready":false,"need":need}))
                } else {
                    self.quotes.remove(id);
                    anyhow::bail!("Decoy selection failed: {e:?}")
                }
            }
        }
    }
    pub fn cancel(&mut self, id: &str) -> bool {
        self.quotes.remove(id).is_some()
    }
    // Build and sign the carrier for a finished record using the quoted input,
    // ring and fee rate. The fee must equal the quote shown to the user.
    pub fn sign(&mut self, id: &str, wire: &[u8]) -> Result<J> {
        let q = self.quotes.remove(id).context("Unknown or expired fee quote")?;
        let (input, quoted_fee, _) = q.ready.context("Fee quote not ready")?;
        ensure!(wire.len() == q.wire_len, "Record size differs from the quote");
        ensure!(!self.spent.contains_key(&q.key_image), "The quoted XMR input was spent meanwhile");
        let mut ovk = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(&mut *ovk);
        let signable = SignableTransaction::new(RctType::ClsagBulletproofPlus, ovk, vec![input], vec![(dummy_address(), DUMMY_AMOUNT)], Change::new(self.pair.clone(), None), transport::parts(wire)?, q.fee_rate).map_err(|e| anyhow::anyhow!("Carrier construction failed: {e:?}"))?;
        let fee = signable.necessary_fee();
        ensure!(fee == quoted_fee, "Carrier fee {fee} differs from the approved quote {quoted_fee}");
        let tx = signable.sign(&mut OsRng, &self.spend).map_err(|e| anyhow::anyhow!("Carrier signing failed: {e:?}"))?;
        let blob = tx.serialize();
        ensure!(tx.prefix().extra.len() <= transport::EXTRA_LIMIT, "tx_extra exceeds the relay limit");
        ensure!(transport::unframe(&tx.prefix().extra)?.as_deref() == Some(wire), "Carrier does not carry the record");
        let images: Vec<[u8; 32]> = tx.prefix().inputs.iter().filter_map(|i| match i { Input::ToKey { key_image, .. } => Some(key_image.to_bytes()), _ => None }).collect();
        ensure!(images == vec![q.key_image], "Unexpected key image");
        let paid = match &tx { Transaction::V2 { proofs: Some(p), .. } => p.base.fee, _ => anyhow::bail!("RingCT required") };
        ensure!(paid == fee, "Fee mismatch");
        self.reserved.insert(q.key_image);
        Ok(json!({"txid":hex32(tx.hash()),"blob":hex::encode(&blob),"nativeBytes":blob.len(),"extraBytes":tx.prefix().extra.len(),"fee":fee.to_string(),"keyImage":hex32(q.key_image),"inputs":1,"outputs":tx.prefix().outputs.len(),"kind":q.kind}))
    }
}

// Monero base58: 8-byte blocks encoded to 11 characters (shorter last block), as monero's tools/base58.cpp.
pub fn monero_base58(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const BLOCK: [usize; 9] = [0, 2, 3, 5, 6, 7, 9, 10, 11];
    let mut out = String::new();
    for block in bytes.chunks(8) {
        let mut n: u128 = 0;
        for b in block { n = (n << 8) | u128::from(*b); }
        let size = BLOCK[block.len()];
        let mut s = vec![b'1'; size];
        for i in (0..size).rev() { s[i] = ALPHABET[(n % 58) as usize]; n /= 58; }
        out.push_str(std::str::from_utf8(&s).unwrap());
    }
    out
}
