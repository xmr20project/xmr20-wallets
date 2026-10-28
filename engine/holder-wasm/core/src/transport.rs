//! tx_extra framing (unchanged from the earlier labs): 254-byte nonce chunks, each prefixed by the
//! 0x7F marker; exactly one tx pubkey field; at most one encrypted payment id; total <= 1,060 bytes.
//! Records are variable-length in this format; the framing admits any length from 1 to MAX_RECORD
//! bytes whose first four bytes are one of the known magics. Exact structure is checked by the
//! record decoders, never here.
use anyhow::{ensure, Result};

pub const EXTRA_LIMIT: usize = 1060;
pub const CHUNK: usize = 254;
/// Largest record that still fits: 1,060 - 33 (tx pubkey) - 4 chunks x (tag 1 + len 2 + marker 1) = 1,011.
pub const MAX_RECORD: usize = 1011;
pub const MAGICS: [&[u8; 4]; 7] = [
    crate::public::MAGIC_TRANSFER,
    crate::public::MAGIC_CREDIT,
    crate::public::MAGIC_BURN,
    crate::shield::MAGIC_SHIELD,
    crate::shield::MAGIC_UNSHIELD,
    crate::private2::MAGIC_A,
    crate::private2::MAGIC_B,
];
pub fn known_magic(b: &[u8]) -> bool {
    b.len() >= 4 && MAGICS.iter().any(|m| b.starts_with(*m))
}
pub fn parts(b: &[u8]) -> Result<Vec<Vec<u8>>> {
    ensure!(!b.is_empty() && b.len() <= MAX_RECORD, "Record size out of range");
    ensure!(known_magic(b), "Unknown application record");
    Ok(b.chunks(CHUNK).map(|c| c.to_vec()).collect())
}
/// Exact tx_extra size a record occupies when framed (tx pubkey 33 + chunks), without a payment id.
pub fn framed_extra_len(record_len: usize) -> usize {
    let mut n = 33;
    let mut left = record_len;
    while left > 0 {
        let c = left.min(CHUNK);
        left -= c;
        let l = c + 1;
        n += 1 + if l < 128 { 1 } else { 2 } + l;
    }
    n
}
pub fn unframe(extra: &[u8]) -> Result<Option<Vec<u8>>> {
    ensure!(extra.len() <= EXTRA_LIMIT);
    let mut at = 0usize;
    let mut chunks = vec![];
    let mut pubkeys = 0;
    let mut payment_ids = 0;
    while at < extra.len() {
        let tag = extra[at];
        at += 1;
        match tag {
            1 => {
                pubkeys += 1;
                ensure!(pubkeys == 1 && at + 32 <= extra.len());
                at += 32;
            }
            2 => {
                let mut len = 0usize;
                let mut shift = 0;
                loop {
                    ensure!(at < extra.len() && shift <= 7);
                    let n = extra[at];
                    at += 1;
                    len |= ((n & 127) as usize) << shift;
                    if n < 128 {
                        ensure!(shift == 0 || n != 0, "Noncanonical nonce length");
                        break;
                    }
                    shift += 7;
                }
                ensure!(len > 0 && len <= 255 && at + len <= extra.len());
                let d = &extra[at..at + len];
                at += len;
                if d[0] == 127 {
                    chunks.push(d[1..].to_vec());
                } else {
                    payment_ids += 1;
                    ensure!(payment_ids == 1 && d[0] == 1 && d.len() == 9);
                }
            }
            _ => anyhow::bail!("Unsupported extra field"),
        }
    }
    ensure!(pubkeys == 1);
    if chunks.is_empty() {
        return Ok(None);
    }
    let b = chunks.concat();
    let expected = parts(&b)?;
    ensure!(expected == chunks, "Noncanonical chunking");
    Ok(Some(b))
}

/// Frame a record exactly as the carrier builder does (tx pubkey field first, then the chunks). Tests and
/// size measurements only; the wallet's native builder frames through monero-wallet with `parts`.
pub fn frame(record: &[u8], tx_pubkey: &[u8; 32]) -> Result<Vec<u8>> {
    let mut out = vec![1u8];
    out.extend(tx_pubkey);
    for c in parts(record)? {
        let l = c.len() + 1;
        out.push(2);
        if l < 128 {
            out.push(l as u8);
        } else {
            out.push((l as u8 & 127) | 128);
            out.push((l >> 7) as u8);
        }
        out.push(127);
        out.extend(c);
    }
    ensure!(out.len() <= EXTRA_LIMIT, "Framed record exceeds the relay limit");
    Ok(out)
}
