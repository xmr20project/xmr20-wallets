//! Key schedule XMR20-TKD1 (unchanged for the shielded pool) plus the public-ledger OWNER key.
//!
//!   root = the account's 32-byte Monero private spend key (one recovery phrase restores everything)
//!   tsk  = BLAKE2b-256(key=root, personal="XMR20-TKD1", msg="xmr20/private-token/spend-key"||LE32(account))
//!          -> Penumbra SpendKey (fvk, nullifier key, shielded address index 0)                 [unchanged]
//!   osk  = BLAKE2b-256(key=root, personal="XMR20-TKD1", msg="xmr20/public-token/owner-key"||LE32(account))
//!          reduced mod r -> decaf377-rdsa SigningKey<SpendAuth>; owner key opk = its verification key   [new]
//! Keyed BLAKE2b is a PRF: neither key can be computed without the root and no public value (owner key,
//! shielded address, records) relates to the native Monero keys or to each other. The owner key is
//! separate from ak on purpose: a shared full viewing key must never be able to spend public notes.
//!
//! Unified token address (bech32m, HRP "xmr20t"): shielded address (80 bytes, Penumbra's F4Jumbled
//! encoding) || owner key (32 bytes). "penumbra1…" addresses stay accepted as PRIVATE-ONLY recipients.
use anyhow::{ensure, Context, Result};
use decaf377::Fr;
use decaf377_rdsa::{SigningKey, SpendAuth, VerificationKey};
use penumbra_sdk_keys::{
    keys::{SpendKey, SpendKeyBytes},
    Address,
};
use std::str::FromStr;
use zeroize::Zeroizing;

pub const UNIFIED_HRP: &str = "xmr20t";

fn prf(root: &[u8; 32], msg: &[u8], account: u32) -> Zeroizing<[u8; 32]> {
    let h = blake2b_simd::Params::new()
        .hash_length(32)
        .key(root)
        .personal(b"XMR20-TKD1")
        .to_state()
        .update(msg)
        .update(&account.to_le_bytes())
        .finalize();
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(h.as_bytes());
    out
}
pub fn derive_token_spend_key(root: &[u8; 32], account: u32) -> Zeroizing<[u8; 32]> {
    prf(root, b"xmr20/private-token/spend-key", account)
}
pub fn token_spend_key(root: &[u8; 32], account: u32) -> SpendKey {
    SpendKeyBytes(*derive_token_spend_key(root, account)).into()
}
pub fn owner_signing_key(root: &[u8; 32], account: u32) -> SigningKey<SpendAuth> {
    let bytes = prf(root, b"xmr20/public-token/owner-key", account);
    // The PRF output is uniform over 256 bits; reduction mod r (~2^253) keeps it uniform enough and never fails.
    SigningKey::from(Fr::from_le_bytes_mod_order(&bytes[..]))
}
pub fn owner_key(sk: &SigningKey<SpendAuth>) -> [u8; 32] {
    VerificationKey::from(sk).to_bytes()
}
pub fn owner_vk(bytes: &[u8; 32]) -> Result<VerificationKey<SpendAuth>> {
    VerificationKey::try_from(*bytes).map_err(|_| anyhow::anyhow!("Invalid owner key"))
}
pub fn shielded_address(k: &SpendKey) -> Address {
    k.full_viewing_key().payment_address(0u32.into()).0
}

/// A recipient as given to the wallet: shielded address (always) and, for unified addresses, the owner key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenAddress {
    pub shielded: Address,
    pub owner: Option<[u8; 32]>,
}
impl TokenAddress {
    pub fn unified(shielded: Address, owner: [u8; 32]) -> Self {
        Self { shielded, owner: Some(owner) }
    }
    pub fn encode(&self) -> String {
        match self.owner {
            Some(o) => {
                let mut data = self.shielded.to_vec();
                data.extend(o);
                bech32m_encode(UNIFIED_HRP, &data)
            }
            None => self.shielded.to_string(),
        }
    }
    pub fn parse(s: &str) -> Result<Self> {
        let s = s.trim();
        if let Some(rest) = s.strip_prefix(&format!("{UNIFIED_HRP}1")) {
            let _ = rest;
            let (hrp, data) = bech32m_decode(s)?;
            ensure!(hrp == UNIFIED_HRP, "Token address prefix");
            ensure!(data.len() == 112, "Unified token address must carry 80 + 32 bytes");
            let shielded = Address::try_from(data[..80].to_vec()).map_err(|e| anyhow::anyhow!("Shielded part: {e}"))?;
            let owner: [u8; 32] = data[80..].try_into().unwrap();
            owner_vk(&owner).context("Owner key part")?;
            Ok(Self { shielded, owner: Some(owner) })
        } else if s.starts_with("penumbra1") {
            let shielded = Address::from_str(s).map_err(|e| anyhow::anyhow!("Token address: {e}"))?;
            Ok(Self { shielded, owner: None })
        } else {
            anyhow::bail!("Not a token address (expected xmr20t1… or penumbra1…)")
        }
    }
}

// ---------------------------------------------------------------- bech32m (BIP-350), self-contained
const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST: u32 = 0x2bc830a3;
fn polymod(values: &[u8]) -> u32 {
    let gen = [0x3b6a57b2u32, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let mut chk = 1u32;
    for v in values {
        let top = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ u32::from(*v);
        for (i, g) in gen.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}
fn hrp_expand(hrp: &str) -> Vec<u8> {
    let mut v: Vec<u8> = hrp.bytes().map(|c| c >> 5).collect();
    v.push(0);
    v.extend(hrp.bytes().map(|c| c & 31));
    v
}
fn convert_bits(data: &[u8], from: u32, to: u32, pad: bool) -> Result<Vec<u8>> {
    let mut acc = 0u32;
    let mut bits = 0u32;
    let mut out = vec![];
    let maxv = (1u32 << to) - 1;
    for d in data {
        acc = (acc << from) | u32::from(*d);
        bits += from;
        while bits >= to {
            bits -= to;
            out.push(((acc >> bits) & maxv) as u8);
        }
    }
    if pad {
        if bits > 0 {
            out.push(((acc << (to - bits)) & maxv) as u8);
        }
    } else {
        ensure!(bits < from && ((acc << (to - bits)) & maxv) == 0, "Invalid bech32 padding");
    }
    Ok(out)
}
pub fn bech32m_encode(hrp: &str, data: &[u8]) -> String {
    let d5 = convert_bits(data, 8, 5, true).expect("padding allowed");
    let mut values = hrp_expand(hrp);
    values.extend(&d5);
    values.extend([0u8; 6]);
    let pm = polymod(&values) ^ BECH32M_CONST;
    let mut s = String::from(hrp);
    s.push('1');
    for v in &d5 {
        s.push(CHARSET[*v as usize] as char);
    }
    for i in 0..6 {
        s.push(CHARSET[((pm >> (5 * (5 - i))) & 31) as usize] as char);
    }
    s
}
pub fn bech32m_decode(s: &str) -> Result<(String, Vec<u8>)> {
    ensure!(s == s.to_lowercase() || s == s.to_uppercase(), "Mixed-case bech32");
    let s = s.to_lowercase();
    let pos = s.rfind('1').context("No separator")?;
    ensure!(pos >= 1 && pos + 7 <= s.len(), "Bech32 length");
    let hrp = &s[..pos];
    let mut d5 = vec![];
    for c in s[pos + 1..].bytes() {
        let i = CHARSET.iter().position(|x| *x == c).context("Invalid bech32 character")?;
        d5.push(i as u8);
    }
    let mut values = hrp_expand(hrp);
    values.extend(&d5);
    ensure!(polymod(&values) == BECH32M_CONST, "Bech32m checksum");
    let data = convert_bits(&d5[..d5.len() - 6], 5, 8, false)?;
    Ok((hrp.to_string(), data))
}
