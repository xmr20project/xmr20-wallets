//! Commit log of the persistent indexer: one block's rows reach the state directory together or not at all.
//!
//! Files (unchanged formats, one JSON row per line):
//!   blocks.jsonl          {height, hash}           one row per committed block; a block's row is its COMMIT POINT
//!   records.jsonl         {height, txid, wire, …}  record rows of committed blocks, in chain order
//!   payments.jsonl        {height, txid, index, …} relay fee payments found in committed blocks
//!   claim-payments.jsonl  payment facts            the facts trade claims were settled with
//!
//! Durability: `open` creates any of the four files that is missing and syncs the directory, so a file's directory entry is
//! durable before any of its rows is committed; an append that has to create a file (deleted since) syncs the directory before
//! the block row. Every whole-file write is temp file + sync + rename + directory sync. The model assumed: a synced file keeps its
//! bytes, a synced directory keeps its entries; nothing else is relied on.
//!
//! Block commit:
//!   0. a commit-pending file left by an earlier block (its block row is on disk; only its removal failed) is removed first; if
//!      that fails, `reload_required` is set and nothing is written;
//!   1. `ensure_clean`: every file has exactly its committed length (a longer file is cut back; a shorter one is refused);
//!   2. if the block brings any row besides its block row, `commit-pending.json` {height, before, after} is written atomically,
//!      where `before` holds the committed byte length of each file and `after` the length each file has once the block is in;
//!   3. the record, payment and claim rows are appended and synced;
//!   4. the block row is appended and synced: the block is committed;
//!   5. `commit-pending.json` is removed. If that fails the block stays committed and the file is removed at step 0 of the next
//!      commit or reorganisation (or at the next open).
//!   A failure before step 4 cuts every file back to its committed length and removes the pending file, so nothing of the
//!   block remains. If that clean-up fails too, `reload_required` is set: the indexer recovers the directory (below) before it
//!   commits anything else.
//!
//! Reorganisation: the same step 0 first (a reorganisation never starts while a commit-pending file exists), then
//! `reorg-pending.json` {fork, forkHash, claims} is written atomically, then each file is rewritten (temp file + rename): blocks,
//! records and payments keep their rows at or below the fork, claim facts become the journal's list. The journal is removed last.
//! From the journal's write on, any failure sets `reload_required`, including a failure of the write
//! itself (its rename can succeed and the directory sync after it fail, leaving the journal visible). Recovery then applies the
//! journal if it is on disk. A commit or reorganisation is also refused, with `reload_required` set, while a reorganisation
//! journal is present in the directory, so no block is ever committed beside an unresolved journal.
//!
//! Recovery (on open and after `reload_required`; also as a dry run for an operator check):
//!   - a reorganisation journal still present is applied again (idempotent);
//!   - a commit-pending file whose block row is missing is undone (every file cut back to `before`); one whose block row is
//!     present names a committed block: every file must hold at least its `after` length (a shorter file lost committed rows,
//!     and recovery refuses the directory), then the file is removed;
//!   - both journals at once cannot be left by this version (step 0 before a reorganisation; no commit while a reorganisation
//!     journal is present); recovery refuses such a directory;
//!   - a last line without its newline (an interrupted append) is dropped;
//!   - record and payment rows above the committed tip, which an indexer version without these rules could leave after a failed
//!     sync, are dropped; with no committed block, claim facts are dropped too;
//!   - repeated record transaction ids (left by such a version when it retried a block) are reported as warnings, not changed.
//! Changed files are written back by temp file + rename and the journals are removed last, so recovery itself can be
//! interrupted and run again. The journals are part of the state: they are never deleted by hand (a reader without these
//! rules would see half of a reorganisation).
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as J};
use std::{
    cell::Cell,
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const BLOCKS: &str = "blocks.jsonl";
pub const RECORDS: &str = "records.jsonl";
pub const PAYMENTS: &str = "payments.jsonl";
pub const CLAIMS: &str = "claim-payments.jsonl";
pub const COMMIT_PENDING: &str = "commit-pending.json";
pub const REORG_PENDING: &str = "reorg-pending.json";
pub const FILES: [&str; 4] = [BLOCKS, RECORDS, PAYMENTS, CLAIMS];
const B: usize = 0;
const R: usize = 1;
const P: usize = 2;
const C: usize = 3;

/// Byte length of each file at the last commit.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lens {
    pub blocks: u64,
    pub records: u64,
    pub payments: u64,
    pub claims: u64,
}
impl Lens {
    fn get(&self, i: usize) -> u64 {
        [self.blocks, self.records, self.payments, self.claims][i]
    }
    fn from(v: [u64; 4]) -> Self {
        Self { blocks: v[0], records: v[1], payments: v[2], claims: v[3] }
    }
}

// ---------------------------------------------------------------- failure injection (test chains only)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The step fails with an error (the process keeps running).
    Error,
    /// The process exits at the step (a crash).
    Exit,
    /// A write step writes half its bytes, then fails with an error; other steps behave like Error.
    Torn,
    /// A write step writes half its bytes, then the process exits; other steps behave like Exit.
    TornExit,
}
struct Armed {
    step: String,
    mode: Mode,
    height: Option<u64>,
    after: u32,
    hits: Cell<u32>,
}
/// Armed failures: each `step` fires at `height` (or any height), after `after` earlier hits of the same step.
#[derive(Default)]
pub struct Failpoints {
    armed: Vec<Armed>,
}
pub const STEPS: [&str; 21] = [
    "fetch", "expand", "fees", "apply", "facts", "settle", "pending", "write-records", "write-payments", "write-claims", "write-block", "undo", "clear-pending", "resolve-pending", "reorg-journal", "reorg-journal-written", "reorg-blocks", "reorg-records", "reorg-payments", "reorg-claims", "reorg-clear",
];
impl Failpoints {
    /// {step: null} disarms all; {step, mode: error|exit|torn|torn-exit, height?, after?} arms one; {list: [..]} arms several.
    pub fn set(&mut self, q: &J) -> Result<J> {
        let list: Vec<J> = match q["list"].as_array() {
            Some(a) => a.clone(),
            None if q["step"].is_null() => vec![],
            None => vec![q.clone()],
        };
        let mut armed = vec![];
        for x in &list {
            let step = x["step"].as_str().context("failure step")?;
            ensure!(STEPS.contains(&step), "Unknown failure step {step}");
            let mode = match x["mode"].as_str().unwrap_or("error") {
                "error" => Mode::Error,
                "exit" => Mode::Exit,
                "torn" => Mode::Torn,
                "torn-exit" => Mode::TornExit,
                m => bail!("Unknown failure mode {m}"),
            };
            armed.push(Armed { step: step.into(), mode, height: x["height"].as_u64(), after: x["after"].as_u64().unwrap_or(0) as u32, hits: Cell::new(0) });
        }
        self.armed = armed;
        Ok(json!({"armed":list}))
    }
    fn fire(&self, step: &str, height: u64) -> Option<Mode> {
        for a in &self.armed {
            if a.step != step || a.height.is_some_and(|h| h != height) {
                continue;
            }
            let n = a.hits.get();
            a.hits.set(n + 1);
            if n >= a.after {
                return Some(a.mode);
            }
        }
        None
    }
    fn exit(step: &str) -> ! {
        eprintln!("injected crash at {step}");
        std::process::exit(75)
    }
    /// A non-write step.
    pub fn hit(&self, step: &str, height: u64) -> Result<()> {
        match self.fire(step, height) {
            None => Ok(()),
            Some(Mode::Error | Mode::Torn) => bail!("Injected failure at {step} (block {height})"),
            Some(Mode::Exit | Mode::TornExit) => Self::exit(step),
        }
    }
}

// ---------------------------------------------------------------- file helpers
fn path(dir: &Path, name: &str) -> PathBuf {
    dir.join(name)
}
fn len_of(p: &Path) -> Result<u64> {
    match fs::metadata(p) {
        Ok(m) => Ok(m.len()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e).with_context(|| format!("{}", p.display())),
    }
}
fn read_bytes(p: &Path) -> Result<Vec<u8>> {
    match fs::read(p) {
        Ok(b) => Ok(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e).with_context(|| format!("{}", p.display())),
    }
}
fn read_json(p: &Path) -> Result<Option<J>> {
    if !p.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(p)?).with_context(|| format!("{}", p.display()))?))
}
fn sync_dir(dir: &Path) -> Result<()> {
    fs::File::open(dir)?.sync_all()?;
    Ok(())
}
/// Write a whole file by temp file + rename, synced (file and directory).
pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let p = path(dir, name);
    let tmp = path(dir, &format!("{name}.tmp"));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, &p)?;
    sync_dir(dir)
}
fn remove(dir: &Path, name: &str) -> Result<()> {
    match fs::remove_file(path(dir, name)) {
        Ok(()) => sync_dir(dir),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
fn cut_to(p: &Path, len: u64) -> Result<()> {
    let now = len_of(p)?;
    ensure!(now >= len, "{} is shorter ({now} bytes) than its committed length ({len}): the state directory was changed outside the indexer", p.display());
    if now > len {
        let f = fs::OpenOptions::new().write(true).open(p)?;
        f.set_len(len)?;
        f.sync_all()?;
    }
    Ok(())
}
/// Create every missing log file (empty) and make the new directory entries durable. Returns the files created.
fn ensure_files(dir: &Path) -> Result<Vec<&'static str>> {
    let mut created = vec![];
    for f in FILES {
        let p = path(dir, f);
        if !p.exists() {
            let file = fs::OpenOptions::new().create(true).append(true).open(&p)?;
            file.sync_all()?;
            created.push(f);
        }
    }
    if !created.is_empty() {
        sync_dir(dir)?;
    }
    Ok(created)
}
fn joined(lines: &[String]) -> Vec<u8> {
    let mut b = Vec::with_capacity(lines.iter().map(|l| l.len() + 1).sum());
    for l in lines {
        b.extend_from_slice(l.as_bytes());
        b.push(b'\n');
    }
    b
}

/// Complete lines of a buffer (each ended by a newline) and, separately, the length of a trailing partial line.
fn split_lines(buf: &[u8]) -> (Vec<&[u8]>, usize) {
    let end = buf.iter().rposition(|&c| c == b'\n').map(|i| i + 1).unwrap_or(0);
    let lines = buf[..end].split(|&c| c == b'\n').filter(|l| !l.is_empty()).collect::<Vec<_>>();
    (lines, buf.len() - end)
}
fn height_of(v: &J) -> Option<u64> {
    v["height"].as_u64()
}

/// Rows of one file kept as their original text, with the parsed JSON beside them.
struct Rows {
    lines: Vec<(String, J)>,
}
impl Rows {
    fn parse(name: &str, buf: &[u8]) -> Result<Self> {
        let (lines, _) = split_lines(buf);
        let mut out = Vec::with_capacity(lines.len());
        for (i, l) in lines.iter().enumerate() {
            let s = std::str::from_utf8(l).with_context(|| format!("{name}:{}", i + 1))?;
            if s.trim().is_empty() {
                continue;
            }
            let v: J = serde_json::from_str(s).with_context(|| format!("{name}:{}", i + 1))?;
            out.push((s.to_string(), v));
        }
        Ok(Self { lines: out })
    }
    fn bytes(&self) -> Vec<u8> {
        joined(&self.lines.iter().map(|(s, _)| s.clone()).collect::<Vec<_>>())
    }
}

/// What a recovery found and changed (or, in a dry run, would change).
#[derive(Default, Debug)]
pub struct Report {
    pub actions: Vec<J>,
    pub warnings: Vec<J>,
}

/// The rows of a recovered state directory, as text lines (the caller parses its own types).
pub struct Loaded {
    pub blocks: Vec<String>,
    pub records: Vec<String>,
    pub payments: Vec<String>,
    pub claims: Vec<String>,
    pub report: Report,
}

pub struct Logs {
    dir: PathBuf,
    committed: Lens,
    /// Set when a failed commit or reorganisation could not be cleaned up in place: recover (as on open) before anything else.
    pub reload_required: bool,
    /// Commit-pending files left behind after their block committed (each is removed before the next change).
    pub stale_pending: u64,
    /// The height named by a commit-pending file still on disk after its block committed (None once it is removed).
    pub stale_height: Option<u64>,
}

impl Logs {
    pub fn committed(&self) -> Lens {
        self.committed
    }

    /// Recover the directory (see the module note) and load its rows. `dry_run` reports without writing anything.
    pub fn open(dir: &Path, dry_run: bool) -> Result<(Self, Loaded)> {
        let mut report = Report::default();
        let mut buf: [Vec<u8>; 4] = [vec![], vec![], vec![], vec![]];
        for (i, f) in FILES.iter().enumerate() {
            buf[i] = read_bytes(&path(dir, f))?;
        }
        let mut changed = [false; 4];
        let reorg = read_json(&path(dir, REORG_PENDING))?;
        let pending = read_json(&path(dir, COMMIT_PENDING))?;
        ensure!(!(reorg.is_some() && pending.is_some()), "Both a reorganisation journal and a commit-pending file are present in {}: this version never leaves both (an earlier build could); refusing to guess. Keep both files and restore a coherent backup or replay the chain into a new directory", dir.display());

        // 1. an interrupted reorganisation: apply its journal again
        if let Some(j) = &reorg {
            let fork = j["fork"].as_u64().context("reorganisation journal: fork")?;
            let blocks = Rows::parse(BLOCKS, &buf[B])?;
            if let Some(h) = j["forkHash"].as_str() {
                let row = blocks.lines.iter().find(|(_, v)| height_of(v) == Some(fork)).context("reorganisation journal: the fork block is not in blocks.jsonl")?;
                ensure!(row.1["hash"].as_str() == Some(h), "reorganisation journal: the fork block hash differs from blocks.jsonl");
            }
            for (i, name) in [(B, BLOCKS), (R, RECORDS), (P, PAYMENTS)] {
                let mut rows = Rows::parse(name, &buf[i])?;
                rows.lines.retain(|(_, v)| height_of(v).is_some_and(|h| h <= fork));
                let b = rows.bytes();
                if b != buf[i] {
                    buf[i] = b;
                    changed[i] = true;
                }
            }
            let claims: Vec<String> = j["claims"].as_array().context("reorganisation journal: claims")?.iter().map(|v| v.to_string()).collect();
            let b = joined(&claims);
            if b != buf[C] {
                buf[C] = b;
                changed[C] = true;
            }
            report.actions.push(json!({"action":"reorganisation-completed","fork":fork}));
        }

        // 2. an interrupted block commit: undo it, or drop a stale pending file
        if let Some(pd) = &pending {
            let height = pd["height"].as_u64().context("commit-pending: height")?;
            let before: Lens = serde_json::from_value(pd["before"].clone()).context("commit-pending: before")?;
            let (lines, _) = split_lines(&buf[B]);
            let last = match lines.last() {
                Some(l) => Some(height_of(&serde_json::from_slice::<J>(l).context("blocks.jsonl: last complete row")?).context("blocks.jsonl: height")?),
                None => None,
            };
            if last.is_some_and(|t| t >= height) {
                // The block committed. Its rows were synced before its block row, so each file holds at least its `after` length
                // (journals written by an older build have no `after`: nothing to compare).
                if !pd["after"].is_null() {
                    let after: Lens = serde_json::from_value(pd["after"].clone()).context("commit-pending: after")?;
                    for (i, f) in FILES.iter().enumerate() {
                        ensure!(buf[i].len() as u64 >= after.get(i), "{f} is shorter ({} bytes) than after committed block {height} ({}): committed rows are missing (lost or changed outside the indexer). Keep the directory as it is and restore a coherent backup or replay the chain into a new directory", buf[i].len(), after.get(i));
                    }
                }
                report.actions.push(json!({"action":"stale-commit-pending-removed","height":height}));
            } else {
                let mut cut = BTreeMap::new();
                for (i, f) in FILES.iter().enumerate() {
                    let want = before.get(i) as usize;
                    ensure!(buf[i].len() >= want, "{f} is shorter ({} bytes) than before the interrupted commit ({want}): the state directory was changed outside the indexer", buf[i].len());
                    if buf[i].len() > want {
                        cut.insert(*f, buf[i].len() - want);
                        buf[i].truncate(want);
                        changed[i] = true;
                    }
                }
                report.actions.push(json!({"action":"interrupted-commit-undone","height":height,"bytesRemoved":cut}));
            }
        }

        // 3. a last line without its newline is an interrupted append
        for (i, f) in FILES.iter().enumerate() {
            let (_, partial) = split_lines(&buf[i]);
            if partial > 0 {
                let n = buf[i].len() - partial;
                buf[i].truncate(n);
                changed[i] = true;
                report.actions.push(json!({"action":"partial-line-dropped","file":f,"bytes":partial}));
            }
        }

        // 4. parse; rows above the committed tip were never committed
        let blocks = Rows::parse(BLOCKS, &buf[B])?;
        let mut records = Rows::parse(RECORDS, &buf[R])?;
        let mut payments = Rows::parse(PAYMENTS, &buf[P])?;
        let mut claims = Rows::parse(CLAIMS, &buf[C])?;
        let mut prev: Option<u64> = None;
        for (s, v) in &blocks.lines {
            let h = height_of(v).with_context(|| format!("blocks.jsonl row without height: {s}"))?;
            ensure!(v["hash"].as_str().is_some_and(|x| x.len() == 64), "blocks.jsonl row without a block hash at height {h}");
            if let Some(p) = prev {
                ensure!(h == p + 1, "blocks.jsonl is not consecutive ({p} then {h})");
            }
            prev = Some(h);
        }
        let tip = prev;
        for (i, name, rows) in [(R, RECORDS, &mut records), (P, PAYMENTS, &mut payments)] {
            let before = rows.lines.len();
            let mut dropped = vec![];
            rows.lines.retain(|(_, v)| {
                let keep = tip.is_some_and(|t| height_of(v).is_some_and(|h| h <= t));
                if !keep {
                    dropped.push(json!({"height":v["height"],"txid":v["txid"]}));
                }
                keep
            });
            if rows.lines.len() != before {
                buf[i] = rows.bytes();
                changed[i] = true;
                report.actions.push(json!({"action":"uncommitted-rows-dropped","file":name,"rows":dropped}));
            }
        }
        if tip.is_none() && !claims.lines.is_empty() {
            report.actions.push(json!({"action":"uncommitted-rows-dropped","file":CLAIMS,"rows":claims.lines.len()}));
            claims.lines.clear();
            buf[C].clear();
            changed[C] = true;
        }
        let mut last_h = 0u64;
        let mut seen = BTreeMap::new();
        for (s, v) in &records.lines {
            let h = height_of(v).with_context(|| format!("records.jsonl row without height: {s}"))?;
            ensure!(h >= last_h, "records.jsonl is out of chain order ({last_h} then {h})");
            last_h = h;
            let txid = v["txid"].as_str().unwrap_or("").to_string();
            if let Some(first) = seen.insert(txid.clone(), h) {
                report.warnings.push(json!({"warning":"repeated-record-transaction","txid":txid,"heights":[first,h],"note":"left by an earlier indexer version after a failed sync; resync this state directory from the start height"}));
            }
        }

        // 5. write back what changed, then remove the journals
        if !dry_run {
            for (i, f) in FILES.iter().enumerate() {
                if changed[i] {
                    write_atomic(dir, f, &buf[i])?;
                }
            }
            for f in FILES {
                let _ = fs::remove_file(path(dir, &format!("{f}.tmp")));
            }
            let _ = fs::remove_file(path(dir, &format!("{COMMIT_PENDING}.tmp")));
            let _ = fs::remove_file(path(dir, &format!("{REORG_PENDING}.tmp")));
            if pending.is_some() {
                remove(dir, COMMIT_PENDING)?;
            }
            if reorg.is_some() {
                remove(dir, REORG_PENDING)?;
            }
            for f in ensure_files(dir)? {
                report.actions.push(json!({"action":"log-file-created","file":f}));
            }
        }
        let committed = Lens::from([buf[B].len() as u64, buf[R].len() as u64, buf[P].len() as u64, buf[C].len() as u64]);
        let take = |r: Rows| r.lines.into_iter().map(|(s, _)| s).collect::<Vec<_>>();
        Ok((Self { dir: dir.to_path_buf(), committed, reload_required: false, stale_pending: 0, stale_height: None }, Loaded { blocks: take(blocks), records: take(records), payments: take(payments), claims: take(claims), report }))
    }

    /// Every file at exactly its committed length: a longer file (left by a failed clean-up) is cut back; a shorter one is refused.
    pub fn ensure_clean(&self) -> Result<()> {
        for (i, f) in FILES.iter().enumerate() {
            cut_to(&path(&self.dir, f), self.committed.get(i))?;
        }
        Ok(())
    }

    fn undo(&self, before: Lens) -> Result<()> {
        for (i, f) in FILES.iter().enumerate() {
            cut_to(&path(&self.dir, f), before.get(i))?;
        }
        remove(&self.dir, COMMIT_PENDING)
    }

    fn append(&self, i: usize, bytes: &[u8], fp: &Failpoints, step: &str, height: u64) -> Result<()> {
        let action = fp.fire(step, height);
        match action {
            Some(Mode::Error) => bail!("Injected failure at {step} (block {height})"),
            Some(Mode::Exit) => Failpoints::exit(step),
            _ => {}
        }
        if bytes.is_empty() && action.is_none() {
            return Ok(());
        }
        let p = path(&self.dir, FILES[i]);
        let existed = p.exists();
        let mut f = fs::OpenOptions::new().create(true).append(true).open(&p)?;
        if !existed {
            // the file was created by this append (open creates all four, so it was deleted since): its directory entry must be
            // durable before the block row
            f.sync_all()?;
            sync_dir(&self.dir)?;
        }
        if let Some(m @ (Mode::Torn | Mode::TornExit)) = action {
            f.write_all(&bytes[..bytes.len() / 2])?;
            f.sync_data()?;
            if m == Mode::TornExit {
                Failpoints::exit(step);
            }
            bail!("Injected torn write at {step} (block {height})");
        }
        f.write_all(bytes)?;
        f.sync_data()?;
        Ok(())
    }

    /// Step 0 of a commit or reorganisation: remove a commit-pending file left by an earlier, committed block. On failure the
    /// directory is recovered (`reload_required`) before any change.
    fn resolve_stale(&mut self, fp: &Failpoints, height: u64) -> Result<()> {
        if self.stale_height.is_none() && !path(&self.dir, COMMIT_PENDING).exists() {
            return Ok(());
        }
        if let Err(e) = fp.hit("resolve-pending", height).and_then(|_| remove(&self.dir, COMMIT_PENDING)) {
            self.reload_required = true;
            return Err(e.context("an earlier block's commit-pending file could not be removed; the state directory is recovered before the next change"));
        }
        self.stale_height = None;
        Ok(())
    }

    /// No change while a reorganisation journal is in the directory: it is applied by recovery first.
    fn refuse_open_reorg(&mut self) -> Result<()> {
        if path(&self.dir, REORG_PENDING).exists() {
            self.reload_required = true;
            bail!("A reorganisation journal is present; the state directory is recovered from it before the next change");
        }
        Ok(())
    }

    /// Commit one block: its record, payment and claim rows, then its block row (see the module note). On error nothing of the
    /// block remains on disk (or `reload_required` is set when the clean-up itself failed). Ok(note) carries a warning when the
    /// block committed but its pending file could not be removed.
    pub fn commit_block(&mut self, height: u64, block: &str, records: &[String], payments: &[String], claims: &[String], fp: &Failpoints) -> Result<Option<J>> {
        ensure!(!self.reload_required, "The state directory needs recovery before the next commit");
        self.refuse_open_reorg()?;
        self.resolve_stale(fp, height)?;
        self.ensure_clean()?;
        let bytes = [joined(&[block.to_string()]), joined(records), joined(payments), joined(claims)];
        let rows = !records.is_empty() || !payments.is_empty() || !claims.is_empty();
        let before = self.committed;
        let after = Lens::from([before.blocks + bytes[B].len() as u64, before.records + bytes[R].len() as u64, before.payments + bytes[P].len() as u64, before.claims + bytes[C].len() as u64]);
        let attempt = (|| -> Result<()> {
            if rows {
                fp.hit("pending", height)?;
                write_atomic(&self.dir, COMMIT_PENDING, serde_json::to_string(&json!({"height":height,"before":before,"after":after}))?.as_bytes())?;
            }
            self.append(R, &bytes[R], fp, "write-records", height)?;
            self.append(P, &bytes[P], fp, "write-payments", height)?;
            self.append(C, &bytes[C], fp, "write-claims", height)?;
            self.append(B, &bytes[B], fp, "write-block", height)?;
            Ok(())
        })();
        if let Err(e) = attempt {
            if let Err(u) = fp.hit("undo", height).and_then(|_| self.undo(before)) {
                self.reload_required = true;
                return Err(e.context(format!("cleaning up the uncommitted block also failed ({u}); the state directory is recovered before the next commit")));
            }
            return Err(e);
        }
        // committed
        self.committed = after;
        if rows {
            if let Err(e) = fp.hit("clear-pending", height).and_then(|_| remove(&self.dir, COMMIT_PENDING)) {
                self.stale_pending += 1;
                self.stale_height = Some(height);
                return Ok(Some(json!({"warning":"commit-pending-left","height":height,"error":e.to_string(),"note":"removed before the next commit or reorganisation"})));
            }
        }
        Ok(None)
    }

    /// Rewrite the four files after a reorganisation at `fork` (journaled; see the module note). On error the caller must not
    /// trust the files: `reload_required` is set unless nothing was written (an error before the journal's write began).
    pub fn reorg(&mut self, fork: u64, fork_hash: Option<&str>, blocks: &[String], records: &[String], payments: &[String], claims: &[String], fp: &Failpoints) -> Result<()> {
        ensure!(!self.reload_required, "The state directory needs recovery before the next change");
        self.refuse_open_reorg()?;
        self.resolve_stale(fp, fork)?;
        self.ensure_clean()?;
        let claims_json: Vec<J> = claims.iter().map(|s| serde_json::from_str(s)).collect::<Result<_, _>>()?;
        let journal = serde_json::to_string(&json!({"fork":fork,"forkHash":fork_hash,"claims":claims_json}))?;
        fp.hit("reorg-journal", fork)?;
        let bytes = [joined(blocks), joined(records), joined(payments), joined(claims)];
        // From here the journal may be on disk even when its write returns an error (rename done, directory sync failed): every
        // failure requires recovery, which applies the journal if it is there.
        let attempt = (|| -> Result<()> {
            write_atomic(&self.dir, REORG_PENDING, journal.as_bytes())?;
            fp.hit("reorg-journal-written", fork)?;
            for (i, step) in [(B, "reorg-blocks"), (R, "reorg-records"), (P, "reorg-payments"), (C, "reorg-claims")] {
                fp.hit(step, fork)?;
                write_atomic(&self.dir, FILES[i], &bytes[i])?;
            }
            fp.hit("reorg-clear", fork)?;
            remove(&self.dir, REORG_PENDING)
        })();
        if let Err(e) = attempt {
            self.reload_required = true;
            return Err(e.context("reorganisation interrupted; the state directory is recovered from its journal before the next change"));
        }
        self.committed = Lens::from([bytes[B].len() as u64, bytes[R].len() as u64, bytes[P].len() as u64, bytes[C].len() as u64]);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("xmr20-logs-{}-{}-{}", name, std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn block(h: u64) -> String {
        json!({"height":h,"hash":format!("{:064x}",h)}).to_string()
    }
    fn record(h: u64, n: u32) -> String {
        json!({"height":h,"txid":format!("{:062x}{:02x}",h,n),"wire":"00"}).to_string()
    }
    fn payment(h: u64) -> String {
        json!({"height":h,"txid":format!("{:064x}",h+1000),"index":1,"amount":"100"}).to_string()
    }
    fn claim(h: u64) -> String {
        json!({"txid":format!("{:064x}",h+2000),"height":h,"outputs":[]}).to_string()
    }
    fn snapshot(d: &Path) -> Vec<Vec<u8>> {
        FILES.iter().map(|f| read_bytes(&path(d, f)).unwrap()).collect()
    }
    /// Commits blocks 1..=3 (block 2 carries one row in each file) and returns the open log.
    fn base(d: &Path) -> Logs {
        let (mut l, _) = Logs::open(d, false).unwrap();
        let fp = Failpoints::default();
        l.commit_block(1, &block(1), &[], &[], &[], &fp).unwrap();
        l.commit_block(2, &block(2), &[record(2, 0)], &[payment(2)], &[claim(2)], &fp).unwrap();
        l.commit_block(3, &block(3), &[], &[], &[], &fp).unwrap();
        l
    }
    fn arm(step: &str, mode: &str) -> Failpoints {
        let mut fp = Failpoints::default();
        fp.set(&json!({"step":step,"mode":mode})).unwrap();
        fp
    }
    const COMMIT_STEPS: [&str; 5] = ["pending", "write-records", "write-payments", "write-claims", "write-block"];

    #[test]
    fn commit_and_reload_round_trip() {
        let d = tmpdir("round");
        let l = base(&d);
        let (l2, loaded) = Logs::open(&d, false).unwrap();
        assert_eq!(l2.committed(), l.committed());
        assert_eq!(loaded.blocks.len(), 3);
        assert_eq!(loaded.records, vec![record(2, 0)]);
        assert_eq!(loaded.payments, vec![payment(2)]);
        assert_eq!(loaded.claims, vec![claim(2)]);
        assert!(loaded.report.actions.is_empty() && loaded.report.warnings.is_empty());
        assert!(!path(&d, COMMIT_PENDING).exists());
        fs::remove_dir_all(d).unwrap();
    }

    /// A failure at each step of a block commit (error or torn write, in process) leaves every file byte for byte as before,
    /// and the next attempt commits the block exactly once.
    #[test]
    fn failed_commit_leaves_files_unchanged_in_process() {
        for step in COMMIT_STEPS {
            for mode in ["error", "torn"] {
                let d = tmpdir("inproc");
                let mut l = base(&d);
                let before = snapshot(&d);
                let lens = l.committed();
                let fp = arm(step, mode);
                let r = l.commit_block(4, &block(4), &[record(4, 0), record(4, 1)], &[payment(4)], &[claim(4)], &fp);
                assert!(r.is_err(), "{step}/{mode} must fail");
                assert_eq!(snapshot(&d), before, "{step}/{mode}: files changed");
                assert_eq!(l.committed(), lens);
                assert!(!l.reload_required);
                assert!(!path(&d, COMMIT_PENDING).exists(), "{step}/{mode}: pending file left");
                // and after a restart the directory loads the committed state with nothing to recover
                let (_, loaded) = Logs::open(&d, false).unwrap();
                assert_eq!(loaded.blocks.len(), 3);
                assert_eq!(loaded.records, vec![record(2, 0)]);
                assert!(loaded.report.actions.is_empty(), "{step}/{mode}: {:?}", loaded.report.actions);
                // the retry commits once
                l.commit_block(4, &block(4), &[record(4, 0), record(4, 1)], &[payment(4)], &[claim(4)], &Failpoints::default()).unwrap();
                let (_, loaded) = Logs::open(&d, false).unwrap();
                assert_eq!(loaded.records, vec![record(2, 0), record(4, 0), record(4, 1)]);
                assert_eq!(loaded.payments, vec![payment(2), payment(4)]);
                assert_eq!(loaded.claims, vec![claim(2), claim(4)]);
                assert_eq!(loaded.blocks.len(), 4);
                fs::remove_dir_all(d).unwrap();
            }
        }
    }

    /// A crash at each step (simulated by leaving the files exactly as the crash would): recovery on open restores the
    /// committed state byte for byte.
    #[test]
    fn crash_at_each_step_is_undone_on_open() {
        // What a crash leaves after each step: (pending written?, rows appended in full, block row appended, partial bytes)
        for (k, step) in COMMIT_STEPS.iter().enumerate() {
            for torn in [false, true] {
                let d = tmpdir("crash");
                let l = base(&d);
                let before = snapshot(&d);
                let lens = l.committed();
                let rows = [vec![record(4, 0), record(4, 1)], vec![payment(4)], vec![claim(4)]];
                // steps before k completed
                if k > 0 {
                    write_atomic(&d, COMMIT_PENDING, json!({"height":4,"before":lens}).to_string().as_bytes()).unwrap();
                }
                for (j, i) in [R, P, C].iter().enumerate() {
                    if k > j + 1 {
                        let mut f = fs::OpenOptions::new().append(true).create(true).open(path(&d, FILES[*i])).unwrap();
                        f.write_all(&joined(&rows[j])).unwrap();
                    }
                }
                // the crashing step itself, torn: half of its bytes
                if torn && k > 0 {
                    let (i, b) = match *step {
                        "write-records" => (R, joined(&rows[0])),
                        "write-payments" => (P, joined(&rows[1])),
                        "write-claims" => (C, joined(&rows[2])),
                        _ => (B, joined(&[block(4)])),
                    };
                    let mut f = fs::OpenOptions::new().append(true).create(true).open(path(&d, FILES[i])).unwrap();
                    f.write_all(&b[..b.len() / 2]).unwrap();
                }
                let (l2, loaded) = Logs::open(&d, false).unwrap();
                assert_eq!(snapshot(&d), before, "{step} torn={torn}: not restored");
                assert_eq!(l2.committed(), lens);
                assert_eq!(loaded.records, vec![record(2, 0)]);
                assert!(!path(&d, COMMIT_PENDING).exists());
                fs::remove_dir_all(d).unwrap();
            }
        }
    }

    /// A crash after the block row is synced keeps the block; the leftover pending file is removed on open.
    #[test]
    fn crash_after_commit_point_keeps_the_block() {
        let d = tmpdir("after");
        let mut l = base(&d);
        let fp = arm("clear-pending", "error");
        let note = l.commit_block(4, &block(4), &[record(4, 0)], &[], &[], &fp).unwrap();
        assert!(note.is_some());
        assert!(path(&d, COMMIT_PENDING).exists());
        let (_, loaded) = Logs::open(&d, false).unwrap();
        assert_eq!(loaded.blocks.len(), 4);
        assert_eq!(loaded.records, vec![record(2, 0), record(4, 0)]);
        assert_eq!(loaded.report.actions[0]["action"], "stale-commit-pending-removed");
        assert!(!path(&d, COMMIT_PENDING).exists());
        fs::remove_dir_all(d).unwrap();
    }

    /// When the clean-up of a failed commit fails too, nothing else commits until the directory is recovered, and recovery
    /// restores the committed state.
    #[test]
    fn failed_cleanup_requires_recovery() {
        let d = tmpdir("cleanup");
        let mut l = base(&d);
        let before = snapshot(&d);
        let mut fp = Failpoints::default();
        fp.set(&json!({"list":[{"step":"write-claims","mode":"torn"},{"step":"undo"}]})).unwrap();
        let r = l.commit_block(4, &block(4), &[record(4, 0)], &[payment(4)], &[claim(4)], &fp);
        assert!(format!("{:#}", r.unwrap_err()).contains("cleaning up"));
        assert!(l.reload_required);
        assert_ne!(snapshot(&d), before, "the partial rows are still on disk");
        assert!(l.commit_block(4, &block(4), &[], &[], &[], &Failpoints::default()).is_err(), "no commit before recovery");
        let (l2, loaded) = Logs::open(&d, false).unwrap();
        assert_eq!(snapshot(&d), before);
        assert_eq!(loaded.report.actions[0]["action"], "interrupted-commit-undone");
        assert!(!l2.reload_required);
        fs::remove_dir_all(d).unwrap();
    }

    /// A file shorter than its committed length (changed outside the indexer) is refused, not repaired.
    #[test]
    fn shorter_file_is_refused() {
        let d = tmpdir("short");
        let mut l = base(&d);
        fs::write(path(&d, RECORDS), b"").unwrap();
        let r = l.commit_block(4, &block(4), &[], &[], &[], &Failpoints::default());
        assert!(format!("{:#}", r.unwrap_err()).contains("shorter"));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn reorganisation_is_journaled_and_completed_on_open() {
        let steps = ["reorg-blocks", "reorg-records", "reorg-payments", "reorg-claims", "reorg-clear"];
        for step in steps {
            let d = tmpdir("reorg");
            let mut l = base(&d);
            let fp = Failpoints::default();
            l.commit_block(4, &block(4), &[record(4, 0)], &[payment(4)], &[claim(4)], &fp).unwrap();
            // fork at 2: keep blocks 1-2 and their rows; claim facts keep only the one at or below the fork
            let (keep_b, keep_r, keep_p, keep_c) = (vec![block(1), block(2)], vec![record(2, 0)], vec![payment(2)], vec![claim(2)]);
            let fp = arm(step, "error");
            let r = l.reorg(2, Some(&format!("{:064x}", 2)), &keep_b, &keep_r, &keep_p, &keep_c, &fp);
            assert!(r.is_err());
            assert!(l.reload_required);
            assert!(path(&d, REORG_PENDING).exists());
            let (l2, loaded) = Logs::open(&d, false).unwrap();
            assert_eq!(loaded.blocks, keep_b, "{step}");
            assert_eq!(loaded.records, keep_r);
            assert_eq!(loaded.payments, keep_p);
            assert_eq!(loaded.claims, keep_c);
            assert_eq!(loaded.report.actions[0]["action"], "reorganisation-completed");
            assert!(!path(&d, REORG_PENDING).exists());
            assert!(!l2.reload_required);
            // opening again changes nothing
            let (_, again) = Logs::open(&d, false).unwrap();
            assert!(again.report.actions.is_empty());
            fs::remove_dir_all(d).unwrap();
        }
    }

    #[test]
    fn journal_refused_when_the_fork_block_differs() {
        let d = tmpdir("reorg-hash");
        let _ = base(&d);
        write_atomic(&d, REORG_PENDING, json!({"fork":2,"forkHash":"ff".repeat(32),"claims":[]}).to_string().as_bytes()).unwrap();
        assert!(Logs::open(&d, false).is_err());
        fs::remove_dir_all(d).unwrap();
    }

    /// State left by an indexer version without these rules: rows of a failed block above the tip, a partial last line, and a
    /// repeated record from a retried block.
    #[test]
    fn earlier_version_leftovers() {
        let d = tmpdir("legacy");
        let _ = base(&d);
        let mut f = fs::OpenOptions::new().append(true).open(path(&d, RECORDS)).unwrap();
        f.write_all(joined(&[record(4, 0), record(4, 1)]).as_slice()).unwrap();
        f.write_all(b"{\"height\":4,\"txid\":\"ab").unwrap();
        let mut f = fs::OpenOptions::new().append(true).open(path(&d, PAYMENTS)).unwrap();
        f.write_all(joined(&[payment(4)]).as_slice()).unwrap();
        // dry run: reports, changes nothing
        let before = snapshot(&d);
        let (_, dry) = Logs::open(&d, true).unwrap();
        assert_eq!(snapshot(&d), before);
        assert_eq!(dry.records, vec![record(2, 0)]);
        let actions: Vec<&str> = dry.report.actions.iter().map(|a| a["action"].as_str().unwrap()).collect();
        assert_eq!(actions, vec!["partial-line-dropped", "uncommitted-rows-dropped", "uncommitted-rows-dropped"]);
        // real open
        let (_, loaded) = Logs::open(&d, false).unwrap();
        assert_eq!(loaded.records, vec![record(2, 0)]);
        assert!(loaded.payments == vec![payment(2)]);
        let (_, again) = Logs::open(&d, false).unwrap();
        assert!(again.report.actions.is_empty());
        // a repeated record at a committed height is reported, not changed
        let mut f = fs::OpenOptions::new().append(true).open(path(&d, RECORDS)).unwrap();
        f.write_all(joined(&[record(2, 0)]).as_slice()).unwrap();
        let (_, w) = Logs::open(&d, false).unwrap();
        assert_eq!(w.report.warnings.len(), 1);
        assert_eq!(w.records.len(), 2);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn empty_directory_and_claims_without_blocks() {
        let d = tmpdir("empty");
        fs::write(path(&d, CLAIMS), joined(&[claim(1)])).unwrap();
        fs::write(path(&d, RECORDS), joined(&[record(1, 0)])).unwrap();
        let (l, loaded) = Logs::open(&d, false).unwrap();
        assert!(loaded.blocks.is_empty() && loaded.records.is_empty() && loaded.claims.is_empty());
        assert_eq!(l.committed(), Lens::default());
        fs::remove_dir_all(d).unwrap();
    }

    // ---------------------------------------------------------------- durable files and stale commit-pending files

    /// `open` creates the four files (empty) so no row ever lands in a file whose directory entry is not yet durable.
    #[test]
    fn open_creates_every_log_file() {
        let d = tmpdir("create");
        let (_, loaded) = Logs::open(&d, false).unwrap();
        for f in FILES {
            assert!(path(&d, f).exists(), "{f} not created");
        }
        assert_eq!(loaded.report.actions.iter().filter(|a| a["action"] == "log-file-created").count(), 4);
        let (_, again) = Logs::open(&d, false).unwrap();
        assert!(again.report.actions.is_empty());
        // a dry run creates nothing
        let e = tmpdir("create-dry");
        let _ = Logs::open(&e, true).unwrap();
        assert!(FILES.iter().all(|f| !path(&e, f).exists()));
        fs::remove_dir_all(d).unwrap();
        fs::remove_dir_all(e).unwrap();
    }

    /// A file deleted after open is created again by the append, which syncs the directory before the block row.
    #[test]
    fn append_recreates_a_deleted_file() {
        let d = tmpdir("recreate");
        let (mut l, _) = Logs::open(&d, false).unwrap();
        l.commit_block(1, &block(1), &[], &[], &[], &Failpoints::default()).unwrap();
        fs::remove_file(path(&d, CLAIMS)).unwrap();
        l.commit_block(2, &block(2), &[], &[], &[claim(2)], &Failpoints::default()).unwrap();
        let (_, loaded) = Logs::open(&d, false).unwrap();
        assert_eq!(loaded.claims, vec![claim(2)]);
        fs::remove_dir_all(d).unwrap();
    }

    /// A stale commit-pending file (its block committed, only its removal failed) is removed before the next commit.
    #[test]
    fn stale_pending_is_removed_before_the_next_commit() {
        let d = tmpdir("stale-commit");
        let mut l = base(&d);
        assert!(l.commit_block(4, &block(4), &[record(4, 0)], &[], &[], &arm("clear-pending", "error")).unwrap().is_some());
        assert_eq!(l.stale_height, Some(4));
        assert!(path(&d, COMMIT_PENDING).exists());
        l.commit_block(5, &block(5), &[], &[], &[], &Failpoints::default()).unwrap();
        assert!(!path(&d, COMMIT_PENDING).exists());
        assert_eq!(l.stale_height, None);
        let (_, loaded) = Logs::open(&d, false).unwrap();
        assert_eq!(loaded.blocks.len(), 5);
        assert_eq!(loaded.records, vec![record(2, 0), record(4, 0)]);
        assert!(loaded.report.actions.is_empty());
        fs::remove_dir_all(d).unwrap();
    }

    /// Stale commit-pending file, then a reorganisation that completes: the reorganisation removes the stale file first, the
    /// directory reopens (twice) to the fork's rows, and the next block commits.
    #[test]
    fn stale_pending_then_completed_reorg() {
        let d = tmpdir("stale-reorg");
        let mut l = base(&d);
        l.commit_block(4, &block(4), &[record(4, 0)], &[payment(4)], &[claim(4)], &arm("clear-pending", "error")).unwrap();
        l.reorg(2, Some(&format!("{:064x}", 2)), &[block(1), block(2)], &[record(2, 0)], &[payment(2)], &[claim(2)], &Failpoints::default()).unwrap();
        assert!(!path(&d, COMMIT_PENDING).exists() && !path(&d, REORG_PENDING).exists());
        for _ in 0..2 {
            let (_, loaded) = Logs::open(&d, false).unwrap();
            assert_eq!(loaded.blocks, vec![block(1), block(2)]);
            assert_eq!(loaded.records, vec![record(2, 0)]);
            assert_eq!(loaded.payments, vec![payment(2)]);
            assert_eq!(loaded.claims, vec![claim(2)]);
            assert!(loaded.report.actions.is_empty());
        }
        // the running log commits on, and so does a reopened one
        l.commit_block(3, &block(3), &[record(3, 0)], &[], &[], &Failpoints::default()).unwrap();
        let (mut l2, loaded) = Logs::open(&d, false).unwrap();
        assert_eq!(loaded.records, vec![record(2, 0), record(3, 0)]);
        l2.commit_block(4, &block(4), &[], &[], &[], &Failpoints::default()).unwrap();
        fs::remove_dir_all(d).unwrap();
    }

    /// Stale commit-pending file, then a reorganisation interrupted at each step: only the reorganisation journal is left, the
    /// directory recovers to the fork's rows, a second recovery changes nothing, and the next block commits.
    #[test]
    fn stale_pending_then_interrupted_reorg() {
        for step in ["reorg-journal", "reorg-blocks", "reorg-records", "reorg-payments", "reorg-claims", "reorg-clear"] {
            let d = tmpdir("stale-reorg-int");
            let mut l = base(&d);
            l.commit_block(4, &block(4), &[record(4, 0)], &[payment(4)], &[claim(4)], &arm("clear-pending", "error")).unwrap();
            let r = l.reorg(2, Some(&format!("{:064x}", 2)), &[block(1), block(2)], &[record(2, 0)], &[payment(2)], &[claim(2)], &arm(step, "error"));
            assert!(r.is_err(), "{step}");
            assert!(!path(&d, COMMIT_PENDING).exists(), "{step}: the stale file is removed before the reorganisation");
            let (mut l2, first) = Logs::open(&d, false).unwrap();
            if step == "reorg-journal" {
                // nothing was rewritten: the committed state is the one before the reorganisation
                assert_eq!(first.blocks.len(), 4, "{step}");
                assert!(!l.reload_required);
            } else {
                assert!(l.reload_required, "{step}");
                assert_eq!(first.blocks, vec![block(1), block(2)], "{step}");
                assert_eq!(first.records, vec![record(2, 0)]);
                assert_eq!(first.payments, vec![payment(2)]);
                assert_eq!(first.claims, vec![claim(2)]);
            }
            let bytes = snapshot(&d);
            let (_, second) = Logs::open(&d, false).unwrap();
            assert_eq!(snapshot(&d), bytes, "{step}: a second recovery changed the files");
            assert!(second.report.actions.is_empty(), "{step}");
            let next = first.blocks.len() as u64 + 1;
            l2.commit_block(next, &block(next), &[record(next, 0)], &[], &[], &Failpoints::default()).unwrap();
            let (_, after) = Logs::open(&d, false).unwrap();
            assert_eq!(after.blocks.len() as u64, next, "{step}");
            fs::remove_dir_all(d).unwrap();
        }
    }

    /// When the stale file cannot be removed at the start of a reorganisation, nothing is changed, recovery is required, and
    /// after recovery the reorganisation runs.
    #[test]
    fn stale_pending_that_cannot_be_removed_stops_the_reorg() {
        let d = tmpdir("stale-stuck");
        let mut l = base(&d);
        l.commit_block(4, &block(4), &[record(4, 0)], &[], &[], &arm("clear-pending", "error")).unwrap();
        let before = snapshot(&d);
        let r = l.reorg(2, Some(&format!("{:064x}", 2)), &[block(1), block(2)], &[record(2, 0)], &[payment(2)], &[claim(2)], &arm("resolve-pending", "error"));
        assert!(format!("{:#}", r.unwrap_err()).contains("recovered before the next change"));
        assert!(l.reload_required);
        assert_eq!(snapshot(&d), before);
        assert!(path(&d, COMMIT_PENDING).exists() && !path(&d, REORG_PENDING).exists());
        assert!(l.commit_block(5, &block(5), &[], &[], &[], &Failpoints::default()).is_err(), "no change before recovery");
        let (mut l2, loaded) = Logs::open(&d, false).unwrap();
        assert_eq!(loaded.report.actions[0]["action"], "stale-commit-pending-removed");
        assert_eq!(loaded.blocks.len(), 4);
        l2.reorg(2, Some(&format!("{:064x}", 2)), &[block(1), block(2)], &[record(2, 0)], &[payment(2)], &[claim(2)], &Failpoints::default()).unwrap();
        let (_, loaded) = Logs::open(&d, false).unwrap();
        assert_eq!(loaded.blocks, vec![block(1), block(2)]);
        fs::remove_dir_all(d).unwrap();
    }

    /// A stale commit-pending file whose committed rows are missing from disk (shorter than its `after` length) is refused, not
    /// accepted as a committed block without its rows. A journal written by an older build (no `after`) is still accepted.
    #[test]
    fn missing_committed_rows_are_refused() {
        for file in [RECORDS, PAYMENTS, CLAIMS] {
            let d = tmpdir("lost-rows");
            let mut l = base(&d);
            let lens = l.committed();
            l.commit_block(4, &block(4), &[record(4, 0)], &[payment(4)], &[claim(4)], &arm("clear-pending", "error")).unwrap();
            let i = FILES.iter().position(|f| *f == file).unwrap();
            let f = fs::OpenOptions::new().write(true).open(path(&d, file)).unwrap();
            f.set_len(lens.get(i)).unwrap();
            let e = Logs::open(&d, true).err().expect("dry run must refuse too");
            assert!(format!("{e:#}").contains("committed rows are missing"), "{file}: {e:#}");
            assert!(Logs::open(&d, false).is_err());
            assert!(path(&d, COMMIT_PENDING).exists(), "the journal is kept for the operator");
            fs::remove_dir_all(d).unwrap();
        }
        let d = tmpdir("old-journal");
        let mut l = base(&d);
        let lens = l.committed();
        l.commit_block(4, &block(4), &[record(4, 0)], &[], &[], &Failpoints::default()).unwrap();
        write_atomic(&d, COMMIT_PENDING, json!({"height":4,"before":lens}).to_string().as_bytes()).unwrap();
        let (_, loaded) = Logs::open(&d, false).unwrap();
        assert_eq!(loaded.report.actions[0]["action"], "stale-commit-pending-removed");
        fs::remove_dir_all(d).unwrap();
    }

    // ---------------------------------------------------------------- reorganisation journal

    /// The reorganisation journal is on disk and the reorganisation then fails (as when the journal's rename succeeds and the
    /// directory sync after it fails): recovery is required, no block commits before it, and recovery applies the journal.
    /// After recovery the next block commits, and a second recovery changes nothing.
    #[test]
    fn failure_after_the_reorg_journal_requires_recovery() {
        let d = tmpdir("reorg-written");
        let mut l = base(&d);
        let before = snapshot(&d);
        let r = l.reorg(2, Some(&format!("{:064x}", 2)), &[block(1), block(2)], &[record(2, 0)], &[payment(2)], &[claim(2)], &arm("reorg-journal-written", "error"));
        assert!(format!("{:#}", r.unwrap_err()).contains("recovered from its journal"));
        assert!(l.reload_required);
        assert!(path(&d, REORG_PENDING).exists());
        assert_eq!(snapshot(&d), before, "no file was rewritten yet");
        assert!(l.commit_block(4, &block(4), &[record(4, 0)], &[], &[], &Failpoints::default()).is_err(), "no commit beside the journal");
        assert!(l.reorg(1, Some(&format!("{:064x}", 1)), &[block(1)], &[], &[], &[], &Failpoints::default()).is_err(), "no other reorganisation");
        assert!(!path(&d, COMMIT_PENDING).exists());
        let (mut l2, loaded) = Logs::open(&d, false).unwrap();
        assert_eq!(loaded.blocks, vec![block(1), block(2)]);
        assert_eq!(loaded.report.actions[0]["action"], "reorganisation-completed");
        l2.commit_block(3, &block(3), &[record(3, 0)], &[], &[], &Failpoints::default()).unwrap();
        let bytes = snapshot(&d);
        let (_, again) = Logs::open(&d, false).unwrap();
        assert_eq!(snapshot(&d), bytes);
        assert_eq!(again.blocks.len(), 3);
        assert!(again.report.actions.is_empty());
        fs::remove_dir_all(d).unwrap();
    }

    /// A reorganisation journal present in the directory of a running log that does not know of it (whatever left it): the next
    /// commit is refused before it writes anything, recovery is required, and recovery applies the journal.
    #[test]
    fn no_commit_beside_a_reorg_journal() {
        let d = tmpdir("reorg-beside");
        let mut l = base(&d);
        write_atomic(&d, REORG_PENDING, json!({"fork":2,"forkHash":format!("{:064x}", 2),"claims":[]}).to_string().as_bytes()).unwrap();
        let before = snapshot(&d);
        let r = l.commit_block(4, &block(4), &[record(4, 0)], &[payment(4)], &[claim(4)], &Failpoints::default());
        assert!(format!("{:#}", r.unwrap_err()).contains("reorganisation journal is present"));
        assert!(l.reload_required);
        assert_eq!(snapshot(&d), before);
        assert!(!path(&d, COMMIT_PENDING).exists(), "no commit journal beside the reorganisation journal");
        let (_, loaded) = Logs::open(&d, false).unwrap();
        assert_eq!(loaded.blocks, vec![block(1), block(2)]);
        assert!(loaded.claims.is_empty());
        assert!(!path(&d, REORG_PENDING).exists());
        fs::remove_dir_all(d).unwrap();
    }
}
