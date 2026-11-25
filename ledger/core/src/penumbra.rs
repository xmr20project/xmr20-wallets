//! Penumbra's unchanged SpendCircuit / OutputCircuit with Penumbra's PUBLISHED Groth16 keys
//! (penumbra-sdk-proof-params 2.1.1: spend_pk.bin 21,673,392 B, output_pk.bin 7,257,360 B, both
//! git-lfs objects of github.com/penumbra-zone/penumbra; spend_vk.param / output_vk.param from the
//! crate). Every loaded key is checked against the crate's PROVING_KEY_ID / VERIFICATION_KEY_ID.
//! Setup assumption inherited: Penumbra's summoning ceremony (phase 1 2023, >15,000 contributors;
//! phase 2 2024). XMR20 runs no setup. Public inputs are ordered exactly as Penumbra's verifiers do:
//! spend = (anchor, balance commitment, nullifier, rk), output = (note commitment, balance commitment).
use anyhow::{ensure, Context, Result};
use ark_ff::{ToConstraintField, UniformRand as _};
use ark_groth16::{Groth16, PreparedVerifyingKey, Proof, ProvingKey, VerifyingKey};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Valid};
use ark_snark::SNARK;
use decaf377::{Bls12_377, Fq, Fr};
use decaf377_rdsa::{SpendAuth, VerificationKey as RdsaVk};
use penumbra_sdk_asset::{asset, balance::Commitment, Value};
use penumbra_sdk_keys::{keys::SpendKey, Address};
use penumbra_sdk_proof_params::{ProvingKeyExt, VerifyingKeyExt};
use penumbra_sdk_proto::DomainType;
use penumbra_sdk_sct::Nullifier;
use penumbra_sdk_shielded_pool::output::{OutputProofPrivate, OutputProofPublic};
use penumbra_sdk_shielded_pool::{Note, OutputCircuit, OutputPlan, SpendCircuit, SpendPlan, SpendProofPrivate, SpendProofPublic};
use penumbra_sdk_tct::{Root, Tree, Witness};
use rand_core::{OsRng, RngCore};

use crate::{ledger::Ledger, value, Payload, Reader};

pub const PROOF_BYTES: usize = 192;
pub const SPEND_PK_BYTES: u64 = 21_673_392;
pub const OUTPUT_PK_BYTES: u64 = 7_257_360;
pub const SPEND_PK_SHA256: &str = "87eca85bef562803fb9684c56c0a6db84aa6d0791b1c00b909e6f2a5c2cff452";
pub const OUTPUT_PK_SHA256: &str = "c9e97866edd6c815a7bcb2f3b5493713794369692bb96e5a2e682613c330e4a8";
pub const SPEND_PK_ID: &str = "groth16pk1ke43yax8cg78h69y0pn6kvjcktdakwq9m4c58nyam8hffweramfqxr94fh";
pub const SPEND_VK_ID: &str = "groth16vk1zu2ks8er6fcj65y7w735wqzj9nx4fd5rsf2483lqyn0jqtlts2hssw2nfh";
pub const OUTPUT_PK_ID: &str = "groth16pk1rkpwdlcaw56gvyqpt0lm7lvj8q9mx93gqpz85dl9l3u677k75reqcnuq7d";
pub const OUTPUT_VK_ID: &str = "groth16vk1lnuw3xdngtwsq42wa5g4ceq3c3zyn6j2c0e57xzde43lznzuvf2sxmsdcc";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Circuit {
    Spend,
    Output,
}
impl Circuit {
    pub fn pk_id(self) -> &'static str {
        match self {
            Circuit::Spend => SPEND_PK_ID,
            Circuit::Output => OUTPUT_PK_ID,
        }
    }
    pub fn vk_id(self) -> &'static str {
        match self {
            Circuit::Spend => SPEND_VK_ID,
            Circuit::Output => OUTPUT_VK_ID,
        }
    }
}
/// Penumbra proving key file (uncompressed ark serialization). The caller authenticates the bytes
/// (length + sha256) against the shipped manifest BEFORE calling this; the key id is checked here too.
pub fn load_pk(circuit: Circuit, bytes: &[u8]) -> Result<ProvingKey<Bls12_377>> {
    let pk: ProvingKey<Bls12_377> = ProvingKey::deserialize_uncompressed_unchecked(bytes).context("Proving key format")?;
    ensure!(pk.debug_id() == circuit.pk_id(), "Proving key id {} is not Penumbra's {:?} key {}", pk.debug_id(), circuit, circuit.pk_id());
    Ok(pk)
}
/// Penumbra verifying key file (*.param, uncompressed), fully validated, id-checked.
pub fn load_vk_param(circuit: Circuit, bytes: &[u8]) -> Result<VerifyingKey<Bls12_377>> {
    let vk: VerifyingKey<Bls12_377> = VerifyingKey::deserialize_uncompressed_unchecked(bytes).context("Verifying key format")?;
    vk.check()?;
    ensure!(vk.debug_id() == circuit.vk_id(), "Verifying key id {} is not Penumbra's {:?} key {}", vk.debug_id(), circuit, circuit.vk_id());
    Ok(vk)
}
pub fn vk_hex(vk: &VerifyingKey<Bls12_377>) -> String {
    let mut b = vec![];
    vk.serialize_compressed(&mut b).expect("serialize");
    hex::encode(b)
}
/// Verifying key from its compressed hex form (as pinned in parameters.json / the manifest); id-checked.
pub fn read_vk(circuit: Circuit, hex_vk: &str) -> Result<PreparedVerifyingKey<Bls12_377>> {
    let vk = VerifyingKey::<Bls12_377>::deserialize_compressed(hex::decode(hex_vk)?.as_slice())?;
    ensure!(vk.debug_id() == circuit.vk_id(), "Pinned {:?} verifying key is not Penumbra's ({})", circuit, vk.debug_id());
    Ok(ark_groth16::prepare_verifying_key(&vk))
}
pub fn pk_matches_vk(pk: &ProvingKey<Bls12_377>, hex_vk: &str) -> bool {
    vk_hex(&pk.vk) == hex_vk
}

// ---------------------------------------------------------------- wire pieces
#[derive(Clone, Debug)]
pub struct ShieldedInput {
    pub cv: Commitment,
    pub nf: Nullifier,
    pub proof: [u8; PROOF_BYTES],
}
impl ShieldedInput {
    pub const BYTES: usize = 32 + 32 + PROOF_BYTES;
    pub fn encode(&self, b: &mut Vec<u8>) {
        b.extend(self.cv.to_bytes());
        b.extend(self.nf.0.to_bytes());
        b.extend(self.proof);
    }
    pub fn decode(r: &mut Reader) -> Result<Self> {
        Ok(Self { cv: Commitment::try_from(r.take(32)?)?, nf: Nullifier::try_from(r.take(32)?)?, proof: r.take(PROOF_BYTES)?.try_into()? })
    }
    pub fn nf_bytes(&self) -> [u8; 32] {
        self.nf.0.to_bytes()
    }
    pub fn verify(&self, vk: &PreparedVerifyingKey<Bls12_377>, anchor: Root, rk: &RdsaVk<SpendAuth>) -> Result<()> {
        let mut v = vec![];
        push(&mut v, Fq::from(anchor))?;
        push(&mut v, self.cv.0)?;
        push(&mut v, self.nf.0)?;
        push(&mut v, decaf377::Encoding(rk.to_bytes()).vartime_decompress().map_err(|_| anyhow::anyhow!("Invalid randomized key"))?)?;
        verify_proof(vk, &self.proof, &v).context("Spend proof rejected")
    }
}
#[derive(Clone, Debug)]
pub struct ShieldedOutput {
    pub cv: Commitment,
    pub payload: Payload,
    pub proof: [u8; PROOF_BYTES],
}
impl ShieldedOutput {
    pub const BYTES: usize = 32 + crate::payload::PAYLOAD_BYTES + PROOF_BYTES;
    pub fn encode(&self, b: &mut Vec<u8>) {
        b.extend(self.cv.to_bytes());
        b.extend(self.payload.encode());
        b.extend(self.proof);
    }
    pub fn decode(r: &mut Reader) -> Result<Self> {
        Ok(Self { cv: Commitment::try_from(r.take(32)?)?, payload: Payload::decode(r.take(crate::payload::PAYLOAD_BYTES)?)?, proof: r.take(PROOF_BYTES)?.try_into()? })
    }
    pub fn commitment_bytes(&self) -> [u8; 32] {
        self.payload.note_commitment.0.to_bytes()
    }
    pub fn verify(&self, vk: &PreparedVerifyingKey<Bls12_377>) -> Result<()> {
        let mut v = vec![];
        push(&mut v, self.payload.note_commitment.0)?;
        push(&mut v, self.cv.0)?;
        verify_proof(vk, &self.proof, &v).context("Output proof rejected")
    }
}
fn push<T: ToConstraintField<Fq>>(v: &mut Vec<Fq>, x: T) -> Result<()> {
    v.extend(x.to_field_elements().context("Public input encoding")?);
    Ok(())
}
fn verify_proof(vk: &PreparedVerifyingKey<Bls12_377>, proof: &[u8; PROOF_BYTES], inputs: &[Fq]) -> Result<()> {
    let p = Proof::<Bls12_377>::deserialize_compressed(proof.as_slice())?;
    ensure!(Groth16::<Bls12_377>::verify_with_processed_vk(vk, inputs, &p)?, "Groth16 proof rejected");
    Ok(())
}
pub fn root_from_bytes(b: &[u8]) -> Result<Root> {
    let mut root = vec![10, 32];
    root.extend(b);
    Root::decode(root.as_slice()).map_err(|e| anyhow::anyhow!("Anchor: {e}"))
}
pub fn root_bytes(r: Root) -> [u8; 32] {
    Fq::from(r).to_bytes()
}

// ---------------------------------------------------------------- prover-side witnesses
pub struct SpendWitness {
    pub public: SpendProofPublic,
    pub private: SpendProofPrivate,
}
pub struct OutputWitness {
    pub public: OutputProofPublic,
    pub private: OutputProofPrivate,
    pub payload: Payload,
    pub note: Note,
}
pub fn zero_note(key: &SpendKey, asset: asset::Id) -> Note {
    Note::generate(&mut OsRng, &crate::keys::shielded_address(key), value(asset, 0))
}
/// Spend witness for one note. Zero-value padding notes (never in the pool) are witnessed in a
/// scratch tree, as upstream permits; real notes are witnessed in the ledger's tree.
pub fn spend_witness(ledger: &Ledger, key: &SpendKey, note: &Note, randomizer: Fr, blind: Fr) -> Result<SpendWitness> {
    let mut scratch = Tree::new();
    let (pos, path) = if u128::from(note.amount()) == 0 {
        scratch.insert(Witness::Keep, note.commit())?;
        (scratch.position_of(note.commit()).unwrap(), scratch.witness(note.commit()).unwrap())
    } else {
        (ledger.tree.position_of(note.commit()).context("Note absent from the pool")?, ledger.tree.witness(note.commit()).context("Missing witness")?)
    };
    let fvk = key.full_viewing_key();
    let mut plan = SpendPlan::new(&mut OsRng, note.clone(), pos);
    plan.randomizer = randomizer;
    plan.value_blinding = blind;
    Ok(SpendWitness {
        public: SpendProofPublic { anchor: ledger.tree.root(), balance_commitment: plan.balance().commit(blind), nullifier: plan.nullifier(fvk), rk: plan.rk(fvk) },
        private: SpendProofPrivate { state_commitment_proof: path, note: note.clone(), v_blinding: blind, spend_auth_randomizer: randomizer, ak: *fvk.spend_verification_key(), nk: *fvk.nullifier_key() },
    })
}
pub fn output_witness(to: &Address, v: Value) -> Result<(OutputWitness, Fr)> {
    let o = OutputPlan::new(&mut OsRng, v, to.clone());
    let n = o.output_note();
    let cv = o.balance().commit(o.value_blinding);
    Ok((
        OutputWitness { public: OutputProofPublic { balance_commitment: cv, note_commitment: n.commit() }, private: OutputProofPrivate { note: n.clone(), balance_blinding: o.value_blinding }, payload: Payload::encrypt(&n)?, note: n },
        o.value_blinding,
    ))
}
pub fn prove_spend(pk: &ProvingKey<Bls12_377>, w: SpendWitness) -> Result<ShieldedInput> {
    let cv = w.public.balance_commitment;
    let nf = w.public.nullifier;
    let proof = Groth16::<Bls12_377>::create_random_proof_with_reduction(SpendCircuit::from_parts(w.public, w.private), pk, &mut OsRng)?;
    Ok(ShieldedInput { cv, nf, proof: compress(&proof)? })
}
pub fn prove_output(pk: &ProvingKey<Bls12_377>, w: OutputWitness) -> Result<ShieldedOutput> {
    let cv = w.public.balance_commitment;
    let proof = Groth16::<Bls12_377>::create_random_proof_with_reduction(OutputCircuit::new(w.public, w.private), pk, &mut OsRng)?;
    Ok(ShieldedOutput { cv, payload: w.payload, proof: compress(&proof)? })
}
fn compress(p: &Proof<Bls12_377>) -> Result<[u8; PROOF_BYTES]> {
    let mut b = vec![];
    p.serialize_compressed(&mut b)?;
    ensure!(b.len() == PROOF_BYTES);
    Ok(b.try_into().unwrap())
}
pub fn random_fr() -> Fr {
    Fr::rand(&mut OsRng)
}
pub fn shuffle<T>(v: &mut [T]) {
    for i in (1..v.len()).rev() {
        let j = (OsRng.next_u32() as usize) % (i + 1);
        v.swap(i, j);
    }
}
