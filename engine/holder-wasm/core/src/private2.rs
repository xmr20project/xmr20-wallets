//! XM4 private transfer in TWO carriers (3 Penumbra spends + 2 Penumbra outputs, Penumbra keys).
//!
//!   opId  = H("XMR20-XM4-OP-v1\0" || domain || anchor32 || nf1 nf2 nf3 || cm1 cm2)
//!   Part A "XMA\xfe": magic4 opId32 anchor32 3 x (cv32 nf32 proof192) rk32 auth64            = 932 bytes
//!   Part B "XMB\xfe": magic4 opId32 2 x (cv32 payload176 proof192) binding64                  = 900 bytes
//!   auth    = SpendAuth signature by the shared randomized key rk over H("XMR20-XM4-A-v1\0"||domain||bodyA)
//!   binding = Binding signature by the sum of all value blindings over H("XMR20-XM4-B-v1\0"||domain||bodyA||bodyB)
//! Neither part means anything alone. The pool applies the operation at most once, when both parts are
//! canonical and every check passes at that moment (pool.rs).
use anyhow::{ensure, Context, Result};
use ark_groth16::{PreparedVerifyingKey, ProvingKey};
use decaf377::{Bls12_377, Fr};
use decaf377_rdsa::{Binding, Signature, SigningKey, SpendAuth, VerificationKey};
use penumbra_sdk_asset::{balance::Commitment, Value};
use penumbra_sdk_keys::{keys::SpendKey, Address};
use penumbra_sdk_sct::Nullifier;
use penumbra_sdk_shielded_pool::Note;
use penumbra_sdk_tct::Root;
use rand_core::OsRng;
use std::collections::BTreeSet;

use crate::penumbra::{self as pz, ShieldedInput, ShieldedOutput};
use crate::{hash, ledger::Ledger, message, value, Reader};

pub const MAGIC_A: &[u8; 4] = b"XMA\xfe";
pub const MAGIC_B: &[u8; 4] = b"XMB\xfe";
pub const INPUTS: usize = 3;
pub const OUTPUTS: usize = 2;
pub const A_BYTES: usize = 4 + 32 + 32 + INPUTS * ShieldedInput::BYTES + 32 + 64;
pub const B_BYTES: usize = 4 + 32 + OUTPUTS * ShieldedOutput::BYTES + 64;
pub const OP_LABEL: &[u8] = b"XMR20-XM4-OP-v1\0";
pub const A_LABEL: &[u8] = b"XMR20-XM4-A-v1\0";
pub const B_LABEL: &[u8] = b"XMR20-XM4-B-v1\0";

pub fn op_id(domain: &[u8; 32], anchor: Root, nfs: &[[u8; 32]; INPUTS], cms: &[[u8; 32]; OUTPUTS]) -> [u8; 32] {
    let mut b = OP_LABEL.to_vec();
    b.extend(domain);
    b.extend(pz::root_bytes(anchor));
    for n in nfs {
        b.extend(n);
    }
    for c in cms {
        b.extend(c);
    }
    hash(&b)
}

#[derive(Clone, Debug)]
pub struct PartA {
    pub op: [u8; 32],
    pub anchor: Root,
    pub inputs: Vec<ShieldedInput>,
    pub rk: VerificationKey<SpendAuth>,
    pub auth: Signature<SpendAuth>,
}
impl PartA {
    pub fn body(&self) -> Vec<u8> {
        let mut b = MAGIC_A.to_vec();
        b.extend(self.op);
        b.extend(pz::root_bytes(self.anchor));
        for i in &self.inputs {
            i.encode(&mut b);
        }
        b.extend(self.rk.to_bytes());
        b
    }
    pub fn message(&self, domain: &[u8; 32]) -> [u8; 32] {
        message(A_LABEL, domain, &self.body())
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.body();
        b.extend(self.auth.to_bytes());
        b
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(b.len() == A_BYTES && &b[..4] == MAGIC_A, "XMA size/magic");
        let mut r = Reader::new(b, 4);
        let op = r.take32()?;
        let anchor = pz::root_from_bytes(r.take(32)?)?;
        let mut inputs = vec![];
        for _ in 0..INPUTS {
            inputs.push(ShieldedInput::decode(&mut r)?);
        }
        let rk = VerificationKey::try_from(r.take32()?)?;
        let auth = Signature::try_from(r.take(64)?)?;
        r.done()?;
        let a = Self { op, anchor, inputs, rk, auth };
        ensure!(a.encode() == b, "Canonical record");
        let mut seen = BTreeSet::new();
        for i in &a.inputs {
            ensure!(seen.insert(i.nf_bytes()), "Duplicate input nullifier");
        }
        Ok(a)
    }
    pub fn nullifiers(&self) -> [[u8; 32]; INPUTS] {
        [self.inputs[0].nf_bytes(), self.inputs[1].nf_bytes(), self.inputs[2].nf_bytes()]
    }
}
#[derive(Clone, Debug)]
pub struct PartB {
    pub op: [u8; 32],
    pub outputs: Vec<ShieldedOutput>,
    pub binding: Signature<Binding>,
}
impl PartB {
    pub fn body(&self) -> Vec<u8> {
        let mut b = MAGIC_B.to_vec();
        b.extend(self.op);
        for o in &self.outputs {
            o.encode(&mut b);
        }
        b
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.body();
        b.extend(self.binding.to_bytes());
        b
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(b.len() == B_BYTES && &b[..4] == MAGIC_B, "XMB size/magic");
        let mut r = Reader::new(b, 4);
        let op = r.take32()?;
        let mut outputs = vec![];
        for _ in 0..OUTPUTS {
            outputs.push(ShieldedOutput::decode(&mut r)?);
        }
        let binding = Signature::try_from(r.take(64)?)?;
        r.done()?;
        let p = Self { op, outputs, binding };
        ensure!(p.encode() == b, "Canonical record");
        ensure!(p.outputs[0].commitment_bytes() != p.outputs[1].commitment_bytes(), "Duplicate outputs");
        Ok(p)
    }
    pub fn commitments(&self) -> [[u8; 32]; OUTPUTS] {
        [self.outputs[0].commitment_bytes(), self.outputs[1].commitment_bytes()]
    }
}
/// A complete operation (both parts). `verify_crypto` is the whole cryptographic admission.
pub struct Operation<'a> {
    pub a: &'a PartA,
    pub b: &'a PartB,
}
impl<'a> Operation<'a> {
    pub fn message_b(&self, domain: &[u8; 32]) -> [u8; 32] {
        let mut body = self.a.body();
        body.extend(self.b.body());
        message(B_LABEL, domain, &body)
    }
    pub fn verify_crypto(&self, spend_vk: &PreparedVerifyingKey<Bls12_377>, output_vk: &PreparedVerifyingKey<Bls12_377>, domain: &[u8; 32]) -> Result<()> {
        let expected = op_id(domain, self.a.anchor, &self.a.nullifiers(), &self.b.commitments());
        ensure!(self.a.op == expected && self.b.op == expected, "Parts do not belong to one operation");
        self.a.rk.verify(&self.a.message(domain), &self.a.auth).context("Spend authorization rejected")?;
        let mut sum = Commitment(decaf377::Element::IDENTITY);
        for i in &self.a.inputs {
            sum = sum + i.cv;
        }
        for o in &self.b.outputs {
            sum = sum + o.cv;
        }
        VerificationKey::<Binding>::try_from(sum.to_bytes())?.verify(&self.message_b(domain), &self.b.binding).context("Conservation rejected")?;
        for i in &self.a.inputs {
            i.verify(spend_vk, self.a.anchor, &self.a.rk)?;
        }
        for o in &self.b.outputs {
            o.verify(output_vk)?;
        }
        Ok(())
    }
}
pub struct Built {
    pub a: PartA,
    pub b: PartB,
    pub op: [u8; 32],
    pub change: Option<Note>,
}
/// Build a private transfer: 1..=3 owned notes of one asset -> payment to `to` plus change to self
/// (zero-value change is a real note the recipient wallet ignores). Padding spends are zero-value notes.
pub fn build(ledger: &Ledger, key: &SpendKey, notes: &[Note], to: &Address, amount: u64, spend_pk: &ProvingKey<Bls12_377>, output_pk: &ProvingKey<Bls12_377>, domain: &[u8; 32]) -> Result<Built> {
    ensure!(!notes.is_empty() && notes.len() <= INPUTS, "One to three inputs required");
    let fvk = key.full_viewing_key();
    let asset = notes[0].asset_id();
    let mut seen = BTreeSet::new();
    let mut total = 0u128;
    for n in notes {
        ensure!(n.controlled_by(fvk), "Input belongs to another holder");
        ensure!(n.asset_id() == asset && u128::from(n.amount()) > 0, "Positive same-asset inputs required");
        ensure!(seen.insert(n.commit().0.to_bytes()), "Duplicate input");
        let pos = ledger.tree.position_of(n.commit()).context("Note absent")?;
        ensure!(!ledger.nullifiers.contains(&Nullifier::derive(fvk.nullifier_key(), pos, &n.commit()).0.to_bytes()), "Input spent");
        total = total.checked_add(u128::from(n.amount())).context("Amount overflow")?;
    }
    ensure!(amount > 0 && u128::from(amount) <= total, "Amount must be positive and covered");
    let change_amount = u64::try_from(total - u128::from(amount))?;
    let randomizer = pz::random_fr();
    let mut blind = Fr::from(0u64);
    let mut padded = notes.to_vec();
    while padded.len() < INPUTS {
        padded.push(pz::zero_note(key, asset));
    }
    pz::shuffle(&mut padded);
    let mut inputs = vec![];
    let mut rk = None;
    let anchor = ledger.tree.root();
    for n in &padded {
        let vb = pz::random_fr();
        blind += vb;
        let w = pz::spend_witness(ledger, key, n, randomizer, vb)?;
        rk = Some(w.public.rk);
        inputs.push(pz::prove_spend(spend_pk, w)?);
    }
    let payments: Vec<(Address, Value)> = vec![(to.clone(), value(asset, amount)), (crate::keys::shielded_address(key), value(asset, change_amount))];
    let mut routes = payments;
    pz::shuffle(&mut routes);
    let mut outputs = vec![];
    let mut change = None;
    for (addr, v) in &routes {
        let (w, vb) = pz::output_witness(addr, *v)?;
        blind += vb;
        if *addr == crate::keys::shielded_address(key) {
            change = Some(w.note.clone());
        }
        outputs.push(pz::prove_output(output_pk, w)?);
    }
    let nfs = [inputs[0].nf_bytes(), inputs[1].nf_bytes(), inputs[2].nf_bytes()];
    let cms = [outputs[0].commitment_bytes(), outputs[1].commitment_bytes()];
    let op = op_id(domain, anchor, &nfs, &cms);
    let mut a = PartA { op, anchor, inputs, rk: rk.unwrap(), auth: [0u8; 64].into() };
    a.auth = key.spend_auth_key().randomize(&randomizer).sign(OsRng, &a.message(domain));
    let mut b = PartB { op, outputs, binding: [0u8; 64].into() };
    let m = Operation { a: &a, b: &b }.message_b(domain);
    b.binding = SigningKey::<Binding>::from(blind).sign(OsRng, &m);
    Ok(Built { a, b, op, change })
}
