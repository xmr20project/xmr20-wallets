//! Persistent incremental indexer (stdio JSON service) for long-running operation; the roles binary's indexer role replays
//! everything on every scan instead. Same admission rules (the core Pool), same trusted-manifest parameter
//! authentication (the lab crate's Params), plus:
//!   - append-only STATE LOG in --state <dir>: blocks.jsonl {height, hash} and records.jsonl {height, txid, wire}
//!     (only records the framing recognised; their admission result is recomputed on replay) and meta.json;
//!   - restart: the pool is rebuilt from the record log (no block is fetched again), then syncing continues at the stored tip;
//!   - reorganisation: the stored tip hash is compared with the daemon's; on a mismatch the fork point is found by walking back
//!     over stored hashes, both logs are truncated at the fork (atomic rewrite), the pool is rebuilt and syncing resumes;
//!   - every sync verifies the hash chain (each new block's previous hash equals the stored one) and that the daemon's
//!     network and genesis are the manifest's. A mainnet daemon is refused unless the manifest says mainnet and XMR20_MAINNET_PILOT=I-UNDERSTAND is set.
//! Ops: sync · status · summary · stateSections · owner · record · tx · verify · view · events · marketRules · close
//!   Moves by Monero address: addressOwner · addressHoldings · addressMovePrepare · addressMoveFinalize · addressRules ·
//!   relayFees · relayFeeAddress · relayPayments. With XMR20_RELAY_FEES=<file {"address","viewKey"}> the indexer also watches
//!   the relay's fee wallet (VIEW key only: it can see payments, never spend them) for payments to its one-time subaddresses
//!   (account 0, index 1..=XMR20_RELAY_FEES_LOOKAHEAD, default 5000), saved in payments.jsonl and truncated on a reorganisation.
//!
//! Atomic block commits: a block is applied to a copy of the ledger view
//! and kept only when all of its rows and then its block row are on disk (`logs`: commit-pending undo file, block row as the
//! commit point, journaled reorganisation rewrite, recovery on open). A failed sync therefore leaves the committed state exactly
//! as it was before the failing block, in memory and on disk, also across a restart. `--check-state <dir>` reports what the
//! recovery would change in a state directory without writing anything (no daemon, no parameters needed).
//!
//! Durability: the state directory, meta.json and the four log files are made durable before any block
//! commits (directory syncs; meta.json by temp file + rename). Operator modes, none needs a daemon:
//!   --check-state <dir>     read-only: what recovery would change, which journals are present;
//!   --recover-state <dir>   journal-aware recovery of a STOPPED indexer's directory (the same recovery as on open);
//!   --compare-state <a> <b> [--height H] [--params <dir> --trusted-manifest <file>]
//!                           read-only: compares two state directories (for example a copy of the live one and a clean replay
//!                           made by a fresh indexer from the start height) at a common block height and hash: blocks, records,
//!                           relay payments and claim payment facts, and with parameters also the ledger state rebuilt from
//!                           them (pool summary and every record's result). Exit status 1 when they differ.
//!
//! State hashes: the hash of the whole ledger state (core `Pool::state_hash`) is taken at the end of every block whose height
//! is a multiple of 720, after the block's records are applied and its claims are settled, when the block is committed. The
//! ledger view is not saved: it is rebuilt from the record log on every start and after a reorganisation, and the hashes are
//! taken again during that rebuild at the same points, so they are held for every such block the directory holds, whichever
//! build read it, and the hashes of blocks a reorganisation removed are gone with them. `state-hashes.json` {every, hashes:
//! [{height, blockHash, stateHash}]} keeps what was computed, for comparison only: on a start, a kept hash for a block still
//! held that differs from the rebuilt one is reported (event `state-hash-differs`, `status`) and appended to
//! `state-hash-differences.jsonl` {height, blockHash, kept, rebuilt, found}, which is never rewritten; then state-hashes.json
//! is written again from the rebuilt hashes (not when the difference could not be written down). A missing or unreadable file changes nothing (a directory written by a build without it loads as
//! before). The file is not part of the commit log: nothing reads the ledger from it.
//!
//! Claim payments: a trade claim names a Monero payment, which the reader fetches from its node when it reads the claim's block.
//! What the node says is bound to the reader's own chain before it is used or kept (`fact_plan`, `fact_verified`):
//!   - a payment the node places above the block being read is not on this chain at that block: it is neither used nor kept
//!     (a later claim asks the node again);
//!   - a payment at or below it must be listed in the node's block of that height, and that block must be on the chain this
//!     reader holds: its hash equals the held block's (the block being read for a payment in it; for a payment below the first
//!     held block, the node's block at the first held height must be the held one, so the payment's block is an ancestor of it).
//!     If the node does not show that, the pass fails and is tried again; nothing of the block is kept.
//! Each kept fact (claim-payments.jsonl) carries `at`, the block at which this reader first learned it. A rebuild settles a
//! block only with the facts of `at` at or below it, so it settles every claim with exactly what was known when the block was
//! read. A reorganisation removes the facts learned above the fork. A row without `at` was written by a build before this
//! rule and is available at every block, as it was then; such rows were not bound to the reader's chain when they were
//! fetched, and only reading the chain again into a new state directory replaces them. A build before this rule reads the
//! new rows (it ignores `at`).
//!
//! Market rules: lot records (XA1/XL1) apply from the activation height built into the core
//! (`market::activation`; mainnet: block 3,796,100). A lot moves only in a transaction that
//! spends its anchor key image, so a stored record keeps the ANCHOR key images its carrier spends (`anchors`): only key images
//! that an earlier lot record already published, never a holder's other inputs (the service's disk state stays free of
//! key images; with the rules off nothing is added). Below the height a lot record is not a
//! record (not stored). Test chains may override the height with XMR20_MARKET_FROM ("off" or a block height);
//! mainnet ignores the override.
mod logs;

use anyhow::{ensure, Context, Result};
use monero_wallet::interface::prelude::*;
use penumbra_sdk_keys::FullViewingKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as J};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    str::FromStr,
};
use xmr20_unshielded_core::{self as core, keys::owner_vk, pool::Pool};
use xmr20_unshielded_lab::{chain::Params, native};

/// The state hash is taken at the end of every block whose height is a multiple of this.
const STATE_HASH_EVERY: u64 = 720;
const STATE_HASHES: &str = "state-hashes.json";
/// The ledger state hash at the end of a block, as this reader computed it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct StateHashRow {
    height: u64,
    #[serde(rename = "blockHash")]
    block_hash: String,
    #[serde(rename = "stateHash")]
    state_hash: String,
}
/// state-hashes.json. Every field has a default, so a file written by another build still reads.
#[derive(Serialize, Deserialize, Default)]
struct StateHashFile {
    #[serde(default)]
    every: u64,
    #[serde(default)]
    hashes: Vec<StateHashRow>,
}

const STATE_HASH_DIFFERENCES: &str = "state-hash-differences.jsonl";
/// A payment fact with the block at which this reader first learned it. None: a row written by a build that did not record
/// it; such a fact is available at every block, as it was for that build.
#[derive(Clone, Debug, PartialEq)]
struct KeptFact {
    fact: core::trade::PaymentFacts,
    at: Option<u64>,
}
type KeptFacts = BTreeMap<[u8; 32], KeptFact>;
/// A row of claim-payments.jsonl: the core's fact (`trade::facts_to_json`) with `at` beside it when known. A build that
/// does not know `at` reads the row as the fact alone.
fn fact_row(k: &KeptFact) -> J {
    let mut v = core::trade::facts_to_json(&k.fact);
    if let Some(at) = k.at {
        v["at"] = json!(at);
    }
    v
}
fn fact_from_row(v: &J) -> Result<KeptFact> {
    Ok(KeptFact { fact: core::trade::facts_from_json(v)?, at: v["at"].as_u64() })
}
fn facts_from_rows(rows: &[J]) -> Result<KeptFacts> {
    rows.iter().map(|v| fact_from_row(v).map(|k| (k.fact.txid, k))).collect()
}
/// The facts the claims of block `height` are settled with: those learned at or below it.
fn facts_at(kept: &KeptFacts, height: u64) -> BTreeMap<[u8; 32], core::trade::PaymentFacts> {
    kept.values().filter(|k| k.at.is_none_or(|at| at <= height)).map(|k| (k.fact.txid, k.fact.clone())).collect()
}
/// The kept facts that remain when the chain is cut back to `fork`: a payment above it is gone, and so is what was learned
/// above it (the blocks read again learn it again, at their own heights).
fn facts_upto(kept: &KeptFacts, fork: u64) -> KeptFacts {
    kept.iter().filter(|(_, k)| k.fact.height <= fork && k.at.is_none_or(|at| at <= fork)).map(|(t, k)| (*t, k.clone())).collect()
}
/// What to do with a payment the node reports at `height` while block `next` is read (see the module note).
#[derive(Debug, PartialEq, Eq)]
enum FactPlan {
    /// Above the block being read: not on this chain at this block. Not used, not kept.
    Later,
    /// In the block being read: that block must list it.
    InBlock,
    /// Below it: the node's block at `height` must list it, and the node's block at `anchor` must be the reader's own.
    /// `anchor` is the payment's height when the reader holds that block, else the first held height (the payment's block
    /// is then an ancestor of a held block), else, with no block held yet, the block being read.
    Check { anchor: u64 },
}
fn fact_plan(height: u64, next: u64, first_held: Option<u64>) -> FactPlan {
    if height > next {
        FactPlan::Later
    } else if height == next {
        FactPlan::InBlock
    } else {
        FactPlan::Check { anchor: first_held.map_or(next, |first| height.max(first)) }
    }
}
/// Whether the node's answers bind the payment to the reader's chain. `listed`: the node's block at the payment's height
/// lists the transaction. `node`: the hash of the node's block at `anchor`. `own`: the hash the reader holds for `anchor`.
/// An error fails the pass (it is tried again); it never refuses or accepts a claim.
fn fact_verified(txid: &[u8; 32], height: u64, anchor: u64, listed: bool, node: [u8; 32], own: Option<[u8; 32]>) -> Result<()> {
    ensure!(listed, "The node reports payment {} in block {height}, but its block {height} does not list it (the chain moved while it was asked, or the node is inconsistent); trying again", hex::encode(txid));
    let own = own.with_context(|| format!("Payment {} is in block {height}, and the reader holds no block {anchor} to check it against", hex::encode(txid)))?;
    ensure!(node == own, "The node's block {anchor} ({}…) is not the block this reader holds ({}…): payment {} cannot be placed on this chain yet; trying again", &hex::encode(node)[..16], &hex::encode(own)[..16], hex::encode(txid));
    Ok(())
}

fn txt<'a>(v: &'a J, k: &str) -> Result<&'a str> {
    v[k].as_str().context(format!("Text field {k}"))
}
#[derive(Serialize, Deserialize, Clone)]
struct BlockRow {
    height: u64,
    hash: String,
}
#[derive(Serialize, Deserialize, Clone)]
struct RecordRow {
    height: u64,
    txid: String,
    wire: String,
    /// The anchor key images this carrier spends (each already public in an earlier lot record); empty otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    anchors: Vec<String>,
}
/// First height at which lot records apply on this network (see the module note).
fn market_from(kind: &str) -> Option<u64> {
    if kind != "mainnet" {
        if let Ok(v) = std::env::var("XMR20_MARKET_FROM") {
            return if v == "off" { None } else { v.parse().ok() };
        }
    }
    core::market::activation(kind)
}
/// First height at which XW1 address moves apply (core `address::activation`); test chains may
/// override it with XMR20_ADDRESS_MOVES_FROM ("off" or a block height); mainnet ignores the override.
fn address_moves(kind: &str) -> Option<core::address::Activation> {
    if kind != "mainnet" {
        if let Ok(v) = std::env::var("XMR20_ADDRESS_MOVES_FROM") {
            let net = if kind == "stagenet" { core::address::STAGENET } else { core::address::MAINNET };
            return if v == "off" { None } else { v.parse().ok().map(|from| core::address::Activation { from, net }) };
        }
    }
    core::address::activation(kind)
}
fn move_record(wire: &[u8]) -> bool {
    wire.len() >= 4 && wire[..4] == core::address::MAGIC_MOVE[..]
}
/// First height at which XT1 applies (core `trade::activation`); test chains may override it with
/// XMR20_TRADES_FROM ("off" or a block height); mainnet ignores the override.
fn trades(kind: &str) -> Option<core::address::Activation> {
    if kind != "mainnet" {
        if let Ok(v) = std::env::var("XMR20_TRADES_FROM") {
            let net = if kind == "stagenet" { core::address::STAGENET } else { core::address::MAINNET };
            return if v == "off" { None } else { v.parse().ok().map(|from| core::address::Activation { from, net }) };
        }
    }
    core::trade::activation(kind)
}
fn trade_record(wire: &[u8]) -> bool {
    wire.len() >= 4 && wire[..4] == core::trade::MAGIC_TRADE[..]
}
fn new_pool(p: &Params) -> Pool {
    let mut pool = Pool::new(p.domain);
    pool.market_from = market_from(&p.manifest.network.kind);
    pool.address_moves = address_moves(&p.manifest.network.kind);
    pool.trades = trades(&p.manifest.network.kind);
    // Open deploys and XO1 from their opening block (core open.rs).
    pool.open = core::open::activation_from_env(&p.manifest.network.kind);
    pool
}
/// The carrier's input key images that anchor a live lot note (the only ones the market rules look at).
fn anchor_inputs(pool: &Pool, tx: &monero_wallet::transaction::Transaction<monero_wallet::transaction::Pruned>) -> Vec<String> {
    if pool.market_from.is_none() {
        return vec![];
    }
    let live: std::collections::BTreeSet<&String> = pool.notes.values().filter_map(|n| n.anchor.as_ref()).collect();
    tx.prefix().inputs.iter().filter_map(|i| match i { monero_wallet::transaction::Input::ToKey { key_image, .. } => Some(hex::encode(key_image.to_bytes())), _ => None }).filter(|k| live.contains(k)).collect()
}
fn lot_record(wire: &[u8]) -> bool {
    wire.len() >= 4 && (wire[..4] == core::market::MAGIC_ANCHORED[..] || wire[..4] == core::market::MAGIC_SALE[..])
}
fn hex_key_images(v: &[String]) -> Vec<[u8; 32]> {
    v.iter().filter_map(|h| hex::decode(h).ok()?.try_into().ok()).collect()
}
/// One payment to a relay fee subaddress, as found in a block.
#[derive(Serialize, Deserialize, Clone)]
struct PaymentRow {
    height: u64,
    txid: String,
    index: u32,
    amount: String,
}
struct RelayFees {
    view: monero_wallet::ViewPair,
    scanner: std::cell::RefCell<monero_wallet::Scanner>,
    network: monero_wallet::address::Network,
    primary: String,
    lookahead: u32,
}
fn relay_fees(kind: &str) -> Result<Option<RelayFees>> {
    let Ok(file) = std::env::var("XMR20_RELAY_FEES") else { return Ok(None) };
    let cfg: J = serde_json::from_slice(&fs::read(&file).with_context(|| format!("XMR20_RELAY_FEES {file}"))?)?;
    let network = match kind {
        "stagenet" => monero_wallet::address::Network::Stagenet,
        _ => monero_wallet::address::Network::Mainnet,
    };
    let addr = monero_wallet::address::MoneroAddress::from_str(network, cfg["address"].as_str().context("relay fees: address")?).map_err(|e| anyhow::anyhow!("relay fees address: {e:?}"))?;
    let v = hex::decode(cfg["viewKey"].as_str().context("relay fees: viewKey")?)?;
    let view = monero_wallet::ed25519::Scalar::read(&mut v.as_slice())?;
    let pair = monero_wallet::ViewPair::new(addr.spend(), zeroize::Zeroizing::new(view)).map_err(|e| anyhow::anyhow!("relay fees view pair: {e:?}"))?;
    ensure!(pair.view() == addr.view(), "relay fees: the view key does not belong to the address");
    let lookahead: u32 = std::env::var("XMR20_RELAY_FEES_LOOKAHEAD").ok().and_then(|v| v.parse().ok()).unwrap_or(5000);
    let mut scanner = monero_wallet::Scanner::new(pair.clone());
    for i in 1..=lookahead {
        scanner.register_subaddress(monero_wallet::address::SubaddressIndex::new(0, i).context("subaddress")?);
    }
    Ok(Some(RelayFees { primary: pair.legacy_address(network).to_string(), view: pair, scanner: std::cell::RefCell::new(scanner), network, lookahead }))
}
#[derive(Serialize, Deserialize, Clone)]
struct Meta {
    domain: String,
    manifest_sha256: String,
    network: String,
    genesis: String,
    start_height: u64,
    /// Open tokens: the opening this state was read under, "<first block>:<XMR721 ledger>"; absent when there was none.
    #[serde(default)]
    open: Option<String>,
}
#[derive(Clone, Serialize)]
struct RecordInfo {
    height: u64,
    txid: String,
    record: String,
    kind: J,
    error: Option<String>,
    detail: J,
}
/// The ledger view derived from the record log: the core pool and the record index. A block is applied to a copy of it, and
/// the copy replaces it only once the block is committed on disk (see `logs`).
#[derive(Clone)]
struct State {
    pool: Pool,
    index: BTreeMap<String, RecordInfo>,
    by_tx: BTreeMap<String, String>,
}
impl State {
    fn new(p: &Params) -> Self {
        Self { pool: new_pool(p), index: BTreeMap::new(), by_tx: BTreeMap::new() }
    }
    /// Rebuild from the record log (every record re-verified; results recomputed).
    fn rebuild(p: &Params, records: &[RecordRow], claim_payments: &KeptFacts) -> Self {
        Self::rebuild_at(p, records, claim_payments, &[]).0
    }
    /// The same rebuild, which also takes the state hash at the end of each block of `heights` (ascending): after every
    /// record at or below that height is applied and that block's claims are settled, before any later record.
    fn rebuild_at(p: &Params, records: &[RecordRow], claim_payments: &KeptFacts, heights: &[u64]) -> (Self, BTreeMap<u64, String>) {
        let mut st = Self::new(p);
        let mut hashes = BTreeMap::new();
        let mut todo = heights.iter().copied().peekable();
        // Every block of `todo` below `below` ends in the state `st` is in now (hashed once, however many blocks share it).
        let mut take = |st: &State, below: Option<u64>| {
            let mut hash: Option<String> = None;
            while let Some(h) = todo.next_if(|h| below.is_none_or(|b| *h < b)) {
                hashes.insert(h, hash.get_or_insert_with(|| hex::encode(st.pool.state_hash())).clone());
            }
        };
        let mut last = 0;
        for r in records {
            // A block's claims settle at its end, before the next block's records.
            if r.height > last {
                st.settle(last, claim_payments);
                take(&st, Some(r.height));
            }
            last = r.height;
            st.apply_row(r, p);
        }
        st.settle(last, claim_payments);
        take(&st, None);
        (st, hashes)
    }
    /// Settle the pool's pending claims of block `height` with the payment facts known at that block (`facts_at`); record
    /// results follow.
    fn settle(&mut self, height: u64, claim_payments: &KeptFacts) -> Vec<J> {
        if self.pool.pending_claims.is_empty() {
            return vec![];
        }
        let ids: Vec<String> = self.pool.pending_claims.iter().map(|c| hex::encode(core::hash(&c.wire))).collect();
        let out = self.pool.resolve_claims(height, &facts_at(claim_payments, height));
        for (id, r) in ids.iter().zip(&out) {
            if let Some(x) = self.index.get_mut(id) {
                x.record = r["record"].as_str().unwrap_or("?").into();
                x.error = r["error"].as_str().map(String::from);
                if !r["detail"].is_null() {
                    x.detail = r["detail"].clone();
                }
            }
        }
        out
    }
    fn apply_row(&mut self, r: &RecordRow, p: &Params) -> J {
        let wire = hex::decode(&r.wire).unwrap_or_default();
        let result = self.pool.apply_carrier(Some(&wire), &r.txid, r.height, &hex_key_images(&r.anchors), &p.vks);
        let id = hex::encode(core::hash(&wire));
        let info = RecordInfo { height: r.height, txid: r.txid.clone(), record: result["record"].as_str().unwrap_or("?").into(), kind: result["kind"].clone(), error: result["error"].as_str().map(String::from), detail: result["detail"].clone() };
        // a completed two-part operation also settles the counterpart recorded earlier
        if result["detail"]["completed"] == true {
            for k in ["part_a", "part_b"] {
                if let Some(other) = result["detail"]["completion"][k].as_str() {
                    if other != id {
                        if let Some(x) = self.index.get_mut(other) {
                            x.record = "accepted".into();
                            x.detail["completed"] = json!(true);
                            x.detail["completion"] = result["detail"]["completion"].clone();
                        }
                    }
                }
            }
        }
        self.index.insert(id.clone(), info);
        self.by_tx.insert(r.txid.clone(), id.clone());
        json!({"height":r.height,"txid":r.txid,"recordId":id,"result":result})
    }
}
/// Everything one block adds, prepared without touching the committed state.
struct Staged {
    block: BlockRow,
    hash: [u8; 32],
    records: Vec<RecordRow>,
    payments: Vec<PaymentRow>,
    facts: Vec<KeptFact>,
    /// The ledger view after this block; None when the block carries no record (the view is unchanged).
    state: Option<State>,
    applied: Vec<J>,
}
struct Follower {
    dir: PathBuf,
    logs: logs::Logs,
    blocks: Vec<BlockRow>,
    records: Vec<RecordRow>,
    st: State,
    events: Vec<J>,
    start: u64,
    payments: Vec<PaymentRow>,
    fees: Option<RelayFees>,
    /// Payments trade claims were settled with, each with the block it was learned at (claim-payments.jsonl; rebuilds
    /// settle with these, no node call).
    claim_payments: KeptFacts,
    /// Failure injection for the atomic-commit tests (offline test chain with XMR20_INDEXER_FAILPOINTS=1 only).
    fp: logs::Failpoints,
    failpoints_allowed: bool,
    /// Blocks whose sync failed before they were committed (nothing of them was kept).
    discarded: u64,
    last_discarded: Option<J>,
    /// What the last recovery of the state directory found and changed (open, or reload after a failed clean-up).
    recovery: J,
    /// The state hash at the end of every held block whose height is a multiple of STATE_HASH_EVERY (see the module note).
    state_hashes: BTreeMap<u64, String>,
    /// Kept state hashes that the rebuild from the record log did not reproduce (empty unless something is wrong).
    state_hash_differs: Vec<J>,
}
fn parse_rows<T: for<'a> Deserialize<'a>>(name: &str, lines: &[String]) -> Result<Vec<T>> {
    lines.iter().enumerate().map(|(i, l)| serde_json::from_str(l).with_context(|| format!("{name}:{}", i + 1))).collect()
}
fn lines_of<T: Serialize>(rows: &[T]) -> Result<Vec<String>> {
    rows.iter().map(|r| serde_json::to_string(r).map_err(Into::into)).collect()
}
fn report_json(r: &logs::Report) -> J {
    json!({"at":now(),"actions":r.actions,"warnings":r.warnings})
}
/// Append rows to a file of the state directory and make them durable (the file, and its directory entry).
fn append_durable(dir: &Path, name: &str, lines: &[String]) -> Result<()> {
    let mut f = fs::OpenOptions::new().create(true).append(true).open(dir.join(name))?;
    for l in lines {
        f.write_all(l.as_bytes())?;
        f.write_all(b"\n")?;
    }
    f.sync_all()?;
    fs::File::open(dir)?.sync_all()?;
    Ok(())
}
/// Create the state directory and make every directory entry on its path durable.
/// Whoever created the directories (this call, the service wrapper's mkdir, or an earlier start that was interrupted), each
/// directory on the resolved path is synced into its parent, from the state directory up to the root of the file system that
/// holds it: the walk stops at a mount point (its entry belongs to the mount, not to the parent file system) or at `/`. When the
/// configured path differs from the resolved one (a symlink on it), the configured path is walked the same way, so the
/// directory holding each symlink entry is synced too and a symlink created before the start is durable. This runs at every
/// start, before anything is committed, so entries an interrupted start left unsynced are synced too. A directory the service
/// cannot open for syncing is refused: the state directory must then live below directories it can open.
fn create_dir_durable(dir: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let real: PathBuf = dir.canonicalize().with_context(|| format!("resolving {}", dir.display()))?;
    let configured: PathBuf = if dir.is_absolute() { dir.to_path_buf() } else { std::env::current_dir()?.join(dir) };
    let sync = |parent: &Path| -> Result<()> {
        let refuse = |e: std::io::Error| anyhow::anyhow!("cannot sync {} to make the state directory {} durable ({e}); use a state directory whose parent directories the service can open", parent.display(), dir.display());
        fs::File::open(parent).map_err(refuse)?.sync_all().map_err(refuse)?;
        Ok(())
    };
    // the resolved path: each directory into its parent, up to the root of its file system
    let mut d: &Path = &real;
    while let Some(parent) = d.parent() {
        if fs::metadata(parent)?.dev() != fs::metadata(d)?.dev() {
            break;
        }
        sync(parent)?;
        d = parent;
    }
    // the configured path, when it differs: each entry (a symlink included) into the directory that holds it; an entry's own
    // device (not its target's) decides where the file system ends
    if configured != real {
        let mut d: &Path = &configured;
        while let Some(parent) = d.parent() {
            if fs::metadata(parent)?.dev() != d.symlink_metadata()?.dev() {
                break;
            }
            sync(parent)?;
            d = parent;
        }
    }
    Ok(())
}
impl Follower {
    fn open(dir: &Path, p: &Params) -> Result<Self> {
        create_dir_durable(dir)?;
        let meta_path = dir.join("meta.json");
        let meta = Meta { domain: p.config.domain.clone(), manifest_sha256: p.manifest_sha256.clone(), network: p.manifest.network.kind.clone(), genesis: p.manifest.network.genesis.clone(), start_height: p.manifest.network.start_height, open: core::open::activation_from_env(&p.manifest.network.kind).map(|a| format!("{}:{}", a.from, hex::encode(a.inscriptions))) };
        let mut stored_open: Option<Option<String>> = None;
        if meta_path.exists() {
            let old: Meta = serde_json::from_slice(&fs::read(&meta_path)?)?;
            ensure!(old.domain == meta.domain && old.genesis == meta.genesis && old.network == meta.network, "State directory {} belongs to another ledger (domain {}…) — refusing to mix", dir.display(), &old.domain[..16]);
            if old.manifest_sha256 != meta.manifest_sha256 {
                eprintln!("note: trusted manifest changed (same ledger domain); continuing the stored state");
            }
            stored_open = Some(old.open);
        } else {
            logs::write_atomic(dir, "meta.json", &serde_json::to_vec_pretty(&meta)?)?;
        }
        let fees = relay_fees(&p.manifest.network.kind)?;
        let failpoints_allowed = std::env::var("XMR20_INDEXER_FAILPOINTS").as_deref() == Ok("1") && p.manifest.network.kind == "offline-fakechain";
        let (logs, loaded) = logs::Logs::open(dir, false)?;
        if !loaded.report.actions.is_empty() || !loaded.report.warnings.is_empty() {
            eprintln!("state recovery: {}", report_json(&loaded.report));
        }
        let mut f = Self { dir: dir.to_path_buf(), logs, blocks: vec![], records: vec![], st: State::new(p), events: vec![], start: p.manifest.network.start_height.max(1), payments: vec![], fees, claim_payments: BTreeMap::new(), fp: logs::Failpoints::default(), failpoints_allowed, discarded: 0, last_discarded: None, recovery: J::Null, state_hashes: BTreeMap::new(), state_hash_differs: vec![] };
        f.load(loaded, p)?;
        // Open tokens: stored blocks were read under the stored opening. Another one is taken only when it changes nothing
        // about them: there was none, and the new one starts above the stored tip. Otherwise the blocks must be read again.
        if let Some(old) = stored_open {
            if old != meta.open {
                let tip = f.tip().map(|b| b.height);
                let above = core::open::activation_from_env(&p.manifest.network.kind).is_some_and(|a| tip.map_or(true, |t| t < a.from));
                ensure!(old.is_none() && above, "State directory {} was read under another opening of open tokens ({}; now {}) — start a new state directory", dir.display(), old.as_deref().unwrap_or("none"), meta.open.as_deref().unwrap_or("none"));
                logs::write_atomic(dir, "meta.json", &serde_json::to_vec_pretty(&meta)?)?;
            }
        }
        f.check_kept_state_hashes();
        Ok(f)
    }
    /// Take the recovered rows as the committed state and rebuild the ledger view from them.
    fn load(&mut self, loaded: logs::Loaded, p: &Params) -> Result<()> {
        self.blocks = parse_rows(logs::BLOCKS, &loaded.blocks)?;
        self.records = parse_rows(logs::RECORDS, &loaded.records)?;
        self.payments = parse_rows(logs::PAYMENTS, &loaded.payments)?;
        let facts: Vec<J> = parse_rows(logs::CLAIMS, &loaded.claims)?;
        self.claim_payments = facts_from_rows(&facts)?;
        self.rebuild(p);
        if !loaded.report.actions.is_empty() || !loaded.report.warnings.is_empty() {
            self.events.push(json!({"at":now(),"event":"state-recovery","detail":report_json(&loaded.report)}));
        }
        self.recovery = report_json(&loaded.report);
        Ok(())
    }
    /// Recover the state directory as on open (after a failed clean-up or an interrupted reorganisation).
    fn reload(&mut self, p: &Params) -> Result<()> {
        let (logs, loaded) = logs::Logs::open(&self.dir, false)?;
        self.logs = logs;
        self.load(loaded, p)?;
        self.check_kept_state_hashes();
        Ok(())
    }
    fn tip(&self) -> Option<&BlockRow> {
        self.blocks.last()
    }
    /// Rebuild the ledger view from the committed rows, with the state hash of every held block that has one.
    fn rebuild(&mut self, p: &Params) {
        let heights: Vec<u64> = self.blocks.iter().map(|b| b.height).filter(|h| h % STATE_HASH_EVERY == 0).collect();
        let (st, hashes) = State::rebuild_at(p, &self.records, &self.claim_payments, &heights);
        self.st = st;
        self.state_hashes = hashes;
    }
    /// The hash this reader holds for the block at `height`, if it holds that block.
    fn block_hash_at(&self, height: u64) -> Option<[u8; 32]> {
        let first = self.blocks.first()?.height;
        let b = self.blocks.get(usize::try_from(height.checked_sub(first)?).ok()?).filter(|b| b.height == height)?;
        hex::decode(&b.hash).ok()?.try_into().ok()
    }
    fn state_hash_rows(&self) -> Vec<StateHashRow> {
        let hash_of: BTreeMap<u64, &String> = self.blocks.iter().filter(|b| b.height % STATE_HASH_EVERY == 0).map(|b| (b.height, &b.hash)).collect();
        self.state_hashes.iter().filter_map(|(h, s)| Some(StateHashRow { height: *h, block_hash: (*hash_of.get(h)?).clone(), state_hash: s.clone() })).collect()
    }
    /// Write state-hashes.json from the hashes held now. The file is a note for the next start's comparison, not state: a
    /// failure to write it is reported and stops nothing.
    fn save_state_hashes(&mut self) {
        let file = StateHashFile { every: STATE_HASH_EVERY, hashes: self.state_hash_rows() };
        let written = serde_json::to_vec(&file).map_err(anyhow::Error::from).and_then(|b| logs::write_atomic(&self.dir, STATE_HASHES, &b));
        if let Err(e) = written {
            self.events.push(json!({"at":now(),"event":"state-hashes-not-saved","detail":format!("{e:#}")}));
        }
    }
    /// After a start: compare the kept state hashes with the rebuilt ones (same block, by height and hash), report every
    /// difference, then keep the rebuilt ones. No file, an unreadable file or one of another interval compares nothing.
    fn check_kept_state_hashes(&mut self) {
        let now_rows = self.state_hash_rows();
        let path = self.dir.join(STATE_HASHES);
        let kept: Option<StateHashFile> = match fs::read(&path) {
            Ok(b) => match serde_json::from_slice(&b) {
                Ok(f) => Some(f),
                Err(e) => {
                    self.events.push(json!({"at":now(),"event":"state-hashes-unreadable","detail":e.to_string()}));
                    None
                }
            },
            Err(_) => None,
        };
        let kept_rows = kept.filter(|f| f.every == STATE_HASH_EVERY).map(|f| f.hashes);
        let mut differ = vec![];
        for k in kept_rows.iter().flatten() {
            if let Some(n) = now_rows.iter().find(|n| n.height == k.height && n.block_hash == k.block_hash) {
                if n.state_hash != k.state_hash {
                    differ.push(json!({"height":k.height,"blockHash":k.block_hash,"kept":k.state_hash,"rebuilt":n.state_hash,"found":now()}));
                }
            }
        }
        if !differ.is_empty() {
            // Written down before the kept hashes are replaced; if that fails the kept file stays as it is.
            let written = lines_of(&differ).and_then(|lines| append_durable(&self.dir, STATE_HASH_DIFFERENCES, &lines));
            for d in differ {
                eprintln!("state hash differs from the one kept for this block: {d}");
                self.events.push(json!({"at":now(),"event":"state-hash-differs","detail":d}));
                self.state_hash_differs.push(d);
            }
            if let Err(e) = written {
                self.events.push(json!({"at":now(),"event":"state-hash-differences-not-saved","detail":format!("{e:#}")}));
                return;
            }
        }
        if kept_rows.as_ref() != Some(&now_rows) {
            self.save_state_hashes();
        }
    }
    /// The ledger state hash of the newest state, with its sections (core `Pool::state_sections`).
    fn state_sections(&self) -> J {
        let sections = self.st.pool.state_sections();
        json!({"tip":self.tip().map(|b|b.height),"stateHash":hex::encode(core::pool::state_total(&sections)),"sections":sections.iter().map(|s| json!({"name":s.name,"count":s.count,"hash":hex::encode(s.hash)})).collect::<Vec<_>>()})
    }
    /// The checkpoint of a held block: the hash of the record list at or below it, and the state hash at its end when the
    /// height is one the state hash is taken at (null otherwise).
    fn checkpoint(&self, height: u64) -> Result<J> {
        let block = self.blocks.iter().rev().find(|b| b.height == height).context("Checkpoint height not held by this indexer")?.clone();
        let mut lines = String::new();
        let mut n = 0u64;
        for r in self.records.iter().filter(|r| r.height <= height) {
            lines.push_str(&format!("{}:{}\n", r.height, r.txid));
            n += 1;
        }
        Ok(json!({"height":height,"blockHash":block.hash,"records":n,"listHash":hex::encode(core::hash(lines.as_bytes())),"stateHash":self.state_hashes.get(&height),"tip":self.tip().map(|b|b.height)}))
    }
    /// Cut the committed state back to `fork_h` (the newest block this chain shares with the node's) and rebuild the view.
    fn roll_back(&mut self, p: &Params, fork_h: u64, previous_tip: u64) -> Result<J> {
        let blocks: Vec<BlockRow> = self.blocks.iter().filter(|b| b.height <= fork_h).cloned().collect();
        let records: Vec<RecordRow> = self.records.iter().filter(|r| r.height <= fork_h).cloned().collect();
        let payments: Vec<PaymentRow> = self.payments.iter().filter(|r| r.height <= fork_h).cloned().collect();
        let claims = facts_upto(&self.claim_payments, fork_h);
        let fork_hash = blocks.last().filter(|b| b.height == fork_h).map(|b| b.hash.clone());
        let facts: Vec<J> = claims.values().map(fact_row).collect();
        self.logs.reorg(fork_h, fork_hash.as_deref(), &lines_of(&blocks)?, &lines_of(&records)?, &lines_of(&payments)?, &lines_of(&facts)?, &self.fp)?;
        let removed_blocks = self.blocks.len() - blocks.len();
        let removed_records = self.records.len() - records.len();
        self.blocks = blocks;
        self.records = records;
        self.payments = payments;
        self.claim_payments = claims;
        // The view and its state hashes are rebuilt from what remains: a hash of a removed block is not held any more.
        self.rebuild(p);
        self.save_state_hashes();
        let reorg = json!({"forkHeight":fork_h,"previousTip":previous_tip,"removedBlocks":removed_blocks,"removedRecords":removed_records});
        self.events.push(json!({"at":now(),"event":"reorganisation","detail":reorg}));
        Ok(reorg)
    }
    fn note_discarded(&mut self, height: u64, e: &anyhow::Error) {
        self.discarded += 1;
        let d = json!({"at":now(),"height":height,"error":format!("{e:#}").chars().take(300).collect::<String>()});
        self.events.push(json!({"at":now(),"event":"block-discarded","detail":d}));
        self.last_discarded = Some(d);
    }
    /// Fetch block `next` and apply it to a copy of the ledger view. Nothing committed is touched (`&self`); an error here
    /// leaves no trace. None: the block does not extend the stored tip (the next sync's reorganisation check handles it).
    async fn stage_block(&self, rpc: &native::Rpc, p: &Params, next: u64, previous: [u8; 32]) -> Result<Option<Staged>> {
        self.fp.hit("fetch", next)?;
        let b = rpc.block_by_number(next as usize).await?;
        ensure!(b.number() == next as usize, "Daemon height mismatch");
        if b.header.previous != previous {
            return Ok(None);
        }
        self.fp.hit("expand", next)?;
        let scan = rpc.expand_to_scannable_block(b.clone()).await?;
        // Payments to the relay's one-time fee subaddresses (view key only).
        self.fp.hit("fees", next)?;
        let mut payments = vec![];
        if let Some(fees) = self.fees.as_ref() {
            let coinbase = b.miner_transaction().hash();
            for o in fees.scanner.borrow_mut().scan(scan.clone())?.ignore_additional_timelock() {
                let Some(si) = o.subaddress() else { continue };
                if si.account() != 0 || o.transaction() == coinbase {
                    continue;
                }
                payments.push(PaymentRow { height: next, txid: hex::encode(o.transaction()), index: si.address(), amount: o.commitment().amount.to_string() });
            }
        }
        let mut staged: Option<State> = None;
        let mut records = vec![];
        let mut applied = vec![];
        for (id, tx) in b.transactions.iter().zip(&scan.transactions) {
            if let Some(wire) = core::transport::wire_at(&tx.prefix().extra, self.st.pool.open, next) {
                let row = {
                    let pool = &staged.as_ref().unwrap_or(&self.st).pool;
                    // Below the activation height a lot record is not a record at all, exactly as for an indexer without the
                    // market rules (its framing refuses the unknown record type): not stored, not listed.
                    if lot_record(&wire) && !pool.market_from.is_some_and(|h| next >= h) {
                        continue;
                    }
                    // Likewise an address move below its activation height.
                    if move_record(&wire) && !pool.address_moves.is_some_and(|a| next >= a.from) {
                        continue;
                    }
                    // And a trade record below its activation height.
                    if trade_record(&wire) && !pool.trades.is_some_and(|a| next >= a.from) {
                        continue;
                    }
                    RecordRow { height: next, txid: hex::encode(id), wire: hex::encode(&wire), anchors: anchor_inputs(pool, tx) }
                };
                let st = staged.get_or_insert_with(|| self.st.clone());
                applied.push(st.apply_row(&row, p));
                records.push(row);
                self.fp.hit("apply", next)?;
            }
        }
        // This block's claims settle now, with their payments fetched from the node (kept for rebuilds).
        let mut facts = vec![];
        self.fp.hit("facts", next)?;
        if staged.as_ref().is_some_and(|s| !s.pool.pending_claims.is_empty()) || !self.st.pool.pending_claims.is_empty() {
            let st = staged.get_or_insert_with(|| self.st.clone());
            let want: Vec<[u8; 32]> = st.pool.claim_payments().into_iter().filter(|t| !self.claim_payments.contains_key(t)).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
            let fetched = native::payment_facts(rpc, &want).await?;
            let mut all = self.claim_payments.clone();
            let first_held = self.blocks.first().map(|x| x.height);
            for (txid, f) in fetched {
                // What the node says is bound to this reader's chain before it is used or kept (module note).
                match fact_plan(f.height, next, first_held) {
                    FactPlan::Later => continue,
                    FactPlan::InBlock => fact_verified(&txid, f.height, next, b.transactions.contains(&txid), b.hash(), Some(b.hash()))?,
                    FactPlan::Check { anchor } => {
                        let at_payment = rpc.block_by_number(f.height as usize).await?;
                        ensure!(at_payment.number() == f.height as usize, "Daemon height mismatch");
                        // the anchor is asked after the payment's block, so a chain that moved in between shows here
                        let node = if anchor == f.height { at_payment.hash() } else { rpc.block_by_number(anchor as usize).await?.hash() };
                        let own = if anchor == next { Some(b.hash()) } else { self.block_hash_at(anchor) };
                        fact_verified(&txid, f.height, anchor, at_payment.transactions.contains(&txid), node, own)?;
                    }
                }
                let kept = KeptFact { fact: f, at: Some(next) };
                all.insert(txid, kept.clone());
                facts.push(kept);
            }
            self.fp.hit("settle", next)?;
            for r in st.settle(next, &all) {
                applied.push(json!({"height":next,"txid":r["txid"],"result":r}));
            }
        } else {
            self.fp.hit("settle", next)?;
        }
        let hash = b.hash();
        Ok(Some(Staged { block: BlockRow { height: next, hash: hex::encode(hash) }, hash, records, payments, facts, state: staged, applied }))
    }
    /// Commit a staged block: its rows on disk (atomically, see `logs`), then the in-memory view. On error nothing of it stays.
    fn commit(&mut self, s: Staged) -> Result<Vec<J>> {
        let facts: Vec<J> = s.facts.iter().map(fact_row).collect();
        let note = self.logs.commit_block(s.block.height, &serde_json::to_string(&s.block)?, &lines_of(&s.records)?, &lines_of(&s.payments)?, &lines_of(&facts)?, &self.fp)?;
        if let Some(n) = note {
            self.events.push(json!({"at":now(),"event":"commit-note","detail":n}));
        }
        let height = s.block.height;
        self.blocks.push(s.block);
        self.records.extend(s.records);
        self.payments.extend(s.payments);
        for f in s.facts {
            self.claim_payments.insert(f.fact.txid, f);
        }
        if let Some(st) = s.state {
            self.st = st;
        }
        // The block is committed and `st` is the ledger at its end (records applied, claims settled).
        if height % STATE_HASH_EVERY == 0 {
            self.state_hashes.insert(height, hex::encode(self.st.pool.state_hash()));
            self.save_state_hashes();
        }
        Ok(s.applied)
    }
    /// Incremental sync: detect a reorganisation at the stored tip, truncate, then fetch, stage and commit new blocks one by one.
    /// A block either commits completely (log rows, block row, ledger view) or leaves the committed state exactly as before.
    async fn sync(&mut self, rpc: &native::Rpc, p: &Params, max_blocks: usize) -> Result<J> {
        if self.logs.reload_required {
            self.reload(p).context("Recovering the state directory after an earlier failure")?;
        }
        native::guard(rpc, &p.manifest.network.kind).await?;
        ensure!(hex::encode(rpc.block_by_number(0).await?.hash()) == p.config.chain, "Wrong chain");
        let daemon_tip = rpc.latest_block_number().await? as u64;
        let mut reorg = J::Null;
        // 1. reorganisation check: walk back from the stored tip until a stored hash equals the daemon's hash at that height
        if let Some(t) = self.tip().cloned() {
            let mut fork: Option<u64> = None;
            let mut depth = 0usize;
            let mut h = t.height.min(daemon_tip);
            loop {
                let stored = self.blocks.iter().rev().find(|b| b.height == h);
                let Some(stored) = stored else { break };
                let live = hex::encode(rpc.block_by_number(h as usize).await?.hash());
                if live == stored.hash {
                    fork = Some(h);
                    break;
                }
                depth += 1;
                if h == self.start - 1 || h == 0 || depth > 10_000 {
                    break;
                }
                h -= 1;
            }
            let fork_h = fork.unwrap_or(self.start - 1);
            if fork_h < t.height {
                reorg = self.roll_back(p, fork_h, t.height)?;
            }
        }
        // 2. fetch forward
        let mut next = self.tip().map(|b| b.height + 1).unwrap_or(self.start);
        let mut previous = match self.tip() {
            Some(b) => hex::decode(&b.hash)?.try_into().map_err(|_| anyhow::anyhow!("hash"))?,
            None => {
                if next >= 1 {
                    rpc.block_by_number(next as usize - 1).await?.hash()
                } else {
                    [0u8; 32]
                }
            }
        };
        let mut applied = vec![];
        let mut fetched = 0usize;
        while next <= daemon_tip && fetched < max_blocks {
            let staged = match self.stage_block(rpc, p, next, previous).await {
                Ok(s) => s,
                Err(e) => {
                    self.note_discarded(next, &e);
                    return Err(e);
                }
            };
            let Some(staged) = staged else {
                // the chain moved under us: stop here, the next sync's reorganisation check sorts it out
                self.events.push(json!({"at":now(),"event":"previous-hash-mismatch","height":next}));
                break;
            };
            let hash = staged.hash;
            match self.commit(staged) {
                Ok(mut out) => applied.append(&mut out),
                Err(e) => {
                    self.note_discarded(next, &e);
                    return Err(e);
                }
            }
            previous = hash;
            next += 1;
            fetched += 1;
        }
        Ok(json!({"tip":self.tip().map(|b|b.height),"tipHash":self.tip().map(|b|b.hash.clone()),"daemonTip":daemon_tip,"behind":daemon_tip.saturating_sub(self.tip().map(|b|b.height).unwrap_or(self.start-1)),"fetched":fetched,"applied":applied,"reorg":reorg}))
    }
    fn status(&self, p: &Params) -> J {
        let (ok, rows) = self.st.pool.invariant();
        let lens = self.logs.committed();
        json!({"tip":self.tip().map(|b|b.height),"tipHash":self.tip().map(|b|b.hash.clone()),"startHeight":self.start,"blocks":self.blocks.len(),"records":self.records.len(),"network":p.manifest.network.kind,"domain":p.config.domain,"manifestSha256":p.manifest_sha256,"invariant":{"ok":ok,"rows":rows},"pendingParts":self.st.pool.pending_records,"completedOperations":self.st.pool.completed.len(),"events":self.events.len(),
            "stateHashes":{"every":STATE_HASH_EVERY,"held":self.state_hashes.len(),"last":self.state_hashes.iter().next_back().map(|(h,s)|json!({"height":h,"stateHash":s})),"differFromKept":self.state_hash_differs},
            "commit":{"atomic":true,"discardedBlocks":self.discarded,"lastDiscarded":self.last_discarded,"reloadRequired":self.logs.reload_required,"stalePending":self.logs.stale_pending,"stalePendingHeight":self.logs.stale_height,"journals":journals(&self.dir),"recovery":self.recovery,"committedBytes":lens}})
    }
    fn confirmations(&self, height: u64) -> u64 {
        self.tip().map(|t| t.height + 1 - height).unwrap_or(0)
    }
}
/// Which recovery journals are on disk (a validation gate requires none).
fn journals(dir: &Path) -> J {
    json!({"commitPending":dir.join(logs::COMMIT_PENDING).exists(),"reorgPending":dir.join(logs::REORG_PENDING).exists()})
}
/// One state directory as recovery would load it, cut at `height` (rows above it are not compared).
struct View {
    tip: Option<u64>,
    blocks: Vec<BlockRow>,
    records: Vec<RecordRow>,
    payments: Vec<PaymentRow>,
    facts: KeptFacts,
    report: J,
}
fn view_of(dir: &Path) -> Result<View> {
    let journals = journals(dir);
    let (_, l) = logs::Logs::open(dir, true).with_context(|| format!("{}", dir.display()))?;
    let blocks: Vec<BlockRow> = parse_rows(logs::BLOCKS, &l.blocks)?;
    let facts: Vec<J> = parse_rows(logs::CLAIMS, &l.claims)?;
    Ok(View {
        tip: blocks.last().map(|b| b.height),
        records: parse_rows(logs::RECORDS, &l.records)?,
        payments: parse_rows(logs::PAYMENTS, &l.payments)?,
        facts: facts_from_rows(&facts)?,
        report: json!({"dir":dir.display().to_string(),"journals":journals,"recoveryWouldChange":l.report.actions,"warnings":l.report.warnings}),
        blocks,
    })
}
/// Rows of two lists that the other does not hold (each side in order), at most `limit` of each.
fn list_diff(a: &[String], b: &[String], limit: usize) -> J {
    let only = |x: &[String], y: &[String]| {
        let mut rest: BTreeMap<&String, usize> = BTreeMap::new();
        for r in y {
            *rest.entry(r).or_default() += 1;
        }
        let mut out = vec![];
        for r in x {
            match rest.get_mut(r) {
                Some(n) if *n > 0 => *n -= 1,
                _ => out.push(serde_json::from_str::<J>(r).unwrap_or(J::String(r.clone()))),
            }
        }
        let n = out.len();
        out.truncate(limit);
        json!({"count":n,"rows":out})
    };
    json!({"equal":a == b,"onlyInA":only(a, b),"onlyInB":only(b, a)})
}
/// `--compare-state`: see the module note. Prints the report; true when the two directories agree at the height.
fn compare_state(a: &Path, b: &Path, height: Option<u64>, params: Option<&Params>) -> Result<bool> {
    let (va, vb) = (view_of(a)?, view_of(b)?);
    let h = match height {
        Some(h) => h,
        None => va.tip.zip(vb.tip).map(|(x, y)| x.min(y)).context("both state directories need committed blocks")?,
    };
    let at = |v: &View| v.blocks.iter().find(|x| x.height == h).map(|x| x.hash.clone());
    let (ha, hb) = (at(&va), at(&vb));
    let mut out = json!({"height":h,"a":va.report,"b":vb.report,"blockHashA":ha,"blockHashB":hb});
    if ha.is_none() || hb.is_none() || ha != hb {
        out["comparable"] = json!(false);
        out["equal"] = json!(false);
        out["note"] = json!("both directories must hold the same block (height and hash) at the comparison height");
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(false);
    }
    let rows = |v: &View| -> Result<[Vec<String>; 4]> {
        // the payments themselves are compared; the block each was learned at shows in the ledger state rebuilt below
        let facts: Vec<J> = facts_upto(&v.facts, h).values().map(|k| core::trade::facts_to_json(&k.fact)).collect();
        Ok([
            lines_of(&v.blocks.iter().filter(|x| x.height <= h).collect::<Vec<_>>())?,
            lines_of(&v.records.iter().filter(|x| x.height <= h).collect::<Vec<_>>())?,
            lines_of(&v.payments.iter().filter(|x| x.height <= h).collect::<Vec<_>>())?,
            lines_of(&facts)?,
        ])
    };
    let (ra, rb) = (rows(&va)?, rows(&vb)?);
    let mut equal = true;
    let mut diff = serde_json::Map::new();
    for (i, name) in ["blocks", "records", "payments", "claimPayments"].iter().enumerate() {
        let d = list_diff(&ra[i], &rb[i], 20);
        equal &= d["equal"] == true;
        diff.insert(name.to_string(), d);
    }
    if let Some(p) = params {
        let state = |v: &View| {
            let recs: Vec<RecordRow> = v.records.iter().filter(|x| x.height <= h).cloned().collect();
            State::rebuild(p, &recs, &facts_upto(&v.facts, h))
        };
        let (sa, sb) = (state(&va), state(&vb));
        let (pa, pb) = (sa.pool.summary(), sb.pool.summary());
        let keys: Vec<&String> = pa.as_object().into_iter().flat_map(|o| o.keys()).filter(|k| pa[*k] != pb[*k]).collect();
        let (ia, ib) = (serde_json::to_value(&sa.index)?, serde_json::to_value(&sb.index)?);
        let ids: Vec<String> = sa.index.keys().chain(sb.index.keys()).filter(|k| ia[k.as_str()] != ib[k.as_str()]).cloned().collect::<std::collections::BTreeSet<_>>().into_iter().take(20).collect();
        let (xa, xb) = (sa.pool.state_sections(), sb.pool.state_sections());
        let sections: Vec<&str> = xa.iter().zip(&xb).filter(|(x, y)| x != y).map(|(x, _)| x.name).collect();
        let same = pa == pb && ia == ib && xa == xb;
        equal &= same;
        diff.insert("ledgerState".into(), json!({"equal":same,"poolSummaryKeysDiffer":keys,"recordResultsDiffer":ids,"stateHashA":hex::encode(core::pool::state_total(&xa)),"stateHashB":hex::encode(core::pool::state_total(&xb)),"stateSectionsDiffer":sections,"invariantA":pa["invariant"],"invariantB":pb["invariant"]}));
    } else {
        diff.insert("ledgerState".into(), json!({"compared":false,"note":"pass --params <dir> --trusted-manifest <file> to compare the rebuilt ledger state too"}));
    }
    out["comparable"] = json!(true);
    out["equal"] = json!(equal);
    out["differences"] = J::Object(diff);
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(equal)
}
fn now() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    format!("{}", d.as_secs())
}
async fn dispatch(f: &mut Follower, rpc: &native::Rpc, p: &Params, q: &J) -> Result<J> {
    match txt(q, "op")? {
        "sync" => f.sync(rpc, p, q["maxBlocks"].as_u64().unwrap_or(500) as usize).await,
        "status" => Ok(f.status(p)),
        "summary" => Ok(json!({"tip":f.tip().map(|b|b.height),"state":f.st.pool.summary(),"stateHash":hex::encode(f.st.pool.state_hash())})),
        // The state hash of the newest state with the hash of each of its sections, to find where two readers differ.
        "stateSections" => Ok(f.state_sections()),
        "owner" => {
            let o: [u8; 32] = hex::decode(txt(q, "owner")?)?.try_into().map_err(|_| anyhow::anyhow!("owner key"))?;
            owner_vk(&o)?;
            let notes = f.st.pool.notes_of_owner(&o);
            Ok(json!({"owner":hex::encode(o),"balances":f.st.pool.public_balances(&o).iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),"notes":notes.iter().map(|(id,n)|json!({"id":id,"asset":n.asset,"amount":n.amount.to_string(),"height":n.height,"txid":n.txid,"confirmations":f.confirmations(n.height)})).collect::<Vec<_>>(),"tip":f.tip().map(|b|b.height)}))
        }
        "record" => {
            let id = txt(q, "id")?;
            Ok(match f.st.index.get(id) {
                Some(r) => json!({"found":true,"recordId":id,"height":r.height,"txid":r.txid,"record":r.record,"kind":r.kind,"error":r.error,"detail":r.detail,"confirmations":f.confirmations(r.height)}),
                None => json!({"found":false,"recordId":id}),
            })
        }
        "tx" => {
            let txid = txt(q, "txid")?;
            Ok(match f.st.by_tx.get(txid).and_then(|id| f.st.index.get(id).map(|r| (id.clone(), r.clone()))) {
                Some((id, r)) => json!({"found":true,"txid":txid,"recordId":id,"height":r.height,"record":r.record,"kind":r.kind,"error":r.error,"detail":r.detail,"confirmations":f.confirmations(r.height)}),
                None => json!({"found":false,"txid":txid}),
            })
        }
        "verify" => {
            let wire = hex::decode(txt(q, "wire")?)?;
            let mut candidate = f.st.pool.clone();
            // Optional `inputs`: the carrier's input key images (needed only to move an anchored lot; not stored).
            let inputs: Vec<String> = q["inputs"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
            Ok(candidate.apply_carrier(Some(&wire), &hex::encode([0u8; 32]), f.tip().map(|b| b.height + 1).unwrap_or(1), &hex_key_images(&inputs), &p.vks))
        }
        // Explicit viewing access: shielded balances for a full viewing key handed over by the holder. Nothing is stored.
        "view" => {
            let fvk = FullViewingKey::from_str(txt(q, "viewingKey")?).map_err(|e| anyhow::anyhow!("Viewing key: {e}"))?;
            Ok(json!({"balances":f.st.pool.shielded_balances(&fvk).iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),"notes":f.st.pool.ledger.unspent_notes(&fvk).len(),"tip":f.tip().map(|b|b.height)}))
        }
        "events" => Ok(json!({"events":f.events})),
        // Failure injection for the atomic-commit tests: offline test chain with XMR20_INDEXER_FAILPOINTS=1 only.
        "failpoint" => {
            ensure!(f.failpoints_allowed, "Failure injection is off (offline test chain with XMR20_INDEXER_FAILPOINTS=1 only)");
            f.fp.set(q)
        }
        // Holdings of a Monero address and the relay's prepare/finalize steps (core Pool::address_op).
        "addressOwner" | "addressHoldings" | "addressMovePrepare" | "addressMoveFinalize" => f.st.pool.address_op(q, &p.vks, f.tip().map(|b| b.height + 1).unwrap_or(1)),
        // Lots, holdings and the relay's prepare/finalize steps (core Pool::trade_op).
        "tradeLots" | "tradeLot" | "tradeHoldings" | "tradeListPrepare" | "tradeCancelPrepare" | "tradeReservePrepare" | "tradeFinalize" | "tradeClaimRecord" => f.st.pool.trade_op(q, &p.vks, f.tip().map(|b| b.height + 1).unwrap_or(1)),
        // A claim as the relay would post it: the payment fetched from this node and checked exactly as every reader will.
        "tradeClaimVerify" => {
            let next = f.tip().map(|b| b.height + 1).unwrap_or(1);
            let wire = f.st.pool.trade_op(&json!({"op":"tradeClaimRecord","lot":q["lot"],"txid":q["txid"],"keys":q["keys"]}), &p.vks, next)?["wire"].clone();
            let txid: [u8; 32] = hex::decode(txt(q, "txid")?)?.try_into().map_err(|_| anyhow::anyhow!("txid"))?;
            let facts = native::payment_facts(rpc, &[txid]).await?;
            let Some(fx) = facts.get(&txid) else { return Ok(json!({"ok":false,"waiting":true,"error":"The payment is not in a block yet (or not on this chain)"})) };
            match f.st.pool.trade_op(&json!({"op":"tradeClaimCheck","wire":wire,"payment":core::trade::facts_to_json(fx)}), &p.vks, next) {
                Ok(d) => Ok(json!({"ok":true,"wire":wire,"detail":d,"paymentHeight":fx.height})),
                Err(e) => Ok(json!({"ok":false,"wire":wire,"error":e.to_string(),"paymentHeight":fx.height})),
            }
        }
        // Open tokens: the tokens anyone deployed, with how much of each is minted (core Pool::open_view), in the order they were deployed.
        "openTokens" => {
            let mut tokens = f.st.pool.open_view();
            tokens.sort_by_key(|t| t["number"].as_u64());
            Ok(json!({"tip":f.tip().map(|b|b.height),"from":f.st.pool.open.map(|a|a.from),"ledger":f.st.pool.open.map(|a|hex::encode(a.inscriptions)),"tokens":tokens}))
        }
        "tradeRules" => Ok(json!({"network":p.manifest.network.kind,"active":f.st.pool.trades.map(|a|a.from),"builtIn":core::trade::activation(&p.manifest.network.kind).map(|a|a.from),"maxReserve":core::trade::MAX_RESERVE})),
        // The transactions that carry XMR20 records, in chain order, so a wallet can rebuild the token
        // ledger from them (it fetches each from the node itself and re-checks every record) instead of every block; and the
        // checkpoint of that list at a height: listHash = SHA-256 over "height:txid\n" lines of every listed transaction at or
        // below it. The list is exactly what every reader applies (lots and address moves only from their start blocks).
        // stateHash = the hash of the whole ledger state at the end of that block (every 720th block; see the module note).
        "recordTxs" => {
            let from = q["from"].as_u64().unwrap_or(0);
            let tip = f.tip().context("Indexer has no blocks yet")?.clone();
            let txs: Vec<J> = f.records.iter().filter(|r| r.height >= from).map(|r| json!({"height":r.height,"txid":r.txid})).collect();
            // Open tokens: a list written with the open-token rules says so, as the wallet engine's saved progress does.
            Ok(json!({"tip":tip.height,"tipHash":tip.hash,"from":from,"txs":txs,"rules":f.st.pool.open.map(|_| "open-tokens-1")}))
        }
        "checkpoint" => f.checkpoint(q["height"].as_u64().context("height")?),
        "relayFees" => Ok(match &f.fees { Some(x) => json!({"configured":true,"primary":x.primary,"lookahead":x.lookahead}), None => json!({"configured":false}) }),
        "relayFeeAddress" => {
            let x = f.fees.as_ref().context("Relay fees are not configured")?;
            let i = q["index"].as_u64().context("index")? as u32;
            ensure!(i >= 1 && i <= x.lookahead, "Fee subaddress index out of range (1..={})", x.lookahead);
            Ok(json!({"index":i,"address":x.view.subaddress(x.network, monero_wallet::address::SubaddressIndex::new(0, i).context("index")?).to_string()}))
        }
        "relayPayments" => {
            ensure!(f.fees.is_some(), "Relay fees are not configured");
            let tip = f.tip().map(|b| b.height).unwrap_or(0);
            let want = q["index"].as_u64().map(|v| v as u32);
            let rows: Vec<J> = f.payments.iter().filter(|r| want.is_none_or(|w| r.index == w)).map(|r| json!({"height":r.height,"txid":r.txid,"index":r.index,"amount":r.amount,"confirmations":tip + 1 - r.height})).collect();
            Ok(json!({"tip":tip,"payments":rows}))
        }
        "addressRules" => Ok(json!({"network":p.manifest.network.kind,"active":f.st.pool.address_moves.map(|a|a.from),"builtIn":core::address::activation(&p.manifest.network.kind).map(|a|a.from)})),
        "marketRules" => Ok(json!({"network":p.manifest.network.kind,"marketFrom":f.st.pool.market_from,"builtIn":core::market::activation(&p.manifest.network.kind),"lots":f.st.pool.notes.values().filter(|n| n.anchor.is_some()).count()})),
        "records" => {
            let from = q["from"].as_u64().unwrap_or(0);
            let rows: Vec<J> = f.st.index.iter().filter(|(_, r)| r.height >= from).map(|(id, r)| json!({"recordId":id,"height":r.height,"txid":r.txid,"record":r.record,"kind":r.kind,"confirmations":f.confirmations(r.height)})).collect();
            Ok(json!({"records":rows}))
        }
        "publishBlob" => {
            native::guard(rpc, &p.manifest.network.kind).await?;
            let tx = native::decode(txt(q, "blob")?)?;
            rpc.publish_transaction(&tx).await?;
            Ok(json!({"txid":hex::encode(tx.hash())}))
        }
        "asset" => {
            let id = core::asset_for_mint(txt(q, "mint")?)?;
            Ok(json!({"asset":hex::encode(id.to_bytes())}))
        }
        other => anyhow::bail!("Unknown indexer op {other}"),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    // Operator check (read-only): what recovery would change in a state directory, e.g. a copy of the live one before an upgrade.
    let cli: Vec<String> = std::env::args().collect();
    let flag = |k: &str| cli.iter().position(|a| a == k).and_then(|i| cli.get(i + 1).cloned());
    if let Some(dir) = flag("--check-state") {
        let journals = journals(Path::new(&dir));
        let (_, loaded) = logs::Logs::open(Path::new(&dir), true)?;
        let tip = loaded.blocks.last().map(|l| serde_json::from_str::<J>(l)).transpose()?;
        let clean = loaded.report.actions.is_empty() && loaded.report.warnings.is_empty();
        println!("{}", serde_json::to_string_pretty(&json!({"stateDir":dir,"tip":tip,"blocks":loaded.blocks.len(),"records":loaded.records.len(),"payments":loaded.payments.len(),"claimPayments":loaded.claims.len(),"journals":journals,"wouldChange":loaded.report.actions,"warnings":loaded.report.warnings,"clean":clean,"note":"clean means recovery would change nothing; it says nothing about whether the rows match the chain (use --compare-state against a clean replay)"}))?);
        return Ok(());
    }
    // Journal-aware recovery of a stopped indexer's directory (for example before an older binary reads it).
    if let Some(dir) = flag("--recover-state") {
        let (_, loaded) = logs::Logs::open(Path::new(&dir), false)?;
        let tip = loaded.blocks.last().map(|l| serde_json::from_str::<J>(l)).transpose()?;
        println!("{}", serde_json::to_string_pretty(&json!({"stateDir":dir,"tip":tip,"blocks":loaded.blocks.len(),"records":loaded.records.len(),"changed":loaded.report.actions,"warnings":loaded.report.warnings,"journals":journals(Path::new(&dir))}))?);
        return Ok(());
    }
    if let Some(i) = cli.iter().position(|a| a == "--compare-state") {
        let a = cli.get(i + 1).context("--compare-state <dir a> <dir b>")?;
        let b = cli.get(i + 2).context("--compare-state <dir a> <dir b>")?;
        let height = flag("--height").map(|h| h.parse::<u64>()).transpose().context("--height")?;
        let params = match (flag("--params"), flag("--trusted-manifest")) {
            (Some(d), Some(t)) => Some(Params::load(Path::new(&d), false, Path::new(&t))?),
            (None, None) => None,
            _ => anyhow::bail!("--params and --trusted-manifest go together"),
        };
        let equal = compare_state(Path::new(a), Path::new(b), height, params.as_ref())?;
        std::process::exit(if equal { 0 } else { 1 });
    }
    ensure!(std::env::var("XMR20_INTEGRATION_LAB").as_deref() == Ok("offline-synthetic-only") || std::env::var("XMR20_INDEXER_SERVICE").as_deref() == Ok("1"), "Set XMR20_INDEXER_SERVICE=1 (or the lab variable) to run");
    let args: Vec<String> = std::env::args().collect();
    let dir = Path::new(args.get(1).context("parameter directory")?);
    let arg = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1).cloned());
    let trusted = arg("--trusted-manifest").context("--trusted-manifest <path> is required")?;
    let state = arg("--state").context("--state <dir> is required")?;
    let p = Params::load(dir, false, Path::new(&trusted))?;
    let mut rpc = native::rpc(&p.manifest.network.kind).await?;
    {
        let genesis = hex::encode(rpc.block_by_number(0).await?.hash());
        ensure!(genesis == p.manifest.network.genesis, "Daemon genesis {}… is not the trusted manifest's network {}…", &genesis[..16], &p.manifest.network.genesis[..16]);
    }
    let mut f = Follower::open(Path::new(&state), &p)?;
    println!("{}", json!({"ready":true,"mode":"indexer-service","domain":p.config.domain,"network":p.manifest.network.kind,"trustedManifest":{"label":p.manifest.label,"sha256":p.manifest_sha256},"state":{"dir":state,"tip":f.tip().map(|b|b.height),"blocks":f.blocks.len(),"records":f.records.len()}}));
    let stdout = io::stdout();
    for line in io::stdin().lock().lines() {
        let line = line?;
        ensure!(line.len() < 2_000_000);
        let q: J = serde_json::from_str(&line)?;
        if q["op"] == "close" {
            break;
        }
        let mut attempt = dispatch(&mut f, &rpc, &p, &q).await;
        if attempt.as_ref().is_err_and(|e| e.to_string().contains("interface error")) {
            if let Ok(fresh) = native::rpc(&p.manifest.network.kind).await {
                rpc = fresh;
                attempt = dispatch(&mut f, &rpc, &p, &q).await;
            }
        }
        let out = match attempt {
            Ok(result) => json!({"result":result}),
            Err(e) => json!({"error":e.to_string()}),
        };
        let mut lock = stdout.lock();
        lock.write_all(out.to_string().as_bytes())?;
        lock.write_all(b"\n")?;
        lock.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn tmpdir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("xmr20-state-dir-{}-{}-{}", name, std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()))
    }

    /// Nested state directories are created whether or not they exist already (created earlier by the wrapper or an
    /// interrupted start); a second call changes nothing.
    #[test]
    fn state_directory_is_created_and_synced_up_the_path() {
        let root = tmpdir("nested");
        let state = root.join("a/b/state");
        create_dir_durable(&state).unwrap();
        assert!(state.is_dir());
        let other = root.join("c/d/state");
        fs::create_dir_all(&other).unwrap();
        create_dir_durable(&other).unwrap();
        create_dir_durable(&state).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    /// A configured path through a symlink (made just before the start) is created and opened through the symlink; a second
    /// call changes nothing. The durability of the symlink entry itself is not covered by this test.
    #[test]
    fn symlinked_state_path_is_created_through_the_link() {
        let root = tmpdir("symlink");
        fs::create_dir_all(root.join("data/a")).unwrap();
        fs::create_dir_all(root.join("cfg")).unwrap();
        std::os::unix::fs::symlink(root.join("data/a"), root.join("cfg/link")).unwrap();
        let state = root.join("cfg/link/b/state");
        create_dir_durable(&state).unwrap();
        assert!(root.join("data/a/b/state").is_dir());
        create_dir_durable(&state).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    /// A parent directory the service cannot open for syncing is refused with a clear error, not skipped.
    #[test]
    fn unopenable_parent_is_refused() {
        let root = tmpdir("refuse");
        let state = root.join("locked/state");
        fs::create_dir_all(&state).unwrap();
        let locked = root.join("locked");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o311)).unwrap();
        let r = create_dir_durable(&state);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        let e = format!("{:#}", r.expect_err("a parent that cannot be opened must be refused"));
        assert!(e.contains("cannot sync") && e.contains("locked"), "{e}");
        fs::remove_dir_all(root).unwrap();
    }

    // ---------------------------------------------------------------- state hashes
    use decaf377_rdsa::{SigningKey, SpendAuth, VerificationKey};

    /// The offline test chain's parameters with an issuer key made here, so the tests can write credits (nothing is proved,
    /// so no proving key is read).
    fn test_params() -> (Params, SigningKey<SpendAuth>) {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../params/test-v2");
        let (manifest, manifest_sha256) = xmr20_unshielded_lab::chain::read_manifest(&dir.join("manifest.json")).unwrap();
        let issuer = SigningKey::<SpendAuth>::from(decaf377::Fr::from(7u64));
        let mut config = manifest.config.clone();
        config.issuer_vk = hex::encode(VerificationKey::from(&issuer).to_bytes());
        config.domain = hex::encode(config.computed_domain().unwrap());
        let domain = config.domain().unwrap();
        let vks = core::pool::Vks { spend: core::penumbra::read_vk(core::penumbra::Circuit::Spend, &config.spend_vk).unwrap(), output: core::penumbra::read_vk(core::penumbra::Circuit::Output, &config.output_vk).unwrap(), issuer: VerificationKey::from(&issuer) };
        (Params { manifest, manifest_sha256, config, domain, spend_pk: None, output_pk: None, vks }, issuer)
    }
    /// One block, applied and committed the way `stage_block` and `commit` do it: its records go to a copy of the view, its
    /// claims are settled with the kept facts and the ones `learned` at this block (what the node gave and the reader
    /// bound to its chain), then rows and view are committed. `salt` makes the block hash (another salt = another chain).
    /// Returns the results of the settled claims.
    fn push_block_with(f: &mut Follower, p: &Params, height: u64, salt: &str, wires: &[Vec<u8>], learned: &[core::trade::PaymentFacts]) -> Vec<J> {
        let mut state: Option<State> = None;
        let (mut records, mut applied) = (vec![], vec![]);
        for (i, w) in wires.iter().enumerate() {
            let row = RecordRow { height, txid: hex::encode(core::hash(format!("tx {height} {i} {salt}").as_bytes())), wire: hex::encode(w), anchors: vec![] };
            let st = state.get_or_insert_with(|| f.st.clone());
            let r = st.apply_row(&row, p);
            assert!(r["result"]["record"] == "accepted" || r["result"]["record"] == "pending", "{r}");
            applied.push(r);
            records.push(row);
        }
        let facts: Vec<KeptFact> = learned.iter().map(|x| KeptFact { fact: x.clone(), at: Some(height) }).collect();
        let mut settled = vec![];
        if let Some(st) = state.as_mut() {
            let mut all = f.claim_payments.clone();
            all.extend(facts.iter().map(|k| (k.fact.txid, k.clone())));
            settled = st.settle(height, &all);
        }
        let hash = core::hash(format!("block {height} {salt}").as_bytes());
        f.commit(Staged { block: BlockRow { height, hash: hex::encode(hash) }, hash, records, payments: vec![], facts, state, applied }).unwrap();
        settled
    }
    fn push_block(f: &mut Follower, p: &Params, height: u64, salt: &str, wires: &[Vec<u8>]) {
        push_block_with(f, p, height, salt, wires, &[]);
    }
    fn kept_file(dir: &Path) -> StateHashFile {
        serde_json::from_slice(&fs::read(dir.join(STATE_HASHES)).unwrap()).unwrap()
    }
    fn tip_hash(f: &Follower) -> String {
        hex::encode(f.st.pool.state_hash())
    }

    /// The state hash is taken at the end of every 720th block (that block's own records included, later ones not), is the
    /// same after a restart, whether or not the hashes were kept on disk, and a rollback drops the hashes of removed blocks.
    #[test]
    fn state_hashes_at_every_720th_block_survive_restart_and_rollback() {
        let (p, issuer) = test_params();
        let dir = tmpdir("state-hashes");
        let asset = core::asset_for_mint("TestMint1111111111111111111111111111111111").unwrap();
        let (ska, skb) = (core::keys::owner_signing_key(&[5; 32], 0), core::keys::owner_signing_key(&[6; 32], 0));
        let (a, b) = (core::keys::owner_key(&ska), core::keys::owner_key(&skb));
        let credit = |owner: [u8; 32], amount: u64, n: u8| core::public::Credit::build(core::public::KIND_DEPOSIT, asset, amount, owner, [n; 32], &issuer, &p.domain).unwrap().encode();
        let mut f = Follower::open(&dir, &p).unwrap();
        assert!(f.state_hashes.is_empty());
        let empty = tip_hash(&f);
        push_block(&mut f, &p, 718, "x", &[credit(a, 1000, 1)]);
        push_block(&mut f, &p, 719, "x", &[credit(b, 500, 2)]);
        let before_720 = tip_hash(&f);
        assert!(f.state_hashes.is_empty(), "719 is not a checkpoint block");
        // the checkpoint block's own record is part of its state hash
        let notes: Vec<[u8; 32]> = f.st.pool.notes_of_owner(&a).iter().map(|(id, _)| hex::decode(id).unwrap().try_into().unwrap()).collect();
        let outs = vec![core::PublicOutput { owner: b, amount: 300 }, core::PublicOutput { owner: a, amount: 700 }];
        let transfer = core::public::Transfer::build(asset, notes, outs, &ska, &p.domain).unwrap().encode();
        push_block(&mut f, &p, 720, "x", &[transfer]);
        let at_720 = tip_hash(&f);
        assert_ne!(at_720, before_720);
        assert_ne!(at_720, empty);
        assert_eq!(f.state_hashes, BTreeMap::from([(720, at_720.clone())]));
        // a later record is not
        push_block(&mut f, &p, 721, "x", &[credit(a, 50, 3)]);
        let after_721 = tip_hash(&f);
        assert_ne!(after_721, at_720);
        assert_eq!(f.state_hashes[&720], at_720);
        for h in 722..=1440 {
            push_block(&mut f, &p, h, "x", &[]);
        }
        push_block(&mut f, &p, 1441, "x", &[credit(b, 9, 4)]);
        let live = f.state_hashes.clone();
        assert_eq!(live, BTreeMap::from([(720, at_720.clone()), (1440, after_721.clone())]), "a block without records ends in the state before it");
        let live_tip = tip_hash(&f);
        assert_ne!(live_tip, after_721);
        // the checkpoint answer carries the hash for these blocks and null for any other
        let c = f.checkpoint(1440).unwrap();
        assert_eq!(c["stateHash"], after_721.as_str());
        assert_eq!(c["records"], 4);
        assert!(f.checkpoint(1439).unwrap()["stateHash"].is_null());
        assert!(f.checkpoint(1442).is_err(), "a block that is not held has no checkpoint");
        let sections = f.state_sections();
        assert_eq!(sections["stateHash"], live_tip.as_str());
        assert_eq!(sections["sections"].as_array().unwrap().len(), 21);
        assert_eq!(f.status(&p)["stateHashes"]["held"], 2);
        // kept on disk with the block each belongs to
        let kept = kept_file(&dir);
        assert_eq!(kept.every, 720);
        assert_eq!(kept.hashes, vec![StateHashRow { height: 720, block_hash: hex::encode(core::hash(b"block 720 x")), state_hash: at_720.clone() }, StateHashRow { height: 1440, block_hash: hex::encode(core::hash(b"block 1440 x")), state_hash: after_721.clone() }]);
        drop(f);

        // restart: the view and the hashes are rebuilt from the record log and equal the ones taken while reading
        let f = Follower::open(&dir, &p).unwrap();
        assert_eq!(f.state_hashes, live);
        assert_eq!(tip_hash(&f), live_tip);
        assert!(f.state_hash_differs.is_empty());
        drop(f);
        // a directory written by a build that kept no hashes (no file), and one with a file of another shape, load the same
        for other in [None, Some("{}"), Some("not json"), Some(r#"{"every":100,"hashes":[{"height":700,"blockHash":"00","stateHash":"00"}]}"#)] {
            match other {
                None => fs::remove_file(dir.join(STATE_HASHES)).unwrap(),
                Some(text) => fs::write(dir.join(STATE_HASHES), text).unwrap(),
            }
            let f = Follower::open(&dir, &p).unwrap();
            assert_eq!(f.state_hashes, live, "{other:?}");
            assert!(f.state_hash_differs.is_empty(), "{other:?}");
            assert_eq!(kept_file(&dir).hashes.len(), 2, "written again from the rebuilt hashes");
        }
        // a kept hash that the rebuild does not reproduce is reported; the rebuilt one is what the reader answers with
        let mut wrong = kept_file(&dir);
        wrong.hashes[0].state_hash = "00".repeat(32);
        wrong.hashes.push(StateHashRow { height: 2160, block_hash: "11".repeat(32), state_hash: "22".repeat(32) });
        fs::write(dir.join(STATE_HASHES), serde_json::to_vec(&wrong).unwrap()).unwrap();
        let f = Follower::open(&dir, &p).unwrap();
        assert_eq!(f.state_hashes, live);
        assert_eq!(f.state_hash_differs.len(), 1, "the row of a block that is not held is dropped without a report");
        assert_eq!(f.state_hash_differs[0]["height"], 720);
        assert_eq!(f.state_hash_differs[0]["rebuilt"], at_720.as_str());
        assert_eq!(kept_file(&dir).hashes, f.state_hash_rows());
        // and written down where a later start does not replace it
        let noted = fs::read_to_string(dir.join(STATE_HASH_DIFFERENCES)).unwrap();
        let rows: Vec<J> = noted.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0]["height"].as_u64(), rows[0]["kept"].as_str(), rows[0]["rebuilt"].as_str()), (Some(720), Some("00".repeat(32).as_str()), Some(at_720.as_str())));
        assert_eq!(rows[0]["blockHash"], hex::encode(core::hash(b"block 720 x")));
        drop(f);
        let mut f = Follower::open(&dir, &p).unwrap();
        assert!(f.state_hash_differs.is_empty());
        assert_eq!(fs::read_to_string(dir.join(STATE_HASH_DIFFERENCES)).unwrap(), noted, "a start without a difference adds nothing");

        // rollback below a checkpoint block: its hash is dropped, the earlier one stays, the state is the one at the fork
        let r = f.roll_back(&p, 1000, 1441).unwrap();
        assert_eq!(r["removedBlocks"], 441);
        assert_eq!(f.state_hashes, BTreeMap::from([(720, at_720.clone())]));
        assert_eq!(tip_hash(&f), after_721);
        assert_eq!(kept_file(&dir).hashes.len(), 1);
        assert!(f.checkpoint(1440).is_err());
        // the other branch carries another record: block 1440 now ends in another state
        for h in 1001..=1440 {
            push_block(&mut f, &p, h, "y", &if h == 1200 { vec![credit(b, 77, 5)] } else { vec![] });
        }
        let branch = f.state_hashes.clone();
        assert_eq!(branch[&720], at_720);
        assert_ne!(branch[&1440], live[&1440]);
        assert_eq!(branch[&1440], tip_hash(&f));
        assert_eq!(kept_file(&dir).hashes[1].block_hash, hex::encode(core::hash(b"block 1440 y")));
        drop(f);
        let mut f = Follower::open(&dir, &p).unwrap();
        assert_eq!(f.state_hashes, branch);
        assert!(f.state_hash_differs.is_empty());
        // rollback to a checkpoint block itself keeps its hash; below the first one nothing is held
        f.roll_back(&p, 720, 1440).unwrap();
        assert_eq!(f.state_hashes, BTreeMap::from([(720, at_720.clone())]));
        assert_eq!(tip_hash(&f), at_720);
        f.roll_back(&p, 719, 720).unwrap();
        assert!(f.state_hashes.is_empty());
        assert_eq!(tip_hash(&f), before_720);
        assert!(kept_file(&dir).hashes.is_empty());
        drop(f);
        fs::remove_dir_all(dir).unwrap();
    }

    /// The rebuild takes each hash after the records of that block and before any later record, for every height asked,
    /// and is the plain rebuild when none is asked.
    #[test]
    fn rebuild_takes_state_hashes_at_block_ends() {
        let (p, issuer) = test_params();
        let asset = core::asset_for_mint("TestMint1111111111111111111111111111111111").unwrap();
        let owner = core::keys::owner_key(&core::keys::owner_signing_key(&[5; 32], 0));
        let row = |height: u64, n: u8| RecordRow { height, txid: hex::encode([n; 32]), wire: hex::encode(core::public::Credit::build(core::public::KIND_DEPOSIT, asset, 10, owner, [n; 32], &issuer, &p.domain).unwrap().encode()), anchors: vec![] };
        let records = vec![row(10, 1), row(720, 2), row(720, 3), row(721, 4), row(2000, 5)];
        let none = BTreeMap::new();
        let upto = |h: u64| {
            let part: Vec<RecordRow> = records.iter().filter(|r| r.height <= h).cloned().collect();
            hex::encode(State::rebuild(&p, &part, &none).pool.state_hash())
        };
        let (st, hashes) = State::rebuild_at(&p, &records, &none, &[0, 720, 1440, 2160, 2880]);
        assert_eq!(hashes, BTreeMap::from([(0, upto(0)), (720, upto(720)), (1440, upto(1440)), (2160, upto(2160)), (2880, upto(2880))]));
        assert_eq!(hashes[&0], hex::encode(State::new(&p).pool.state_hash()));
        assert_ne!(hashes[&720], upto(719));
        assert_eq!(hashes[&1440], upto(721));
        assert_eq!(hashes[&2160], hashes[&2880]);
        assert_eq!(hex::encode(st.pool.state_hash()), upto(2000));
        assert_eq!(st.pool.accepted, 5);
        let plain = State::rebuild(&p, &records, &none);
        assert_eq!(plain.pool.state_sections(), st.pool.state_sections());
        assert_eq!(serde_json::to_value(&plain.index).unwrap(), serde_json::to_value(&st.index).unwrap());
    }

    // ---------------------------------------------------------------- claim payments
    /// A payment the node places above the block being read is not used; one at or below it is used only when the node's
    /// blocks tie it to the chain the reader holds.
    #[test]
    fn a_fetched_payment_is_bound_to_the_readers_chain() {
        // where the node's answer has to be checked
        assert_eq!(fact_plan(721, 720, Some(700)), FactPlan::Later);
        assert_eq!(fact_plan(720, 720, Some(700)), FactPlan::InBlock);
        assert_eq!(fact_plan(720, 720, None), FactPlan::InBlock);
        assert_eq!(fact_plan(719, 720, Some(700)), FactPlan::Check { anchor: 719 });
        assert_eq!(fact_plan(700, 720, Some(700)), FactPlan::Check { anchor: 700 });
        // below the first held block: the first held block stands for its ancestors
        assert_eq!(fact_plan(650, 720, Some(700)), FactPlan::Check { anchor: 700 });
        assert_eq!(fact_plan(1, 720, Some(700)), FactPlan::Check { anchor: 700 });
        // nothing held yet (the first block is being read): the block being read does
        assert_eq!(fact_plan(650, 720, None), FactPlan::Check { anchor: 720 });
        // the check itself
        let (t, ours, other) = ([1u8; 32], [2u8; 32], [3u8; 32]);
        fact_verified(&t, 710, 710, true, ours, Some(ours)).unwrap();
        let e = fact_verified(&t, 710, 710, false, ours, Some(ours)).unwrap_err().to_string();
        assert!(e.contains("does not list it"), "{e}");
        let e = fact_verified(&t, 710, 710, true, other, Some(ours)).unwrap_err().to_string();
        assert!(e.contains("is not the block this reader holds"), "{e}");
        let e = fact_verified(&t, 650, 700, true, ours, None).unwrap_err().to_string();
        assert!(e.contains("holds no block 700"), "{e}");
        // The case of a payment that leaves the chain: a claim in block 720 names a payment the node has in 721. It is not
        // kept, so when the node's block 721 is replaced and a claim in the new 722 names it again, the node is asked again
        // and whatever it says then is checked against the blocks read by then.
        assert_eq!(fact_plan(721, 720, Some(700)), FactPlan::Later);
        assert_eq!(fact_plan(723, 722, Some(700)), FactPlan::Later);
        assert_eq!(fact_plan(721, 722, Some(700)), FactPlan::Check { anchor: 721 });
        assert!(fact_verified(&t, 721, 721, true, other, Some(ours)).is_err(), "the node's 721 is not the 721 this reader read");
    }

    fn fact(n: u8, height: u64) -> core::trade::PaymentFacts {
        core::trade::PaymentFacts { txid: [n; 32], height, outputs: vec![core::trade::PaymentOutput { key: [n; 32], ecdh: [n; 8], commitment: [n; 32] }] }
    }
    /// A kept fact is available from the block it was learned at; a row without that block (an earlier build's) at every
    /// block; a build that does not know the field reads the row as the fact.
    #[test]
    fn kept_facts_carry_the_block_they_were_learned_at() {
        let kept: KeptFacts = [KeptFact { fact: fact(1, 700), at: Some(720) }, KeptFact { fact: fact(2, 710), at: None }, KeptFact { fact: fact(3, 730), at: Some(730) }].into_iter().map(|k| (k.fact.txid, k)).collect();
        let known = |h: u64| facts_at(&kept, h).keys().map(|t| t[0]).collect::<Vec<_>>();
        assert_eq!(known(719), [2]);
        assert_eq!(known(720), [1, 2]);
        assert_eq!(known(730), [1, 2, 3]);
        let left = |fork: u64| facts_upto(&kept, fork).keys().map(|t| t[0]).collect::<Vec<_>>();
        assert_eq!(left(705), Vec::<u8>::new());
        assert_eq!(left(719), [2], "a payment below the fork that was learned above it is learned again");
        assert_eq!(left(720), [1, 2]);
        assert_eq!(left(1000), [1, 2, 3]);
        for k in kept.values() {
            let row = fact_row(k);
            assert_eq!(row["at"].as_u64(), k.at);
            assert_eq!(row.as_object().unwrap().contains_key("at"), k.at.is_some());
            assert_eq!(&fact_from_row(&row).unwrap(), k);
            assert_eq!(core::trade::facts_from_json(&row).unwrap(), k.fact, "the core's reader, which an earlier build uses, takes the row");
            assert_eq!(fact_from_row(&core::trade::facts_to_json(&k.fact)).unwrap().at, None);
        }
    }

    /// Claims in the reader: one settled inside a 720th block is part of that block's state hash; a claim refused because
    /// its payment was not known yet stays refused when the view is rebuilt after the payment became known; a rollback drops
    /// what was learned above the fork.
    #[test]
    fn claims_settle_with_what_was_known_at_their_block() {
        let (p, _) = test_params();
        let fx: J = serde_json::from_slice(&fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../core/src/trade_claim_fixture.json")).unwrap()).unwrap();
        assert_eq!(fx["domain"], p.config.domain, "the fixture is of this test ledger");
        let wire = |k: &str| hex::decode(fx[k]["wire"].as_str().unwrap()).unwrap();
        let h32 = |v: &J| -> [u8; 32] { hex::decode(v.as_str().unwrap()).unwrap().try_into().unwrap() };
        let payment = core::trade::facts_from_json(&fx["payment"]).unwrap();
        assert_eq!(payment.height, 720);
        let lot = h32(&fx["lot"]);
        let claim = core::trade::Body::Claim { lot, txid: payment.txid, keys: fx["claimKeys"].as_array().unwrap().iter().map(h32).collect() }.bytes();
        let start = |f: &mut Follower| {
            push_block(f, &p, 718, "x", &[wire("credit")]);
            push_block(f, &p, 719, "x", &[wire("list"), wire("reserve")]);
        };
        let sold = |f: &Follower| f.st.pool.lots[&lot].claim.is_some();

        // the payment is known when the claim's block is read: the sale is in the state hash of block 720
        let dir = tmpdir("claim-known");
        let mut f = Follower::open(&dir, &p).unwrap();
        start(&mut f);
        let before = tip_hash(&f);
        let r = push_block_with(&mut f, &p, 720, "x", &[claim.clone()], &[payment.clone()]);
        assert_eq!(r[0]["record"], "accepted", "{r:?}");
        assert!(sold(&f) && f.st.pool.pending_claims.is_empty());
        let sold_at_720 = tip_hash(&f);
        assert_ne!(sold_at_720, before);
        assert_eq!(f.state_hashes, BTreeMap::from([(720, sold_at_720.clone())]));
        assert_eq!(f.claim_payments[&payment.txid].at, Some(720));
        let row: J = serde_json::from_str(fs::read_to_string(dir.join(logs::CLAIMS)).unwrap().trim()).unwrap();
        assert_eq!(row["at"], 720);
        assert_eq!(core::trade::facts_from_json(&row).unwrap(), payment);
        drop(f);
        let mut f = Follower::open(&dir, &p).unwrap();
        assert_eq!(f.state_hashes, BTreeMap::from([(720, sold_at_720.clone())]));
        assert!(sold(&f) && f.state_hash_differs.is_empty());
        f.roll_back(&p, 719, 720).unwrap();
        assert!(f.claim_payments.is_empty() && !sold(&f) && f.state_hashes.is_empty());
        assert_eq!(tip_hash(&f), before);
        drop(f);
        fs::remove_dir_all(dir).unwrap();

        // the payment is not known at block 720 (the node did not give it): the claim is refused there, and the same claim
        // in block 721, when the node gives it, is accepted
        let dir = tmpdir("claim-later");
        let mut f = Follower::open(&dir, &p).unwrap();
        start(&mut f);
        assert_eq!(tip_hash(&f), before);
        let r = push_block_with(&mut f, &p, 720, "x", &[claim.clone()], &[]);
        assert_eq!(r[0]["record"], "rejected", "{r:?}");
        assert!(r[0]["error"].as_str().unwrap().contains("not on this chain"));
        assert_eq!(f.state_hashes, BTreeMap::from([(720, before.clone())]), "a refused claim leaves the state as it was");
        let r = push_block_with(&mut f, &p, 721, "x", &[claim.clone()], &[payment.clone()]);
        assert_eq!(r[0]["record"], "accepted", "{r:?}");
        let sold_at_721 = tip_hash(&f);
        assert_ne!(sold_at_721, sold_at_720, "sold in another block");
        assert_eq!(f.claim_payments[&payment.txid].at, Some(721));
        drop(f);
        // rebuilt: block 720 is settled without the fact learned at 721, as it was when it was read
        let mut f = Follower::open(&dir, &p).unwrap();
        assert_eq!(f.state_hashes, BTreeMap::from([(720, before.clone())]));
        assert_eq!(tip_hash(&f), sold_at_721);
        assert!(f.state_hash_differs.is_empty());
        assert_eq!(f.st.pool.lots[&lot].claim.as_ref().unwrap().height, 721);
        // a rollback to block 720 drops the fact (learned above the fork, though the payment is in block 720)
        f.roll_back(&p, 720, 721).unwrap();
        assert!(f.claim_payments.is_empty() && !sold(&f));
        assert_eq!(fs::read_to_string(dir.join(logs::CLAIMS)).unwrap(), "");
        assert_eq!(tip_hash(&f), before);
        let r = push_block_with(&mut f, &p, 721, "x", &[claim.clone()], &[payment.clone()]);
        assert_eq!(r[0]["record"], "accepted");
        assert_eq!(tip_hash(&f), sold_at_721);
        drop(f);
        // A row without the block it was learned at, as an earlier build wrote it, is available at every block: a rebuild
        // then settles the claim of block 720 with it. The kept state hash of block 720 shows the difference, and it is noted.
        let legacy = core::trade::facts_to_json(&payment).to_string() + "\n";
        fs::write(dir.join(logs::CLAIMS), legacy).unwrap();
        let f = Follower::open(&dir, &p).unwrap();
        assert_eq!(f.claim_payments[&payment.txid].at, None);
        assert_eq!(f.st.pool.lots[&lot].claim.as_ref().unwrap().height, 720);
        assert_eq!(f.state_hashes[&720], sold_at_720);
        assert_eq!(f.state_hash_differs.len(), 1);
        let noted: J = serde_json::from_str(fs::read_to_string(dir.join(STATE_HASH_DIFFERENCES)).unwrap().trim()).unwrap();
        assert_eq!((noted["height"].as_u64(), noted["kept"].as_str(), noted["rebuilt"].as_str()), (Some(720), Some(before.as_str()), Some(sold_at_720.as_str())));
        drop(f);
        fs::remove_dir_all(dir).unwrap();
    }
}
