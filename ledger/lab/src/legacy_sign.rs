//! Monero's ordinary message signature (crypto.cpp generate_signature /
//! check_signature) over ed25519, using curve25519-dalek scalars/points and the
//! Monero keccak-256 from the vendored wallet stack. Signs with the wallet's own
//! derived one-time output secret; never computes a key image.
//!
//! The dalek library performs scalar arithmetic in constant time by design; this
//! module makes NO constant-time claim for the whole path (hashing, retries,
//! allocation, the surrounding process).
use anyhow::{ensure, Result};
use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT as G, edwards::CompressedEdwardsY, scalar::Scalar,
    traits::Identity, EdwardsPoint,
};
use monero_wallet::primitives::keccak256;
use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

fn hash_to_scalar(parts: &[&[u8]]) -> Scalar {
    let mut b = vec![];
    for p in parts {
        b.extend_from_slice(p);
    }
    Scalar::from_bytes_mod_order(keccak256(b))
}
fn point(b: &[u8; 32]) -> Result<EdwardsPoint> {
    CompressedEdwardsY(*b)
        .decompress()
        .filter(|p| p.is_torsion_free())
        .ok_or_else(|| anyhow::anyhow!("Invalid public key"))
}
pub fn public_key(secret: &Scalar) -> [u8; 32] {
    (G * secret).compress().to_bytes()
}
// generate_signature: comm = kG; c = Hs(prefix || pub || comm); r = k - c*sec.
pub fn generate_signature(prefix_hash: &[u8; 32], secret: &Scalar) -> [u8; 64] {
    let pubkey = public_key(secret);
    loop {
        let mut wide = Zeroizing::new([0u8; 64]);
        OsRng.fill_bytes(&mut *wide);
        let k = Zeroizing::new(Scalar::from_bytes_mod_order_wide(&wide));
        let comm = (G * *k).compress().to_bytes();
        let c = hash_to_scalar(&[prefix_hash, &pubkey, &comm]);
        if c == Scalar::ZERO {
            continue;
        }
        let r = *k - c * secret;
        if r == Scalar::ZERO {
            continue;
        }
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&c.to_bytes());
        out[32..].copy_from_slice(&r.to_bytes());
        return out;
    }
}
// check_signature: reject non-canonical or zero c, non-canonical r; comm = cP + rG
// must not be the identity; accept iff Hs(prefix || pub || comm) == c.
pub fn check_signature(prefix_hash: &[u8; 32], pubkey: &[u8; 32], sig: &[u8; 64]) -> bool {
    let (Some(c), Some(r)) = (
        Scalar::from_canonical_bytes(sig[..32].try_into().unwrap()).into(),
        Scalar::from_canonical_bytes(sig[32..].try_into().unwrap()).into(),
    ) else {
        return false;
    };
    let c: Scalar = c;
    let r: Scalar = r;
    if c == Scalar::ZERO {
        return false;
    }
    let Ok(p) = point(pubkey) else { return false };
    let comm = p * c + G * r;
    if comm == EdwardsPoint::identity() {
        return false;
    }
    hash_to_scalar(&[prefix_hash, pubkey, &comm.compress().to_bytes()]) == c
}
pub fn hex32(s: &str) -> Result<[u8; 32]> {
    let b = hex::decode(s)?;
    ensure!(b.len() == 32, "32-byte hex required");
    Ok(b.try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upstream_check_signature_vectors_and_own_signatures() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests-data/upstream-signature-vectors.json"
        );
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let rows = v["vectors"].as_array().unwrap();
        assert_eq!(rows.len(), 40);
        let mut valid = 0;
        for row in rows {
            let h = hex32(row["messageHash"].as_str().unwrap()).unwrap();
            let p = hex32(row["publicKey"].as_str().unwrap()).unwrap();
            let s: [u8; 64] = hex::decode(row["signature"].as_str().unwrap()).unwrap().try_into().unwrap();
            assert_eq!(check_signature(&h, &p, &s), row["valid"].as_bool().unwrap(), "{row}");
            valid += row["valid"].as_bool().unwrap() as u32;
        }
        assert_eq!(valid, 9);
        let mut w = [0u8; 64];
        OsRng.fill_bytes(&mut w);
        let secret = Scalar::from_bytes_mod_order_wide(&w);
        OsRng.fill_bytes(&mut w);
        let other = Scalar::from_bytes_mod_order_wide(&w);
        let h = [7u8; 32];
        let sig = generate_signature(&h, &secret);
        assert!(check_signature(&h, &public_key(&secret), &sig));
        assert!(!check_signature(&h, &public_key(&other), &sig));
        assert!(!check_signature(&[8u8; 32], &public_key(&secret), &sig));
        let mut bad = sig;
        bad[40] ^= 1;
        assert!(!check_signature(&h, &public_key(&secret), &bad));
        assert_ne!(generate_signature(&h, &secret), sig, "randomized");
    }
}
