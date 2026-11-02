//! SIGN TO MOVE (2 Nov 2026, research/sign-to-move-20261101). EXPERIMENTAL, UNREVIEWED.
//!
//! Open notes held by a plain Monero address (main address or subaddress) and moved by an ordinary Monero wallet message
//! signature: Feather (Tools → Sign/verify message), Cake Wallet (Settings → Other → Sign / Verify), the Monero GUI/CLI — all
//! wallet2 "SigV2". A relay carries the record in its own transaction; it cannot change a move, only delay it.
//!
//! ADDRESS OWNER: a decaf377 key nobody can sign for, so every existing record (XP1 outputs, XC1 credits, XR1 change, XA1/XL1)
//! can name a Monero address as an ordinary owner while only XW1 can spend the notes:
//!   owner(B, A) = compress(hash_to_curve(Fq(h[0..32]), Fq(h[32..64]))),  h = BLAKE2b-512("XMR20-ADDRESS-OWNER-v1\0" || B || A)
//! where B / A are the spend / view public keys inside the address (a subaddress's own keys for a subaddress).
//!
//!   XW1 address move: magic4 asset32 until4 nIn1 inputs(nIn x noteId32) nTo1 recipients(nTo x (kind1 keys amount8))
//!                     feeOwner32 feeAmount8 change8 flags1 signerKind1 B32 A32 tickerLen1 ticker variant1 c32 r32
//!     recipient kind 0 address / 1 subaddress: B32 A32 (the note's owner is owner(B, A)); kind 2: an owner key (32 bytes);
//!       kind 3 an XMR20 wallet's main address with its published certificate: B32 A32 opk32 c32 s32 — the note goes to opk
//!       (its normal Open balance) and the text still shows the address; the certificate (wallet-extension/src/address-cert.js,
//!       "XMR20-OPEN-OWNER-v1", Schnorr under B over the address, opk and this ledger's domain) must verify
//!     flags bit 0: the Monero network fee is paid in XMR to the relay (feeAmount must then be 0)
//!     change (if > 0) returns to the signer's address owner; the fee note (if > 0) goes to feeOwner
//!     signature: wallet2's message signature by the signer's SPEND key over text + ["", "\n", "\r\n"][variant]:
//!       h = keccak256("MoneroMessageSignature\0" || B || A || 0x00 || varint(len) || text), (c, r): c == Hs(h || B || rG + cB)
//!     text = "XMR20 move: send <amount> <ticker> to <address | XMR20 key <hex>>[ and …]; <fee <amount> <ticker> | network fee
//!             paid in XMR | no fee>; from <address>; valid until block <until>; code <hex of the first 16 bytes of
//!             H(MOVE_LABEL || domain || body)>"  — amounts with 6 decimals (every XMR20 token has 6), no trailing zeros.
//!     The code pins what the text does not spell out (which notes, who gets a token fee) and the ledger.
//!
//! DISCLOSURE: the record names the signing address's public keys; owners are public in the Open ledger anyway. No native
//! output key, key image or ring position. The relay's carrier spends the relay's own XMR with ordinary rings.
use anyhow::{ensure, Context, Result};
use curve25519_dalek::{edwards::CompressedEdwardsY, scalar::Scalar, traits::IsIdentity, EdwardsPoint};
use decaf377::{Element, Fq};
use decaf377_rdsa::{SpendAuth, VerificationKey};
use penumbra_sdk_asset::asset;
use sha3::{Digest, Keccak256};

use crate::{asset_from_bytes, message, sum_amounts, Reader};

pub const MAGIC_MOVE: &[u8; 4] = b"XW1\xfe";
pub const OWNER_LABEL: &[u8] = b"XMR20-ADDRESS-OWNER-v1\0";
pub const MOVE_LABEL: &[u8] = b"XMR20-ADDRESS-MOVE-v1\0";
pub const MAX_INPUTS: usize = 4;
pub const MAX_RECIPIENTS: usize = 3;
pub const MAX_TICKER: usize = 12;
pub const DECIMALS: u32 = 6;
pub const FLAG_FEE_IN_XMR: u8 = 1;
pub const SUFFIX: [&str; 3] = ["", "\n", "\r\n"];

/// Monero address prefixes of one network (standard address, subaddress).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Net {
    pub main: u8,
    pub sub: u8,
}
pub const MAINNET: Net = Net { main: 18, sub: 42 };
pub const STAGENET: Net = Net { main: 24, sub: 36 };
pub const TESTNET: Net = Net { main: 53, sub: 63 };

/// The block from which every reader applies XW1, and the address network its texts use. Below it, and when it is None,
/// XW1 is ignored exactly as a reader without these rules ignores it (unknown magic), so old and new readers agree.
/// Test chains are on from the start; mainnet is set at BUILD time with XMR20_ADDRESS_MOVES_MAINNET_ACTIVATION=<height>.
pub const MAINNET_ACTIVATION: Option<u64> = parse_height(option_env!("XMR20_ADDRESS_MOVES_MAINNET_ACTIVATION"));
const fn parse_height(v: Option<&str>) -> Option<u64> {
    let Some(s) = v else { return None };
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 12 {
        panic!("XMR20_ADDRESS_MOVES_MAINNET_ACTIVATION must be a block height");
    }
    let mut n: u64 = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] < b'0' || b[i] > b'9' {
            panic!("XMR20_ADDRESS_MOVES_MAINNET_ACTIVATION must be a block height");
        }
        n = n * 10 + (b[i] - b'0') as u64;
        i += 1;
    }
    Some(n)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Activation {
    pub from: u64,
    pub net: Net,
}
pub fn activation(network_kind: &str) -> Option<Activation> {
    match network_kind {
        // The offline lab chain is a mainnet-type fakechain.
        "offline-fakechain" => Some(Activation { from: 0, net: MAINNET }),
        "stagenet" => Some(Activation { from: 0, net: STAGENET }),
        "mainnet" => MAINNET_ACTIVATION.map(|from| Activation { from, net: MAINNET }),
        _ => None,
    }
}

// ---------------------------------------------------------------- addresses
const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ENCODED: [usize; 9] = [0, 2, 3, 5, 6, 7, 9, 10, 11];
fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut k = Keccak256::new();
    for p in parts {
        k.update(p);
    }
    k.finalize().into()
}
fn base58(bytes: &[u8]) -> String {
    let mut out = String::new();
    for block in bytes.chunks(8) {
        let mut n: u128 = 0;
        for b in block {
            n = n * 256 + u128::from(*b);
        }
        let mut s = vec![b'1'; ENCODED[block.len()]];
        for c in s.iter_mut().rev() {
            *c = ALPHABET[(n % 58) as usize];
            n /= 58;
        }
        out.push_str(std::str::from_utf8(&s).unwrap());
    }
    out
}
fn unbase58(text: &str) -> Result<Vec<u8>> {
    let mut out = vec![];
    for block in text.as_bytes().chunks(11) {
        let size = ENCODED.iter().position(|n| *n == block.len()).filter(|n| *n > 0).context("Not a Monero address")?;
        let mut n: u128 = 0;
        for c in block {
            let d = ALPHABET.iter().position(|a| a == c).context("Not a Monero address")?;
            n = n * 58 + d as u128;
        }
        ensure!(n < 1u128 << (8 * size), "Not a Monero address");
        out.extend(&n.to_be_bytes()[16 - size..]);
    }
    Ok(out)
}
/// A Monero standard address or subaddress: (is_subaddress, spend public key, view public key).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Address {
    pub sub: bool,
    pub spend: [u8; 32],
    pub view: [u8; 32],
}
impl Address {
    pub fn encode(&self, net: Net) -> String {
        let mut b = vec![if self.sub { net.sub } else { net.main }];
        b.extend(self.spend);
        b.extend(self.view);
        let sum = keccak(&[&b]);
        b.extend(&sum[..4]);
        base58(&b)
    }
    pub fn decode(text: &str, net: Net) -> Result<Self> {
        ensure!(text.len() == 95, "Use a main address or a subaddress (95 characters)");
        let b = unbase58(text)?;
        ensure!(b.len() == 69, "Not a Monero address");
        ensure!(keccak(&[&b[..65]])[..4] == b[65..], "Monero address checksum is wrong");
        let sub = match b[0] {
            p if p == net.main => false,
            p if p == net.sub => true,
            _ => anyhow::bail!("Address of another network"),
        };
        Ok(Self { sub, spend: b[1..33].try_into().unwrap(), view: b[33..65].try_into().unwrap() })
    }
    /// The address owner key (see the module header).
    pub fn owner(&self) -> [u8; 32] {
        owner_key(&self.spend, &self.view)
    }
}
pub fn owner_key(spend: &[u8; 32], view: &[u8; 32]) -> [u8; 32] {
    let h = blake2b_simd::Params::new().hash_length(64).to_state().update(OWNER_LABEL).update(spend).update(view).finalize();
    let b = h.as_bytes();
    let p = Element::hash_to_curve(&Fq::from_le_bytes_mod_order(&b[..32]), &Fq::from_le_bytes_mod_order(&b[32..]));
    p.vartime_compress().0
}

// ---------------------------------------------------------------- Monero message signatures (wallet2 SigV2)
fn varint(mut n: usize, out: &mut Vec<u8>) {
    loop {
        let b = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}
pub fn message_hash(text: &[u8], spend: &[u8; 32], view: &[u8; 32], mode: u8) -> [u8; 32] {
    let mut len = vec![];
    varint(text.len(), &mut len);
    keccak(&[b"MoneroMessageSignature\0", spend, view, &[mode], &len, text])
}
/// True only for a mode-0 (spend key) signature of exactly `text` by the address, under a usable spend key (on the curve,
/// prime order, not the identity). A view-key signature, which wallet2 also accepts as a proof, never passes.
pub fn verify_spend_signature(text: &[u8], addr: &Address, c: &[u8; 32], r: &[u8; 32]) -> bool {
    let Some(b) = CompressedEdwardsY(addr.spend).decompress() else { return false };
    if b.is_identity() || !b.is_torsion_free() {
        return false;
    }
    let (Some(c), Some(r)) = (Option::<Scalar>::from(Scalar::from_canonical_bytes(*c)), Option::<Scalar>::from(Scalar::from_canonical_bytes(*r))) else {
        return false;
    };
    if c == Scalar::ZERO {
        return false;
    }
    let big_r = EdwardsPoint::vartime_double_scalar_mul_basepoint(&c, &b, &r);
    let h = message_hash(text, &addr.spend, &addr.view, 0);
    Scalar::from_bytes_mod_order(keccak(&[&h, &addr.spend, big_r.compress().as_bytes()])) == c
}

// ---------------------------------------------------------------- XW1
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Recipient {
    Address(Address),
    Key([u8; 32]),
    Certified { addr: Address, owner: [u8; 32], c: [u8; 32], s: [u8; 32] },
}
impl Recipient {
    pub fn owner(&self) -> [u8; 32] {
        match self {
            Recipient::Address(a) => a.owner(),
            Recipient::Key(k) => *k,
            Recipient::Certified { owner, .. } => *owner,
        }
    }
}
/// An XMR20 wallet's open-owner certificate (wallet-extension/src/address-cert.js): valid iff c == Hs(m || B || sG + cB) with
/// m = keccak256("XMR20-OPEN-OWNER-v1" 0 address 0 hex(owner) 0 hex(domain)), under a usable spend key B of a MAIN address.
pub fn verify_certificate(addr: &Address, owner: &[u8; 32], c: &[u8; 32], s: &[u8; 32], domain: &[u8; 32], net: Net) -> bool {
    if addr.sub {
        return false;
    }
    let Some(b) = CompressedEdwardsY(addr.spend).decompress() else { return false };
    if b.is_identity() || !b.is_torsion_free() {
        return false;
    }
    let (Some(c), Some(s)) = (Option::<Scalar>::from(Scalar::from_canonical_bytes(*c)), Option::<Scalar>::from(Scalar::from_canonical_bytes(*s))) else {
        return false;
    };
    if c == Scalar::ZERO {
        return false;
    }
    let m = keccak(&[b"XMR20-OPEN-OWNER-v1\0", addr.encode(net).as_bytes(), b"\0", hex::encode(owner).as_bytes(), b"\0", hex::encode(domain).as_bytes()]);
    let big_r = EdwardsPoint::vartime_double_scalar_mul_basepoint(&c, &b, &s);
    Scalar::from_bytes_mod_order(keccak(&[&m, &addr.spend, big_r.compress().as_bytes()])) == c
}
#[derive(Clone, Debug)]
pub struct Move {
    pub asset: asset::Id,
    pub until: u32,
    pub inputs: Vec<[u8; 32]>,
    pub to: Vec<(Recipient, u64)>,
    pub fee_owner: [u8; 32],
    pub fee: u64,
    pub change: u64,
    pub flags: u8,
    pub signer: Address,
    pub ticker: String,
    pub variant: u8,
    pub c: [u8; 32],
    pub r: [u8; 32],
}
fn amount(n: u64) -> String {
    let unit = 10u64.pow(DECIMALS);
    let frac = format!("{:06}", n % unit);
    let frac = frac.trim_end_matches('0');
    if frac.is_empty() { (n / unit).to_string() } else { format!("{}.{}", n / unit, frac) }
}
impl Move {
    pub fn body(&self) -> Vec<u8> {
        let mut b = MAGIC_MOVE.to_vec();
        b.extend(self.asset.to_bytes());
        b.extend(self.until.to_le_bytes());
        b.push(self.inputs.len() as u8);
        for i in &self.inputs {
            b.extend(i);
        }
        b.push(self.to.len() as u8);
        for (r, n) in &self.to {
            match r {
                Recipient::Address(a) => {
                    b.push(u8::from(a.sub));
                    b.extend(a.spend);
                    b.extend(a.view);
                }
                Recipient::Key(k) => {
                    b.push(2);
                    b.extend(k);
                }
                Recipient::Certified { addr, owner, c, s } => {
                    b.push(3);
                    b.extend(addr.spend);
                    b.extend(addr.view);
                    b.extend(owner);
                    b.extend(c);
                    b.extend(s);
                }
            }
            b.extend(n.to_le_bytes());
        }
        b.extend(self.fee_owner);
        b.extend(self.fee.to_le_bytes());
        b.extend(self.change.to_le_bytes());
        b.push(self.flags);
        b.push(u8::from(self.signer.sub));
        b.extend(self.signer.spend);
        b.extend(self.signer.view);
        b.push(self.ticker.len() as u8);
        b.extend(self.ticker.as_bytes());
        b
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.body();
        b.push(self.variant);
        b.extend(self.c);
        b.extend(self.r);
        b
    }
    pub fn check(&self) -> Result<()> {
        ensure!(!self.inputs.is_empty() && self.inputs.len() <= MAX_INPUTS, "One to four inputs required");
        let mut seen = std::collections::BTreeSet::new();
        for i in &self.inputs {
            ensure!(seen.insert(*i), "Duplicate input");
        }
        ensure!(!self.to.is_empty() && self.to.len() <= MAX_RECIPIENTS, "One to three recipients required");
        for (r, n) in &self.to {
            ensure!(*n > 0, "Zero-value recipient");
            if let Recipient::Key(k) | Recipient::Certified { owner: k, .. } = r {
                VerificationKey::<SpendAuth>::try_from(*k).map_err(|_| anyhow::anyhow!("Invalid recipient owner key"))?;
            }
        }
        ensure!(self.flags & !FLAG_FEE_IN_XMR == 0, "Unknown flags");
        if self.fee > 0 {
            ensure!(self.flags & FLAG_FEE_IN_XMR == 0, "A token fee and a fee paid in XMR together");
            VerificationKey::<SpendAuth>::try_from(self.fee_owner).map_err(|_| anyhow::anyhow!("Invalid fee owner key"))?;
        } else {
            ensure!(self.fee_owner == [0; 32], "A fee owner without a fee");
        }
        ensure!(!self.ticker.is_empty() && self.ticker.len() <= MAX_TICKER && self.ticker.bytes().all(|c| c.is_ascii_alphanumeric()), "Ticker: 1 to 12 letters or digits");
        ensure!((self.variant as usize) < SUFFIX.len(), "Unknown text variant");
        Ok(())
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        let mut r = Reader::new(b, 0);
        ensure!(r.take(4)? == MAGIC_MOVE, "Not an address move");
        let asset = asset_from_bytes(r.take(32)?)?;
        let until = u32::from_le_bytes(r.take(4)?.try_into().unwrap());
        let n_in = r.u8()? as usize;
        ensure!((1..=MAX_INPUTS).contains(&n_in), "One to four inputs required");
        let inputs = (0..n_in).map(|_| r.take32()).collect::<Result<Vec<_>>>()?;
        let n_to = r.u8()? as usize;
        ensure!((1..=MAX_RECIPIENTS).contains(&n_to), "One to three recipients required");
        let mut to = vec![];
        for _ in 0..n_to {
            let rec = match r.u8()? {
                k @ (0 | 1) => Recipient::Address(Address { sub: k == 1, spend: r.take32()?, view: r.take32()? }),
                2 => Recipient::Key(r.take32()?),
                3 => Recipient::Certified { addr: Address { sub: false, spend: r.take32()?, view: r.take32()? }, owner: r.take32()?, c: r.take32()?, s: r.take32()? },
                _ => anyhow::bail!("Unknown recipient kind"),
            };
            to.push((rec, r.u64()?));
        }
        let fee_owner = r.take32()?;
        let fee = r.u64()?;
        let change = r.u64()?;
        let flags = r.u8()?;
        let sk = r.u8()?;
        ensure!(sk <= 1, "Unknown signer kind");
        let signer = Address { sub: sk == 1, spend: r.take32()?, view: r.take32()? };
        let tl = r.u8()? as usize;
        let ticker = String::from_utf8(r.take(tl)?.to_vec()).map_err(|_| anyhow::anyhow!("Bad ticker"))?;
        let variant = r.u8()?;
        let c = r.take32()?;
        let rr = r.take32()?;
        r.done()?;
        let m = Self { asset, until, inputs, to, fee_owner, fee, change, flags, signer, ticker, variant, c, r: rr };
        m.check()?;
        Ok(m)
    }
    pub fn total_out(&self) -> Result<u128> {
        let mut parts: Vec<u64> = self.to.iter().map(|(_, n)| *n).collect();
        parts.push(self.fee);
        parts.push(self.change);
        sum_amounts(parts.iter())
    }
    pub fn code(&self, domain: &[u8; 32]) -> [u8; 16] {
        message(MOVE_LABEL, domain, &self.body())[..16].try_into().unwrap()
    }
    /// The exact text the signer signs (without the variant's line ending).
    pub fn text(&self, domain: &[u8; 32], net: Net) -> String {
        let t = &self.ticker;
        let sends: Vec<String> = self
            .to
            .iter()
            .map(|(r, n)| match r {
                Recipient::Address(a) | Recipient::Certified { addr: a, .. } => format!("{} {} to {}", amount(*n), t, a.encode(net)),
                Recipient::Key(k) => format!("{} {} to XMR20 key {}", amount(*n), t, hex::encode(k)),
            })
            .collect();
        let fee = if self.fee > 0 {
            format!("fee {} {}", amount(self.fee), t)
        } else if self.flags & FLAG_FEE_IN_XMR != 0 {
            "network fee paid in XMR".to_string()
        } else {
            "no fee".to_string()
        };
        format!(
            "XMR20 move: send {}; {}; from {}; valid until block {}; code {}",
            sends.join(" and "),
            fee,
            self.signer.encode(net),
            self.until,
            hex::encode(self.code(domain))
        )
    }
    pub fn verify_sig(&self, domain: &[u8; 32], net: Net) -> Result<()> {
        let mut text = self.text(domain, net);
        text.push_str(SUFFIX[self.variant as usize]);
        ensure!(verify_spend_signature(text.as_bytes(), &self.signer, &self.c, &self.r), "Invalid address move signature");
        for (rec, _) in &self.to {
            if let Recipient::Certified { addr, owner, c, s } = rec {
                ensure!(verify_certificate(addr, owner, c, s, domain, net), "Invalid recipient certificate");
            }
        }
        Ok(())
    }
    /// A prepared move (body only, as `body()` returns it) read back for signing or relaying.
    pub fn decode_body(body: &[u8]) -> Result<Self> {
        let mut b = body.to_vec();
        b.push(0);
        b.extend([0u8; 64]);
        Self::decode(&b)
    }
    /// Relay helper: attach a pasted "SigV2…" signature, finding the line ending the copy added; then every check but the
    /// ledger's (signature, certificates).
    pub fn attach(&mut self, signature: &str, domain: &[u8; 32], net: Net) -> Result<()> {
        let (c, r) = parse_signature(signature)?;
        self.c = c;
        self.r = r;
        self.variant = self.find_variant(domain, net).context("This signature is not for this move text from this address. Sign the exact text with the address shown after \"from\".")?;
        self.verify_sig(domain, net)
    }
    /// Relay helper: the variant whose text the pasted signature verifies, if any.
    pub fn find_variant(&self, domain: &[u8; 32], net: Net) -> Option<u8> {
        let text = self.text(domain, net);
        (0..SUFFIX.len() as u8).find(|v| verify_spend_signature(format!("{}{}", text, SUFFIX[*v as usize]).as_bytes(), &self.signer, &self.c, &self.r))
    }
}

/// Parse a wallet2 "SigV2…" signature into (c, r).
pub fn parse_signature(text: &str) -> Result<([u8; 32], [u8; 32])> {
    let t = text.trim();
    ensure!(t.starts_with("SigV2"), "A Monero message signature starts with SigV2");
    let b = unbase58(&t[5..]).map_err(|_| anyhow::anyhow!("The signature is damaged"))?;
    ensure!(b.len() == 64, "The signature is damaged");
    Ok((b[..32].try_into().unwrap(), b[32..].try_into().unwrap()))
}
