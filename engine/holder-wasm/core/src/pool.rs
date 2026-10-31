//! The indexer state for the unshielded format: public notes + shielded pool + pending XM4 parts.
//! Rebuilt from the canonical native chain on every scan (as every earlier lab). A record failing
//! admission changes nothing; the native transaction still mined and its fee was spent.
//!
//! Multi-part rule (XM4): parts are stored by operation id when they decode. On every arrival the
//! pool tries each stored counterpart in canonical order; the first pair that passes the FULL check
//! (anchor known, nullifiers distinct and unspent, commitments fresh, ids match, 5 proofs, 2 signatures)
//! is applied once and both parts are consumed. Invalid look-alike parts stay in place and never block
//! the genuine pair. Nothing is reserved by a lone part. Parts never expire.
//!
//! INVARIANT per asset: publicSupply + shieldedSupply == minted - burned, where shieldedSupply is the
//! public tally of XS1 amounts in minus XU1 amounts out (the shielded pool's own conservation keeps
//! private transfers value-neutral).
use anyhow::{ensure, Context, Result};
use ark_groth16::PreparedVerifyingKey;
use decaf377::Bls12_377;
use decaf377_rdsa::{SpendAuth, VerificationKey};
use penumbra_sdk_keys::FullViewingKey;
use serde::Serialize;
use serde_json::{json, Value as J};
use std::collections::{BTreeMap, BTreeSet};

use crate::{keys::owner_vk, ledger::Ledger, market, private2, public, shield, transport, PublicOutput};

pub struct Vks {
    pub spend: PreparedVerifyingKey<Bls12_377>,
    pub output: PreparedVerifyingKey<Bls12_377>,
    pub issuer: VerificationKey<SpendAuth>,
}
#[derive(Clone, Serialize, Debug)]
pub struct PublicNote {
    pub asset: String,
    pub amount: u64,
    pub owner: String,
    pub height: u64,
    pub txid: String,
    /// MARKET candidate: native key image every consuming carrier must spend (None = plain note).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
}
#[derive(Clone, Serialize)]
pub struct Credit {
    pub kind: u8,
    pub asset: String,
    pub amount: u64,
    pub owner: String,
    pub txid: String,
    pub height: u64,
}
#[derive(Clone, Serialize)]
pub struct Redemption {
    pub asset: String,
    pub amount: u64,
    pub binding: String,
    pub owner: String,
    pub txid: String,
    pub height: u64,
}
#[derive(Clone)]
struct StoredA {
    part: private2::PartA,
    hash: [u8; 32],
    txid: String,
    height: u64,
}
#[derive(Clone)]
struct StoredB {
    part: private2::PartB,
    hash: [u8; 32],
    txid: String,
    height: u64,
}
#[derive(Clone, Serialize)]
pub struct Completed {
    pub part_a: String,
    pub part_b: String,
    pub txid_a: String,
    pub txid_b: String,
    pub height: u64,
}
#[derive(Clone)]
pub struct Pool {
    pub ledger: Ledger,
    pub notes: BTreeMap<[u8; 32], PublicNote>,
    pub spent_notes: BTreeSet<[u8; 32]>,
    pub minted: BTreeMap<String, u128>,
    pub burned: BTreeMap<String, u128>,
    pub shielded_in: BTreeMap<String, u128>,
    pub shielded_out: BTreeMap<String, u128>,
    pub credits: BTreeMap<[u8; 32], Credit>,
    pub redemptions: BTreeMap<[u8; 32], Redemption>,
    pending_a: BTreeMap<[u8; 32], Vec<StoredA>>,
    pending_b: BTreeMap<[u8; 32], Vec<StoredB>>,
    pub completed: BTreeMap<[u8; 32], Completed>,
    pub accepted: usize,
    pub rejected: usize,
    pub pending_records: usize,
    /// First height at which XA1/XL1 apply (`market::activation`); None = never (fails closed: a reader that does not set it
    /// behaves like one without the market rules).
    pub market_from: Option<u64>,
}
fn hx(b: &[u8]) -> String {
    hex::encode(b)
}
impl Pool {
    pub fn new(domain: [u8; 32]) -> Self {
        Self {
            ledger: Ledger::new(domain),
            notes: BTreeMap::new(),
            spent_notes: BTreeSet::new(),
            minted: BTreeMap::new(),
            burned: BTreeMap::new(),
            shielded_in: BTreeMap::new(),
            shielded_out: BTreeMap::new(),
            credits: BTreeMap::new(),
            redemptions: BTreeMap::new(),
            pending_a: BTreeMap::new(),
            pending_b: BTreeMap::new(),
            completed: BTreeMap::new(),
            accepted: 0,
            rejected: 0,
            pending_records: 0,
            market_from: None,
        }
    }
    pub fn domain(&self) -> [u8; 32] {
        self.ledger.domain
    }
    // ---- public helpers
    /// Resolve the inputs of a public record: all must exist, be unspent, share the asset and the owner.
    /// MARKET candidate: an ANCHORED input is only resolved when the record's own native carrier spends
    /// its anchor key image (`native` = the carrier's input key images). Every record kind that consumes
    /// public notes (XP1, XR1, XS1, XA1, XL1) resolves its inputs here, so no consumption path skips it.
    fn take_inputs(&self, inputs: &[[u8; 32]], asset: &str, native: &[[u8; 32]]) -> Result<(VerificationKey<SpendAuth>, u128)> {
        let mut owner: Option<[u8; 32]> = None;
        let mut total = 0u128;
        for id in inputs {
            let n = self.notes.get(id).ok_or_else(|| anyhow::anyhow!(if self.spent_notes.contains(id) { "Public input already spent" } else { "Unknown public input" }))?;
            ensure!(n.asset == asset, "Input asset differs from the record asset");
            if let Some(a) = &n.anchor {
                let ki: [u8; 32] = hex::decode(a)?.try_into().map_err(|_| anyhow::anyhow!("anchor"))?;
                ensure!(native.contains(&ki), "Anchored input: the carrier does not spend its anchor key image");
            }
            let o: [u8; 32] = hex::decode(&n.owner)?.try_into().unwrap();
            match owner {
                None => owner = Some(o),
                Some(p) => ensure!(p == o, "Inputs belong to different owners"),
            }
            total = total.checked_add(u128::from(n.amount)).context("Amount overflow")?;
        }
        Ok((owner_vk(&owner.unwrap())?, total))
    }
    fn spend_inputs(&mut self, inputs: &[[u8; 32]]) {
        for id in inputs {
            self.notes.remove(id);
            self.spent_notes.insert(*id);
        }
    }
    fn create_outputs(&mut self, record_id: &[u8; 32], asset: &str, outs: &[&PublicOutput], txid: &str, height: u64) -> Vec<String> {
        let mut ids = vec![];
        for (i, o) in outs.iter().enumerate() {
            if o.amount == 0 {
                continue;
            }
            let id = public::note_id(record_id, i as u16);
            self.notes.insert(id, PublicNote { asset: asset.to_string(), amount: o.amount, owner: hx(&o.owner), height, txid: txid.to_string(), anchor: None });
            ids.push(hx(&id));
        }
        ids
    }
    fn create_anchored(&mut self, record_id: &[u8; 32], asset: &str, outs: &[market::AnchoredOutput], txid: &str, height: u64) -> Vec<String> {
        let mut ids = vec![];
        for (i, o) in outs.iter().enumerate() {
            let id = public::note_id(record_id, i as u16);
            self.notes.insert(id, PublicNote { asset: asset.to_string(), amount: o.amount, owner: hx(&o.owner), height, txid: txid.to_string(), anchor: o.anchor().map(|a| hx(&a)) });
            ids.push(hx(&id));
        }
        ids
    }
    // ---- MARKET candidate records
    fn anchored(&mut self, b: &[u8], txid: &str, height: u64, domain: &[u8; 32], native: &[[u8; 32]]) -> Result<J> {
        let t = market::Anchored::decode(b)?;
        let asset = hx(&t.asset.to_bytes());
        let (owner, total_in) = self.take_inputs(&t.inputs, &asset, native)?;
        ensure!(total_in == t.total_out()?, "Anchored transfer does not conserve value");
        t.verify_sig(&owner, domain)?;
        self.spend_inputs(&t.inputs);
        let rid = public::record_id(b);
        let ids = self.create_anchored(&rid, &asset, &t.outputs, txid, height);
        Ok(json!({"asset":asset,"inputs":t.inputs.len(),"outputs":ids,"owner":hx(&owner.to_bytes()),"anchored":t.outputs.iter().filter(|o|o.anchor().is_some()).count()}))
    }
    fn sale(&mut self, b: &[u8], txid: &str, height: u64, domain: &[u8; 32], native: &[[u8; 32]]) -> Result<J> {
        let s = market::Sale::decode(b)?;
        let asset = hx(&s.asset.to_bytes());
        let lot = self.notes.get(&s.lot).ok_or_else(|| anyhow::anyhow!(if self.spent_notes.contains(&s.lot) { "Lot already spent" } else { "Unknown lot" }))?;
        ensure!(lot.anchor.is_some(), "Lot is not an anchored note");
        ensure!(lot.amount == s.quantity, "Whole lot only: quantity differs from the lot note");
        let (owner, total_in) = self.take_inputs(&[s.lot], &asset, native)?;
        ensure!(total_in == u128::from(s.quantity), "Sale does not conserve value");
        ensure!(owner.to_bytes() != s.buyer, "Buyer must differ from the seller");
        s.verify_sig(&owner, domain)?;
        self.spend_inputs(&[s.lot]);
        let rid = public::record_id(b);
        let out = market::AnchoredOutput { owner: s.buyer, amount: s.quantity, anchor: s.buyer_anchor };
        let ids = self.create_anchored(&rid, &asset, &[out], txid, height);
        Ok(json!({"asset":asset,"lot":hx(&s.lot),"quantity":s.quantity.to_string(),"seller":hx(&owner.to_bytes()),"buyer":hx(&s.buyer),"offer":hx(&s.offer),"terms":hx(&s.terms),"outputs":ids,"buyerAnchored":s.buyer_anchor().is_some()}))
    }
    // ---- record admission
    fn transfer(&mut self, b: &[u8], txid: &str, height: u64, domain: &[u8; 32], native: &[[u8; 32]]) -> Result<J> {
        let t = public::Transfer::decode(b)?;
        let asset = hx(&t.asset.to_bytes());
        let (owner, total_in) = self.take_inputs(&t.inputs, &asset, native)?;
        ensure!(total_in == t.total_out()?, "Public transfer does not conserve value");
        t.verify_sig(&owner, domain)?;
        self.spend_inputs(&t.inputs);
        let rid = public::record_id(b);
        let outs: Vec<&PublicOutput> = t.outputs.iter().collect();
        let ids = self.create_outputs(&rid, &asset, &outs, txid, height);
        Ok(json!({"asset":asset,"inputs":t.inputs.len(),"outputs":ids,"owner":hx(&owner.to_bytes())}))
    }
    fn credit(&mut self, b: &[u8], txid: &str, height: u64, domain: &[u8; 32], issuer: &VerificationKey<SpendAuth>) -> Result<J> {
        let c = public::Credit::decode(b)?;
        ensure!(!self.credits.contains_key(&c.binding), "Backing receipt or claim already credited");
        c.verify_sig(issuer, domain)?;
        let asset = hx(&c.asset.to_bytes());
        let rid = public::record_id(b);
        let ids = self.create_outputs(&rid, &asset, &[&PublicOutput { owner: c.owner, amount: c.amount }], txid, height);
        *self.minted.entry(asset.clone()).or_default() += u128::from(c.amount);
        self.credits.insert(c.binding, Credit { kind: c.kind, asset: asset.clone(), amount: c.amount, owner: hx(&c.owner), txid: txid.to_string(), height });
        Ok(json!({"asset":asset,"kind":c.kind,"amount":c.amount.to_string(),"binding":hx(&c.binding),"outputs":ids}))
    }
    fn burn(&mut self, b: &[u8], txid: &str, height: u64, domain: &[u8; 32], native: &[[u8; 32]]) -> Result<J> {
        let x = public::Burn::decode(b)?;
        let asset = hx(&x.asset.to_bytes());
        let tid: [u8; 32] = hex::decode(txid)?.try_into().map_err(|_| anyhow::anyhow!("txid"))?;
        ensure!(!self.redemptions.contains_key(&tid), "Redemption carrier already indexed");
        let (owner, total_in) = self.take_inputs(&x.inputs, &asset, native)?;
        ensure!(total_in == x.total_out()?, "Burn does not conserve value");
        ensure!(x.change.owner == owner.to_bytes(), "Burn change must return to the owner");
        x.verify_sig(&owner, domain)?;
        self.spend_inputs(&x.inputs);
        let rid = public::record_id(b);
        let ids = self.create_outputs(&rid, &asset, &[&x.change], txid, height);
        *self.burned.entry(asset.clone()).or_default() += u128::from(x.amount);
        self.redemptions.insert(tid, Redemption { asset: asset.clone(), amount: x.amount, binding: hx(&x.binding), owner: hx(&owner.to_bytes()), txid: txid.to_string(), height });
        Ok(json!({"asset":asset,"amount":x.amount.to_string(),"binding":hx(&x.binding),"change":ids}))
    }
    fn shield(&mut self, b: &[u8], txid: &str, height: u64, vks: &Vks, domain: &[u8; 32], native: &[[u8; 32]]) -> Result<J> {
        let s = shield::Shield::decode(b)?;
        let asset = hx(&s.asset.to_bytes());
        let (owner, total_in) = self.take_inputs(&s.inputs, &asset, native)?;
        ensure!(total_in == s.total_out(), "Shield does not conserve value");
        ensure!(s.change.owner == owner.to_bytes(), "Shield change must return to the owner");
        ensure!(!self.ledger.commitment_exists(&s.out.payload), "Output commitment already exists");
        s.verify_crypto(&owner, &vks.output, domain)?;
        self.spend_inputs(&s.inputs);
        let rid = public::record_id(b);
        let ids = self.create_outputs(&rid, &asset, &[&s.change], txid, height);
        self.ledger.commit([], &[&s.out.payload])?;
        *self.shielded_in.entry(asset.clone()).or_default() += u128::from(s.amount);
        Ok(json!({"asset":asset,"shielded":s.amount.to_string(),"change":ids,"commitment":hx(&s.out.commitment_bytes())}))
    }
    fn unshield(&mut self, b: &[u8], txid: &str, height: u64, vks: &Vks, domain: &[u8; 32]) -> Result<J> {
        let u = shield::Unshield::decode(b)?;
        let asset = hx(&u.asset.to_bytes());
        ensure!(self.ledger.known_root(u.anchor), "Unknown anchor");
        let nf = u.input.nf_bytes();
        ensure!(!self.ledger.nullifiers.contains(&nf), "Spent token input");
        ensure!(!self.ledger.commitment_exists(&u.change.payload), "Change commitment already exists");
        u.verify_crypto(&vks.spend, &vks.output, domain)?;
        self.ledger.commit([nf], &[&u.change.payload])?;
        let rid = public::record_id(b);
        let ids = self.create_outputs(&rid, &asset, &[&u.out], txid, height);
        *self.shielded_out.entry(asset.clone()).or_default() += u128::from(u.out.amount);
        Ok(json!({"asset":asset,"unshielded":u.out.amount.to_string(),"outputs":ids,"nullifier":hx(&nf)}))
    }
    /// Full admission of a complete XM4 pair against the current state.
    fn try_complete(&mut self, a: &StoredA, b: &StoredB, vks: &Vks, domain: &[u8; 32], height: u64) -> Result<Completed> {
        ensure!(self.ledger.known_root(a.part.anchor), "Unknown anchor");
        let nfs = a.part.nullifiers();
        for n in &nfs {
            ensure!(!self.ledger.nullifiers.contains(n), "Spent token input");
        }
        for o in &b.part.outputs {
            ensure!(!self.ledger.commitment_exists(&o.payload), "Output commitment already exists");
        }
        private2::Operation { a: &a.part, b: &b.part }.verify_crypto(&vks.spend, &vks.output, domain)?;
        self.ledger.commit(nfs, &[&b.part.outputs[0].payload, &b.part.outputs[1].payload])?;
        Ok(Completed { part_a: hx(&a.hash), part_b: hx(&b.hash), txid_a: a.txid.clone(), txid_b: b.txid.clone(), height })
    }
    /// Remove every stored part of a completed operation and account for each removed entry.
    fn finish(&mut self, op: [u8; 32], c: Completed) {
        let removed = self.pending_a.remove(&op).map_or(0, |v| v.len()) + self.pending_b.remove(&op).map_or(0, |v| v.len());
        self.pending_records -= removed;
        self.completed.insert(op, c);
    }
    /// FIX (review M4): a part of a completed operation is ignored (not stored, not counted); a byte-identical duplicate of a
    /// pending part is ignored; only pairs that include the NEW part are tried (older pairs were tried when their later member
    /// arrived); completion removes every stored part of the operation and subtracts exactly that number. Deterministic on
    /// replay and rollback (the pool is rebuilt from canonical records); a genuine pair still completes despite invalid
    /// look-alike parts, which stay pending until the operation completes.
    fn part(&mut self, b: &[u8], txid: &str, height: u64, vks: &Vks, domain: &[u8; 32]) -> Result<J> {
        let h = crate::hash(b);
        let is_a = b.starts_with(private2::MAGIC_A);
        let label = if is_a { "A" } else { "B" };
        let (op, new_a, new_b) = if is_a {
            let p = private2::PartA::decode(b)?;
            (p.op, Some(p), None)
        } else {
            let p = private2::PartB::decode(b)?;
            (p.op, None, Some(p))
        };
        if self.completed.contains_key(&op) {
            return Ok(json!({"op":hx(&op),"part":label,"completed":false,"stored":false,"note":"operation already applied; part ignored (not stored)"}));
        }
        let duplicate = if is_a {
            self.pending_a.get(&op).is_some_and(|v| v.iter().any(|x| x.hash == h))
        } else {
            self.pending_b.get(&op).is_some_and(|v| v.iter().any(|x| x.hash == h))
        };
        if duplicate {
            return Ok(json!({"op":hx(&op),"part":label,"completed":false,"stored":false,"note":"identical part already pending; duplicate ignored (not stored)"}));
        }
        let mut last_err = None;
        if let Some(a) = new_a {
            let a = StoredA { part: a, hash: h, txid: txid.to_string(), height };
            let counterparts = self.pending_b.get(&op).cloned().unwrap_or_default();
            for bb in &counterparts {
                let mut candidate = self.clone();
                match candidate.try_complete(&a, bb, vks, domain, height) {
                    Ok(c) => {
                        candidate.finish(op, c.clone());
                        *self = candidate;
                        return Ok(json!({"op":hx(&op),"part":label,"completed":true,"completion":c}));
                    }
                    Err(e) => last_err = Some(e.to_string()),
                }
            }
            self.pending_a.entry(op).or_default().push(a);
            self.pending_records += 1;
            return Ok(json!({"op":hx(&op),"part":label,"completed":false,"stored":true,"counterparts":counterparts.len(),"lastError":last_err}));
        }
        let bb = StoredB { part: new_b.unwrap(), hash: h, txid: txid.to_string(), height };
        let counterparts = self.pending_a.get(&op).cloned().unwrap_or_default();
        for a in &counterparts {
            let mut candidate = self.clone();
            match candidate.try_complete(a, &bb, vks, domain, height) {
                Ok(c) => {
                    candidate.finish(op, c.clone());
                    *self = candidate;
                    return Ok(json!({"op":hx(&op),"part":label,"completed":true,"completion":c}));
                }
                Err(e) => last_err = Some(e.to_string()),
            }
        }
        self.pending_b.entry(op).or_default().push(bb);
        self.pending_records += 1;
        Ok(json!({"op":hx(&op),"part":label,"completed":false,"stored":true,"counterparts":counterparts.len(),"lastError":last_err}))
    }
    /// Called with native-consensus-validated carriers in canonical chain order.
    /// Result: {"record":"accepted"|"rejected"|"pending"|"ignored", "kind":…, …}
    /// Without the carrier's key images no anchored note can be consumed (fails closed).
    pub fn apply(&mut self, wire: Option<&[u8]>, txid: &str, height: u64, vks: &Vks) -> J {
        self.apply_carrier(wire, txid, height, &[], vks)
    }
    /// MARKET candidate: `native` = the carrier's input key images, in transaction order.
    pub fn apply_carrier(&mut self, wire: Option<&[u8]>, txid: &str, height: u64, native: &[[u8; 32]], vks: &Vks) -> J {
        let Some(b) = wire else {
            return json!({"record":"ignored"});
        };
        if !transport::known_magic(b) {
            return json!({"record":"ignored"});
        }
        let kind = match &b[..4] {
            m if m == public::MAGIC_TRANSFER => "public-transfer",
            m if m == public::MAGIC_CREDIT => "public-credit",
            m if m == public::MAGIC_BURN => "public-burn",
            m if m == shield::MAGIC_SHIELD => "shield",
            m if m == shield::MAGIC_UNSHIELD => "unshield",
            m if m == market::MAGIC_ANCHORED => "anchored-transfer",
            m if m == market::MAGIC_SALE => "lot-sale",
            m if m == private2::MAGIC_A => "private-part-a",
            _ => "private-part-b",
        };
        // Byte-for-byte the answer of a reader without the market rules (unknown magic), so old and new readers agree below H.
        if matches!(kind, "anchored-transfer" | "lot-sale") && !self.market_from.is_some_and(|h| height >= h) {
            return json!({"record":"ignored"});
        }
        let domain = self.ledger.domain;
        let mut candidate = self.clone();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match kind {
            "public-transfer" => candidate.transfer(b, txid, height, &domain, native),
            "public-credit" => candidate.credit(b, txid, height, &domain, &vks.issuer),
            "public-burn" => candidate.burn(b, txid, height, &domain, native),
            "shield" => candidate.shield(b, txid, height, vks, &domain, native),
            "unshield" => candidate.unshield(b, txid, height, vks, &domain),
            "anchored-transfer" => candidate.anchored(b, txid, height, &domain, native),
            "lot-sale" => candidate.sale(b, txid, height, &domain, native),
            _ => candidate.part(b, txid, height, vks, &domain),
        }))
        .unwrap_or_else(|_| Err(anyhow::anyhow!("Malformed record")));
        match outcome {
            Ok(detail) => {
                let pending = kind.starts_with("private-part") && detail["completed"] == false;
                if !pending {
                    candidate.accepted += 1;
                }
                *self = candidate;
                let mut j = json!({"record":if pending {"pending"} else {"accepted"},"kind":kind});
                j["detail"] = detail;
                j
            }
            Err(e) => {
                self.rejected += 1;
                json!({"record":"rejected","kind":kind,"error":e.to_string()})
            }
        }
    }
    // ---- views
    pub fn public_supply(&self) -> BTreeMap<String, u128> {
        let mut out = BTreeMap::new();
        for n in self.notes.values() {
            *out.entry(n.asset.clone()).or_default() += u128::from(n.amount);
        }
        out
    }
    pub fn shielded_supply(&self) -> BTreeMap<String, i128> {
        let mut out: BTreeMap<String, i128> = BTreeMap::new();
        for (a, v) in &self.shielded_in {
            *out.entry(a.clone()).or_default() += *v as i128;
        }
        for (a, v) in &self.shielded_out {
            *out.entry(a.clone()).or_default() -= *v as i128;
        }
        out
    }
    pub fn outstanding(&self) -> BTreeMap<String, u128> {
        let mut out = BTreeMap::new();
        for (a, m) in &self.minted {
            out.insert(a.clone(), m - self.burned.get(a).copied().unwrap_or(0));
        }
        out
    }
    /// publicSupply + shieldedSupply == minted - burned for every asset.
    pub fn invariant(&self) -> (bool, Vec<J>) {
        let pub_s = self.public_supply();
        let sh = self.shielded_supply();
        let out = self.outstanding();
        let mut assets: BTreeSet<String> = BTreeSet::new();
        assets.extend(pub_s.keys().cloned());
        assets.extend(sh.keys().cloned());
        assets.extend(out.keys().cloned());
        let mut ok = true;
        let mut rows = vec![];
        for a in assets {
            let p = pub_s.get(&a).copied().unwrap_or(0) as i128;
            let s = sh.get(&a).copied().unwrap_or(0);
            let o = out.get(&a).copied().unwrap_or(0) as i128;
            let row_ok = p + s == o && s >= 0;
            ok &= row_ok;
            rows.push(json!({"asset":a,"publicSupply":p.to_string(),"shieldedSupply":s.to_string(),"outstanding":o.to_string(),"ok":row_ok}));
        }
        (ok, rows)
    }
    pub fn notes_of_owner(&self, owner: &[u8; 32]) -> Vec<(String, PublicNote)> {
        let o = hx(owner);
        self.notes.iter().filter(|(_, n)| n.owner == o).map(|(id, n)| (hx(id), n.clone())).collect()
    }
    pub fn public_balances(&self, owner: &[u8; 32]) -> BTreeMap<String, u128> {
        let mut out = BTreeMap::new();
        for (_, n) in self.notes_of_owner(owner) {
            *out.entry(n.asset).or_default() += u128::from(n.amount);
        }
        out
    }
    pub fn shielded_balances(&self, fvk: &FullViewingKey) -> BTreeMap<String, u128> {
        let mut out = BTreeMap::new();
        for n in self.ledger.unspent_notes(fvk) {
            *out.entry(hx(&n.asset_id().to_bytes())).or_default() += u128::from(n.amount());
        }
        out
    }
    pub fn summary(&self) -> J {
        let (ok, rows) = self.invariant();
        json!({
            "root": hx(&crate::ledger::root_bytes(self.ledger.root())),
            "shieldedNotes": self.ledger.history.len(),
            "nullifiers": self.ledger.nullifiers.len(),
            "publicNotes": self.notes.len(),
            "minted": self.minted.iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),
            "burned": self.burned.iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),
            "outstanding": self.outstanding().iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),
            "publicSupply": self.public_supply().iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),
            "shieldedSupply": self.shielded_supply().iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),
            "invariant": {"ok": ok, "rows": rows},
            "accepted": self.accepted,
            "rejected": self.rejected,
            "pendingParts": self.pending_records,
            "completedOperations": self.completed.len(),
            "credits": self.credits.iter().map(|(k,v)| json!({"binding":hx(k),"kind":v.kind,"asset":v.asset,"amount":v.amount.to_string(),"owner":v.owner,"txid":v.txid,"height":v.height})).collect::<Vec<_>>(),
            "redemptions": self.redemptions.values().map(|v| json!({"txid":v.txid,"asset":v.asset,"amount":v.amount.to_string(),"binding":v.binding,"owner":v.owner,"height":v.height})).collect::<Vec<_>>(),
        })
    }
}
