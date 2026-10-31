//! Holder-side token engine for the UNSHIELDED-BY-DEFAULT format. SYNTHETIC TEST CODE, UNREVIEWED.
//!
//! Runs inside the extension's worker as wasm32 (plain C ABI, JSON requests). Everything that touches
//! secrets happens here: key derivation (XMR20-TKD1: token spend key AND public owner key from the
//! account's root), local scanning of the public ledger and trial decryption of the shielded pool,
//! nullifier derivation, note selection, Groth16 proving with Penumbra's published keys, signatures,
//! and the holder's native Monero wallet for carrier fees. Only public data leaves through JSON.
//!
//! Ops: version · derive · openViewing · viewingKey · params · reset · applyBlock · tip · apply ·
//!      nativeStart/nativeAddress/nativeStatus/nativeReserve/nativeRelease · carrierQuote/carrierOuts/
//!      carrierSign/carrierCancel · status · selectPublic · select · plan · build · verify · close
use anyhow::{ensure, Context, Result};
use ark_groth16::{PreparedVerifyingKey, ProvingKey};
use decaf377::Bls12_377;
use decaf377_rdsa::{SigningKey, SpendAuth};
use penumbra_sdk_asset::asset;
use penumbra_sdk_keys::{keys::SpendKey, Address, FullViewingKey};
use penumbra_sdk_shielded_pool::Note;
use serde::Serialize;
use serde_json::{json, Value as J};
use std::{cell::RefCell, collections::BTreeMap, str::FromStr};
use xmr20_unshielded_core::{
    self as core,
    keys::{self, TokenAddress},
    manifest::{authenticate_file, Manifest},
    penumbra as pz, pool, private2, public, shield, transport, Config, PublicOutput, DOMAIN_LABEL, MANIFEST_FORMAT, PROTOCOL, SCHEME,
};
use zeroize::Zeroizing;

pub mod native;
// MONERO MARKET candidate (30 Oct 2026): anchored NFT sales on XMR20-NFT-V2 (records, carrier, SigV2 verification).
pub mod nft_v2;
// MONERO MARKET candidate (29 Oct 2026): engine-level market operations (anchored lots, offers, whole-lot sales).
mod market_ops;
// MONERO MARKET candidate (30 Oct 2026): anchored NFT sales (engine side).
mod nft_ops;

// ------------------------------------------------------------ randomness (wasm host import)
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn xmr20_random(ptr: *mut u8, len: usize) -> u32;
}
#[cfg(target_arch = "wasm32")]
fn host_random(buf: &mut [u8]) -> Result<(), getrandom::Error> {
    let r = unsafe { xmr20_random(buf.as_mut_ptr(), buf.len()) };
    if r == 0 {
        Ok(())
    } else {
        Err(getrandom::Error::UNSUPPORTED)
    }
}
#[cfg(target_arch = "wasm32")]
getrandom::register_custom_getrandom!(host_random);

// ------------------------------------------------------------ parameters
/// A fresh ledger pool for this manifest's network, with the market rules from their activation height (core `market::activation`).
fn fresh_pool(domain: [u8; 32], manifest: &Manifest) -> pool::Pool {
    let mut p = pool::Pool::new(domain);
    p.market_from = core::market::activation(&manifest.network.kind);
    p
}
pub struct Params {
    pub config: Config,
    pub domain: [u8; 32],
    pub manifest: Manifest,
    pub vks: pool::Vks,
}
impl Params {
    pub fn new(manifest: Manifest, served: Option<Config>) -> Result<Self> {
        let domain = manifest.validate()?;
        if let Some(s) = served {
            ensure!(s == manifest.config, "The parameter server serves a different ledger or version (domain {}…) than the parameters shipped with this build (domain {}…)", &s.domain[..16], &manifest.config.domain[..16]);
        }
        let config = manifest.config.clone();
        let issuer: [u8; 32] = hex::decode(&config.issuer_vk)?.try_into().map_err(|_| anyhow::anyhow!("Issuer key"))?;
        let vks = pool::Vks { spend: pz::read_vk(pz::Circuit::Spend, &config.spend_vk)?, output: pz::read_vk(pz::Circuit::Output, &config.output_vk)?, issuer: decaf377_rdsa::VerificationKey::try_from(issuer)? };
        Ok(Self { config, domain, manifest, vks })
    }
}

// ------------------------------------------------------------ engine
#[derive(Clone, Serialize)]
pub struct RecordInfo {
    pub height: u64,
    pub txid: String,
    pub status: String,
    pub kind: J,
    pub error: Option<String>,
    pub detail: J,
}
#[derive(Default)]
pub struct Engine {
    key: Option<SpendKey>,
    fvk: Option<FullViewingKey>,
    owner: Option<SigningKey<SpendAuth>>,
    owner_key: Option<[u8; 32]>,
    params: Option<Params>,
    pool: Option<pool::Pool>,
    records: BTreeMap<String, RecordInfo>,
    tip: u64,
    // Saved scan progress: every XMR20 record extra the pool did not ignore, in applied order (replayed through the same
    // verification on restore), and the last block height whose extras were applied.
    // MARKET candidate: each entry also keeps the carrier's input key images (anchored notes need them on replay).
    pool_log: Vec<(u64, String, Vec<u8>, Vec<[u8; 32]>)>,
    pool_tip: Option<u64>,
    // 29 Oct 2026: the block height and transaction of every note commitment the pool added (shielded notes report their
    // height, so a wallet can show "Confirming n/10" for tokens it received). Rebuilt with the pool on replay and reset.
    note_origin: BTreeMap<[u8; 32], (u64, String)>,
    spend_pk: Option<ProvingKey<Bls12_377>>,
    output_pk: Option<ProvingKey<Bls12_377>>,
    native: Option<native::NativeWallet>,
    market: market_ops::MarketState,
}
fn txt<'a>(v: &'a J, k: &str) -> Result<&'a str> {
    v[k].as_str().context(format!("Text field {k}"))
}
fn bytes32(s: &str) -> Result<[u8; 32]> {
    hex::decode(s)?.try_into().map_err(|_| anyhow::anyhow!("32-byte field"))
}
fn amount(v: &J, k: &str) -> Result<u64> {
    let s = txt(v, k)?;
    ensure!(!s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0')), "Canonical atomic amount");
    Ok(s.parse()?)
}
fn asset_of(q: &J) -> Result<asset::Id> {
    core::asset_from_bytes(&bytes32(txt(q, "asset")?)?)
}
fn hexset(v: &J) -> Result<std::collections::BTreeSet<[u8; 32]>> {
    let mut s = std::collections::BTreeSet::new();
    if let Some(a) = v.as_array() {
        for x in a {
            s.insert(bytes32(x.as_str().context("hex entry")?)?);
        }
    }
    Ok(s)
}
fn hexlist(v: &J) -> Result<Vec<[u8; 32]>> {
    let mut out = vec![];
    for x in v.as_array().context("array")? {
        out.push(bytes32(x.as_str().context("hex entry")?)?);
    }
    Ok(out)
}
/// A recipient for the public side: an owner key hex or a unified token address.
fn owner_of(s: &str) -> Result<[u8; 32]> {
    if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
        let o = bytes32(s)?;
        keys::owner_vk(&o)?;
        return Ok(o);
    }
    TokenAddress::parse(s)?.owner.context("This recipient address carries no public owner key (penumbra1… addresses receive private transfers only)")
}
fn shielded_of(s: &str) -> Result<Address> {
    if s.starts_with("penumbra1") {
        return Address::from_str(s).map_err(|e| anyhow::anyhow!("Token address: {e}"));
    }
    Ok(TokenAddress::parse(s)?.shielded)
}
impl Engine {
    fn params(&self) -> Result<&Params> {
        self.params.as_ref().context("Set the public parameters first")
    }
    fn pool(&self) -> Result<&pool::Pool> {
        self.pool.as_ref().context("Set the public parameters first")
    }
    fn fvk(&self) -> Result<&FullViewingKey> {
        self.fvk.as_ref().context("No wallet open in the engine")
    }
    fn key(&self) -> Result<&SpendKey> {
        self.key.as_ref().context("This engine holds a viewing key only: it cannot spend")
    }
    fn owner(&self) -> Result<&SigningKey<SpendAuth>> {
        self.owner.as_ref().context("This engine holds no public owner key: it cannot spend public notes")
    }
    fn owner_key(&self) -> Result<[u8; 32]> {
        self.owner_key.context("No public owner key in this engine")
    }
    fn unified(&self) -> Result<String> {
        let fvk = self.fvk()?;
        let sh = fvk.payment_address(0u32.into()).0;
        Ok(match self.owner_key {
            Some(o) => TokenAddress::unified(sh, o).encode(),
            None => sh.to_string(),
        })
    }
    pub fn owned(&self) -> Result<Vec<core::ledger::OwnedNote>> {
        self.pool()?.ledger.owned(self.fvk()?)
    }
    fn note_json(&self, o: &core::ledger::OwnedNote) -> J {
        let cm = o.note.commit().0.to_bytes();
        let mut j = json!({"commitment":hex::encode(cm),"asset":hex::encode(o.note.asset_id().to_bytes()),"amount":u128::from(o.note.amount()).to_string(),"position":o.position,"spent":o.spent});
        if let Some((height, txid)) = self.note_origin.get(&cm) {
            j["height"] = json!(height);
            j["txid"] = json!(txid);
        }
        j
    }
    fn select_shielded(&self, asset: asset::Id, amount: u128, exclude: &std::collections::BTreeSet<[u8; 32]>, max: usize) -> Result<Vec<Note>> {
        ensure!(amount > 0, "Positive amount required");
        let mut notes = self.owned()?.into_iter().filter(|o| !o.spent && o.note.asset_id() == asset && u128::from(o.note.amount()) > 0 && !exclude.contains(&o.note.commit().0.to_bytes())).map(|o| o.note).collect::<Vec<_>>();
        notes.sort_by_key(|n| std::cmp::Reverse(u128::from(n.amount())));
        let available: u128 = notes.iter().map(|n| u128::from(n.amount())).sum();
        ensure!(available >= amount, "Insufficient unreserved shielded balance of this asset: {available} available");
        let mut selected = vec![];
        let mut total = 0u128;
        for n in notes.into_iter().take(max) {
            total += u128::from(n.amount());
            selected.push(n);
            if total >= amount {
                return Ok(selected);
            }
        }
        anyhow::bail!("No set of up to {max} unreserved shielded notes covers {amount}; consolidate first (fragmented balance)")
    }
    fn select_public(&self, asset: asset::Id, amount: u128, exclude: &std::collections::BTreeSet<[u8; 32]>) -> Result<(Vec<[u8; 32]>, u128)> {
        ensure!(amount > 0, "Positive amount required");
        let a = hex::encode(asset.to_bytes());
        // MARKET candidate: anchored lots are never picked for an ordinary send (they need their anchor input; cancel the lot first).
        let mut notes: Vec<([u8; 32], u64)> = self.pool()?.notes_of_owner(&self.owner_key()?).into_iter().filter(|(_, n)| n.asset == a && n.anchor.is_none()).map(|(id, n)| (bytes32(&id).unwrap(), n.amount)).filter(|(id, _)| !exclude.contains(id)).collect();
        notes.sort_by_key(|(_, v)| std::cmp::Reverse(*v));
        let available: u128 = notes.iter().map(|(_, v)| u128::from(*v)).sum();
        ensure!(available >= amount, "Insufficient unreserved public balance of this asset: {available} available");
        let mut selected = vec![];
        let mut total = 0u128;
        for (id, v) in notes.into_iter().take(public::MAX_IO) {
            total += u128::from(v);
            selected.push(id);
            if total >= amount {
                return Ok((selected, total));
            }
        }
        anyhow::bail!("No set of up to four unreserved public notes covers {amount}; merge notes first (fragmented balance)")
    }
    fn notes_by_commitment(&self, cms: &J, max: usize) -> Result<Vec<Note>> {
        let want = cms.as_array().context("notes array")?;
        ensure!(!want.is_empty() && want.len() <= max, "One to {max} inputs required");
        let owned = self.owned()?;
        let mut out = vec![];
        for c in want {
            let cm = bytes32(c.as_str().context("Commitment hex")?)?;
            let o = owned.iter().find(|o| o.note.commit().0.to_bytes() == cm).context("Selected note is not in this wallet")?;
            ensure!(!o.spent, "Selected note is already spent");
            out.push(o.note.clone());
        }
        Ok(out)
    }
    fn public_total(&self, ids: &[[u8; 32]], asset: asset::Id) -> Result<u64> {
        let pool = self.pool()?;
        let me = hex::encode(self.owner_key()?);
        let a = hex::encode(asset.to_bytes());
        let mut total = 0u128;
        for id in ids {
            let n = pool.notes.get(id).context("Selected public note is not unspent")?;
            ensure!(n.owner == me, "Selected public note belongs to another owner");
            ensure!(n.asset == a, "Selected public note is another asset");
            total += u128::from(n.amount);
        }
        Ok(u64::try_from(total)?)
    }
    pub fn set_blob(&mut self, slot: u32, bytes: &[u8]) -> Result<J> {
        let p = self.params()?;
        let (expected, circuit) = p.manifest.file(slot)?;
        let digest = authenticate_file(expected, bytes)?;
        let pk = pz::load_pk(circuit, bytes)?;
        ensure!(pz::pk_matches_vk(&pk, &expected.vk), "Proving key does not match the pinned verifying key");
        let label = p.manifest.label.clone();
        if slot == 0 {
            self.spend_pk = Some(pk);
        } else {
            self.output_pk = Some(pk);
        }
        Ok(json!({"slot":slot,"bytes":bytes.len(),"sha256":digest,"authenticated":true,"manifest":MANIFEST_FORMAT,"label":label,"keyId":circuit.pk_id()}))
    }
    pub fn proving_key_loaded(&self, slot: u32) -> bool {
        match slot {
            0 => self.spend_pk.is_some(),
            _ => self.output_pk.is_some(),
        }
    }
    fn apply_extra(&mut self, height: u64, txid: String, extra: &[u8], native: &[[u8; 32]]) -> Result<J> {
        let wire = transport::unframe(extra).ok().flatten();
        let p = self.params.as_ref().context("params")?;
        let pool = self.pool.as_mut().context("params")?;
        let before = pool.ledger.history.len();
        let result = pool.apply_carrier(wire.as_deref(), &txid, height, native, &p.vks);
        if result["record"] == "ignored" {
            return Ok(json!({"record":"ignored"}));
        }
        let added: Vec<[u8; 32]> = pool.ledger.history[before..].iter().map(|x| x.note_commitment.0.to_bytes()).collect();
        for cm in added {
            self.note_origin.insert(cm, (height, txid.clone()));
        }
        self.pool_log.push((height, txid.clone(), extra.to_vec(), native.to_vec()));
        let id = hex::encode(core::hash(wire.as_deref().unwrap()));
        let info = RecordInfo { height, txid, status: result["record"].as_str().unwrap_or("?").into(), kind: result["kind"].clone(), error: result["error"].as_str().map(String::from), detail: result["detail"].clone() };
        self.records.insert(id.clone(), info.clone());
        // A completed two-part operation: the counterpart that arrived earlier (status "pending") is now part of an accepted operation.
        if result["detail"]["completed"] == true {
            for k in ["part_a", "part_b"] {
                if let Some(other) = result["detail"]["completion"][k].as_str() {
                    if other != id {
                        if let Some(r) = self.records.get_mut(other) {
                            r.status = "accepted".into();
                            r.detail["completed"] = json!(true);
                            r.detail["completion"] = result["detail"]["completion"].clone();
                        }
                    }
                }
            }
        }
        Ok(json!({"record":info.status,"kind":info.kind,"recordId":id,"error":info.error,"detail":info.detail}))
    }
    /// Local admission check of a built record (or a complete two-part operation) against a copy of the pool.
    fn self_check(&self, wires: &[&[u8]]) -> Result<J> {
        let p = self.params()?;
        let mut candidate = self.pool()?.clone();
        let mut last = json!(null);
        for (i, w) in wires.iter().enumerate() {
            last = candidate.apply(Some(w), &hex::encode([i as u8 + 1; 32]), self.tip + 1, &p.vks);
            ensure!(last["record"] != "rejected", "Built record fails local admission: {}", last["error"]);
        }
        if wires.len() > 1 {
            ensure!(last["record"] == "accepted" && last["detail"]["completed"] == true, "Two-part operation does not complete locally: {}", last);
        }
        Ok(last)
    }
    fn build(&self, q: &J) -> Result<J> {
        let p = self.params()?;
        let pool = self.pool()?;
        match txt(q, "kind")? {
            // XP1: public notes -> payment to `to` (owner key or unified address) + change to self.
            "public" => {
                let owner = self.owner()?;
                let asset = asset_of(q)?;
                let n = amount(q, "amount")?;
                let to = owner_of(txt(q, "to")?)?;
                let ids = hexlist(&q["notes"])?;
                let total = self.public_total(&ids, asset)?;
                ensure!(total >= n, "Selected notes do not cover the amount");
                let me = self.owner_key()?;
                let mut outs = vec![PublicOutput { owner: to, amount: n }];
                if total > n {
                    outs.push(PublicOutput { owner: me, amount: total - n });
                }
                let t = public::Transfer::build(asset, ids.clone(), outs, owner, &p.domain)?;
                let wire = t.encode();
                self.self_check(&[&wire])?;
                Ok(json!({"kind":"public","wire":hex::encode(&wire),"recordId":hex::encode(core::hash(&wire)),"bytes":wire.len(),"inputs":ids.len(),"amount":n.to_string(),"change":(total-n).to_string(),"reserved":ids.iter().map(hex::encode).collect::<Vec<_>>(),"asset":hex::encode(asset.to_bytes()),"transactions":1}))
            }
            // XR1: burn `amount` of public notes for a bridge payout bound to `binding`; change to self.
            "burn" => {
                let owner = self.owner()?;
                let asset = asset_of(q)?;
                let n = amount(q, "amount")?;
                let binding = bytes32(txt(q, "binding")?)?;
                let ids = hexlist(&q["notes"])?;
                let total = self.public_total(&ids, asset)?;
                ensure!(total >= n, "Selected notes do not cover the amount");
                let me = self.owner_key()?;
                let b = public::Burn::build(asset, ids.clone(), n, PublicOutput { owner: me, amount: total - n }, binding, owner, &p.domain)?;
                let wire = b.encode();
                self.self_check(&[&wire])?;
                Ok(json!({"kind":"burn","wire":hex::encode(&wire),"recordId":hex::encode(core::hash(&wire)),"bytes":wire.len(),"inputs":ids.len(),"amount":n.to_string(),"change":(total-n).to_string(),"reserved":ids.iter().map(hex::encode).collect::<Vec<_>>(),"asset":hex::encode(asset.to_bytes()),"transactions":1}))
            }
            // XS1: public notes -> one shielded note of `amount` (to self by default, or to a shielded address) + public change.
            "shield" => {
                let owner = self.owner()?;
                let asset = asset_of(q)?;
                let n = amount(q, "amount")?;
                let ids = hexlist(&q["notes"])?;
                let total = self.public_total(&ids, asset)?;
                let to = match q["to"].as_str() {
                    Some(s) if !s.is_empty() => shielded_of(s)?,
                    _ => keys::shielded_address(self.key()?),
                };
                let opk = self.output_pk.as_ref().context("Output proving key not loaded")?;
                let (s, _note) = shield::Shield::build(asset, ids.clone(), total, n, &to, owner, opk, &p.domain)?;
                let wire = s.encode();
                self.self_check(&[&wire])?;
                Ok(json!({"kind":"shield","wire":hex::encode(&wire),"recordId":hex::encode(core::hash(&wire)),"bytes":wire.len(),"inputs":ids.len(),"amount":n.to_string(),"change":(total-n).to_string(),"reserved":ids.iter().map(hex::encode).collect::<Vec<_>>(),"asset":hex::encode(asset.to_bytes()),"transactions":1}))
            }
            // XU1: ONE shielded note -> public note of `amount` for `to` (self by default) + shielded change.
            "unshield" => {
                let key = self.key()?;
                let n = amount(q, "amount")?;
                let notes = self.notes_by_commitment(&q["notes"], 1)?;
                let to = match q["to"].as_str() {
                    Some(s) if !s.is_empty() => owner_of(s)?,
                    _ => self.owner_key()?,
                };
                let spk = self.spend_pk.as_ref().context("Spend proving key not loaded")?;
                let opk = self.output_pk.as_ref().context("Output proving key not loaded")?;
                let (u, _change) = shield::Unshield::build(&pool.ledger, key, &notes[0], n, to, spk, opk, &p.domain)?;
                let wire = u.encode();
                self.self_check(&[&wire])?;
                let change = u128::from(notes[0].amount()) - u128::from(n);
                Ok(json!({"kind":"unshield","wire":hex::encode(&wire),"recordId":hex::encode(core::hash(&wire)),"bytes":wire.len(),"inputs":1,"amount":n.to_string(),"change":change.to_string(),"reserved":[hex::encode(notes[0].commit().0.to_bytes())],"asset":hex::encode(notes[0].asset_id().to_bytes()),"transactions":1}))
            }
            // XM4: 1..=3 shielded notes -> private payment to a shielded address + change; TWO wires.
            "private" => {
                let key = self.key()?;
                let n = amount(q, "amount")?;
                let notes = self.notes_by_commitment(&q["notes"], private2::INPUTS)?;
                let to = shielded_of(txt(q, "to")?)?;
                let spk = self.spend_pk.as_ref().context("Spend proving key not loaded")?;
                let opk = self.output_pk.as_ref().context("Output proving key not loaded")?;
                let built = private2::build(&pool.ledger, key, &notes, &to, n, spk, opk, &p.domain)?;
                let (wa, wb) = (built.a.encode(), built.b.encode());
                self.self_check(&[&wa, &wb])?;
                let total: u128 = notes.iter().map(|x| u128::from(x.amount())).sum();
                Ok(json!({"kind":"private","op":hex::encode(built.op),"wires":[hex::encode(&wa),hex::encode(&wb)],"recordIds":[hex::encode(core::hash(&wa)),hex::encode(core::hash(&wb))],"bytes":[wa.len(),wb.len()],"inputs":notes.len(),"amount":n.to_string(),"change":(total-u128::from(n)).to_string(),"reserved":notes.iter().map(|x|hex::encode(x.commit().0.to_bytes())).collect::<Vec<_>>(),"asset":hex::encode(notes[0].asset_id().to_bytes()),"transactions":2}))
            }
            other => anyhow::bail!("Unknown build kind {other}"),
        }
    }
    /// Exact record lengths for a build request, so the carrier fee can be quoted BEFORE anything is proved.
    fn plan(q: &J) -> Result<J> {
        let n_in = q["inputs"].as_u64().unwrap_or(1) as usize;
        let change = q["change"].as_bool().unwrap_or(true);
        let lens: Vec<usize> = match txt(q, "kind")? {
            "public" => vec![4 + 32 + 2 + 32 * n_in + PublicOutput::BYTES * if change { 2 } else { 1 } + 64],
            "burn" => vec![4 + 32 + 1 + 32 * n_in + 8 + PublicOutput::BYTES + 32 + 64],
            "shield" => vec![4 + 32 + 1 + 32 * n_in + PublicOutput::BYTES + 8 + pz::ShieldedOutput::BYTES + 64 + 64],
            "unshield" => vec![shield::UNSHIELD_BYTES],
            "private" => vec![private2::A_BYTES, private2::B_BYTES],
            other => anyhow::bail!("Unknown plan kind {other}"),
        };
        for l in &lens {
            ensure!(*l <= transport::MAX_RECORD, "Planned record of {l} bytes does not fit one carrier");
        }
        Ok(json!({"wireLengths":lens,"transactions":lens.len(),"extraBytes":lens.iter().map(|l|transport::framed_extra_len(*l)).collect::<Vec<_>>()}))
    }
    pub fn call(&mut self, q: &J) -> Result<J> {
        match txt(q, "op")? {
            "version" => Ok(json!({"scheme":SCHEME,"protocol":PROTOCOL,"engine":"xmr20-holder-wasm 0.0.6-market-experimental","market":market_ops::MARKET_PROTOCOL_INFO,"parameterManifest":MANIFEST_FORMAT,"domainLabel":DOMAIN_LABEL,"records":{"public":"XP1","credit":"XC1","burn":"XR1","shield":"XS1","unshield":"XU1","privateA":"XMA","privateB":"XMB","anchored":"XA1","sale":"XL1"},"parameters":self.params.as_ref().map(|p|json!({"label":p.manifest.label,"domain":p.config.domain,"spendLoaded":self.spend_pk.is_some(),"outputLoaded":self.output_pk.is_some()}))})),
            "derive" => {
                let mut root = Zeroizing::new(bytes32(txt(q, "root")?)?);
                let account = q["account"].as_u64().unwrap_or(0) as u32;
                let key = keys::token_spend_key(&root, account);
                let owner = keys::owner_signing_key(&root, account);
                let native_wallet = native::NativeWallet::from_root(&root)?;
                root.fill(0);
                let fvk = key.full_viewing_key().clone();
                let opk = keys::owner_key(&owner);
                let shielded = keys::shielded_address(&key);
                let native_address = native_wallet.address();
                self.key = Some(key);
                self.fvk = Some(fvk);
                self.owner = Some(owner);
                self.owner_key = Some(opk);
                self.native = Some(native_wallet);
                Ok(json!({"scheme":SCHEME,"account":account,"tokenAddress":self.unified()?,"shieldedAddress":shielded.to_string(),"ownerKey":hex::encode(opk),"nativeAddress":native_address}))
            }
            // View-only engine: shielded view from the full viewing key; public view if an owner key is given too.
            "openViewing" => {
                let fvk = FullViewingKey::from_str(txt(q, "viewingKey")?).map_err(|e| anyhow::anyhow!("Viewing key: {e}"))?;
                let owner = match q["owner"].as_str() {
                    Some(o) => Some(owner_of(o)?),
                    None => None,
                };
                self.key = None;
                self.owner = None;
                self.fvk = Some(fvk);
                self.owner_key = owner;
                Ok(json!({"tokenAddress":self.unified()?,"canSpend":false}))
            }
            "viewingKey" => Ok(json!({"viewingKey":self.fvk()?.to_string(),"ownerKey":self.owner_key.map(hex::encode)})),
            "params" => {
                ensure!(!q["manifest"].is_null(), "Shipped parameter manifest required (no server-supplied configuration is trusted on its own)");
                let manifest: Manifest = serde_json::from_value(q["manifest"].clone()).context("Parameter manifest")?;
                let served: Option<Config> = if q["served"].is_null() { None } else { Some(serde_json::from_value(q["served"].clone()).context("served configuration")?) };
                let p = Params::new(manifest, served)?;
                self.pool = Some(fresh_pool(p.domain, &p.manifest));
                self.note_origin.clear();
                self.records.clear();
                self.pool_log.clear();
                self.pool_tip = None;
                self.tip = 0;
                self.spend_pk = None;
                self.output_pk = None;
                let domain = p.config.domain.clone();
                self.params = Some(p);
                Ok(json!({"domain":domain}))
            }
            "reset" => {
                let fresh = fresh_pool(self.params()?.domain, &self.params()?.manifest);
                self.pool = Some(fresh);
                self.note_origin.clear();
                self.records.clear();
                self.pool_log.clear();
                self.pool_tip = None;
                self.tip = 0;
                if let Some(n) = self.native.as_mut() {
                    n.reset();
                }
                Ok(json!({"reset":true}))
            }
            // `pool`/`native` (default true) select which side takes the block: after restoring saved progress the pool
            // and the native wallet can be at different heights. A skipped native side still checks the block blob.
            "applyBlock" => {
                let height = q["height"].as_u64().context("height")?;
                let apply_pool = q["pool"].as_bool().unwrap_or(true);
                let apply_native = q["native"].as_bool().unwrap_or(true);
                ensure!(apply_pool || apply_native, "applyBlock with neither side");
                if apply_pool {
                    ensure!(self.pool_tip.map_or(true, |t| height > t), "Pool already holds block {height}");
                }
                let txs: Vec<(String, String)> = q["txs"].as_array().context("txs")?.iter().map(|t| Ok((txt(t, "txid")?.to_string(), txt(t, "hex")?.to_string()))).collect::<Result<_>>()?;
                let (extras, native_stats) = match self.native.as_mut() {
                    Some(n) if apply_native => n.apply_block(height as usize, txt(q, "block")?, &txs)?,
                    Some(_) => {
                        let (_, parsed) = native::parse_block(height as usize, txt(q, "block")?, &txs)?;
                        (parsed.iter().map(|tx| (hex::encode(tx.hash()), tx.prefix().extra.clone(), native::key_images(tx))).collect(), json!({"skipped":true}))
                    }
                    None => {
                        let mut out = vec![];
                        for (txid, hex_tx) in &txs {
                            let b = hex::decode(hex_tx)?;
                            let tx = monero_wallet::transaction::Transaction::read(&mut b.as_slice()).map_err(|e| anyhow::anyhow!("Transaction: {e}"))?;
                            ensure!(hex::encode(tx.hash()) == *txid, "Transaction hash mismatch");
                            out.push((txid.clone(), tx.prefix().extra.clone(), native::key_images(&tx)));
                        }
                        (out, json!(null))
                    }
                };
                let mut records = vec![];
                if apply_pool {
                    for (txid, extra, kis) in extras {
                        let r = self.apply_extra(height, txid, &extra, &kis)?;
                        if r["record"] != "ignored" {
                            records.push(r);
                        }
                    }
                    self.pool_tip = Some(height);
                }
                self.tip = self.tip.max(height);
                Ok(json!({"height":height,"records":records,"native":native_stats,"pool":apply_pool}))
            }
            "poolSnapshot" => Ok(json!({
                "tip": self.pool_tip,
                "log": self.pool_log.iter().map(|(h, txid, extra, kis)| json!({"height": h, "txid": txid, "extra": hex::encode(extra), "inputs": kis.iter().map(hex::encode).collect::<Vec<_>>()})).collect::<Vec<_>>()
            })),
            // Rebuilds the pool from a saved record log: a fresh pool, every record re-verified in its saved order.
            "poolRestore" => {
                let tip = q["tip"].as_u64().context("tip")?;
                let entries = q["log"].as_array().context("log")?;
                let fresh = fresh_pool(self.params()?.domain, &self.params()?.manifest);
                self.pool = Some(fresh);
                self.note_origin.clear();
                self.records.clear();
                self.pool_log.clear();
                let mut last = 0;
                for e in entries {
                    let height = e["height"].as_u64().context("height")?;
                    ensure!(height >= last && height <= tip, "Saved record log out of order");
                    last = height;
                    // A record log saved by an engine without carrier inputs (0.0.4 and earlier) cannot be replayed under the
                    // anchored rules once they apply: refuse it then, so the scanner starts over from the chain instead of
                    // rejecting valid sales. Below the activation height (mainnet until H is set) nothing needs the inputs, so
                    // an upgraded wallet keeps its saved progress (31 Oct 2026).
                    let active = self.pool.as_ref().and_then(|p| p.market_from).is_some_and(|h| height >= h);
                    ensure!(!active || !e["inputs"].is_null(), "Saved record log has no carrier inputs (saved by an older engine); rescanning");
                    let kis = if e["inputs"].is_null() { vec![] } else { hexlist(&e["inputs"])? };
                    let r = self.apply_extra(height, txt(e, "txid")?.to_string(), &hex::decode(txt(e, "extra")?)?, &kis)?;
                    ensure!(r["record"] != "ignored", "Saved record log holds a non-record");
                }
                self.pool_tip = Some(tip);
                self.tip = self.tip.max(tip);
                Ok(json!({"tip":tip,"records":self.pool_log.len()}))
            }
            "nativeSnapshot" => Ok(self.native.as_ref().context("No native wallet")?.snapshot()),
            "nativeRestore" => {
                let rollback = match q["rollbackTo"].as_u64() {
                    Some(h) => Some((h as usize, q["rctOutputs"].as_u64().context("rctOutputs through the rollback height")?)),
                    None => None,
                };
                let n = self.native.as_mut().context("No native wallet")?;
                n.restore(&q["state"], rollback)?;
                let tip = n.tip as u64;
                self.tip = self.tip.max(tip);
                Ok(json!({"blocks":tip+1}))
            }
            "nativeStart" => {
                let height = q["height"].as_u64().context("height")?;
                let rct = q["rctOutputs"].as_u64().context("rctOutputs")?;
                self.native.as_mut().context("No native wallet")?.start_at(height as usize, rct)?;
                self.tip = self.tip.max(height.saturating_sub(1));
                Ok(json!({"startHeight":height,"rctOutputs":rct}))
            }
            "nativeAddress" => {
                let kind = self.params()?.manifest.network.kind.clone();
                Ok(json!({"network":kind,"nativeAddress":self.native.as_ref().context("No native wallet")?.address_for(&kind)}))
            }
            "nativeStatus" => {
                let exclude = hexset(&q["exclude"])?;
                Ok(self.native.as_ref().context("No native wallet in this engine")?.status(&exclude))
            }
            "nativeReserve" => {
                let kis: Vec<[u8; 32]> = hexset(&q["keyImages"])?.into_iter().collect();
                self.native.as_mut().context("No native wallet")?.reserve(&kis);
                Ok(json!({"reserved":kis.len()}))
            }
            "nativeRelease" => {
                let kis: Vec<[u8; 32]> = hexset(&q["keyImages"])?.into_iter().collect();
                self.native.as_mut().context("No native wallet")?.release(&kis);
                Ok(json!({"released":kis.len()}))
            }
            // Carrier fee quote for a record of exactly `wireLen` bytes (from `plan`).
            "carrierQuote" => {
                let kind = txt(q, "kind")?;
                let wire_len = q["wireLen"].as_u64().context("wireLen (from plan)")? as usize;
                let per_weight = q["feeRate"]["perWeight"].as_str().context("feeRate.perWeight")?.parse::<u64>()?;
                let mask = q["feeRate"]["mask"].as_str().context("feeRate.mask")?.parse::<u64>()?;
                let fee_rate = monero_wallet::interface::FeeRate::new(per_weight, mask).context("Invalid fee rate")?;
                let distribution: Vec<u64> = q["distribution"].as_array().context("distribution")?.iter().map(|v| v.as_u64().context("distribution entry")).collect::<Result<_>>()?;
                let mut exclude = hexset(&q["exclude"])?;
                exclude.extend(self.anchors_in_use());
                self.native.as_mut().context("No native wallet")?.quote(kind, wire_len, fee_rate, distribution, &exclude)
            }
            "carrierOuts" => {
                let id = txt(q, "quoteId")?;
                let mut outs = vec![];
                for o in q["outs"].as_array().context("outs")? {
                    let index = o["index"].as_u64().context("index")?;
                    let unlocked = o["unlocked"].as_bool().unwrap_or(false);
                    let point = |k: &str| -> Result<monero_wallet::ed25519::Point> { monero_wallet::ed25519::CompressedPoint::from(bytes32(txt(o, k)?)?).decompress().context("Invalid point from daemon") };
                    let v = if unlocked { Some([point("key")?, point("mask")?]) } else { None };
                    outs.push((index, v));
                }
                self.native.as_mut().context("No native wallet")?.quote_outs(id, &outs)
            }
            "carrierSign" => {
                let wire = hex::decode(txt(q, "wire")?)?;
                // The record must still be admissible (or be a pending half of an operation) before a fee is paid for it.
                let p = self.params()?;
                let mut candidate = self.pool()?.clone();
                let check = candidate.apply(Some(&wire), &hex::encode([0u8; 32]), self.tip + 1, &p.vks);
                ensure!(check["record"] == "accepted" || check["record"] == "pending", "Record fails local admission; no carrier built: {}", check["error"]);
                self.native.as_mut().context("No native wallet")?.sign(txt(q, "quoteId")?, &wire)
            }
            "carrierCancel" => Ok(json!({"cancelled":self.native.as_mut().context("No native wallet")?.cancel(txt(q, "quoteId")?)})),
            "apply" => {
                let height = q["height"].as_u64().context("height")?;
                let txid = txt(q, "txid")?.to_string();
                let extra = hex::decode(txt(q, "extra")?)?;
                let kis = if q["inputs"].is_null() { vec![] } else { hexlist(&q["inputs"])? };
                let r = self.apply_extra(height, txid, &extra, &kis)?;
                self.pool_tip = Some(self.pool_tip.map_or(height, |t| t.max(height)));
                self.tip = self.tip.max(height);
                Ok(r)
            }
            // 29 Oct 2026: read-only check of waiting (unconfirmed) transactions for incoming tokens. The node's pool
            // transactions are tried, in the given order, on a COPY of the token pool at the next height; nothing in the engine
            // changes. A record that spends any of this wallet's notes is its own operation (a send, Make private/open), so its
            // outputs to this wallet are change and are left out. First halves of two-part private transfers add nothing until
            // the second half is also waiting. A second pass retries records that depend on another waiting record.
            "peekPool" => {
                let txs: Vec<(String, String)> = q["txs"].as_array().context("txs")?.iter().map(|t| Ok((txt(t, "txid")?.to_string(), txt(t, "hex")?.to_string()))).collect::<Result<_>>()?;
                let mut wires = vec![];
                for (txid, hex_tx) in &txs {
                    let b = hex::decode(hex_tx)?;
                    let tx = monero_wallet::transaction::Transaction::read(&mut b.as_slice()).map_err(|e| anyhow::anyhow!("Transaction: {e}"))?;
                    ensure!(hex::encode(tx.hash()) == *txid, "Transaction hash mismatch");
                    if let Some(w) = transport::unframe(&tx.prefix().extra).ok().flatten() {
                        if transport::known_magic(&w) {
                            wires.push((txid.clone(), w, native::key_images(&tx)));
                        }
                    }
                }
                if wires.is_empty() {
                    return Ok(json!({"incoming":[],"checked":txs.len(),"records":0}));
                }
                let p = self.params()?;
                let fvk = self.fvk()?;
                let owner = self.owner_key;
                let mut candidate = self.pool()?.clone();
                let height = self.tip + 1;
                let shielded_of = |pool: &pool::Pool| -> Result<BTreeMap<[u8; 32], (bool, asset::Id, u128)>> {
                    Ok(pool.ledger.owned(fvk)?.into_iter().map(|o| (o.note.commit().0.to_bytes(), (o.spent, o.note.asset_id(), u128::from(o.note.amount())))).collect())
                };
                let public_of = |pool: &pool::Pool| -> BTreeMap<String, pool::PublicNote> { owner.map(|o| pool.notes_of_owner(&o).into_iter().collect()).unwrap_or_default() };
                let mut incoming = vec![];
                let mut accepted = 0usize;
                let mut todo = wires;
                for _pass in 0..2 {
                    let mut retry = vec![];
                    for (txid, w, kis) in todo {
                        let (sh0, pb0) = (shielded_of(&candidate)?, public_of(&candidate));
                        let r = candidate.apply_carrier(Some(&w), &txid, height, &kis, &p.vks);
                        match r["record"].as_str() {
                            Some("accepted") => accepted += 1,
                            Some("rejected") => {
                                retry.push((txid, w, kis));
                                continue;
                            }
                            _ => continue,
                        }
                        let (sh1, pb1) = (shielded_of(&candidate)?, public_of(&candidate));
                        let own = sh0.iter().any(|(cm, (spent, _, _))| !spent && sh1.get(cm).map_or(false, |x| x.0)) || pb0.keys().any(|id| !pb1.contains_key(id));
                        if own {
                            continue;
                        }
                        for (cm, (spent, a, v)) in &sh1 {
                            if !spent && *v > 0 && !sh0.contains_key(cm) {
                                incoming.push(json!({"kind":"shielded","record":r["kind"],"asset":hex::encode(a.to_bytes()),"amount":v.to_string(),"commitment":hex::encode(cm),"txid":txid}));
                            }
                        }
                        for (id, n) in &pb1 {
                            if n.amount > 0 && !pb0.contains_key(id) {
                                incoming.push(json!({"kind":"public","record":r["kind"],"asset":n.asset,"amount":n.amount.to_string(),"id":id,"txid":txid}));
                            }
                        }
                    }
                    if retry.is_empty() {
                        break;
                    }
                    todo = retry;
                }
                Ok(json!({"incoming":incoming,"checked":txs.len(),"records":accepted}))
            }
            "tip" => {
                self.tip = q["height"].as_u64().context("height")?;
                Ok(json!({"tip":self.tip}))
            }
            "status" => {
                let pool = self.pool()?;
                let owned = self.owned()?;
                let mut shielded: BTreeMap<String, u128> = BTreeMap::new();
                for o in owned.iter().filter(|o| !o.spent) {
                    *shielded.entry(hex::encode(o.note.asset_id().to_bytes())).or_default() += u128::from(o.note.amount());
                }
                let (public_balances, public_notes) = match self.owner_key {
                    Some(o) => (pool.public_balances(&o), pool.notes_of_owner(&o)),
                    None => (BTreeMap::new(), vec![]),
                };
                let records = self.records.iter().map(|(id, r)| (id.clone(), json!({"height":r.height,"txid":r.txid,"status":r.status,"kind":r.kind,"error":r.error,"detail":r.detail,"confirmations":self.tip+1-r.height}))).collect::<BTreeMap<_, _>>();
                Ok(json!({
                    "tokenAddress":self.unified()?,
                    "shieldedAddress":self.fvk()?.payment_address(0u32.into()).0.to_string(),
                    "ownerKey":self.owner_key.map(hex::encode),
                    "canSpend":self.key.is_some(),
                    "tip":self.tip,
                    "public":{"balances":public_balances.iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),"notes":public_notes.iter().map(|(id,n)|json!({"id":id,"asset":n.asset,"amount":n.amount.to_string(),"height":n.height,"txid":n.txid,"anchored":n.anchor.is_some()})).collect::<Vec<_>>()},
                    "shielded":{"balances":shielded.iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),"notes":owned.iter().filter(|o|!o.spent&&u128::from(o.note.amount())>0).map(|o| self.note_json(o)).collect::<Vec<_>>(),"spent":owned.iter().filter(|o|o.spent).map(|o| self.note_json(o)).collect::<Vec<_>>(),"zeroNotes":owned.iter().filter(|o|!o.spent&&u128::from(o.note.amount())==0).count()},
                    // Backwards-compatible aliases for callers that read the shielded view only.
                    "balances":shielded.iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),
                    "notes":owned.iter().filter(|o|!o.spent&&u128::from(o.note.amount())>0).map(|o| self.note_json(o)).collect::<Vec<_>>(),
                    "spent":owned.iter().filter(|o|o.spent).map(|o| self.note_json(o)).collect::<Vec<_>>(),
                    "records":records,
                    "pool":pool.summary()
                }))
            }
            "selectPublic" => {
                let asset = asset_of(q)?;
                let n = amount(q, "amount")?;
                let exclude = hexset(&q["exclude"])?;
                let (ids, total) = self.select_public(asset, u128::from(n), &exclude)?;
                Ok(json!({"notes":ids.iter().map(hex::encode).collect::<Vec<_>>(),"total":total.to_string(),"change":(total-u128::from(n)).to_string()}))
            }
            "select" => {
                let asset = asset_of(q)?;
                let n = amount(q, "amount")?;
                let exclude = hexset(&q["exclude"])?;
                let max = q["max"].as_u64().unwrap_or(private2::INPUTS as u64) as usize;
                let notes = self.select_shielded(asset, u128::from(n), &exclude, max.clamp(1, private2::INPUTS))?;
                let total: u128 = notes.iter().map(|x| u128::from(x.amount())).sum();
                Ok(json!({"notes":notes.iter().map(|x|hex::encode(x.commit().0.to_bytes())).collect::<Vec<_>>(),"total":total.to_string(),"change":(total-u128::from(n)).to_string()}))
            }
            "plan" => Self::plan(q),
            "build" => self.build(q),
            "verify" => {
                let p = self.params()?;
                let mut candidate = self.pool()?.clone();
                if let Some(ws) = q["wires"].as_array() {
                    let mut last = json!(null);
                    for (i, w) in ws.iter().enumerate() {
                        let wire = hex::decode(w.as_str().context("wire hex")?)?;
                        last = candidate.apply(Some(&wire), &hex::encode([i as u8 + 1; 32]), self.tip + 1, &p.vks);
                    }
                    return Ok(last);
                }
                let wire = hex::decode(txt(q, "wire")?)?;
                // Optional carrier key images (anchored notes are only admissible with them; without, this fails closed).
                let kis = if q["inputs"].is_null() { vec![] } else { hexlist(&q["inputs"])? };
                Ok(candidate.apply_carrier(Some(&wire), &hex::encode([0u8; 32]), self.tip + 1, &kis, &p.vks))
            }
            "close" => {
                self.key = None;
                self.fvk = None;
                self.owner = None;
                self.owner_key = None;
                self.native = None;
                Ok(json!({"closed":true}))
            }
            other if other.starts_with("market") => self.market_call(other, q),
            other if other.starts_with("nft") => self.nft_call(other, q),
            other => anyhow::bail!("Unknown engine op {other}"),
        }
    }
}

// ------------------------------------------------------------ C ABI
thread_local! {
    static ENGINE: RefCell<Engine> = RefCell::new(Engine::default());
    static OUT: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    static PANIC: RefCell<String> = RefCell::new(String::new());
}
fn respond(v: J) -> u32 {
    OUT.with(|o| {
        let mut o = o.borrow_mut();
        *o = v.to_string().into_bytes();
        o.len() as u32
    })
}
#[no_mangle]
pub extern "C" fn xmr20_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}
#[no_mangle]
pub unsafe extern "C" fn xmr20_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}
#[no_mangle]
pub extern "C" fn xmr20_out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn xmr20_init() {
    std::panic::set_hook(Box::new(|info| {
        PANIC.with(|p| *p.borrow_mut() = info.to_string());
    }));
}
#[no_mangle]
pub extern "C" fn xmr20_panic_len() -> u32 {
    PANIC.with(|p| p.borrow().len() as u32)
}
#[no_mangle]
pub extern "C" fn xmr20_panic_ptr() -> *const u8 {
    PANIC.with(|p| p.borrow().as_ptr())
}
#[no_mangle]
pub unsafe extern "C" fn xmr20_call(ptr: *mut u8, len: usize) -> u32 {
    let req = Vec::from_raw_parts(ptr, len, len);
    let out = match serde_json::from_slice::<J>(&req) {
        Ok(q) => ENGINE.with(|e| match e.borrow_mut().call(&q) {
            Ok(r) => json!({"result":r}),
            Err(err) => json!({"error":err.to_string()}),
        }),
        Err(err) => json!({"error":format!("Request JSON: {err}")}),
    };
    respond(out)
}
// Binary parameter upload (proving keys): slot 0 = Penumbra spend key, 1 = Penumbra output key.
#[no_mangle]
pub unsafe extern "C" fn xmr20_blob(slot: u32, ptr: *mut u8, len: usize) -> u32 {
    let bytes = Vec::from_raw_parts(ptr, len, len);
    let out = ENGINE.with(|e| match e.borrow_mut().set_blob(slot, &bytes) {
        Ok(r) => json!({"result":r}),
        Err(err) => json!({"error":err.to_string()}),
    });
    respond(out)
}
