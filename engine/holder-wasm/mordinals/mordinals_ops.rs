//! Mordinals by signature: the wallet engine's part (9 Nov 2026), in the extension as vendor/mordinals.wasm since 0.1.142.
//! Not independently reviewed.
//!
//! Rules: RULES.md of github.com/xmr20project/xmr721. The engine holds the wallet's keys; the host (the wallet
//! popup) holds only public data. Three operations, none of which builds or spends a Monero transaction:
//!
//!   mordinalsFind       which entries of the public owner list belong to this wallet (main address and subaddresses).
//!   mordinalsClaimSign  proof 0 of a claim: a signature under the owner coin's one-time key. Only for a claim that
//!                       names this wallet's own main address, and only when the key derives from this wallet.
//!   mordinalsSign       a wallet2 "sign message" signature (spend key) over one line of text. Only texts that start
//!                       with "Mordinals move: ", "Mordinals list: ", "Mordinals cancel: " or "Mordinals reserve: ".
//!
//! The private keys never leave this module. A claim shows nothing but the one-time key already on the owner list.
use super::*;
use curve25519_dalek::edwards::{CompressedEdwardsY, EdwardsPoint};

const CLAIM_TAG: &[u8] = b"MORDINALS-CLAIM-KEY-v1\0";
const SIGN_PREFIXES: [&str; 7] = ["Mordinals move: ", "Mordinals list: ", "Mordinals cancel: ", "Mordinals reserve: ", "XMR721 collection: ", "XMR721 mint: ", "XMR721 burn: "];
const MAX_ACCOUNTS: u64 = 5;
const MAX_INDICES: u64 = 200;
// "MD1" 0xfe, op 1 (claim).
const CLAIM_HEAD: [u8; 5] = [0x4d, 0x44, 0x31, 0xfe, 1];
// head 5, inscription 32, owner transaction 32, address 65 (kind, spend key, view key), proof kind 1.
const CLAIM_BODY: usize = 135;

fn hs(data: &[u8]) -> DS {
    DS::from_bytes_mod_order(keccak256(data))
}
fn point(text: &str) -> Result<EdwardsPoint> {
    let bytes = hex::decode(text)?;
    ensure!(bytes.len() == 32, "32-byte key");
    CompressedEdwardsY::from_slice(&bytes).map_err(|_| anyhow::anyhow!("32-byte key"))?.decompress().context("Not a valid key")
}
// m = Hs("SubAddr\0" ‖ view key ‖ account ‖ index), 0 for the main address (wallet2).
fn subaddress_scalar(view: &DS, account: u32, index: u32) -> DS {
    if account == 0 && index == 0 {
        return DS::ZERO;
    }
    let mut data = Vec::with_capacity(48);
    data.extend_from_slice(b"SubAddr\0");
    data.extend_from_slice(&view.to_bytes());
    data.extend_from_slice(&account.to_le_bytes());
    data.extend_from_slice(&index.to_le_bytes());
    hs(&data)
}
// 8·a·R: the key derivation of output 0 with transaction public key R.
fn derivation(view: &DS, tx_pub: &EdwardsPoint) -> [u8; 32] {
    (tx_pub * view).mul_by_cofactor().compress().to_bytes()
}
// Hs(derivation ‖ varint 0)
fn output_scalar(derivation: &[u8; 32]) -> DS {
    let mut data = derivation.to_vec();
    data.push(0);
    hs(&data)
}
fn view_tag(derivation: &[u8; 32]) -> u8 {
    let mut data = b"view_tag".to_vec();
    data.extend_from_slice(derivation);
    data.push(0);
    keccak256(&data)[0]
}

impl NativeWallet {
    // (private spend key, private view key). The view key is Hs(spend key), checked against the wallet's address.
    fn mordinals_keys(&self) -> Result<(DS, DS)> {
        let spend: DS = (*self.spend).into();
        let view = hs(&spend.to_bytes());
        ensure!((G * view).compress().to_bytes() == self.pair.view().compress().to_bytes(), "The view key of this wallet is unavailable");
        Ok((spend, view))
    }

    pub fn mordinals_call(&self, op: &str, q: &J) -> Result<J> {
        match op {
            "mordinalsFind" => self.mordinals_find(q),
            "mordinalsClaimSign" => self.mordinals_claim_sign(q),
            "mordinalsSign" => self.mordinals_sign(q),
            other => anyhow::bail!("Unknown Mordinals op {other}"),
        }
    }

    // owners: entries of the owner list (ownerOutputKey, ownerViewTag, ownerTxPubKeys, ownerAdditionalPubKeys).
    // accounts × indices: how many subaddresses of this wallet to try (the main address is always tried).
    fn mordinals_find(&self, q: &J) -> Result<J> {
        let (spend, view) = self.mordinals_keys()?;
        let accounts = q["accounts"].as_u64().unwrap_or(1).clamp(1, MAX_ACCOUNTS) as u32;
        let indices = q["indices"].as_u64().unwrap_or(50).clamp(1, MAX_INDICES) as u32;
        let spend_pub = G * spend;
        let mut table: BTreeMap<[u8; 32], (u32, u32)> = BTreeMap::new();
        for account in 0..accounts {
            for index in 0..indices {
                table.insert((spend_pub + G * subaddress_scalar(&view, account, index)).compress().to_bytes(), (account, index));
            }
        }
        let owners = q["owners"].as_array().context("owners")?;
        let mut found = Vec::new();
        for entry in owners {
            let Some(Ok(key)) = entry["ownerOutputKey"].as_str().map(point) else { continue };
            let tag = entry["ownerViewTag"].as_str().and_then(|t| u8::from_str_radix(t, 16).ok());
            let keys = entry["ownerTxPubKeys"].as_array().into_iter().flatten().chain(entry["ownerAdditionalPubKeys"].as_array().into_iter().flatten().take(1));
            for tx_pub_text in keys.filter_map(|k| k.as_str()) {
                let Ok(tx_pub) = point(tx_pub_text) else { continue };
                let d = derivation(&view, &tx_pub);
                if tag.is_some_and(|t| t != view_tag(&d)) {
                    continue;
                }
                let candidate = (key - G * output_scalar(&d)).compress().to_bytes();
                if let Some((account, index)) = table.get(&candidate) {
                    found.push(json!({"number":entry["number"],"registrationTx":entry["registrationTx"],"ownerTx":entry["ownerTx"],"ownerOutputKey":entry["ownerOutputKey"],"txPubKey":tx_pub_text,"account":account,"index":index}));
                    break;
                }
            }
        }
        Ok(json!({"checked":owners.len(),"found":found}))
    }

    // body: the claim record body (hex) for proof 0. outputKey, txPubKey, account, index: as mordinalsFind returned them.
    fn mordinals_claim_sign(&self, q: &J) -> Result<J> {
        let (spend, view) = self.mordinals_keys()?;
        let domain = crate::bytes32(crate::txt(q, "domain")?)?;
        let body = hex::decode(crate::txt(q, "body")?)?;
        ensure!(body.len() == CLAIM_BODY && body[..5] == CLAIM_HEAD && body[CLAIM_BODY - 1] == 0, "Not a one-time-key claim");
        let spend_pub = (G * spend).compress().to_bytes();
        let view_pub = (G * view).compress().to_bytes();
        ensure!(body[69] == 0 && body[70..102] == spend_pub && body[102..134] == view_pub, "This wallet claims a Mordinal to its own address only");
        let key = point(crate::txt(q, "outputKey")?)?;
        let tx_pub = point(crate::txt(q, "txPubKey")?)?;
        let account = q["account"].as_u64().unwrap_or(0);
        let index = q["index"].as_u64().unwrap_or(0);
        ensure!(account < MAX_ACCOUNTS && index < MAX_INDICES, "Subaddress out of range");
        let x = output_scalar(&derivation(&view, &tx_pub)) + spend + subaddress_scalar(&view, account as u32, index as u32);
        let key_bytes = key.compress().to_bytes();
        ensure!(x != DS::ZERO && (G * x).compress().to_bytes() == key_bytes, "This wallet does not hold that Mordinal's coin");
        let mut data = Vec::with_capacity(CLAIM_TAG.len() + 32 + body.len());
        data.extend_from_slice(CLAIM_TAG);
        data.extend_from_slice(&domain);
        data.extend_from_slice(&body);
        let hash = keccak256(&data);
        let mut seed = [0u8; 64];
        OsRng.fill_bytes(&mut seed);
        let k = DS::from_bytes_mod_order_wide(&seed);
        ensure!(k != DS::ZERO, "Random number unavailable");
        let mut challenge = Vec::with_capacity(96);
        challenge.extend_from_slice(&hash);
        challenge.extend_from_slice(&key_bytes);
        challenge.extend_from_slice(&(G * k).compress().to_bytes());
        let c = hs(&challenge);
        let r = k - c * x;
        Ok(json!({"c":hex::encode(c.to_bytes()),"r":hex::encode(r.to_bytes()),"outputKey":hex::encode(key_bytes)}))
    }

    fn mordinals_sign(&self, q: &J) -> Result<J> {
        let text = crate::txt(q, "text")?;
        ensure!(SIGN_PREFIXES.iter().any(|p| text.starts_with(p)), "Only Mordinals and XMR721 record texts are signed");
        ensure!(text.len() <= 1024 && text.bytes().all(|c| (0x20..0x7f).contains(&c)), "The text to sign is not one plain line");
        Ok(json!({"signature":self.sign_message(text.as_bytes())?,"address":self.address()}))
    }
}
