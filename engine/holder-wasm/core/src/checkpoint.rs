//! FAST START (2 Nov 2026, research/sign-to-move-20261101): the signed anchor of a token-ledger checkpoint, posted about once a day
//! by the bridge's issuer in an ordinary Monero transaction. NOT a record: its magic is not in transport::MAGICS, so every token
//! reader (old and new) sees no record in that transaction and nothing about balances depends on it. Wallets that start the
//! ledger from an indexer's list compare that list with the newest anchor (records + listHash) and check its issuer signature.
//!   anchor = magic4 ("XCK\xfd") height4 blockHash32 listHash32 records4 sig64
//!   listHash = SHA-256 over "height:txid\n" for every record-carrying transaction at or below `height`, in chain order
//!   sig = the issuer's SpendAuth signature over message(LABEL, ledger domain, everything before sig)
use anyhow::{ensure, Context, Result};
use decaf377_rdsa::{Signature, SigningKey, SpendAuth, VerificationKey};
use rand_core::OsRng;

use crate::message;

pub const MAGIC: &[u8; 4] = b"XCK\xfd";
pub const LABEL: &[u8] = b"XMR20-CHECKPOINT-v1\0";
pub const BYTES: usize = 4 + 4 + 32 + 32 + 4 + 64;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub height: u32,
    pub block_hash: [u8; 32],
    pub list_hash: [u8; 32],
    pub records: u32,
}
impl Anchor {
    fn body(&self) -> Vec<u8> {
        let mut b = MAGIC.to_vec();
        b.extend(self.height.to_le_bytes());
        b.extend(self.block_hash);
        b.extend(self.list_hash);
        b.extend(self.records.to_le_bytes());
        b
    }
    pub fn sign(&self, issuer: &SigningKey<SpendAuth>, domain: &[u8; 32]) -> Vec<u8> {
        let mut b = self.body();
        let sig = issuer.sign(OsRng, &message(LABEL, domain, &b));
        b.extend(<[u8; 64]>::from(sig));
        b
    }
    /// Decode and check one anchor (the issuer's key and the ledger domain come from the shipped parameter manifest).
    pub fn verify(wire: &[u8], issuer: &VerificationKey<SpendAuth>, domain: &[u8; 32]) -> Result<Self> {
        ensure!(wire.len() == BYTES && &wire[..4] == MAGIC, "Not a checkpoint anchor");
        let a = Self {
            height: u32::from_le_bytes(wire[4..8].try_into().unwrap()),
            block_hash: wire[8..40].try_into().unwrap(),
            list_hash: wire[40..72].try_into().unwrap(),
            records: u32::from_le_bytes(wire[72..76].try_into().unwrap()),
        };
        let sig = Signature::<SpendAuth>::from(<[u8; 64]>::try_from(&wire[76..]).context("signature")?);
        issuer.verify(&message(LABEL, domain, &a.body()), &sig).map_err(|_| anyhow::anyhow!("Checkpoint anchor not signed by the issuer"))?;
        Ok(a)
    }
    /// The anchor in a carrier's extra field: its 0x7F data chunks joined (a record would have a record magic instead).
    pub fn from_extra(extra: &[u8]) -> Option<Vec<u8>> {
        let mut at = 0usize;
        let mut chunks: Vec<u8> = vec![];
        while at < extra.len() {
            let tag = extra[at];
            at += 1;
            match tag {
                1 => at += 32,
                2 => {
                    // varint length (a 141-byte nonce takes two length bytes)
                    let (mut n, mut shift) = (0usize, 0);
                    loop {
                        let b = *extra.get(at)?;
                        at += 1;
                        n |= ((b & 127) as usize) << shift;
                        if b < 128 {
                            break;
                        }
                        shift += 7;
                        if shift > 14 {
                            return None;
                        }
                    }
                    if at + n > extra.len() || n == 0 {
                        return None;
                    }
                    let d = &extra[at..at + n];
                    at += n;
                    if d[0] == 127 {
                        chunks.extend(&d[1..]);
                    }
                }
                _ => return None,
            }
        }
        (chunks.len() == BYTES && &chunks[..4] == MAGIC).then_some(chunks)
    }
}
