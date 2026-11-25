//! Ordinary native carrier transactions built privately inside their owner.
//! One input, two outputs (1 piconero self-payment plus change), normal gamma
//! decoy sampling from the trusted local offline daemon. Synthetic keys only.
use anyhow::{ensure, Context, Result};
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT as G, scalar::Scalar as DS};
use monero_simple_request_rpc::{prelude::MoneroDaemon, SimpleRequestTransport};
use monero_wallet::{
    address::{MoneroAddress, Network},
    ed25519::{Point, Scalar},
    interface::{prelude::*, FeeRate},
    ringct::RctType,
    send::{Change, SignableTransaction},
    transaction::{Input, Transaction},
    OutputWithDecoys, Scanner, ViewPair, WalletOutput,
};
use rand_core::{OsRng, RngCore};
use serde_json::Value as J;
use std::collections::{BTreeMap, BTreeSet};
use zeroize::Zeroizing;
pub type Rpc = MoneroDaemon<SimpleRequestTransport>;
pub const RPC_PORT: u16 = 30011;
pub fn rpc_port() -> u16 {
    std::env::var("XMR20_INTEGRATION_RPC_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .filter(|p: &u16| *p >= 30000)
        .unwrap_or(RPC_PORT)
}
// The daemon URL: XMR20_INTEGRATION_RPC_URL (for example the operator's own stagenet node) or the loopback
// fakechain port. The expected network comes from the trusted manifest and is enforced by `guard`.
pub fn rpc_url() -> String {
    std::env::var("XMR20_INTEGRATION_RPC_URL").ok().filter(|u| u.starts_with("http://") || u.starts_with("https://")).unwrap_or_else(|| format!("http://127.0.0.1:{}", rpc_port()))
}
pub async fn rpc(network: &str) -> Result<Rpc> {
    let r = SimpleRequestTransport::new(rpc_url()).await?;
    guard(&r, network).await?;
    Ok(r)
}
// Explicit network selection. "offline-fakechain": offline zero-peer regtest fakechain.
// "stagenet": a stagenet daemon with NORMAL validation (online allowed). "mainnet": see below. Testnet and anything
// else are refused.
pub async fn guard(r: &Rpc, network: &str) -> Result<J> {
    let j: J = serde_json::from_str(&r.json_rpc_call("get_info", None, 8192).await?)?;
    let is_mainnet = j["mainnet"] == true || j["nettype"] == "mainnet";
    // A mainnet daemon is accepted only when the TRUSTED manifest says mainnet AND
    // the process was started with XMR20_MAINNET_PILOT=I-UNDERSTAND. Otherwise a mainnet daemon is refused.
    let pilot = std::env::var("XMR20_MAINNET_PILOT").map(|v| v == "I-UNDERSTAND").unwrap_or(false);
    ensure!(!is_mainnet || (network == "mainnet" && pilot), "Mainnet daemon refused: the trusted manifest must say mainnet and XMR20_MAINNET_PILOT=I-UNDERSTAND must be set");
    match network {
        "offline-fakechain" => ensure!(
            j["nettype"] == "fakechain" && j["offline"] == true && j["incoming_connections_count"] == 0 && j["outgoing_connections_count"] == 0,
            "Offline zero-peer fakechain required (daemon reports nettype {}, offline {})",
            j["nettype"],
            j["offline"]
        ),
        "stagenet" => ensure!(j["nettype"] == "stagenet" && j["stagenet"] == true, "Stagenet daemon required by the trusted manifest (daemon reports nettype {})", j["nettype"]),
        "mainnet" => ensure!(pilot && is_mainnet && j["synchronized"] == true, "Mainnet pilot: XMR20_MAINNET_PILOT=I-UNDERSTAND and a synchronized mainnet daemon are required (daemon reports nettype {})", j["nettype"]),
        other => anyhow::bail!("Unsupported network {other:?} in the trusted manifest"),
    }
    Ok(j)
}
pub fn images<P: monero_wallet::transaction::PotentiallyPruned>(
    tx: &Transaction<P>,
) -> Vec<[u8; 32]> {
    tx.prefix()
        .inputs
        .iter()
        .filter_map(|i| match i {
            Input::ToKey { key_image, .. } => Some(key_image.to_bytes()),
            _ => None,
        })
        .collect()
}
fn random() -> Scalar {
    Scalar::random(&mut OsRng)
}
fn seed() -> Zeroizing<[u8; 32]> {
    let mut b = [0; 32];
    OsRng.fill_bytes(&mut b);
    Zeroizing::new(b)
}
fn image(sk: Scalar) -> [u8; 32] {
    let s: DS = sk.into();
    Point::from(Point::biased_hash((G * s).compress().to_bytes()).into() * s)
        .compress()
        .to_bytes()
}
pub fn fee(tx: &Transaction) -> Result<u64> {
    match tx {
        Transaction::V2 {
            proofs: Some(p), ..
        } => Ok(p.base.fee),
        _ => anyhow::bail!("RingCT required"),
    }
}
pub fn decode(blob: &str) -> Result<Transaction> {
    ensure!(blob.len() < 32768, "Bounded native blob");
    let b = hex::decode(blob)?;
    let mut cursor = b.as_slice();
    let tx = Transaction::read(&mut cursor)?;
    ensure!(
        cursor.is_empty() && tx.serialize() == b,
        "Canonical native transaction"
    );
    Ok(tx)
}
pub struct Wallet {
    spend: Zeroizing<Scalar>,
    view: ViewPair,
    view_secret: Zeroizing<Scalar>,
    owned: BTreeMap<[u8; 32], WalletOutput>,
    // Every output this wallet ever received, including spent ones: a legacy
    // entitlement keyed by a spent output must still be claimable.
    history: BTreeMap<[u8; 32], WalletOutput>,
    // Inputs used by any carrier this process built, kept for the process
    // lifetime so a rollback cannot make a conflicting carrier reuse them.
    spent: BTreeSet<[u8; 32]>,
    // Network selection and pool start height, remembered from the last `refresh` so that `single` re-scans
    // under the same explicit network (set by the trusted manifest, never by the daemon).
    network: String,
    start_height: usize,
    // Consensus spend locks (found on stagenet, invisible on the deterministic fakechain): an output received
    // at height h is spendable from block h+10 (coinbase h+60). Keyed by key image; `tip` is the last scanned block.
    maturity: BTreeMap<[u8; 32], (usize, bool)>,
    tip: usize,
}
impl Wallet {
    pub fn new() -> Self {
        Self::from_scalars(random(), random())
    }
    fn from_scalars(s: Scalar, v: Scalar) -> Self {
        let d: DS = s.into();
        Self {
            spend: Zeroizing::new(s),
            view: ViewPair::new(Point::from(G * d), Zeroizing::new(v)).unwrap(),
            view_secret: Zeroizing::new(v),
            owned: BTreeMap::new(),
            history: BTreeMap::new(),
            spent: BTreeSet::new(),
            network: String::from("offline-fakechain"),
            start_height: 0,
            maturity: BTreeMap::new(),
            tip: 0,
        }
    }
    // SYNTHETIC keys only: used by the crash/restore tests. Never for a real wallet.
    pub fn from_secrets(spend: [u8; 32], view: [u8; 32]) -> Result<Self> {
        let s = Scalar::read(&mut spend.as_slice())?;
        let v = Scalar::read(&mut view.as_slice())?;
        Ok(Self::from_scalars(s, v))
    }
    pub fn secrets(&self) -> ([u8; 32], [u8; 32]) {
        ((*self.spend).into().to_bytes(), (*self.view_secret).into().to_bytes())
    }
    pub fn address(&self) -> MoneroAddress {
        self.view.legacy_address(Network::Mainnet)
    }
    // Address formatted for the explicitly selected network: stagenet prefix for "stagenet", the mainnet
    // prefix otherwise (the offline regtest fakechain uses mainnet-format addresses).
    pub fn address_for(&self, network: &str) -> MoneroAddress {
        self.view.legacy_address(if network == "stagenet" { Network::Stagenet } else { Network::Mainnet })
    }
    fn secret(&self, o: &WalletOutput) -> Scalar {
        let a: DS = (*self.spend).into();
        let b: DS = o.key_offset().into();
        Scalar::from(a + b)
    }
    pub async fn refresh(&mut self, r: &Rpc, network: &str, start_height: usize) -> Result<()> {
        guard(r, network).await?;
        self.network = network.to_string();
        self.start_height = start_height;
        let tip = r.latest_block_number().await?;
        let tip_hash = r.block_by_number(tip).await?.hash();
        let first = start_height.max(1);
        // A start height above the tip simply means nothing is scanned yet (the pool begins in the future).
        let mut previous = if first <= tip { r.block_by_number(first - 1).await?.hash() } else { [0u8; 32] };
        let mut recovered = BTreeMap::new();
        let mut maturity = BTreeMap::new();
        for h in first..=tip {
            let b = r.block_by_number(h).await?;
            ensure!(
                b.number() == h && b.header.previous == previous,
                "Native chain changed during scan"
            );
            previous = b.hash();
            let coinbase_txid = b.miner_transaction().hash();
            let scan = r.expand_to_scannable_block(b).await?;
            for tx in &scan.transactions {
                for i in images(tx) {
                    recovered.remove(&i);
                }
            }
            for o in Scanner::new(self.view.clone())
                .scan(scan)?
                .additional_timelock_satisfied_by(tip, 0)
            {
                let ki = image(self.secret(&o));
                maturity.insert(ki, (h, o.transaction() == coinbase_txid));
                self.history.insert(o.key().compress().to_bytes(), o.clone());
                recovered.insert(ki, o);
            }
        }
        // As in chain.rs: the replayed chain must end at the snapshot tip.
        if first <= tip {
            ensure!(previous == tip_hash, "Inconsistent canonical chain snapshot: the replayed tip differs from the snapshot tip; retry");
        }
        ensure!(
            r.block_by_number(tip).await?.hash() == tip_hash,
            "Native chain changed during scan; retry"
        );
        // `spent` is deliberately never pruned: a rollback can return an output
        // this process already used in a carrier that may still be rebroadcast.
        self.owned = recovered;
        self.maturity = maturity;
        self.tip = tip;
        Ok(())
    }
    // Monero's consensus spend lock: spendable in block tip+1 when tip + 1 >= h + 10 (coinbase: + 60).
    fn mature(&self, ki: &[u8; 32]) -> bool {
        match self.maturity.get(ki) {
            Some((h, coinbase)) => self.tip + 1 >= h + if *coinbase { 60 } else { 10 },
            None => false,
        }
    }
    // The wallet's own one-time output keys (public data the owner already
    // knows) with amounts. Used to build legacy lots from REAL wallet outputs.
    pub fn owned_outputs(&self) -> Vec<(String, u64)> {
        self.owned
            .values()
            .map(|o| (hex::encode(o.key().compress().to_bytes()), o.commitment().amount))
            .collect()
    }
    // x = spend + key_offset for the owned output with public key P, exactly
    // the wallet's own derivation. Returned only to the in-process signer.
    pub fn output_secret(&self, key: [u8; 32]) -> Option<DS> {
        self.history.get(&key).map(|o| self.secret(o).into())
    }
    pub fn all_outputs(&self) -> Vec<(String, u64, bool)> {
        let unspent: BTreeSet<[u8; 32]> = self.owned.values().map(|o| o.key().compress().to_bytes()).collect();
        self.history
            .iter()
            .map(|(k, o)| (hex::encode(k), o.commitment().amount, unspent.contains(k)))
            .collect()
    }
    pub fn spent_images(&self) -> Vec<[u8; 32]> {
        self.spent.iter().copied().collect()
    }
    pub fn mark_spent(&mut self, ki: [u8; 32]) {
        self.spent.insert(ki);
    }
    pub fn balance(&self) -> u128 {
        self.owned
            .values()
            .map(|o| u128::from(o.commitment().amount))
            .sum()
    }
    /// Plain XMR payments from the issuer's test wallet (several outputs in ONE transaction; no record). Used on
    /// stagenet to give holders the spendable outputs their carriers need, instead of waiting on the faucet.
    pub async fn pay(&mut self, r: &Rpc, payments: &[(MoneroAddress, u64)]) -> Result<Transaction> {
        ensure!(!payments.is_empty() && payments.len() <= 14, "1..=14 payments per transaction");
        let (network, start_height) = (self.network.clone(), self.start_height);
        self.refresh(r, &network, start_height).await?;
        let total: u64 = payments.iter().map(|(_, a)| *a).sum();
        let (ki, out) = self
            .owned
            .iter()
            .filter(|(i, o)| !self.spent.contains(*i) && self.mature(i) && o.commitment().amount > total + 1_000_000_000)
            .max_by_key(|(_, o)| o.commitment().amount)
            .map(|(i, o)| (*i, o.clone()))
            .context("No mature unreserved native input large enough for these payments")?;
        let decoys = OutputWithDecoys::new(&mut OsRng, r, 16, r.latest_block_number().await?, out).await?;
        let rate: FeeRate = ProvidesFeeRates::fee_rate(r, FeePriority::Unimportant, 10_000_000).await?;
        let tx = SignableTransaction::new(RctType::ClsagBulletproofPlus, seed(), vec![decoys], payments.to_vec(), Change::new(self.view.clone(), None), vec![], rate)?.sign(&mut OsRng, &self.spend)?;
        self.spent.insert(ki);
        Ok(tx)
    }
    pub async fn single(&mut self, r: &Rpc, wire: Option<&[u8]>) -> Result<Transaction> {
        let data = wire.map(crate::transport::parts).transpose()?.unwrap_or_default();
        self.single_data(r, data).await
    }
    /// A carrier with arbitrary extra data chunks (the checkpoint anchor, whose magic is not a record
    /// magic, so every token reader — old and new — sees no record in it).
    pub async fn single_data(&mut self, r: &Rpc, data: Vec<Vec<u8>>) -> Result<Transaction> {
        let (network, start_height) = (self.network.clone(), self.start_height);
        self.refresh(r, &network, start_height).await?;
        let (ki, out) = self
            .owned
            .iter()
            // Input-selection policy (not validation): any unspent output above 0.001 XMR can carry the
            // 1-piconero-class self-payment plus the fee. Stagenet faucet outputs are exactly 0.01 XMR,
            // so a "> 0.01 XMR" threshold would exclude every real test output.
            .filter(|(i, o)| {
                !self.spent.contains(*i) && self.mature(i) && o.commitment().amount > 1_000_000_000
            })
            .max_by_key(|(_, o)| o.commitment().amount)
            .map(|(i, o)| (*i, o.clone()))
            .context("No mature unreserved native input")?;
        let decoys = OutputWithDecoys::new(
            &mut OsRng,
            r,
            16,
            r.latest_block_number().await?,
            out,
        )
        .await?;
        let rate: FeeRate =
            ProvidesFeeRates::fee_rate(r, FeePriority::Unimportant, 10_000_000).await?;
        let tx = SignableTransaction::new(
            RctType::ClsagBulletproofPlus,
            seed(),
            vec![decoys],
            vec![(self.address(), 1_000_000)],
            Change::new(self.view.clone(), None),
            data,
            rate,
        )?
        .sign(&mut OsRng, &self.spend)?;
        ensure!(tx.prefix().extra.len() <= crate::transport::EXTRA_LIMIT);
        self.spent.insert(ki);
        Ok(tx)
    }
}

/// The payment transactions trade claims name, fetched from this node with their block heights (a
/// payment still in the pool, unknown, or not a current RingCT transaction is left out: its claim is refused). Each id re-checked.
pub async fn payment_facts(r: &Rpc, ids: &[[u8; 32]]) -> Result<BTreeMap<[u8; 32], xmr20_unshielded_core::trade::PaymentFacts>> {
    let mut out = BTreeMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let body = serde_json::json!({"txs_hashes": ids.iter().map(hex::encode).collect::<Vec<_>>(), "decode_as_json": false}).to_string();
    let v: J = serde_json::from_str(&r.rpc_call("get_transactions", Some(body), 8 << 20).await.map_err(|e| anyhow::anyhow!("get_transactions: {e:?}"))?)?;
    for t in v["txs"].as_array().into_iter().flatten() {
        let (Some(height), Some(hx)) = (t["block_height"].as_u64(), t["as_hex"].as_str()) else { continue };
        if t["in_pool"] == true || hx.is_empty() {
            continue;
        }
        let bytes = hex::decode(hx)?;
        let Ok(tx) = Transaction::read(&mut bytes.as_slice()) else { continue };
        let txid = tx.hash();
        if !ids.contains(&txid) {
            continue;
        }
        let Transaction::V2 { prefix, proofs: Some(p) } = &tx else { continue };
        if p.base.encrypted_amounts.len() != prefix.outputs.len() || p.base.commitments.len() != prefix.outputs.len() {
            continue;
        }
        let mut outputs = vec![];
        for ((o, a), c) in prefix.outputs.iter().zip(&p.base.encrypted_amounts).zip(&p.base.commitments) {
            let monero_wallet::ringct::EncryptedAmount::Compact { amount } = a else { break };
            outputs.push(xmr20_unshielded_core::trade::PaymentOutput { key: o.key.to_bytes(), ecdh: *amount, commitment: c.to_bytes() });
        }
        if outputs.len() == prefix.outputs.len() {
            out.insert(txid, xmr20_unshielded_core::trade::PaymentFacts { txid, height, outputs });
        }
    }
    Ok(out)
}
