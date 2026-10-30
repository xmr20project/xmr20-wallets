//! Trusted parameter manifest, format XMR20-PARAMS-2 (shared by the roles binary and the holder engine).
//! It pins, for this protocol version and network: Penumbra's two proving-key files (exact length,
//! sha256 = Penumbra's git-lfs object id, compressed verifying key, Penumbra key id), parameters.json,
//! the ledger domain and the issuer key. Anything a parameter server says about its own files is checked
//! AGAINST this manifest and never trusted on its own.
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value as J;
use std::collections::BTreeMap;

use crate::{hash, penumbra as pz, Config, DOMAIN_LABEL, MANIFEST_FORMAT, PROTOCOL, SCHEME};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ManifestFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    #[serde(default)]
    pub vk: String,
    #[serde(default, rename = "keyId")]
    pub key_id: String,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestShape {
    pub magic: String,
    pub bytes: String,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestProtocol {
    pub version: String,
    pub scheme: String,
    #[serde(rename = "domainLabel")]
    pub domain_label: String,
    pub records: BTreeMap<String, ManifestShape>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestNetwork {
    pub kind: String,
    pub genesis: String,
    #[serde(rename = "startHeight", default)]
    pub start_height: u64,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestFiles {
    pub spend: ManifestFile,
    pub output: ManifestFile,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Manifest {
    pub format: String,
    pub label: String,
    pub protocol: ManifestProtocol,
    pub network: ManifestNetwork,
    #[serde(rename = "ledgerDomain")]
    pub ledger_domain: String,
    #[serde(rename = "issuerVk")]
    pub issuer_vk: String,
    pub config: Config,
    #[serde(rename = "parametersJson")]
    pub parameters_json: ManifestFile,
    pub files: ManifestFiles,
    #[serde(default)]
    pub provenance: J,
}
impl Manifest {
    /// Internal consistency and protocol identity; returns the ledger domain.
    pub fn validate(&self) -> Result<[u8; 32]> {
        ensure!(self.format == MANIFEST_FORMAT, "Manifest format {} is not {MANIFEST_FORMAT}", self.format);
        ensure!(self.protocol.version == PROTOCOL, "Manifest protocol {:?} is not {PROTOCOL:?}", self.protocol.version);
        ensure!(self.protocol.domain_label == DOMAIN_LABEL, "Manifest protocol domain {:?} is not {DOMAIN_LABEL:?}", self.protocol.domain_label);
        ensure!(self.protocol.scheme == SCHEME, "Manifest key scheme {} is not {SCHEME}", self.protocol.scheme);
        // MAINNET PILOT (26 Oct 2026): "mainnet" is an accepted manifest kind. The operational refusals stay where the daemon is touched:
        // the roles binary needs XMR20_MAINNET_PILOT=I-UNDERSTAND (format/native.rs), the service XMR20_BRIDGE_MAINNET=I-UNDERSTAND.
        ensure!(matches!(self.network.kind.as_str(), "offline-fakechain" | "stagenet" | "mainnet"), "Unsupported network {:?} (offline-fakechain, stagenet or mainnet)", self.network.kind);
        ensure!(self.network.genesis == self.config.chain, "Manifest genesis differs from its configuration");
        ensure!(self.ledger_domain == self.config.domain, "Manifest ledger domain differs from its configuration");
        ensure!(self.issuer_vk == self.config.issuer_vk, "Manifest issuer key differs from its configuration");
        ensure!(self.files.spend.vk == self.config.spend_vk && self.files.output.vk == self.config.output_vk, "Manifest verifying keys differ from its configuration");
        ensure!(self.files.spend.key_id == pz::SPEND_PK_ID && self.files.output.key_id == pz::OUTPUT_PK_ID, "Manifest proving-key ids are not Penumbra's published ids");
        ensure!(self.files.spend.bytes == pz::SPEND_PK_BYTES && self.files.spend.sha256 == pz::SPEND_PK_SHA256, "Manifest spend proving key is not Penumbra's published file");
        ensure!(self.files.output.bytes == pz::OUTPUT_PK_BYTES && self.files.output.sha256 == pz::OUTPUT_PK_SHA256, "Manifest output proving key is not Penumbra's published file");
        for f in [&self.parameters_json, &self.files.spend, &self.files.output] {
            ensure!(hex::decode(&f.sha256).map(|h| h.len() == 32).unwrap_or(false) && f.bytes > 0, "Manifest pin for {} is malformed", f.path);
        }
        self.config.domain()
    }
    pub fn file(&self, slot: u32) -> Result<(&ManifestFile, pz::Circuit)> {
        match slot {
            0 => Ok((&self.files.spend, pz::Circuit::Spend)),
            1 => Ok((&self.files.output, pz::Circuit::Output)),
            _ => anyhow::bail!("Unknown parameter slot"),
        }
    }
}
/// Authenticate a complete parameter file against the manifest BEFORE anything parses it.
pub fn authenticate_file(expected: &ManifestFile, bytes: &[u8]) -> Result<String> {
    ensure!(bytes.len() as u64 == expected.bytes, "Parameter file {} rejected: {} bytes received, the shipped manifest pins {} bytes (missing, truncated or substituted file)", expected.path, bytes.len(), expected.bytes);
    let digest = hex::encode(hash(bytes));
    ensure!(digest == expected.sha256, "Parameter file {} rejected: sha256 {}… does not match the shipped manifest ({}…); the file was not used", expected.path, &digest[..16], &expected.sha256[..16]);
    Ok(digest)
}
