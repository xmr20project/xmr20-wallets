//! Open tokens (xmr20-tokens/OPEN.md in the XMR721 repository). Off until `activation`.
//!
//! A token anyone creates: announced by one XMR721 inscription (an MD1 mint record whose content is an open deploy text) and
//! minted by anyone with XO1 records. No issuer signs anything for it.
//!
//!   deploy = an MD1 mint record of exactly this shape (anything else is an NFT and nothing here):
//!     "MD1" 0xfe  08  collection32 (zero)  edition4 (zero)  creator(kind1 B32 A32)  flags1 (zero)  nameLen1 (zero)
//!     type1 (6)  contentLen2  content (the open deploy text)  variant1 c32 r32
//!     token id = SHA-256("MORDINALS-RECORD-v1" 0x00 || inscription domain || record without variant, c, r)   (the XMR721 record id)
//!     signature: the creator's Monero message signature (spend key) over the XMR721 mint text
//!       "XMR721 mint: one NFT in no collection; <n> bytes of type 6, SHA-256 <hex>; first owner <creator>; code <first 32 hex of id>"
//!   XO1 mint: magic4 asset32 amount8 owner32 salt8          (no signature; whoever carries it mints to `owner`)
//!
//! Text: {"p":"xmr20","op":"deploy","tick":…,["name":…,]"max":…,"dec":"6","mode":"open"[,"col":…][,"lim":…][,"pre":…]}
//! written one way only (this order, no spaces). max / lim / pre are whole tokens; records count units (1 token = 1,000,000).
use anyhow::{ensure, Context, Result};
use curve25519_dalek::{edwards::CompressedEdwardsY, traits::IsIdentity};
use decaf377_rdsa::{SpendAuth, VerificationKey};
use penumbra_sdk_asset::asset;
use serde_json::Value as J;
use sha2::{Digest, Sha256};

use crate::address::{self, Address, Net};
use crate::{asset_from_bytes, Reader};

pub const MAGIC_MINT: &[u8; 4] = b"XO1\xfe";
pub const MAGIC_INSCRIPTION: &[u8; 4] = b"MD1\xfe";
pub const INSCRIPTION_MINT: u8 = 8;
pub const TYPE_JSON: u8 = 6;
/// The largest XMR721 record (its RULES.md, section 8).
pub const MAX_INSCRIPTION: usize = 1000;
pub const MAX_TEXT: usize = 600;
pub const UNIT: u64 = 1_000_000;
/// The largest supply in whole tokens: what 8 bytes hold in units.
pub const MAX_WHOLE: u64 = u64::MAX / UNIT;
pub const MAX_TICK: usize = 32;
pub const MAX_NAME: usize = 64;
/// Hex characters of the token id a signed text shows.
pub const ID_SHOWN: usize = 16;
pub const ID_TAG: &[u8] = b"MORDINALS-RECORD-v1\0";
pub const FIELDS: [&str; 10] = ["p", "op", "tick", "name", "max", "dec", "mode", "col", "lim", "pre"];

/// The block from which open deploys and XO1 count, the address network of the signed texts and the domain of the XMR721
/// ledger whose inscriptions announce tokens. Below `from`, and when it is None, both are ignored exactly as a reader
/// without these rules ignores them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Activation {
    pub from: u64,
    pub net: Net,
    pub inscriptions: [u8; 32],
}
/// Mainnet: a constant of the rules (specification, section 1). It is not a build setting: every build of this
/// source applies these records on mainnet from the same block.
pub const MAINNET_ACTIVATION: Option<u64> = Some(3_812_510);
/// The domain of the XMR721 mainnet ledger: SHA-256("XMR721 mainnet ledger 1").
pub fn mainnet_inscriptions() -> [u8; 32] {
    Sha256::digest(b"XMR721 mainnet ledger 1").into()
}
/// Whether these record bytes are a record of open tokens at `height`: an XO1, or an MD1 record that is an open deploy by its
/// bytes and its signature. Below the opening block, and without one, nothing is.
pub fn record_at(open: Option<Activation>, b: &[u8], height: u64) -> bool {
    let Some(a) = open.filter(|a| height >= a.from) else { return false };
    b.starts_with(MAGIC_MINT) || b.starts_with(MAGIC_INSCRIPTION) && Deploy::decode(b).is_ok_and(|d| d.verify_sig(&a.inscriptions, a.net).is_ok())
}
/// The opening of open tokens for a service that reads its network from a manifest: mainnet's is built in; a test chain names
/// the domain of its XMR721 ledger in XMR20_OPEN_TEST_LEDGER (64 hex characters), and is closed without it.
pub fn activation_from_env(network_kind: &str) -> Option<Activation> {
    let test = std::env::var("XMR20_OPEN_TEST_LEDGER").ok().and_then(|v| hex::decode(v.trim()).ok()).and_then(|b| <[u8; 32]>::try_from(b).ok());
    activation(network_kind, if network_kind == "mainnet" { None } else { test })
}
/// A test chain names the domain of its own XMR721 ledger; without one open tokens are off there.
pub fn activation(network_kind: &str, test_inscriptions: Option<[u8; 32]>) -> Option<Activation> {
    match network_kind {
        "offline-fakechain" => test_inscriptions.map(|inscriptions| Activation { from: 0, net: address::MAINNET, inscriptions }),
        "stagenet" => test_inscriptions.map(|inscriptions| Activation { from: 0, net: address::STAGENET, inscriptions }),
        "mainnet" => MAINNET_ACTIVATION.map(|from| Activation { from, net: address::MAINNET, inscriptions: mainnet_inscriptions() }),
        _ => None,
    }
}

// ---------------------------------------------------------------- the deploy text
/// Characters a ticker or a name cannot hold (FORMAT.md of the XMR721 repository; the same fixed list).
const HIDDEN: &[(u32, u32)] = &[
    (0x0000, 0x001f), (0x007f, 0x00a0), (0x00ad, 0x00ad), (0x034f, 0x034f), (0x0600, 0x0605), (0x061c, 0x061c), (0x06dd, 0x06dd),
    (0x070f, 0x070f), (0x0890, 0x0891), (0x08e2, 0x08e2), (0x115f, 0x1160), (0x1680, 0x1680), (0x17b4, 0x17b5), (0x180b, 0x180f),
    (0x2000, 0x200f), (0x2028, 0x202f), (0x205f, 0x206f), (0x2800, 0x2800), (0x3000, 0x3000), (0x3164, 0x3164), (0xe000, 0xf8ff),
    (0xfdd0, 0xfdef), (0xfe00, 0xfe0f), (0xfeff, 0xfeff), (0xffa0, 0xffa0), (0xfff0, 0xffff), (0x110bd, 0x110bd), (0x110cd, 0x110cd),
    (0x13430, 0x1343f), (0x1bca0, 0x1bca3), (0x1d173, 0x1d17a), (0x1fffe, 0x1ffff), (0x2fffe, 0x2ffff), (0x3fffe, 0x3ffff),
    (0x4fffe, 0x4ffff), (0x5fffe, 0x5ffff), (0x6fffe, 0x6ffff), (0x7fffe, 0x7ffff), (0x8fffe, 0x8ffff), (0x9fffe, 0x9ffff),
    (0xafffe, 0xaffff), (0xbfffe, 0xbffff), (0xcfffe, 0xcffff), (0xdfffe, 0xdffff), (0xe0000, 0xe0fff), (0xefffe, 0xeffff),
    (0xf0000, 0x10ffff),
];
/// Text a person reads as a name: 1 to `max` characters, no space at either end, none of the hidden characters.
pub fn readable(v: &str, max: usize) -> bool {
    let n = v.chars().count();
    n >= 1 && n <= max && !v.starts_with(' ') && !v.ends_with(' ') && !v.chars().any(|c| HIDDEN.iter().any(|(a, b)| (*a..=*b).contains(&(c as u32))))
}
/// A whole number of tokens as the text writes it: digits, no leading zero, 1 to MAX_WHOLE.
fn whole(v: &str) -> Option<u64> {
    if v.is_empty() || v.len() > 14 || v.starts_with('0') || !v.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    v.parse::<u64>().ok().filter(|n| (1..=MAX_WHOLE).contains(n))
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Text {
    pub tick: String,
    pub name: Option<String>,
    pub max: u64,
    pub col: Option<String>,
    pub lim: Option<u64>,
    pub pre: Option<u64>,
}
impl Text {
    pub fn check(&self) -> Result<()> {
        ensure!(readable(&self.tick, MAX_TICK), "tick: 1 to 32 characters");
        if let Some(n) = &self.name {
            ensure!(readable(n, MAX_NAME), "name: 1 to 64 characters");
        }
        ensure!((1..=MAX_WHOLE).contains(&self.max), "max: 1 to 18,446,744,073,709 whole tokens");
        if let Some(c) = &self.col {
            ensure!(c.len() == 64 && c.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "col: the id of an XMR721 collection");
        }
        let pre = self.pre.unwrap_or(0);
        ensure!(self.pre != Some(0) && pre <= self.max, "pre: 1 to max");
        match self.lim {
            Some(l) => ensure!(pre < self.max && l >= 1 && l <= self.max, "lim: 1 to max, written only while something is left to mint"),
            None => ensure!(pre == self.max, "lim is required while something is left to mint"),
        }
        Ok(())
    }
    /// The one text of this deploy.
    pub fn write(&self) -> Result<String> {
        self.check()?;
        let q = |s: &str| serde_json::to_string(s).expect("a string");
        let mut t = format!("{{\"p\":\"xmr20\",\"op\":\"deploy\",\"tick\":{}", q(&self.tick));
        if let Some(n) = &self.name {
            t.push_str(&format!(",\"name\":{}", q(n)));
        }
        t.push_str(&format!(",\"max\":\"{}\",\"dec\":\"6\",\"mode\":\"open\"", self.max));
        if let Some(c) = &self.col {
            t.push_str(&format!(",\"col\":\"{c}\""));
        }
        if let Some(l) = self.lim {
            t.push_str(&format!(",\"lim\":\"{l}\""));
        }
        if let Some(p) = self.pre {
            t.push_str(&format!(",\"pre\":\"{p}\""));
        }
        t.push('}');
        ensure!(t.len() <= MAX_TEXT, "A deploy is at most 600 bytes");
        Ok(t)
    }
    /// The open deploy written in these bytes, or None. Only the exact text `write` gives is read.
    pub fn read(bytes: &[u8]) -> Option<Self> {
        if bytes.is_empty() || bytes.len() > MAX_TEXT {
            return None;
        }
        let text = std::str::from_utf8(bytes).ok()?;
        let v: J = serde_json::from_str(text).ok()?;
        let o = v.as_object()?;
        if o.keys().any(|k| !FIELDS.contains(&k.as_str())) || o.values().any(|x| !x.is_string()) {
            return None;
        }
        let s = |k: &str| o.get(k).and_then(|x| x.as_str());
        if s("p")? != "xmr20" || s("op")? != "deploy" || s("dec")? != "6" || s("mode")? != "open" {
            return None;
        }
        let num = |k: &str| -> Option<Option<u64>> {
            match s(k) {
                None => Some(None),
                Some(x) => whole(x).map(Some),
            }
        };
        let t = Self { tick: s("tick")?.to_string(), name: s("name").map(String::from), max: whole(s("max")?)?, col: s("col").map(String::from), lim: num("lim")?, pre: num("pre")? };
        (t.write().ok()? == text).then_some(t)
    }
    pub fn max_units(&self) -> u64 {
        self.max * UNIT
    }
    pub fn pre_units(&self) -> u64 {
        self.pre.unwrap_or(0) * UNIT
    }
    pub fn lim_units(&self) -> u64 {
        self.lim.unwrap_or(0) * UNIT
    }
}
/// What the ticker field of a move or a listing holds for an open token: the ticker when the field can hold it.
pub fn ticker_field(tick: &str) -> String {
    if !tick.is_empty() && tick.len() <= address::MAX_TICKER && tick.bytes().all(|c| c.is_ascii_alphanumeric()) {
        tick.to_string()
    } else {
        "TOKEN".to_string()
    }
}
/// How a signed text names an open token.
pub fn label(tick: &str, id: &[u8; 32]) -> String {
    format!("{} (token {})", ticker_field(tick), &hex::encode(id)[..ID_SHOWN])
}
/// Every id that starts with the bytes a signed text shows of `id`.
pub fn shown_range(id: &[u8; 32]) -> std::ops::RangeInclusive<[u8; 32]> {
    let n = ID_SHOWN / 2;
    let (mut lo, mut hi) = ([0u8; 32], [0xffu8; 32]);
    lo[..n].copy_from_slice(&id[..n]);
    hi[..n].copy_from_slice(&id[..n]);
    lo..=hi
}
pub fn asset_for_open(id: &[u8; 32]) -> Result<asset::Id> {
    let denom = format!("uxmr20open{}", hex::encode(id));
    Ok(asset::REGISTRY.parse_denom(&denom).context("Unparseable denom")?.id())
}

// ---------------------------------------------------------------- the deploy inscription
/// A key a Monero wallet can use: on the curve, in the main group, not the neutral point (XMR721 asks it of both keys).
fn usable(key: &[u8; 32]) -> bool {
    // Written the one way a key is written: the XMR721 library refuses any other encoding of the same point.
    CompressedEdwardsY(*key).decompress().is_some_and(|p| !p.is_identity() && p.is_torsion_free() && p.compress().0 == *key)
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deploy {
    pub creator: Address,
    pub text: Text,
    pub variant: u8,
    pub c: [u8; 32],
    pub r: [u8; 32],
}
impl Deploy {
    pub fn body(&self) -> Result<Vec<u8>> {
        let content = self.text.write()?;
        let mut b = MAGIC_INSCRIPTION.to_vec();
        b.push(INSCRIPTION_MINT);
        b.extend([0u8; 36]);
        b.push(u8::from(self.creator.sub));
        b.extend(self.creator.spend);
        b.extend(self.creator.view);
        b.extend([0, 0, TYPE_JSON]);
        b.extend((content.len() as u16).to_le_bytes());
        b.extend(content.as_bytes());
        Ok(b)
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        let mut b = self.body()?;
        b.push(self.variant);
        b.extend(self.c);
        b.extend(self.r);
        Ok(b)
    }
    /// Reads an open deploy and nothing else: any other MD1 record, also a valid one, is an error here.
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(b.len() <= MAX_INSCRIPTION, "Inscription record too large");
        let mut r = Reader::new(b, 0);
        ensure!(r.take(4)? == MAGIC_INSCRIPTION && r.u8()? == INSCRIPTION_MINT, "Not a mint inscription");
        ensure!(r.take(36)? == [0u8; 36], "An open deploy is in no collection");
        let kind = r.u8()?;
        ensure!(kind <= 1, "Unknown address kind");
        let creator = Address { sub: kind == 1, spend: r.take32()?, view: r.take32()? };
        ensure!(usable(&creator.spend) && usable(&creator.view), "The creator's address has an unusable key");
        ensure!(r.take(3)? == [0, 0, TYPE_JSON], "An open deploy has no first owner, origin or name, and is JSON");
        let n = u16::from_le_bytes(r.take(2)?.try_into().unwrap()) as usize;
        let text = Text::read(r.take(n)?).context("Not an open deploy text")?;
        let variant = r.u8()?;
        ensure!((variant as usize) < address::SUFFIX.len(), "Unknown text variant");
        let d = Self { creator, text, variant, c: r.take32()?, r: r.take32()? };
        r.done()?;
        ensure!(d.encode()? == b, "Canonical record");
        Ok(d)
    }
    /// The token id: the XMR721 id of the record.
    pub fn id(&self, inscriptions: &[u8; 32]) -> Result<[u8; 32]> {
        let mut h = Sha256::new();
        h.update(ID_TAG);
        h.update(inscriptions);
        h.update(self.body()?);
        Ok(h.finalize().into())
    }
    /// The text the creator signed, as the XMR721 rules render it for this record.
    pub fn signed_text(&self, inscriptions: &[u8; 32], net: Net) -> Result<String> {
        let content = self.text.write()?;
        Ok(format!(
            "XMR721 mint: one NFT in no collection; {} bytes of type {}, SHA-256 {}; first owner {}; code {}",
            content.len(),
            TYPE_JSON,
            hex::encode(Sha256::digest(content.as_bytes())),
            self.creator.encode(net),
            &hex::encode(self.id(inscriptions)?)[..32]
        ))
    }
    pub fn verify_sig(&self, inscriptions: &[u8; 32], net: Net) -> Result<()> {
        let mut text = self.signed_text(inscriptions, net)?;
        text.push_str(address::SUFFIX[self.variant as usize]);
        ensure!(address::verify_spend_signature(text.as_bytes(), &self.creator, &self.c, &self.r), "Invalid deploy signature");
        Ok(())
    }
}

// ---------------------------------------------------------------- XO1
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mint {
    pub asset: asset::Id,
    pub amount: u64,
    pub owner: [u8; 32],
    pub salt: [u8; 8],
}
impl Mint {
    pub const BYTES: usize = 4 + 32 + 8 + 32 + 8;
    pub fn encode(&self) -> Vec<u8> {
        let mut b = MAGIC_MINT.to_vec();
        b.extend(self.asset.to_bytes());
        b.extend(self.amount.to_le_bytes());
        b.extend(self.owner);
        b.extend(self.salt);
        b
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(b.len() == Self::BYTES && &b[..4] == MAGIC_MINT, "XO1 size/magic");
        let mut r = Reader::new(b, 4);
        let m = Self { asset: asset_from_bytes(r.take(32)?)?, amount: r.u64()?, owner: r.take32()?, salt: r.take(8)?.try_into().unwrap() };
        r.done()?;
        ensure!(m.encode() == b, "Canonical record");
        ensure!(m.amount > 0, "A mint of nothing");
        VerificationKey::<SpendAuth>::try_from(m.owner).map_err(|_| anyhow::anyhow!("Invalid mint owner key"))?;
        Ok(m)
    }
}
