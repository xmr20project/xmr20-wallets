//! Roles over stdin JSON for the unshielded-by-default format. The network is the trusted manifest's (native.rs `guard`).
//!   setup <dir> <genesis-hex> <penumbra-params-dir>   write parameters.json, issuer.secret.json, link/copy Penumbra keys
//!   indexer <dir> --trusted-manifest <path>           public state, viewing-key balances, owner balances; cannot spend
//!   issuer  <dir> --trusted-manifest <path>           single-operator PUBLIC credits (XC1), carriers paid by the issuer
//! There is no wallet role: holders are the wasm engine (holder-wasm) driven by the extension or wallet-lib.
use anyhow::{ensure, Context, Result};
use decaf377_rdsa::{SigningKey, SpendAuth, VerificationKey};
use monero_wallet::interface::prelude::*;
use penumbra_sdk_keys::FullViewingKey;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as J};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, BufRead, Write},
    path::Path,
    str::FromStr,
};
use xmr20_unshielded_core::{self as core, asset_for_mint, hash, keys::owner_vk, penumbra as pz, public, Config};
use xmr20_unshielded_lab::{
    chain::{Chain, Params},
    native,
};

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
fn carrier_json(tx: &monero_wallet::transaction::Transaction, wire: &[u8]) -> Result<J> {
    Ok(json!({"wire":hex::encode(wire),"blob":hex::encode(tx.serialize()),"txid":hex::encode(tx.hash()),"extraBytes":tx.prefix().extra.len(),"nativeBytes":tx.serialize().len(),"fee":native::fee(tx)?.to_string(),"recordId":hex::encode(hash(wire))}))
}

// ---------------------------------------------------------------- setup
#[derive(Serialize, Deserialize)]
struct IssuerSecret {
    signing: [u8; 32],
    native_spend: [u8; 32],
    native_view: [u8; 32],
}
/// Writes a parameter set directory for `chain` (genesis hex): Penumbra's two proving keys (copied from
/// `penumbra_dir`, re-verified), parameters.json (Config with Penumbra's verifying keys), the issuer secret.
/// The manifest is produced by make-manifest.mjs from this directory.
fn setup(dir: &Path, chain: String, penumbra_dir: &Path) -> Result<()> {
    ensure!(!dir.exists(), "Parameter directory exists");
    fs::create_dir_all(dir)?;
    let sp = fs::read(penumbra_dir.join("spend_pk.bin")).context("spend_pk.bin")?;
    let op = fs::read(penumbra_dir.join("output_pk.bin")).context("output_pk.bin")?;
    ensure!(sp.len() as u64 == pz::SPEND_PK_BYTES && hex::encode(hash(&sp)) == pz::SPEND_PK_SHA256, "spend_pk.bin is not Penumbra's published file");
    ensure!(op.len() as u64 == pz::OUTPUT_PK_BYTES && hex::encode(hash(&op)) == pz::OUTPUT_PK_SHA256, "output_pk.bin is not Penumbra's published file");
    let spk = pz::load_pk(pz::Circuit::Spend, &sp)?;
    let opk = pz::load_pk(pz::Circuit::Output, &op)?;
    let svk = pz::load_vk_param(pz::Circuit::Spend, &fs::read(penumbra_dir.join("spend_vk.param"))?)?;
    let ovk = pz::load_vk_param(pz::Circuit::Output, &fs::read(penumbra_dir.join("output_vk.param"))?)?;
    ensure!(pz::vk_hex(&spk.vk) == pz::vk_hex(&svk) && pz::vk_hex(&opk.vk) == pz::vk_hex(&ovk), "Penumbra proving and verifying keys disagree");
    let issuer_sign = SigningKey::<SpendAuth>::new(OsRng);
    let issuer_native = native::Wallet::new();
    let (native_spend, native_view) = issuer_native.secrets();
    let mut config = Config { chain, domain: String::new(), spend_vk: pz::vk_hex(&svk), output_vk: pz::vk_hex(&ovk), issuer_vk: hex::encode(VerificationKey::from(&issuer_sign).to_bytes()) };
    config.domain = hex::encode(config.computed_domain()?);
    fs::copy(penumbra_dir.join("spend_pk.bin"), dir.join("spend_pk.bin"))?;
    fs::copy(penumbra_dir.join("output_pk.bin"), dir.join("output_pk.bin"))?;
    fs::write(dir.join("parameters.json"), serde_json::to_vec_pretty(&config)?)?;
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(dir.join("issuer.secret.json"))?;
        f.write_all(&serde_json::to_vec(&IssuerSecret { signing: issuer_sign.to_bytes(), native_spend, native_view })?)?;
    }
    println!("{}", json!({"ready":true,"config":config,"issuerNativeAddress":issuer_native.address().to_string(),"spendPkId":pz::SPEND_PK_ID,"outputPkId":pz::OUTPUT_PK_ID,"spendPkSha256":pz::SPEND_PK_SHA256,"outputPkSha256":pz::OUTPUT_PK_SHA256}));
    Ok(())
}

// ---------------------------------------------------------------- indexer
struct IndexerRole {
    chain: Chain,
}
impl IndexerRole {
    async fn handle(&mut self, rpc: &native::Rpc, p: &Params, q: &J) -> Result<J> {
        match txt(q, "op")? {
            "scan" => Ok(json!({"public":self.chain.scan(rpc, p).await?})),
            // Viewing access: shielded balances/notes for a full viewing key. No spend authority here.
            "view" => {
                let fvk = FullViewingKey::from_str(txt(q, "viewingKey")?).map_err(|e| anyhow::anyhow!("Viewing key: {e}"))?;
                ensure!(self.chain.public != J::Null, "Scan first");
                let balances = self.chain.pool.shielded_balances(&fvk);
                Ok(json!({"balances":balances.iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),"notes":self.chain.pool.ledger.unspent_notes(&fvk).len(),"tip":self.chain.tip}))
            }
            // Public balances are public: anyone can ask for an owner key's notes.
            "owner" => {
                ensure!(self.chain.public != J::Null, "Scan first");
                let o = bytes32(txt(q, "owner")?)?;
                owner_vk(&o)?;
                let notes = self.chain.pool.notes_of_owner(&o);
                Ok(json!({"balances":self.chain.pool.public_balances(&o).iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),"notes":notes.iter().map(|(id,n)|json!({"id":id,"asset":n.asset,"amount":n.amount.to_string(),"height":n.height,"txid":n.txid})).collect::<Vec<_>>(),"tip":self.chain.tip}))
            }
            "verify" => {
                let wire = hex::decode(txt(q, "wire")?)?;
                let mut candidate = self.chain.pool.clone();
                Ok(candidate.apply(Some(&wire), &hex::encode([0u8; 32]), 0, &p.vks))
            }
            "publishBlob" => {
                native::guard(rpc, &p.manifest.network.kind).await?;
                let tx = native::decode(txt(q, "blob")?)?;
                rpc.publish_transaction(&tx).await?;
                Ok(json!({"txid":hex::encode(tx.hash())}))
            }
            "credit" | "send" | "redeem" => anyhow::bail!("Indexer holds no spending or issuing key"),
            other => anyhow::bail!("Unknown indexer op {other}"),
        }
    }
}

// ---------------------------------------------------------------- issuer
struct IssuerRole {
    sign: SigningKey<SpendAuth>,
    native: native::Wallet,
    chain: Chain,
}
impl IssuerRole {
    async fn handle(&mut self, rpc: &native::Rpc, p: &Params, q: &J) -> Result<J> {
        match txt(q, "op")? {
            "scan" => {
                let public = self.chain.scan(rpc, p).await?;
                self.native.refresh(rpc, &p.manifest.network.kind, p.manifest.network.start_height as usize).await?;
                Ok(json!({"public":public,"issuerNative":self.native.balance().to_string()}))
            }
            // PUBLIC credit (XC1): deposit (kind 1) or migration (kind 2) to an owner key, bound to the receipt/claim.
            "credit" => {
                self.chain.scan(rpc, p).await?;
                let owner = bytes32(txt(q, "owner")?)?;
                owner_vk(&owner)?;
                let kind = q["kind"].as_u64().context("kind")? as u8;
                let binding = bytes32(txt(q, "binding")?)?;
                let n = amount(q, "amount")?;
                let asset = core::asset_from_bytes(&bytes32(txt(q, "asset")?)?)?;
                let forged = SigningKey::<SpendAuth>::new(OsRng);
                let signer = if q["forgeIssuer"] == true { &forged } else { &self.sign };
                let record = public::Credit::build(kind, asset, n, owner, binding, signer, &p.domain)?;
                let wire = record.encode();
                // Self-check against the issuer's own replica before paying a carrier fee.
                let mut candidate = self.chain.pool.clone();
                let check = candidate.apply(Some(&wire), &hex::encode([0u8; 32]), 0, &p.vks);
                ensure!(check["record"] == "accepted" || q["forgeIssuer"] == true, "Credit fails local admission: {}", check["error"]);
                let tx = self.native.single(rpc, Some(&wire)).await?;
                carrier_json(&tx, &wire)
            }
            // TEST SERVICE: plain XMR payments from the issuer's test wallet (funding on stagenet). No record.
            "pay" => {
                native::guard(rpc, &p.manifest.network.kind).await?;
                let net = if p.manifest.network.kind == "stagenet" { monero_wallet::address::Network::Stagenet } else { monero_wallet::address::Network::Mainnet };
                let mut payments = vec![];
                for x in q["payments"].as_array().context("payments")? {
                    let a = monero_wallet::address::MoneroAddress::from_str(net, txt(x, "address")?).map_err(|e| anyhow::anyhow!("Address: {e:?}"))?;
                    payments.push((a, amount(x, "amount")?));
                }
                let tx = self.native.pay(rpc, &payments).await?;
                rpc.publish_transaction(&tx).await?;
                Ok(json!({"txid":hex::encode(tx.hash()),"fee":native::fee(&tx)?.to_string(),"outputs":tx.prefix().outputs.len(),"nativeBytes":tx.serialize().len()}))
            }
            "publishBlob" => {
                native::guard(rpc, &p.manifest.network.kind).await?;
                let tx = native::decode(txt(q, "blob")?)?;
                rpc.publish_transaction(&tx).await?;
                Ok(json!({"txid":hex::encode(tx.hash())}))
            }
            other => anyhow::bail!("Unknown issuer op {other}"),
        }
    }
}

enum Role {
    Indexer(IndexerRole),
    Issuer(IssuerRole),
}
async fn dispatch(role: &mut Role, rpc: &native::Rpc, p: &Params, q: &J) -> Result<J> {
    if q["op"] == "asset" {
        let mint = txt(q, "mint")?;
        let id = asset_for_mint(mint)?;
        return Ok(json!({"asset":hex::encode(id.to_bytes()),"mint":mint}));
    }
    match role {
        Role::Indexer(r) => r.handle(rpc, p, q).await,
        Role::Issuer(r) => r.handle(rpc, p, q).await,
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    ensure!(std::env::var("XMR20_INTEGRATION_LAB").as_deref() == Ok("offline-synthetic-only"), "Refusing to run outside the isolated lab");
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).context("mode")?.clone();
    let dir = Path::new(args.get(2).context("parameter directory")?);
    if mode == "setup" {
        return setup(dir, args.get(3).context("genesis hex")?.clone(), Path::new(args.get(4).context("penumbra params dir")?));
    }
    let trusted = {
        let i = args.iter().position(|a| a == "--trusted-manifest").context("--trusted-manifest <path> is required")?;
        Path::new(args.get(i + 1).context("--trusted-manifest path")?)
    };
    let p = Params::load(dir, mode == "issuer", trusted)?;
    let mut rpc = native::rpc(&p.manifest.network.kind).await?;
    {
        let genesis = hex::encode(rpc.block_by_number(0).await?.hash());
        ensure!(genesis == p.manifest.network.genesis, "Daemon genesis {}… is not the trusted manifest's network {}…", &genesis[..16], &p.manifest.network.genesis[..16]);
    }
    let mut role = match mode.as_str() {
        "indexer" => Role::Indexer(IndexerRole { chain: Chain::new(p.domain) }),
        "issuer" => {
            let secret: IssuerSecret = serde_json::from_slice(&fs::read(dir.join("issuer.secret.json"))?)?;
            let sign = SigningKey::<SpendAuth>::try_from(secret.signing)?;
            ensure!(VerificationKey::from(&sign) == p.vks.issuer, "Issuer key mismatch");
            Role::Issuer(IssuerRole { sign, native: native::Wallet::from_secrets(secret.native_spend, secret.native_view)?, chain: Chain::new(p.domain) })
        }
        _ => anyhow::bail!("Unknown mode"),
    };
    let ready = match &role {
        Role::Indexer(_) => json!({"ready":true,"mode":"indexer","domain":p.config.domain,"trustedManifest":{"label":p.manifest.label,"sha256":p.manifest_sha256}}),
        Role::Issuer(i) => json!({"ready":true,"mode":"issuer","issuerNativeAddress":i.native.address_for(&p.manifest.network.kind).to_string(),"trustedManifest":{"label":p.manifest.label,"sha256":p.manifest_sha256}}),
    };
    println!("{ready}");
    let stdout = io::stdout();
    for line in io::stdin().lock().lines() {
        let line = line?;
        ensure!(line.len() < 2_000_000);
        let q: J = serde_json::from_str(&line)?;
        let mut attempt = dispatch(&mut role, &rpc, &p, &q).await;
        if attempt.as_ref().is_err_and(|e| e.to_string().contains("interface error")) {
            if let Ok(fresh) = native::rpc(&p.manifest.network.kind).await {
                rpc = fresh;
                attempt = dispatch(&mut role, &rpc, &p, &q).await;
            }
        }
        let out = match attempt {
            Ok(result) => json!({"result":result}),
            Err(e) => json!({"error":e.to_string()}),
        };
        let mut lock = stdout.lock();
        lock.write_all(out.to_string().as_bytes())?;
        lock.write_all(b"\n")?;
        lock.flush()?;
    }
    Ok(())
}
