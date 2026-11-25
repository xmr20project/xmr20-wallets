//! Trusted parameter manifest (format XMR20-PARAMS-2) and canonical-chain replay. Every role rebuilds
//! the pool from genesis (or the manifest's start height) on each scan, caching parsed blocks by hash.
//!
//! The manifest is handed to a role as a SEPARATE path (--trusted-manifest), independent of the
//! parameter directory it authenticates; optionally its own sha256 is pinned (XMR20_TRUSTED_MANIFEST_SHA256).
//! Parameter files are authenticated (exact length, sha256) BEFORE they are parsed, then checked against
//! Penumbra's published key ids; parameters.json must equal the manifest's configuration; the manifest
//! must describe this protocol version and network; the daemon's genesis must equal the manifest's.
use anyhow::{ensure, Context, Result};
use ark_groth16::{PreparedVerifyingKey, ProvingKey};
use ark_serialize::Valid;
use decaf377::Bls12_377;
use decaf377_rdsa::{SpendAuth, VerificationKey};
use monero_wallet::interface::prelude::*;
use rayon::prelude::*;
use serde_json::{json, Value as J};
use std::{collections::BTreeMap, fs, path::Path};
use xmr20_unshielded_core::{self as core, hash, penumbra as pz, pool::{Pool, Vks}, Config};

use crate::native;

pub use xmr20_unshielded_core::manifest::{authenticate_file, Manifest, ManifestFile, ManifestFiles, ManifestNetwork, ManifestProtocol, ManifestShape};
/// Read the trusted manifest from its own path (optionally pinned by XMR20_TRUSTED_MANIFEST_SHA256) and validate it.
pub fn read_manifest(path: &Path) -> Result<(Manifest, String)> {
    let bytes = fs::read(path).map_err(|e| anyhow::anyhow!("Trusted manifest {}: {e}", path.display()))?;
    let digest = hex::encode(hash(&bytes));
    if let Ok(pin) = std::env::var("XMR20_TRUSTED_MANIFEST_SHA256") {
        ensure!(pin == digest, "Trusted manifest sha256 {} does not match the pinned value {}", &digest[..16], &pin.get(..16).unwrap_or(&pin));
    }
    let m: Manifest = serde_json::from_slice(&bytes).map_err(|e| anyhow::anyhow!("Trusted manifest: {e}"))?;
    m.validate()?;
    Ok((m, digest))
}
pub struct Params {
    pub manifest: Manifest,
    pub manifest_sha256: String,
    pub config: Config,
    pub domain: [u8; 32],
    pub spend_pk: Option<ProvingKey<Bls12_377>>,
    pub output_pk: Option<ProvingKey<Bls12_377>>,
    pub vks: Vks,
}
pub fn load_pk(circuit: pz::Circuit, path: &Path, expected: &ManifestFile) -> Result<ProvingKey<Bls12_377>> {
    let bytes = fs::read(path).map_err(|e| anyhow::anyhow!("Parameter file {} refused: {e}", expected.path))?;
    authenticate_file(expected, &bytes)?;
    let key = pz::load_pk(circuit, &bytes)?;
    key.vk.check()?;
    key.beta_g1.check()?;
    key.delta_g1.check()?;
    for points in [&key.a_query, &key.b_g1_query, &key.h_query, &key.l_query] {
        points.par_iter().try_for_each(|p| p.check())?;
    }
    key.b_g2_query.par_iter().try_for_each(|p| p.check())?;
    Ok(key)
}
impl Params {
    pub fn load(dir: &Path, prover: bool, trusted_manifest: &Path) -> Result<Self> {
        let (manifest, manifest_sha256) = read_manifest(trusted_manifest)?;
        let raw = fs::read(dir.join("parameters.json")).map_err(|e| anyhow::anyhow!("parameters.json refused: {e}"))?;
        authenticate_file(&manifest.parameters_json, &raw)?;
        let config: Config = serde_json::from_slice(&raw)?;
        ensure!(config == manifest.config, "parameters.json describes another ledger or version than the trusted manifest");
        let domain = config.domain()?;
        let (spend_pk, output_pk) = if prover {
            let s = load_pk(pz::Circuit::Spend, &dir.join(&manifest.files.spend.path), &manifest.files.spend)?;
            let o = load_pk(pz::Circuit::Output, &dir.join(&manifest.files.output.path), &manifest.files.output)?;
            ensure!(pz::pk_matches_vk(&s, &config.spend_vk) && pz::pk_matches_vk(&o, &config.output_vk), "Local proving keys do not match the pinned verifying keys");
            (Some(s), Some(o))
        } else {
            (None, None)
        };
        let issuer: [u8; 32] = hex::decode(&config.issuer_vk)?.try_into().map_err(|_| anyhow::anyhow!("Issuer key"))?;
        let vks = Vks { spend: pz::read_vk(pz::Circuit::Spend, &config.spend_vk)?, output: pz::read_vk(pz::Circuit::Output, &config.output_vk)?, issuer: VerificationKey::<SpendAuth>::try_from(issuer)? };
        Ok(Self { manifest, manifest_sha256, config, domain, spend_pk, output_pk, vks })
    }
}
struct Block {
    hash: [u8; 32],
    txs: Vec<([u8; 32], Option<Vec<u8>>)>,
}
pub struct Chain {
    cache: BTreeMap<[u8; 32], Block>,
    pub pool: Pool,
    pub public: J,
    pub tip: usize,
}
impl Chain {
    pub fn new(domain: [u8; 32]) -> Self {
        Self { cache: BTreeMap::new(), pool: Pool::new(domain), public: J::Null, tip: 0 }
    }
    pub async fn scan(&mut self, rpc: &native::Rpc, p: &Params) -> Result<J> {
        native::guard(rpc, &p.manifest.network.kind).await?;
        let genesis = rpc.block_by_number(0).await?;
        ensure!(hex::encode(genesis.hash()) == p.config.chain, "Wrong chain");
        let tip = rpc.latest_block_number().await?;
        let tip_hash = rpc.block_by_number(tip).await?.hash();
        let first = (p.manifest.network.start_height as usize).max(1);
        let mut previous = if first <= tip { rpc.block_by_number(first - 1).await?.hash() } else { [0u8; 32] };
        let mut pool = Pool::new(p.domain);
        pool.open = core::open::activation_from_env(&p.manifest.network.kind);
        let mut events = vec![];
        let mut blocks = vec![];
        for height in first..=tip {
            let b = rpc.block_by_number(height).await?;
            ensure!(b.number() == height && b.header.previous == previous, "Inconsistent canonical chain snapshot");
            previous = b.hash();
            if !self.cache.contains_key(&b.hash()) {
                let scan = rpc.expand_to_scannable_block(b.clone()).await?;
                let txs = b.transactions.iter().zip(&scan.transactions).map(|(id, tx)| (*id, core::transport::wire_at(&tx.prefix().extra, core::open::activation_from_env(&p.manifest.network.kind), height as u64))).collect();
                self.cache.insert(b.hash(), Block { hash: b.hash(), txs });
            }
            let block = &self.cache[&b.hash()];
            let mut ids = vec![];
            for (id, wire) in &block.txs {
                let txid = hex::encode(id);
                let result = pool.apply(wire.as_deref(), &txid, height as u64, &p.vks);
                if result["record"] != "ignored" {
                    events.push(json!({"height":height,"txid":txid,"result":result}));
                }
                ids.push(txid);
            }
            blocks.push(json!({"height":height,"hash":hex::encode(block.hash),"transactions":ids}));
        }
        // The replayed chain itself must end at the snapshot tip. Without this, an A/B/A view across the RPC
        // calls (tip read as A, blocks replayed from branch B, tip re-read as A) would label branch B's state with tip hash A.
        if first <= tip {
            ensure!(previous == tip_hash, "Inconsistent canonical chain snapshot: the replayed tip differs from the snapshot tip; retry");
        } else {
            // Empty replay (start height beyond the tip): the state is the empty pool, labelled with the tip read above.
            ensure!(events.is_empty() && blocks.is_empty(), "Empty replay produced blocks");
        }
        ensure!(rpc.block_by_number(tip).await?.hash() == tip_hash, "Chain changed during replay; retry");
        self.pool = pool;
        self.tip = tip;
        self.public = json!({"tip":tip,"tipHash":hex::encode(tip_hash),"state":self.pool.summary(),"events":events,"canonicalBlocks":blocks});
        Ok(self.public.clone())
    }
    pub fn confirmed(&self, txid: &str) -> Option<usize> {
        self.public["canonicalBlocks"].as_array()?.iter().find(|b| b["transactions"].as_array().is_some_and(|t| t.iter().any(|x| x == txid))).and_then(|b| b["height"].as_u64()).map(|h| self.tip - h as usize + 1)
    }
}
