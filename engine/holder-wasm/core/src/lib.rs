//! XMR20 token format v0.2-experimental — UNSHIELDED BY DEFAULT, optional shielded transfers.
//! UNREVIEWED research code (research/token-format-unshielded-20261025, DESIGN.txt).
//!
//! Records (all carried in tx_extra of ordinary Monero transactions, <= 1,060 bytes framed):
//!   XP1 public transfer · XC1 public credit · XR1 public burn (redemption)
//!   XS1 shield (public -> shielded) · XU1 unshield (shielded -> public)
//!   XMA + XMB two-part private transfer (3 Penumbra spends + 2 Penumbra outputs)
//! Proofs: Penumbra's unchanged SpendCircuit / OutputCircuit with Penumbra's PUBLISHED proving
//! and verifying keys (penumbra.rs). This crate runs no Groth16 setup of its own.
//! Disclosure rule: no record contains a native Monero output key, key image, ring position,
//! native amount or mask; public ownership is a derived decaf377-rdsa key (keys.rs).
use anyhow::{ensure, Result};
use penumbra_sdk_asset::{asset, Value};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub mod keys;
pub mod ledger;
pub mod manifest;
pub mod payload;
pub mod penumbra;
pub mod pool;
pub mod private2;
pub mod public;
pub mod shield;
pub mod transport;
pub use payload::Payload;
#[cfg(test)]
mod tests;

pub const SCHEME: &str = "XMR20-TKD1";
pub const PROTOCOL: &str = "XMR20-UNSHIELDED-v0.2-experimental";
pub const DOMAIN_LABEL: &str = "XMR20-UNSHIELDED-DOMAIN-v1";
pub const MANIFEST_FORMAT: &str = "XMR20-PARAMS-2";

pub fn hash(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}
/// Domain-separated message: H(label || domain || body). Labels are fixed protocol strings
/// (never attacker-chosen); the domain pins the ledger (genesis, verifying keys, issuer key).
pub fn message(label: &[u8], domain: &[u8; 32], body: &[u8]) -> [u8; 32] {
    let mut b = label.to_vec();
    b.extend(domain);
    b.extend(body);
    hash(&b)
}
pub fn value(a: asset::Id, n: u64) -> Value {
    Value { asset_id: a, amount: n.into() }
}
pub fn asset_from_bytes(b: &[u8]) -> Result<asset::Id> {
    let arr: [u8; 32] = b.try_into().map_err(|_| anyhow::anyhow!("Asset id size"))?;
    asset::Id::try_from(arr).map_err(|_| anyhow::anyhow!("Asset id encoding"))
}
pub fn asset_for_mint(mint: &str) -> Result<asset::Id> {
    let denom: String = format!("uxmr20private{}", mint.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>());
    Ok(asset::REGISTRY.parse_denom(&denom).ok_or_else(|| anyhow::anyhow!("Unparseable denom"))?.id())
}

pub struct Reader<'a> {
    pub b: &'a [u8],
    pub at: usize,
}
impl<'a> Reader<'a> {
    pub fn new(b: &'a [u8], at: usize) -> Self {
        Self { b, at }
    }
    pub fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        ensure!(n <= self.b.len() - self.at, "Truncated record");
        let x = &self.b[self.at..self.at + n];
        self.at += n;
        Ok(x)
    }
    pub fn take32(&mut self) -> Result<[u8; 32]> {
        Ok(self.take(32)?.try_into().unwrap())
    }
    pub fn take64(&mut self) -> Result<[u8; 64]> {
        Ok(self.take(64)?.try_into().unwrap())
    }
    pub fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    pub fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    pub fn done(&self) -> Result<()> {
        ensure!(self.at == self.b.len(), "Trailing bytes");
        Ok(())
    }
}

/// Ledger configuration (parameters.json). The ledger domain binds the chain genesis, Penumbra's
/// two verifying keys (compressed ark encoding, hex) and the single lab issuer key.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Config {
    pub chain: String,
    pub domain: String,
    pub spend_vk: String,
    pub output_vk: String,
    pub issuer_vk: String,
}
impl Config {
    pub fn computed_domain(&self) -> Result<[u8; 32]> {
        let mut b = DOMAIN_LABEL.as_bytes().to_vec();
        b.push(0);
        for f in [&self.chain, &self.spend_vk, &self.output_vk, &self.issuer_vk] {
            let bytes = hex::decode(f)?;
            b.extend((bytes.len() as u32).to_le_bytes());
            b.extend(bytes);
        }
        Ok(hash(&b))
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(hex::decode(&self.chain)?.len() == 32, "Chain genesis");
        ensure!(hex::decode(&self.issuer_vk)?.len() == 32, "Issuer key");
        ensure!(hex::encode(self.computed_domain()?) == self.domain, "Domain mismatch");
        Ok(())
    }
    pub fn domain(&self) -> Result<[u8; 32]> {
        self.validate()?;
        Ok(hex::decode(&self.domain)?.try_into().unwrap())
    }
}

/// Public output of a record: owner key (decaf377-rdsa SpendAuth verification key bytes) and amount.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicOutput {
    pub owner: [u8; 32],
    pub amount: u64,
}
impl PublicOutput {
    pub const BYTES: usize = 40;
    pub fn encode(&self, b: &mut Vec<u8>) {
        b.extend(self.owner);
        b.extend(self.amount.to_le_bytes());
    }
    pub fn decode(r: &mut Reader) -> Result<Self> {
        Ok(Self { owner: r.take32()?, amount: r.u64()? })
    }
}
pub fn sum_amounts<'a>(mut it: impl Iterator<Item = &'a u64>) -> Result<u128> {
    it.try_fold(0u128, |s, n| s.checked_add(u128::from(*n)).ok_or_else(|| anyhow::anyhow!("Amount overflow")))
}
