//! Minimal authenticated encrypted wallet file (XChaCha20-Poly1305). The 32-byte
//! unlock key arrives on fd 3 (private pipe), never argv/env/stdin. Synthetic
//! keys only; the format is a test container, not a
//! production wallet store.
use anyhow::{ensure, Context, Result};
use chacha20poly1305::{
    aead::{Aead, NewAead, Payload},
    XChaCha20Poly1305,
};
use rand_core::{OsRng, RngCore};
use std::{
    fs,
    io::{Read, Write},
    os::unix::{fs::OpenOptionsExt, io::FromRawFd},
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;
const MAGIC: &[u8; 4] = b"XW1\0";
pub fn unlock_pipe() -> Result<Zeroizing<[u8; 32]>> {
    let mut pipe = unsafe { fs::File::from_raw_fd(3) };
    let mut key = Zeroizing::new([0u8; 32]);
    pipe.read_exact(&mut *key).context("Unlock key on fd 3")?;
    let mut extra = [0u8; 1];
    ensure!(pipe.read(&mut extra)? == 0, "Exactly 32 unlock bytes");
    Ok(key)
}
pub struct Vault {
    path: PathBuf,
    key: Zeroizing<[u8; 32]>,
    domain: [u8; 32],
}
impl Vault {
    pub fn new(path: &Path, key: Zeroizing<[u8; 32]>, domain: [u8; 32]) -> Self {
        Self { path: path.to_path_buf(), key, domain }
    }
    fn aad(&self) -> Vec<u8> {
        let mut a = MAGIC.to_vec();
        a.extend(self.domain);
        a
    }
    pub fn exists(&self) -> bool {
        self.path.exists()
    }
    pub fn load(&self) -> Result<Zeroizing<Vec<u8>>> {
        let file = fs::read(&self.path)?;
        ensure!(file.len() > 28 && &file[..4] == MAGIC, "Vault format");
        let c = XChaCha20Poly1305::new((&*self.key).into());
        let plain = c
            .decrypt(
                (&file[4..28]).into(),
                Payload { msg: &file[28..], aad: &self.aad() },
            )
            .map_err(|_| anyhow::anyhow!("Vault authentication failed (wrong key or damaged file)"))?;
        Ok(Zeroizing::new(plain))
    }
    // Atomic: temp file (0600) + fsync + rename + directory fsync.
    pub fn save(&self, plaintext: &[u8]) -> Result<()> {
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let c = XChaCha20Poly1305::new((&*self.key).into());
        let sealed = c
            .encrypt((&nonce).into(), Payload { msg: plaintext, aad: &self.aad() })
            .map_err(|_| anyhow::anyhow!("Seal"))?;
        let mut file = MAGIC.to_vec();
        file.extend(nonce);
        file.extend(sealed);
        let tmp = self.path.with_extension(format!("tmp-{}", hex::encode(&nonce[..8])));
        {
            let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
            f.write_all(&file)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &self.path)?;
        if let Some(dir) = self.path.parent() {
            fs::File::open(dir)?.sync_all()?;
        }
        Ok(())
    }
}
