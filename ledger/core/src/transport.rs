//! tx_extra framing: 254-byte nonce chunks, each prefixed by the
//! 0x7F marker; exactly one tx pubkey field; at most one encrypted payment id; total <= 1,060 bytes.
//! Records are variable-length in this format; the framing admits any length from 1 to MAX_RECORD
//! bytes whose first four bytes are one of the known magics. Exact structure is checked by the
//! record decoders, never here.
use anyhow::{ensure, Result};

pub const EXTRA_LIMIT: usize = 1060;
pub const CHUNK: usize = 254;
/// Largest record that still fits: 1,060 - 33 (tx pubkey) - 4 chunks x (tag 1 + len 2 + marker 1) = 1,011.
pub const MAX_RECORD: usize = 1011;
pub const MAGICS: [&[u8; 4]; 11] = [
    crate::public::MAGIC_TRANSFER,
    crate::public::MAGIC_CREDIT,
    crate::public::MAGIC_BURN,
    crate::shield::MAGIC_SHIELD,
    crate::shield::MAGIC_UNSHIELD,
    crate::private2::MAGIC_A,
    crate::private2::MAGIC_B,
    crate::market::MAGIC_ANCHORED,
    crate::market::MAGIC_SALE,
    crate::address::MAGIC_MOVE,
    crate::trade::MAGIC_TRADE,
];
pub fn known_magic(b: &[u8]) -> bool {
    b.len() >= 4 && MAGICS.iter().any(|m| b.starts_with(*m))
}
/// Open tokens: the two magics of open.rs. They are not in MAGICS: `known_magic`, `parts` and `unframe` answer for them
/// what they always answered, so everything built on those (record lists, checkpoints, wallets) is unchanged until it
/// asks for open records by name (`unframe_open`, `Pool::open_record`).
pub fn open_magic(b: &[u8]) -> bool {
    b.starts_with(crate::open::MAGIC_MINT) || b.starts_with(crate::open::MAGIC_INSCRIPTION)
}
pub fn parts(b: &[u8]) -> Result<Vec<Vec<u8>>> {
    parts_of(b, false)
}
fn parts_of(b: &[u8], open: bool) -> Result<Vec<Vec<u8>>> {
    ensure!(!b.is_empty() && b.len() <= MAX_RECORD, "Record size out of range");
    ensure!(known_magic(b) || open && open_magic(b), "Unknown application record");
    Ok(b.chunks(CHUNK).map(|c| c.to_vec()).collect())
}
/// The chunks of an XO1 record (a carrier builder frames them like any record's).
pub fn parts_open(b: &[u8]) -> Result<Vec<Vec<u8>>> {
    parts_of(b, true)
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
    unframe_of(extra, false)
}
/// As `unframe`, and also the records of open tokens: an XO1, or an MD1 record in the one order the XMR721 readers take.
/// An error means the same as None: this transaction carries no record (the XMR721 reader answers null for both).
pub fn unframe_open(extra: &[u8]) -> Result<Option<Vec<u8>>> {
    unframe_of(extra, true)
}
/// The record a transaction carries at `height`, for a reader of both: one of the ledger's records as always, or a record of
/// open tokens (from their opening block on, and of the XMR721 ledger's records only an open deploy).
pub fn wire_at(extra: &[u8], open: Option<crate::open::Activation>, height: u64) -> Option<Vec<u8>> {
    unframe(extra).ok().flatten().or_else(|| unframe_open(extra).ok().flatten().filter(|w| crate::open::record_at(open, w, height)))
}
fn unframe_of(extra: &[u8], open: bool) -> Result<Option<Vec<u8>>> {
    ensure!(extra.len() <= EXTRA_LIMIT);
    let mut at = 0usize;
    let mut chunks = vec![];
    let mut pubkeys = 0;
    let mut payment_ids = 0;
    // Open tokens: an MD1 record is read by the XMR721 readers too, and they take one order only (their RULES.md, section
    // 8): the public key first, then the payment id if there is one, then the chunks.
    let mut ordered = extra.first() == Some(&1);
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
                    ordered &= chunks.is_empty();
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
    if open && b.starts_with(crate::open::MAGIC_INSCRIPTION) && !(ordered && b.len() >= 5 && b.len() <= crate::open::MAX_INSCRIPTION) {
        return Ok(None);
    }
    let expected = parts_of(&b, open)?;
    ensure!(expected == chunks, "Noncanonical chunking");
    Ok(Some(b))
}

/// Frame a record exactly as the carrier builder does (tx pubkey field first, then the chunks). Tests and
/// size measurements only; the wallet's native builder frames through monero-wallet with `parts`.
pub fn frame(record: &[u8], tx_pubkey: &[u8; 32]) -> Result<Vec<u8>> {
    frame_of(record, tx_pubkey, false)
}
/// As `frame`, for the records of open tokens too.
pub fn frame_open(record: &[u8], tx_pubkey: &[u8; 32]) -> Result<Vec<u8>> {
    frame_of(record, tx_pubkey, true)
}
fn frame_of(record: &[u8], tx_pubkey: &[u8; 32], open: bool) -> Result<Vec<u8>> {
    let mut out = vec![1u8];
    out.extend(tx_pubkey);
    for c in parts_of(record, open)? {
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
