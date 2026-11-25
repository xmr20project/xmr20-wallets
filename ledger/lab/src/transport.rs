//! tx_extra framing: 254-byte nonce chunks,
//! each prefixed by the 0x7f marker. Accepts ordinary XM3 transfers and the
//! new XB3 boundary records only. Nothing else is admitted from tx_extra.
use anyhow::{ensure, Result};
pub const EXTRA_LIMIT: usize = 1060;
pub fn parts(b: &[u8]) -> Result<Vec<Vec<u8>>> {
    ensure!(
        matches!(
            b.len(),
            xmr20_multi_input_lab::WIRE_BYTES | crate::boundary::WIRE_BYTES
        ),
        "Fixed experimental record sizes only"
    );
    Ok(b.chunks(254).map(|c| c.to_vec()).collect())
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
    ensure!(expected == chunks);
    ensure!(
        b.starts_with(xmr20_multi_input_lab::MAGIC) || b.starts_with(crate::boundary::MAGIC),
        "Unknown application record"
    );
    Ok(Some(b))
}
