//! Boundary records between the public ledger and the shielded pool (one Monero transaction each).
//!
//!   XS1 shield:   magic4 asset32 nIn1 inputs(nIn x 32) change(owner32 amount8) amount8 out(cv32 payload176 proof192)
//!                 ownerSig64 conservation64                       — 1..=4 public inputs, ONE shielded output
//!   XU1 unshield: magic4 asset32 anchor32 in(cv32 nf32 proof192) rk32 auth64 out(owner32 amount8)
//!                 change(cv32 payload176 proof192) conservation64 — ONE shielded input (924 bytes)
//! The PUBLIC amount enters the conservation (Binding) signature as a zero-blinding value commitment:
//! shield:   cv_out + commit(-amount, 0)             must be a commitment to zero -> verifies with blind
//! unshield: cv_in + cv_change + commit(-amount, 0)  idem. The asset is thereby bound to the shielded side.
//! Two shielded inputs with a change output would be 1,148 bytes (> 1,011): measured blocker, so XU1
//! takes exactly one input; wallets unshield note by note or consolidate privately first.
use anyhow::{ensure, Context, Result};
use decaf377::Fr;
use decaf377_rdsa::{Binding, Signature, SigningKey, SpendAuth, VerificationKey};
use penumbra_sdk_asset::{asset, balance::{Balance, Commitment}};
use penumbra_sdk_keys::{keys::SpendKey, Address};
use penumbra_sdk_shielded_pool::Note;
use penumbra_sdk_tct::Root;
use rand_core::OsRng;

use crate::penumbra::{self as pz, ShieldedInput, ShieldedOutput};
use crate::{asset_from_bytes, ledger::Ledger, message, value, PublicOutput, Reader};
use ark_groth16::{PreparedVerifyingKey, ProvingKey};
use decaf377::Bls12_377;

pub const MAGIC_SHIELD: &[u8; 4] = b"XS1\xfe";
pub const MAGIC_UNSHIELD: &[u8; 4] = b"XU1\xfe";
pub const SHIELD_LABEL: &[u8] = b"XMR20-UNSHIELDED-SHIELD-v1\0";
pub const UNSHIELD_LABEL: &[u8] = b"XMR20-UNSHIELDED-UNSHIELD-v1\0";
pub const UNSHIELD_BYTES: usize = 4 + 32 + 32 + ShieldedInput::BYTES + 32 + 64 + PublicOutput::BYTES + ShieldedOutput::BYTES + 64;

/// Penumbra sign convention: a spend's balance is +value (provides), an output's is -value (requires).
/// A shield PROVIDES the public amount to the shielded side (+), an unshield REQUIRES it back (-).
fn conservation_key(sum: Commitment, asset: asset::Id, public_amount: u64, provides: bool) -> Result<VerificationKey<Binding>> {
    let b = Balance::from(value(asset, public_amount));
    let adjust = if provides { b.commit(Fr::from(0u64)) } else { (-b).commit(Fr::from(0u64)) };
    VerificationKey::<Binding>::try_from((sum + adjust).to_bytes()).map_err(|_| anyhow::anyhow!("Conservation key"))
}

// ---------------------------------------------------------------- XS1
#[derive(Clone, Debug)]
pub struct Shield {
    pub asset: asset::Id,
    pub inputs: Vec<[u8; 32]>,
    pub change: PublicOutput,
    pub amount: u64,
    pub out: ShieldedOutput,
    pub owner_sig: Signature<SpendAuth>,
    pub conservation: Signature<Binding>,
}
impl Shield {
    pub fn body(&self) -> Vec<u8> {
        let mut b = MAGIC_SHIELD.to_vec();
        b.extend(self.asset.to_bytes());
        b.push(self.inputs.len() as u8);
        for i in &self.inputs {
            b.extend(i);
        }
        self.change.encode(&mut b);
        b.extend(self.amount.to_le_bytes());
        self.out.encode(&mut b);
        b
    }
    pub fn message(&self, domain: &[u8; 32]) -> [u8; 32] {
        message(SHIELD_LABEL, domain, &self.body())
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.body();
        b.extend(self.owner_sig.to_bytes());
        b.extend(self.conservation.to_bytes());
        b
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(b.len() >= 4 && &b[..4] == MAGIC_SHIELD, "XS1 magic");
        let mut r = Reader::new(b, 4);
        let asset = asset_from_bytes(r.take(32)?)?;
        let n_in = r.u8()? as usize;
        ensure!((1..=crate::public::MAX_IO).contains(&n_in), "Input count");
        let mut inputs = vec![];
        for _ in 0..n_in {
            inputs.push(r.take32()?);
        }
        let change = PublicOutput::decode(&mut r)?;
        let amount = r.u64()?;
        let out = ShieldedOutput::decode(&mut r)?;
        let owner_sig = Signature::try_from(r.take(64)?)?;
        let conservation = Signature::try_from(r.take(64)?)?;
        r.done()?;
        let s = Self { asset, inputs, change, amount, out, owner_sig, conservation };
        ensure!(s.encode() == b, "Canonical record");
        ensure!(s.amount > 0, "Positive shielded amount required");
        let mut seen = std::collections::BTreeSet::new();
        for i in &s.inputs {
            ensure!(seen.insert(*i), "Duplicate input");
        }
        VerificationKey::<SpendAuth>::try_from(s.change.owner).map_err(|_| anyhow::anyhow!("Invalid change owner key"))?;
        Ok(s)
    }
    pub fn total_out(&self) -> u128 {
        u128::from(self.amount) + u128::from(self.change.amount)
    }
    pub fn verify_crypto(&self, owner: &VerificationKey<SpendAuth>, output_vk: &PreparedVerifyingKey<Bls12_377>, domain: &[u8; 32]) -> Result<()> {
        let m = self.message(domain);
        owner.verify(&m, &self.owner_sig).context("Owner signature rejected")?;
        conservation_key(self.out.cv, self.asset, self.amount, true)?.verify(&m, &self.conservation).context("Shield conservation rejected")?;
        self.out.verify(output_vk)
    }
    /// Build: public inputs (owned by `owner`) -> shielded note of `amount` for `to`, public change to the owner.
    pub fn build(asset: asset::Id, inputs: Vec<[u8; 32]>, total_in: u64, amount: u64, to: &Address, owner: &SigningKey<SpendAuth>, output_pk: &ProvingKey<Bls12_377>, domain: &[u8; 32]) -> Result<(Self, Note)> {
        ensure!(amount > 0 && amount <= total_in, "Shield amount must be positive and covered by the inputs");
        let (w, blind) = pz::output_witness(to, value(asset, amount))?;
        let note = w.note.clone();
        let out = pz::prove_output(output_pk, w)?;
        let change = PublicOutput { owner: crate::keys::owner_key(owner), amount: total_in - amount };
        let mut s = Self { asset, inputs, change, amount, out, owner_sig: [0u8; 64].into(), conservation: [0u8; 64].into() };
        let m = s.message(domain);
        s.owner_sig = owner.sign(OsRng, &m);
        s.conservation = SigningKey::<Binding>::from(blind).sign(OsRng, &m);
        Ok((s, note))
    }
}

// ---------------------------------------------------------------- XU1
#[derive(Clone, Debug)]
pub struct Unshield {
    pub asset: asset::Id,
    pub anchor: Root,
    pub input: ShieldedInput,
    pub rk: VerificationKey<SpendAuth>,
    pub auth: Signature<SpendAuth>,
    pub out: PublicOutput,
    pub change: ShieldedOutput,
    pub conservation: Signature<Binding>,
}
impl Unshield {
    pub fn body(&self) -> Vec<u8> {
        let mut b = MAGIC_UNSHIELD.to_vec();
        b.extend(self.asset.to_bytes());
        b.extend(pz::root_bytes(self.anchor));
        self.input.encode(&mut b);
        b.extend(self.rk.to_bytes());
        b
    }
    fn body_after_auth(&self) -> Vec<u8> {
        let mut b = vec![];
        self.out.encode(&mut b);
        self.change.encode(&mut b);
        b
    }
    /// Both signatures cover every public field except the signatures themselves.
    pub fn message(&self, domain: &[u8; 32]) -> [u8; 32] {
        let mut b = self.body();
        b.extend(self.body_after_auth());
        message(UNSHIELD_LABEL, domain, &b)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.body();
        b.extend(self.auth.to_bytes());
        b.extend(self.body_after_auth());
        b.extend(self.conservation.to_bytes());
        b
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(b.len() == UNSHIELD_BYTES && &b[..4] == MAGIC_UNSHIELD, "XU1 size/magic");
        let mut r = Reader::new(b, 4);
        let asset = asset_from_bytes(r.take(32)?)?;
        let anchor = pz::root_from_bytes(r.take(32)?)?;
        let input = ShieldedInput::decode(&mut r)?;
        let rk = VerificationKey::try_from(r.take32()?)?;
        let auth = Signature::try_from(r.take(64)?)?;
        let out = PublicOutput::decode(&mut r)?;
        let change = ShieldedOutput::decode(&mut r)?;
        let conservation = Signature::try_from(r.take(64)?)?;
        r.done()?;
        let u = Self { asset, anchor, input, rk, auth, out, change, conservation };
        ensure!(u.encode() == b, "Canonical record");
        ensure!(u.out.amount > 0, "Positive public amount required");
        VerificationKey::<SpendAuth>::try_from(u.out.owner).map_err(|_| anyhow::anyhow!("Invalid output owner key"))?;
        Ok(u)
    }
    pub fn verify_crypto(&self, spend_vk: &PreparedVerifyingKey<Bls12_377>, output_vk: &PreparedVerifyingKey<Bls12_377>, domain: &[u8; 32]) -> Result<()> {
        let m = self.message(domain);
        self.rk.verify(&m, &self.auth).context("Spend authorization rejected")?;
        conservation_key(self.input.cv + self.change.cv, self.asset, self.out.amount, false)?.verify(&m, &self.conservation).context("Unshield conservation rejected")?;
        self.input.verify(spend_vk, self.anchor, &self.rk)?;
        self.change.verify(output_vk)
    }
    /// Build: spend ONE owned shielded note; `amount` becomes a public note for `to_owner`; the rest returns as shielded change.
    pub fn build(ledger: &Ledger, key: &SpendKey, note: &Note, amount: u64, to_owner: [u8; 32], spend_pk: &ProvingKey<Bls12_377>, output_pk: &ProvingKey<Bls12_377>, domain: &[u8; 32]) -> Result<(Self, Note)> {
        let fvk = key.full_viewing_key();
        ensure!(note.controlled_by(fvk), "Input belongs to another holder");
        ensure!(u128::from(note.amount()) > 0, "Positive input required");
        ensure!(amount > 0 && u128::from(amount) <= u128::from(note.amount()), "Unshield amount must be positive and covered by the note");
        let asset = note.asset_id();
        let pos = ledger.tree.position_of(note.commit()).context("Note absent")?;
        ensure!(!ledger.nullifiers.contains(&penumbra_sdk_sct::Nullifier::derive(fvk.nullifier_key(), pos, &note.commit()).0.to_bytes()), "Input spent");
        let change_amount = u64::try_from(u128::from(note.amount()) - u128::from(amount))?;
        let randomizer = pz::random_fr();
        let vb = pz::random_fr();
        let w = pz::spend_witness(ledger, key, note, randomizer, vb)?;
        let rk = w.public.rk;
        let anchor = w.public.anchor;
        let input = pz::prove_spend(spend_pk, w)?;
        let (ow, ob) = pz::output_witness(&crate::keys::shielded_address(key), value(asset, change_amount))?;
        let change_note = ow.note.clone();
        let change = pz::prove_output(output_pk, ow)?;
        let mut u = Self { asset, anchor, input, rk, auth: [0u8; 64].into(), out: PublicOutput { owner: to_owner, amount }, change, conservation: [0u8; 64].into() };
        let m = u.message(domain);
        u.auth = key.spend_auth_key().randomize(&randomizer).sign(OsRng, &m);
        u.conservation = SigningKey::<Binding>::from(vb + ob).sign(OsRng, &m);
        Ok((u, change_note))
    }
}
