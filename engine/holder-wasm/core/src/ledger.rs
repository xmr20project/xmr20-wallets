//! Shielded-pool ledger: Penumbra tiered commitment tree, nullifier set, payload history and the set
//! of every root the pool ever had (records may anchor at any historical root so independent
//! holders can publish concurrently). Verification logic lives in the record modules and pool.rs.
use anyhow::{Context, Result};
use decaf377::Fq;
use penumbra_sdk_keys::FullViewingKey;
use penumbra_sdk_sct::Nullifier;
use penumbra_sdk_shielded_pool::Note;
use penumbra_sdk_tct::{Root, Tree, Witness};
use std::collections::BTreeSet;

use crate::Payload;

#[derive(Clone)]
pub struct Ledger {
    pub tree: Tree,
    pub nullifiers: BTreeSet<[u8; 32]>,
    pub history: Vec<Payload>,
    pub roots: BTreeSet<[u8; 32]>,
    pub domain: [u8; 32],
}
pub fn root_bytes(r: Root) -> [u8; 32] {
    Fq::from(r).to_bytes()
}
pub struct OwnedNote {
    pub note: Note,
    pub position: u64,
    pub spent: bool,
}
impl Ledger {
    pub fn new(domain: [u8; 32]) -> Self {
        let tree = Tree::new();
        let mut roots = BTreeSet::new();
        roots.insert(root_bytes(tree.root()));
        Self { tree, nullifiers: BTreeSet::new(), history: vec![], roots, domain }
    }
    pub fn root(&self) -> Root {
        self.tree.root()
    }
    pub fn known_root(&self, r: Root) -> bool {
        self.roots.contains(&root_bytes(r))
    }
    pub fn commitment_exists(&self, p: &Payload) -> bool {
        self.tree.position_of(p.note_commitment).is_some()
    }
    /// Commit spent nullifiers and new outputs atomically (caller validated everything).
    pub fn commit(&mut self, nullifiers: impl IntoIterator<Item = [u8; 32]>, outputs: &[&Payload]) -> Result<()> {
        self.nullifiers.extend(nullifiers);
        for o in outputs {
            self.tree.insert(Witness::Keep, o.note_commitment).context("Commitment tree insert")?;
            self.history.push((*o).clone());
        }
        self.roots.insert(root_bytes(self.tree.root()));
        Ok(())
    }
    /// Every note the viewing key can decrypt, with its spent status (nullifier derived locally).
    pub fn owned(&self, fvk: &FullViewingKey) -> Result<Vec<OwnedNote>> {
        let mut out = vec![];
        for p in &self.history {
            if let Ok(note) = p.decrypt(fvk) {
                let position: u64 = self.tree.position_of(note.commit()).context("Indexed note")?.into();
                let nf = Nullifier::derive(fvk.nullifier_key(), position.into(), &note.commit()).0.to_bytes();
                out.push(OwnedNote { note, position, spent: self.nullifiers.contains(&nf) });
            }
        }
        Ok(out)
    }
    pub fn unspent_notes(&self, fvk: &FullViewingKey) -> Vec<Note> {
        self.owned(fvk).map(|v| v.into_iter().filter(|o| !o.spent).map(|o| o.note).collect()).unwrap_or_default()
    }
}
