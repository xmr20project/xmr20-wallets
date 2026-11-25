//! Roles library for the unshielded-by-default format: trusted-manifest parameter loading, canonical
//! chain replay into the core Pool, the issuer's native carrier wallet, the legacy (plain Monero
//! signature) claim check and the encrypted vault. The network is the trusted
//! manifest's: offline fakechain, stagenet, or mainnet when XMR20_MAINNET_PILOT=I-UNDERSTAND is set (native.rs).
pub mod chain;
pub mod legacy_sign;
pub mod native;
pub mod vault;
pub mod transport {
    pub use xmr20_unshielded_core::transport::*;
}
pub use xmr20_unshielded_core::Config;
