//! MONERO MARKET candidate (30 Oct 2026): anchored NFT sales on XMR20-NFT-V2. EXPERIMENTAL, UNREVIEWED, LAB ONLY.
//!
//! The NFT wire format is unchanged: same signing domain ("XMR20-NFT-V2\n"), carrier magic ("XMR20T2" + raw deflate of
//! the JSON envelope), "XM2" tx_extra fragments and 984-byte limit. The market adds two operations, which a reader must
//! accept from one activation height (the historical reader rejects them as unsupported):
//!
//!   nft_anchor {token, prev, anchor}                     owner binds the NFT to one native key image
//!   nft_sale   {token, prev, to, anchor, offer, terms}   owner sells it inside the buyer-built transaction
//!
//! and one rule: once anchored, every operation consuming the NFT (transfer, sale, re-anchor) is accepted only if its
//! own carrier spends the anchor key image. This module builds, compresses, frames and checks those records inside the
//! wallet engine, so the owner's spend-key signature for them is only ever produced together with the native
//! transaction that carries it.
use anyhow::{ensure, Context, Result};
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT as G, edwards::CompressedEdwardsY, scalar::Scalar as DS};
use monero_wallet::{
    address::{AddressType, MoneroAddress, Network},
    primitives::keccak256,
};
use sha2::{Digest, Sha256};

pub const DOMAIN: &str = "XMR20-NFT-V2\n";
pub const MAGIC: &[u8; 7] = b"XMR20T2";
pub const LIMIT: usize = 984;
pub const EXPANSION_LIMIT: usize = 16384;
pub const LISTING_DOMAIN: &str = "XMR20-MARKET-NFT-LISTING-V1\n";
const TERMS_DOMAIN: &[u8] = b"XMR20-MARKET-NFT-TERMS-V1";
const FRAGMENT: usize = 250;
/// Placeholder data the construction reserves (monero-oxide nonces 0x7F + payload): the same 1,016 extra bytes as the
/// largest NFT carrier's fragments, so the fee is fixed and every carrier up to LIMIT fits.
const PLACEHOLDER_PARTS: [usize; 4] = [254, 254, 254, 238];

pub fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}
pub fn signing_message(record_json: &str) -> String {
    format!("{DOMAIN}{}", sha256_hex(record_json.as_bytes()))
}
pub fn is_hex(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}
/// XMR20-NFT-V2 owner/recipient: a standard mainnet-format address (the lab fakechain uses the mainnet format).
pub fn address(s: &str) -> Result<MoneroAddress> {
    ensure!(s.len() == 95 && s.starts_with('4'), "NFT addresses are standard mainnet-format addresses");
    let a = MoneroAddress::from_str(Network::Mainnet, s).map_err(|e| anyhow::anyhow!("Address: {e:?}"))?;
    ensure!(*a.kind() == AddressType::Legacy, "Standard (primary) address required");
    Ok(a)
}

// ---------------------------------------------------------------- records (exact JSON bytes: the signature binds them)
pub fn anchor_json(owner: &str, nonce: &str, token: &str, prev: &str, anchor: &str) -> Result<String> {
    address(owner)?;
    ensure!(is_hex(nonce, 32) && is_hex(token, 64) && is_hex(prev, 64) && is_hex(anchor, 64), "Invalid nft_anchor fields");
    Ok(format!(r#"{{"p":"xmr20","v":2,"net":"mainnet","op":"nft_anchor","owner":"{owner}","nonce":"{nonce}","token":"{token}","prev":"{prev}","anchor":"{anchor}"}}"#))
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaleRecord {
    pub owner: String,
    pub nonce: String,
    pub token: String,
    pub prev: String,
    pub to: String,
    pub anchor: String,
    pub offer: String,
    pub terms: String,
}
impl SaleRecord {
    pub fn json(&self) -> Result<String> {
        address(&self.owner)?;
        address(&self.to)?;
        ensure!(self.to != self.owner, "Sale to the current owner");
        for (v, n) in [(&self.nonce, 32), (&self.token, 64), (&self.prev, 64), (&self.anchor, 64), (&self.offer, 64), (&self.terms, 64)] {
            ensure!(is_hex(v, n), "Invalid nft_sale field");
        }
        let s = self;
        Ok(format!(
            r#"{{"p":"xmr20","v":2,"net":"mainnet","op":"nft_sale","owner":"{}","nonce":"{}","token":"{}","prev":"{}","to":"{}","anchor":"{}","offer":"{}","terms":"{}"}}"#,
            s.owner, s.nonce, s.token, s.prev, s.to, s.anchor, s.offer, s.terms
        ))
    }
    /// Parse a sale record and require its exact canonical bytes (field order fixed, nothing else present).
    pub fn parse(json: &str) -> Result<Self> {
        let v: serde_json::Value = serde_json::from_str(json)?;
        let f = |k: &str| -> Result<String> { Ok(v[k].as_str().with_context(|| format!("nft_sale.{k}"))?.to_string()) };
        ensure!(v["op"] == "nft_sale", "Not an nft_sale record");
        let r = Self { owner: f("owner")?, nonce: f("nonce")?, token: f("token")?, prev: f("prev")?, to: f("to")?, anchor: f("anchor")?, offer: f("offer")?, terms: f("terms")? };
        ensure!(r.json()? == json, "Sale record is not in its canonical form");
        Ok(r)
    }
}
pub fn envelope(record_json: &str, signature: &str) -> String {
    format!(r#"{{"record":{record_json},"signature":"{signature}"}}"#)
}
/// (record JSON, signature) of an envelope produced by `envelope` (the reader requires this exact serialization).
pub fn split_envelope(env: &str) -> Result<(&str, &str)> {
    let rest = env.strip_prefix(r#"{"record":"#).context("Envelope prefix")?.strip_suffix(r#""}"#).context("Envelope suffix")?;
    let pos = rest.rfind(r#","signature":""#).context("Envelope signature")?;
    let (rec, sig) = (&rest[..pos], &rest[pos + 14..]);
    ensure!(sig.len() == 93 && sig.starts_with("SigV2"), "Invalid signature format");
    Ok((rec, sig))
}

// ---------------------------------------------------------------- carrier: MAGIC + raw deflate(envelope)
pub fn carrier(envelope: &str) -> Result<Vec<u8>> {
    ensure!(envelope.len() <= EXPANSION_LIMIT, "Envelope too large");
    let mut b = MAGIC.to_vec();
    b.extend(miniz_oxide::deflate::compress_to_vec(envelope.as_bytes(), 9));
    ensure!(b.len() <= LIMIT, "NFT carrier is {} bytes; the limit is {LIMIT}", b.len());
    ensure!(open(&b)? == envelope, "Carrier round trip failed");
    Ok(b)
}
/// Inflate a carrier as the reader does: whole compressed input consumed, output within the expansion limit, UTF-8.
pub fn open(carrier: &[u8]) -> Result<String> {
    use miniz_oxide::inflate::{core::{decompress, inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF, DecompressorOxide}, TINFLStatus};
    ensure!(carrier.len() <= LIMIT && carrier.len() > MAGIC.len() && carrier.starts_with(MAGIC), "Invalid carrier");
    let data = &carrier[MAGIC.len()..];
    let mut out = vec![0u8; EXPANSION_LIMIT];
    let mut d = DecompressorOxide::new();
    let (status, consumed, written) = decompress(&mut d, data, &mut out, 0, TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
    ensure!(status == TINFLStatus::Done, "Carrier does not inflate ({status:?})");
    ensure!(consumed == data.len(), "Trailing compressed bytes");
    out.truncate(written);
    Ok(String::from_utf8(out).context("Invalid UTF-8")?)
}

// ---------------------------------------------------------------- tx_extra: "XM2" + index + total + 250-byte chunks
pub fn fragments(carrier: &[u8]) -> Result<Vec<Vec<u8>>> {
    ensure!(!carrier.is_empty() && carrier.len() <= LIMIT, "Invalid carrier");
    let total = carrier.len().div_ceil(FRAGMENT);
    Ok((0..total).map(|i| [b"XM2".as_slice(), &[i as u8, total as u8], &carrier[i * FRAGMENT..((i + 1) * FRAGMENT).min(carrier.len())]].concat()).collect())
}
pub fn placeholder_parts() -> Vec<Vec<u8>> {
    PLACEHOLDER_PARTS.iter().map(|n| vec![0u8; *n]).collect()
}
fn fields(extra: &[u8]) -> Result<Vec<(u8, Vec<u8>)>> {
    let mut at = 0usize;
    let mut out = vec![];
    while at < extra.len() {
        let tag = extra[at];
        at += 1;
        match tag {
            1 => {
                ensure!(at + 32 <= extra.len(), "Truncated tx pubkey");
                out.push((1, extra[at..at + 32].to_vec()));
                at += 32;
            }
            2 => {
                let mut len = 0usize;
                let mut shift = 0;
                loop {
                    ensure!(at < extra.len() && shift <= 14, "Bad nonce length");
                    let n = extra[at];
                    at += 1;
                    len |= ((n & 127) as usize) << shift;
                    if n < 128 {
                        break;
                    }
                    shift += 7;
                }
                ensure!(len <= 255 && at + len <= extra.len(), "Bad nonce");
                out.push((2, extra[at..at + len].to_vec()));
                at += len;
            }
            _ => anyhow::bail!("Unsupported extra field {tag}"),
        }
    }
    Ok(out)
}
fn write_nonce(out: &mut Vec<u8>, n: &[u8]) {
    out.push(2);
    if n.len() < 128 {
        out.push(n.len() as u8);
    } else {
        out.push((n.len() & 127) as u8 | 128);
        out.push((n.len() >> 7) as u8);
    }
    out.extend_from_slice(n);
}
/// Replace the construction's placeholder data with the carrier's fragments. Every other field (tx pubkey, the dummy
/// payment id monero-oxide adds to two-output transactions) is kept in place; the placeholder must be exactly ours.
pub fn final_extra(extra: &[u8], carrier: &[u8]) -> Result<Vec<u8>> {
    let fs = fields(extra)?;
    let expected: Vec<Vec<u8>> = placeholder_parts().into_iter().map(|p| [vec![0x7f], p].concat()).collect();
    let ph: Vec<usize> = fs.iter().enumerate().filter(|(_, (t, b))| *t == 2 && b.first() == Some(&0x7f)).map(|(i, _)| i).collect();
    ensure!(ph.len() == expected.len() && ph.iter().zip(&expected).all(|(i, e)| fs[*i].1 == *e), "Extra does not carry the NFT placeholder");
    ensure!(ph.windows(2).all(|w| w[1] == w[0] + 1), "Placeholder fields are not contiguous");
    ensure!(fs.iter().filter(|(t, _)| *t == 1).count() == 1 && fs[0].0 == 1, "Exactly one leading tx pubkey expected");
    let mut out = vec![];
    for (i, (t, b)) in fs.iter().enumerate() {
        if i == ph[0] {
            for f in fragments(carrier)? {
                write_nonce(&mut out, &f);
            }
        }
        if ph.contains(&i) {
            continue;
        }
        if *t == 1 {
            out.push(1);
            out.extend_from_slice(b);
        } else {
            ensure!(!b.starts_with(b"XM2"), "Extra already carries NFT fragments");
            write_nonce(&mut out, b);
        }
    }
    ensure!(out.len() <= extra.len() && out.len() <= 1060, "Final extra larger than the reserved space");
    ensure!(extract(&out)?.as_deref() == Some(carrier), "Final extra does not carry the carrier");
    Ok(out)
}
/// The reader's extractCarrier: XM2 nonces in order, at most five, equal sizes except the last.
pub fn extract(extra: &[u8]) -> Result<Option<Vec<u8>>> {
    ensure!(extra.len() <= 1060, "Extra too large");
    let frs: Vec<Vec<u8>> = fields(extra)?.into_iter().filter(|(t, b)| *t == 2 && b.starts_with(b"XM2")).map(|(_, b)| b).collect();
    if frs.is_empty() {
        return Ok(None);
    }
    ensure!(frs.len() <= 5, "Too many fragments");
    for (i, b) in frs.iter().enumerate() {
        ensure!(b.len() > 5 && b[3] as usize == i && b[4] as usize == frs.len(), "Fragment order");
        ensure!(i == frs.len() - 1 || b.len() == frs[0].len(), "Fragment size");
    }
    Ok(Some(frs.iter().flat_map(|b| b[5..].to_vec()).collect()))
}

// ---------------------------------------------------------------- SigV2 verification (as monero-wallet-rpc `verify`)
fn monero_base58_decode(s: &str) -> Result<Vec<u8>> {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const SIZES: [usize; 12] = [0, 0, 1, 2, 0, 3, 4, 5, 0, 6, 7, 8]; // encoded chars -> bytes (0 = invalid except 0)
    let mut out = vec![];
    for block in s.as_bytes().chunks(11) {
        let size = SIZES.get(block.len()).copied().unwrap_or(0);
        ensure!(size > 0, "Invalid base58 block");
        let mut n: u128 = 0;
        for c in block {
            let d = ALPHABET.iter().position(|a| a == c).context("Invalid base58 character")? as u128;
            n = n.checked_mul(58).and_then(|x| x.checked_add(d)).context("base58 overflow")?;
        }
        ensure!(size == 8 || n >> (8 * size) == 0, "base58 block overflow");
        ensure!(n >> 64 == 0, "base58 block overflow");
        out.extend_from_slice(&n.to_be_bytes()[16 - size..]);
    }
    Ok(out)
}
pub fn sigv2_verify(addr: &str, data: &[u8], sig: &str) -> Result<bool> {
    let a = address(addr)?;
    let raw = monero_base58_decode(sig.strip_prefix("SigV2").context("SigV2 prefix")?)?;
    ensure!(raw.len() == 64, "Signature length");
    let c = Option::<DS>::from(DS::from_canonical_bytes(raw[..32].try_into().unwrap()));
    let r = Option::<DS>::from(DS::from_canonical_bytes(raw[32..].try_into().unwrap()));
    let (Some(c), Some(r)) = (c, r) else { return Ok(false) };
    let spend_pub = a.spend().compress().to_bytes();
    let view_pub = a.view().compress().to_bytes();
    let p = CompressedEdwardsY(spend_pub).decompress().context("Spend key")?;
    let mut m = Vec::with_capacity(96 + data.len());
    m.extend_from_slice(b"MoneroMessageSignature\0");
    m.extend_from_slice(&spend_pub);
    m.extend_from_slice(&view_pub);
    m.push(0);
    let mut n = data.len();
    while n >= 128 {
        m.push(((n & 127) | 128) as u8);
        n >>= 7;
    }
    m.push(n as u8);
    m.extend_from_slice(data);
    let m = keccak256(&m);
    let comm = (G * r + p * c).compress().to_bytes();
    let h = DS::from_bytes_mod_order(keccak256([m.as_slice(), &spend_pub, &comm].concat()));
    Ok(h == c)
}

// ---------------------------------------------------------------- off-chain listing (nft/protocol.mjs, signed elsewhere)
pub struct Listing {
    pub genesis: String,
    pub token: String,
    pub last: String,
    pub owner: String,
    pub price: u64,
    pub created: u64,
    pub expires: u64,
    pub nonce: String,
}
impl Listing {
    pub fn from_json(v: &serde_json::Value) -> Result<Self> {
        let s = |k: &str| -> Result<String> { Ok(v[k].as_str().with_context(|| format!("listing.{k}"))?.to_string()) };
        let obj = v.as_object().context("listing object")?;
        let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        ensure!(keys == ["created", "expires", "genesis", "last", "nonce", "owner", "pricePiconero", "token", "v"], "Unexpected listing fields");
        ensure!(v["v"] == 1, "Listing version");
        let price = s("pricePiconero")?;
        ensure!(!price.is_empty() && price.len() <= 20 && !price.starts_with('0') && price.bytes().all(|c| c.is_ascii_digit()), "Listing price");
        let l = Self { genesis: s("genesis")?, token: s("token")?, last: s("last")?, owner: s("owner")?, price: price.parse()?, created: v["created"].as_u64().context("created")?, expires: v["expires"].as_u64().context("expires")?, nonce: s("nonce")? };
        ensure!(is_hex(&l.genesis, 64) && is_hex(&l.token, 64) && is_hex(&l.last, 64) && is_hex(&l.nonce, 32), "Invalid listing");
        address(&l.owner)?;
        ensure!(l.expires > l.created && l.expires - l.created <= 7 * 86400, "Listing window must be positive and at most seven days");
        Ok(l)
    }
    /// canonical() of nft/protocol.mjs: sorted keys, integers as numbers.
    fn canonical(&self) -> String {
        format!(
            r#"{{"created":{},"expires":{},"genesis":"{}","last":"{}","nonce":"{}","owner":"{}","pricePiconero":"{}","token":"{}","v":1}}"#,
            self.created, self.expires, self.genesis, self.last, self.nonce, self.owner, self.price, self.token
        )
    }
    pub fn message(&self) -> String {
        format!("{LISTING_DOMAIN}{}", sha256_hex(self.canonical().as_bytes()))
    }
    pub fn id(&self) -> String {
        sha256_hex(self.message().as_bytes())
    }
}
/// What both wallets agree on; the seller recomputes it from the transaction it signs.
#[allow(clippy::too_many_arguments)]
pub fn terms(genesis: &str, listing: &str, token: &str, prev: &str, price: u64, payout: &str, buyer: &str, buyer_anchor: &str, fee: u64, seller_anchor: &str) -> String {
    let mut b = TERMS_DOMAIN.to_vec();
    for s in [genesis, listing, token, prev] {
        b.extend_from_slice(s.as_bytes());
    }
    b.extend_from_slice(&price.to_le_bytes());
    for s in [payout, buyer, buyer_anchor] {
        b.extend_from_slice(s.as_bytes());
    }
    b.extend_from_slice(&fee.to_le_bytes());
    b.extend_from_slice(seller_anchor.as_bytes());
    hex::encode(keccak256(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn carrier_fragments_round_trip() {
        let rec = anchor_json(&"4".repeat(1), "00", "", "", "").err();
        assert!(rec.is_some());
        let env = envelope(r#"{"a":1}"#, &format!("SigV2{}", "1".repeat(88)));
        let c = carrier(&env).unwrap();
        assert_eq!(open(&c).unwrap(), env);
        let f = fragments(&c).unwrap();
        assert_eq!(f[0][..3], *b"XM2");
        let (r, s) = split_envelope(&env).unwrap();
        assert_eq!(r, r#"{"a":1}"#);
        assert!(s.starts_with("SigV2"));
    }
}
