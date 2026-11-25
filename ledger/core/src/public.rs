//! Public (unshielded) ledger records. Amounts and owners are public; ownership is a plain
//! decaf377-rdsa SpendAuth signature by the owner key of ALL inputs (one owner per record).
//! No proof, no native XMR field of any kind.
//!
//!   XP1 transfer: magic4 asset32 nIn1 nOut1 inputs(nIn x noteId32) outputs(nOut x (owner32 amount8)) sig64
//!   XC1 credit:   magic4 kind1 asset32 amount8 owner32 binding32 issuerSig64
//!   XR1 burn:     magic4 asset32 nIn1 inputs(nIn x 32) amount8 change(owner32 amount8) binding32 sig64
use anyhow::{ensure, Context, Result};
use decaf377_rdsa::{Signature, SigningKey, SpendAuth, VerificationKey};
use penumbra_sdk_asset::asset;
use rand_core::OsRng;

use crate::{asset_from_bytes, hash, message, sum_amounts, PublicOutput, Reader};

pub const MAGIC_TRANSFER: &[u8; 4] = b"XP1\xfe";
pub const MAGIC_CREDIT: &[u8; 4] = b"XC1\xfe";
pub const MAGIC_BURN: &[u8; 4] = b"XR1\xfe";
pub const MAX_IO: usize = 4;
pub const KIND_DEPOSIT: u8 = 1;
pub const KIND_MIGRATION: u8 = 2;
pub const AUTH_LABEL: &[u8] = b"XMR20-UNSHIELDED-AUTH-v1\0";
pub const ISSUER_LABEL: &[u8] = b"XMR20-UNSHIELDED-ISSUER-v1\0";

/// Public note id: hash of the creating record and the output index. Never a native outpoint.
pub fn note_id(record_id: &[u8; 32], index: u16) -> [u8; 32] {
    let mut b = b"XMR20-PUBLIC-NOTE-v1\0".to_vec();
    b.extend(record_id);
    b.extend(index.to_le_bytes());
    hash(&b)
}
pub fn record_id(wire: &[u8]) -> [u8; 32] {
    hash(wire)
}
fn check_inputs(inputs: &[[u8; 32]]) -> Result<()> {
    ensure!(!inputs.is_empty() && inputs.len() <= MAX_IO, "One to four inputs required");
    let mut seen = std::collections::BTreeSet::new();
    for i in inputs {
        ensure!(seen.insert(*i), "Duplicate input");
    }
    Ok(())
}
fn check_outputs(outputs: &[PublicOutput]) -> Result<()> {
    ensure!(!outputs.is_empty() && outputs.len() <= MAX_IO, "One to four outputs required");
    for o in outputs {
        ensure!(o.amount > 0, "Zero-value public output");
        VerificationKey::<SpendAuth>::try_from(o.owner).map_err(|_| anyhow::anyhow!("Invalid output owner key"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------- XP1
#[derive(Clone, Debug)]
pub struct Transfer {
    pub asset: asset::Id,
    pub inputs: Vec<[u8; 32]>,
    pub outputs: Vec<PublicOutput>,
    pub sig: Signature<SpendAuth>,
}
impl Transfer {
    pub fn body(&self) -> Vec<u8> {
        let mut b = MAGIC_TRANSFER.to_vec();
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
        message(AUTH_LABEL, domain, &self.body())
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.body();
        b.extend(self.sig.to_bytes());
        b
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(b.len() >= 4 && &b[..4] == MAGIC_TRANSFER, "XP1 magic");
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
            outputs.push(PublicOutput::decode(&mut r)?);
        }
        let sig = Signature::try_from(r.take(64)?)?;
        r.done()?;
        let t = Self { asset, inputs, outputs, sig };
        ensure!(t.encode() == b, "Canonical record");
        check_inputs(&t.inputs)?;
        check_outputs(&t.outputs)?;
        Ok(t)
    }
    pub fn total_out(&self) -> Result<u128> {
        sum_amounts(self.outputs.iter().map(|o| &o.amount))
    }
    pub fn verify_sig(&self, owner: &VerificationKey<SpendAuth>, domain: &[u8; 32]) -> Result<()> {
        owner.verify(&self.message(domain), &self.sig).context("Owner signature rejected")
    }
    pub fn build(asset: asset::Id, inputs: Vec<[u8; 32]>, outputs: Vec<PublicOutput>, owner: &SigningKey<SpendAuth>, domain: &[u8; 32]) -> Result<Self> {
        check_inputs(&inputs)?;
        check_outputs(&outputs)?;
        let mut t = Self { asset, inputs, outputs, sig: [0u8; 64].into() };
        t.sig = owner.sign(OsRng, &t.message(domain));
        Ok(t)
    }
}

// ---------------------------------------------------------------- XC1
#[derive(Clone, Debug)]
pub struct Credit {
    pub kind: u8,
    pub asset: asset::Id,
    pub amount: u64,
    pub owner: [u8; 32],
    pub binding: [u8; 32],
    pub issuer: Signature<SpendAuth>,
}
impl Credit {
    pub const BYTES: usize = 4 + 1 + 32 + 8 + 32 + 32 + 64;
    pub fn body(&self) -> Vec<u8> {
        let mut b = MAGIC_CREDIT.to_vec();
        b.push(self.kind);
        b.extend(self.asset.to_bytes());
        b.extend(self.amount.to_le_bytes());
        b.extend(self.owner);
        b.extend(self.binding);
        b
    }
    pub fn message(&self, domain: &[u8; 32]) -> [u8; 32] {
        message(ISSUER_LABEL, domain, &self.body())
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.body();
        b.extend(self.issuer.to_bytes());
        b
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(b.len() == Self::BYTES && &b[..4] == MAGIC_CREDIT, "XC1 size/magic");
        let mut r = Reader::new(b, 4);
        let kind = r.u8()?;
        let asset = asset_from_bytes(r.take(32)?)?;
        let amount = r.u64()?;
        let owner = r.take32()?;
        let binding = r.take32()?;
        let issuer = Signature::try_from(r.take(64)?)?;
        r.done()?;
        let c = Self { kind, asset, amount, owner, binding, issuer };
        ensure!(c.encode() == b, "Canonical record");
        ensure!(c.kind == KIND_DEPOSIT || c.kind == KIND_MIGRATION, "Unknown credit kind");
        ensure!(c.amount > 0 && c.binding != [0; 32], "Positive bound credit required");
        VerificationKey::<SpendAuth>::try_from(c.owner).map_err(|_| anyhow::anyhow!("Invalid credit owner key"))?;
        Ok(c)
    }
    pub fn verify_sig(&self, issuer_vk: &VerificationKey<SpendAuth>, domain: &[u8; 32]) -> Result<()> {
        issuer_vk.verify(&self.message(domain), &self.issuer).context("Issuer signature rejected")
    }
    pub fn build(kind: u8, asset: asset::Id, amount: u64, owner: [u8; 32], binding: [u8; 32], issuer: &SigningKey<SpendAuth>, domain: &[u8; 32]) -> Result<Self> {
        ensure!(kind == KIND_DEPOSIT || kind == KIND_MIGRATION, "Credit kind");
        ensure!(amount > 0 && binding != [0; 32], "Positive bound credit required");
        let mut c = Self { kind, asset, amount, owner, binding, issuer: [0u8; 64].into() };
        c.issuer = issuer.sign(OsRng, &c.message(domain));
        Ok(c)
    }
}

// ---------------------------------------------------------------- XR1
#[derive(Clone, Debug)]
pub struct Burn {
    pub asset: asset::Id,
    pub inputs: Vec<[u8; 32]>,
    pub amount: u64,
    pub change: PublicOutput,
    pub binding: [u8; 32],
    pub sig: Signature<SpendAuth>,
}
impl Burn {
    pub fn body(&self) -> Vec<u8> {
        let mut b = MAGIC_BURN.to_vec();
        b.extend(self.asset.to_bytes());
        b.push(self.inputs.len() as u8);
        for i in &self.inputs {
            b.extend(i);
        }
        b.extend(self.amount.to_le_bytes());
        self.change.encode(&mut b);
        b.extend(self.binding);
        b
    }
    pub fn message(&self, domain: &[u8; 32]) -> [u8; 32] {
        message(AUTH_LABEL, domain, &self.body())
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.body();
        b.extend(self.sig.to_bytes());
        b
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(b.len() >= 4 && &b[..4] == MAGIC_BURN, "XR1 magic");
        let mut r = Reader::new(b, 4);
        let asset = asset_from_bytes(r.take(32)?)?;
        let n_in = r.u8()? as usize;
        ensure!((1..=MAX_IO).contains(&n_in), "Input count");
        let mut inputs = vec![];
        for _ in 0..n_in {
            inputs.push(r.take32()?);
        }
        let amount = r.u64()?;
        let change = PublicOutput::decode(&mut r)?;
        let binding = r.take32()?;
        let sig = Signature::try_from(r.take(64)?)?;
        r.done()?;
        let x = Self { asset, inputs, amount, change, binding, sig };
        ensure!(x.encode() == b, "Canonical record");
        check_inputs(&x.inputs)?;
        ensure!(x.amount > 0 && x.binding != [0; 32], "Positive bound burn required");
        VerificationKey::<SpendAuth>::try_from(x.change.owner).map_err(|_| anyhow::anyhow!("Invalid change owner key"))?;
        Ok(x)
    }
    pub fn total_out(&self) -> Result<u128> {
        Ok(u128::from(self.amount) + u128::from(self.change.amount))
    }
    pub fn verify_sig(&self, owner: &VerificationKey<SpendAuth>, domain: &[u8; 32]) -> Result<()> {
        owner.verify(&self.message(domain), &self.sig).context("Owner signature rejected")
    }
    pub fn build(asset: asset::Id, inputs: Vec<[u8; 32]>, amount: u64, change: PublicOutput, binding: [u8; 32], owner: &SigningKey<SpendAuth>, domain: &[u8; 32]) -> Result<Self> {
        check_inputs(&inputs)?;
        ensure!(amount > 0 && binding != [0; 32], "Positive bound burn required");
        let mut x = Self { asset, inputs, amount, change, binding, sig: [0u8; 64].into() };
        x.sig = owner.sign(OsRng, &x.message(domain));
        Ok(x)
    }
}
