//! Experimental recipient-only codec. This is NOT the upstream note ciphertext.
//! Standard wallet-derived shielded addresses (and the transparent special case)
//! are reconstructible. Arbitrary custom clue-key addresses are not supported.
use anyhow::{ensure, Result};
use decaf377_ka as ka;
use penumbra_sdk_keys::{
    keys::Diversifier,
    symmetric::{PayloadKey, PayloadKind},
    FullViewingKey,
};
use penumbra_sdk_shielded_pool::Note;
use penumbra_sdk_tct::StateCommitment;

pub const PAYLOAD_BYTES: usize = 176; // commitment32 + epk32 + ciphertext112
#[derive(Clone)]
pub struct Payload {
    pub note_commitment: StateCommitment,
    pub ephemeral_key: ka::Public,
    pub ciphertext: [u8; 112],
}
fn key(shared: &ka::SharedSecret, epk: &ka::Public, cm: StateCommitment) -> PayloadKey {
    // Independent KDF domain from Penumbra_Payload. Includes the commitment,
    // so changing any reconstructed note field changes the encryption key.
    // Nonce zero is used only under this per-note derived key, as in upstream.
    let h = blake2b_simd::Params::new()
        .hash_length(32)
        .personal(b"XMR20_M3_Cipher")
        .to_state()
        .update(b"compact-note-v1\0")
        .update(&shared.0)
        .update(&epk.0)
        .update(&cm.0.to_bytes())
        .finalize();
    PayloadKey::try_from(h.as_bytes()).expect("32-byte KDF")
}
fn nonidentity(p: &ka::Public) -> Result<()> {
    let x = decaf377::Encoding(p.0)
        .vartime_decompress()
        .map_err(|_| anyhow::anyhow!("Invalid encryption point"))?;
    ensure!(
        x != decaf377::Element::IDENTITY,
        "Identity encryption point"
    );
    Ok(())
}
impl Payload {
    pub fn encrypt(note: &Note) -> Result<Self> {
        let epk = note.ephemeral_public_key();
        nonidentity(&epk)?;
        nonidentity(note.transmission_key())?;
        let cm = note.commit();
        let shared = note
            .ephemeral_secret_key()
            .key_agreement_with(note.transmission_key())?;
        let bytes = note.to_bytes();
        // Address::to_vec() is F4Jumbled: take the raw diversifier explicitly.
        let mut plain = note.diversifier().0.to_vec();
        plain.extend(&bytes[80..]); // amount16, asset32, seed32; omit two reconstructible keys
        ensure!(plain.len() == 96);
        let cipher = key(&shared, &epk, cm).encrypt(plain, PayloadKind::Note);
        Ok(Self {
            note_commitment: cm,
            ephemeral_key: epk,
            ciphertext: cipher.try_into().unwrap(),
        })
    }
    pub fn decrypt(&self, fvk: &FullViewingKey) -> Result<Note> {
        nonidentity(&self.ephemeral_key)?;
        let ivk = fvk.incoming();
        let shared = ivk.key_agreement_with(&self.ephemeral_key)?;
        let plain = key(&shared, &self.ephemeral_key, self.note_commitment)
            .decrypt(self.ciphertext.to_vec(), PayloadKind::Note)?;
        ensure!(plain.len() == 96);
        let d = Diversifier(plain[..16].try_into()?);
        let standard = ivk.payment_address(ivk.index_for_diversifier(&d)).0;
        let mut candidates = vec![standard];
        if plain[..16] == [0; 16] {
            candidates.push(ivk.transparent_address().parse()?);
        }
        for a in candidates {
            let mut bytes = a.to_vec();
            bytes.extend(&plain[16..]);
            let note = Note::try_from(bytes.as_slice())?;
            if note.commit() == self.note_commitment
                && note.ephemeral_public_key() == self.ephemeral_key
                && note.controlled_by(fvk)
            {
                return Ok(note);
            }
        }
        anyhow::bail!("Ciphertext does not reconstruct the committed recipient note")
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.note_commitment.0.to_bytes().to_vec();
        b.extend(self.ephemeral_key.0);
        b.extend(self.ciphertext);
        b
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(b.len() == PAYLOAD_BYTES);
        let p = Self {
            note_commitment: StateCommitment::try_from(&b[..32])?,
            ephemeral_key: ka::Public(b[32..64].try_into()?),
            ciphertext: b[64..].try_into()?,
        };
        nonidentity(&p.ephemeral_key)?;
        Ok(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value;
    use penumbra_sdk_keys::{keys::{SpendKey, SpendKeyBytes}, Address};
    use rand_core::{OsRng, RngCore};
    fn fresh_key() -> SpendKey {
        let mut b = [0; 32];
        OsRng.fill_bytes(&mut b);
        SpendKeyBytes(b).into()
    }
    fn address(k: &SpendKey) -> Address {
        crate::keys::shielded_address(k)
    }
    fn test_asset() -> penumbra_sdk_asset::asset::Id {
        crate::asset_for_mint("PayloadTestMint").unwrap()
    }
    fn plaintext(n: &Note) -> Vec<u8> {
        let mut p = n.diversifier().0.to_vec();
        p.extend(&n.to_bytes()[80..]);
        p
    }
    // Re-encrypt with genuine authentication tags, bypassing ordinary corruption
    // tests: receipt validation must still enforce the committed note contents.
    fn encrypt_chosen(transport: &Note, cm: StateCommitment, plain: Vec<u8>) -> Payload {
        let epk = transport.ephemeral_public_key();
        let shared = transport
            .ephemeral_secret_key()
            .key_agreement_with(transport.transmission_key())
            .unwrap();
        Payload {
            note_commitment: cm,
            ephemeral_key: epk,
            ciphertext: key(&shared, &epk, cm)
                .encrypt(plain, PayloadKind::Note)
                .try_into()
                .unwrap(),
        }
    }
    #[test]
    fn authenticated_wrong_fields_do_not_credit_wallet() {
        let k = fresh_key();
        let n = Note::generate(&mut OsRng, &address(&k), value(test_asset(), 123));
        for i in [0, 16, 32, 64] {
            let mut p = plaintext(&n);
            p[i] ^= 1;
            assert!(encrypt_chosen(&n, n.commit(), p)
                .decrypt(k.full_viewing_key())
                .is_err());
        }
    }
    #[test]
    fn matching_commitment_still_requires_rseed_ephemeral_key_integrity() {
        let k = fresh_key();
        let transport = Note::generate(&mut OsRng, &address(&k), value(test_asset(), 123));
        let committed = Note::generate(&mut OsRng, &address(&k), value(test_asset(), 123));
        let p = encrypt_chosen(&transport, committed.commit(), plaintext(&committed));
        assert!(p.decrypt(k.full_viewing_key()).is_err());
    }
    #[test]
    fn zero_and_full_128_bit_amounts_recover_without_truncation() {
        let k = fresh_key();
        for amount in [0, u128::MAX] {
            let n = Note::generate(
                &mut OsRng,
                &address(&k),
                penumbra_sdk_asset::Value {
                    asset_id: test_asset(),
                    amount: amount.into(),
                },
            );
            assert_eq!(
                Payload::encrypt(&n)
                    .unwrap()
                    .decrypt(k.full_viewing_key())
                    .unwrap()
                    .to_bytes(),
                n.to_bytes()
            );
        }
    }
    #[test]
    fn unsupported_custom_clue_key_does_not_create_false_wallet_credit() {
        let k = fresh_key();
        let a = address(&k);
        let other = address(&fresh_key());
        let custom = penumbra_sdk_keys::Address::from_components(
            *a.diversifier(),
            *a.transmission_key(),
            *other.clue_key(),
        )
        .unwrap();
        let n = Note::generate(&mut OsRng, &custom, value(test_asset(), 123));
        assert!(Payload::encrypt(&n)
            .unwrap()
            .decrypt(k.full_viewing_key())
            .is_err());
    }
}

impl std::fmt::Debug for Payload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Payload({})", hex::encode(self.note_commitment.0.to_bytes()))
    }
}
