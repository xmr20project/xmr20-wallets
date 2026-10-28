// An isolated overlay replayer, NOT a validating Monero node or live indexer.
// Native consensus, block completeness, tx order, output indices and the pinned
// activation checkpoint are a REQUIRED upstream trust boundary. The separate
// local-chain adapter supplies these only for an isolated offline fakechain.
import {Buffer} from 'buffer';
import {bytes, domain, exact, hash, hex, join, need, ordered, Reader, uint} from './bytes.mjs';
import {decodeManifest, encodeManifest, manifestId, outpointKey, EXPIRING_CREDIT_PROFILE, circulatingSupply, offlineRecipients, validCreditEpoch} from './records.mjs';
import {decodeCarrier, inspectCarrier} from './carrier.mjs';
import {inspectNativeObservation} from './native-observation.mjs';
import {publicPoint, verifyClaim, verifyCredit} from './proofs.mjs';
import {authorizedRecipient,deferredRecipient,lotAcceptsImage,UNREVEALED_IMAGE} from './output-identity.mjs';

export const READINESS = Object.freeze({productionReady: false, atomicSaleSafe: false, nativeConsensusVerified: false,
  twoPartySigningImplemented: false, walletIntegrated: false, ordinaryTradeSolanaSignatureRequired: false});
function initial(m) {
  return {height: m.height, blockHash: m.blockHash, issued: 0n, burned: 0n,
    lots: new Map(), consumed: new Map(), spends: new Map(), issuances: new Map(), burns: new Map(),
    transactions: new Map(), outputIndices: new Map()};
}
const MAPS = ['lots', 'consumed', 'spends', 'issuances', 'burns', 'transactions', 'outputIndices'];
// A block stages only changed entries. Existing values are immutable internal
// records; public snapshots are still deep copies. The committed maps remain
// untouched while asynchronous admission policy is running or fails.
class BlockMap {
  constructor(base) { this.base = base; this.updates = new Map(); }
  has(key) { return this.updates.has(key) || this.base.has(key); }
  get(key) { return this.updates.has(key) ? this.updates.get(key) : this.base.get(key); }
  set(key, value) { this.updates.set(key, value); return this; }
  *entries() {
    for (const [key, value] of this.base) yield [key, this.updates.has(key) ? this.updates.get(key) : value];
    for (const entry of this.updates) if (!this.base.has(entry[0])) yield entry;
  }
  *values() { for (const [, value] of this.entries()) yield value; }
  [Symbol.iterator]() { return this.entries(); }
}
function stageState(state) {
  return {...state, ...Object.fromEntries(MAPS.map(name => [name, new BlockMap(state[name])]))};
}
function undoBlock(state, frame) {
  for (const name of MAPS) for (const [key, existed, value] of frame.undo[name]) {
    if (existed) state[name].set(key, value); else state[name].delete(key);
  }
  state.height = frame.height; state.blockHash = frame.blockHash;
  state.issued = frame.issued; state.burned = frame.burned;
}
function addLots(state, tx, allocations, height, recordId, outputIndices, context, manifest) {
  const id=manifestId(manifest),images = new Set([...state.lots.values()].map(l => l.image).filter(image=>image!==UNREVEALED_IMAGE));
  const deferredKeys=offlineRecipients(manifest.profile)?new Set([...state.lots.values()].map(l=>l.key)):null;
  return allocations.map(a => {
    const output = tx.outputs[a.vout]; need(output, 'Allocation output missing'); publicPoint(output.key);
    need(authorizedRecipient(manifest,{manifest:id, context, allocation: a, outputKey: output.key}), 'Invalid recipient authorization');
    need(tx.outputs.filter(o => o.key === output.key).length === 1 && !images.has(a.image), 'Duplicate token output identity');
    if(deferredKeys){need(!deferredKeys.has(output.key),'Reused token output key');deferredKeys.add(output.key);}
    need(!state.spends.has(a.image) && !tx.inputs.some(input => input.keyImage === a.image), 'Destination identity already spent');
    if(!deferredRecipient(manifest,a))images.add(a.image);
    return {id: outpointKey({txid: tx.txid, vout: a.vout}), key: output.key, image: a.image, amount: a.amount,
      globalIndex: outputIndices[a.vout], height, recordId};
  });
}
function applyRecord(state, tx, decoded, manifest, id, height, outputIndices) {
  const {record: r, context, recordId} = decoded;
  need(r.manifest === id, 'Wrong manifest');
  if (r.op === 'CREDIT') {
    need(manifest.profile!==EXPIRING_CREDIT_PROFILE||height<=BigInt(r.epoch),'Native credit creation deadline passed');
    need(!state.issuances.has(r.issuance) && ![...state.issuances.values()].some(i => i.lock === r.lock), 'Reused issuance or lock');
    const counted = circulatingSupply(manifest.profile) ? state.issued - state.burned : state.issued;
    need(counted + r.amount <= manifest.cap && state.issued + r.amount <= 0xffffffffffffffffn, 'Issuance cap exceeded');
    const lots = addLots(state, tx, [r], height, recordId, outputIndices, context, manifest);
    need(verifyCredit(r, context, lots[0].key, manifest), 'Invalid issuer authorization');
    lots.forEach(l => state.lots.set(l.id, l));
    state.issuances.set(r.issuance, {lock: r.lock, txid: tx.txid, amount: r.amount, epoch: r.epoch});
    state.issued += r.amount;
    return;
  }
  const claimed = r.claims.map(claim => {
    const source = outpointKey(claim.source), lot = state.lots.get(source), input = tx.inputs[claim.vin];
    need(lot && !state.consumed.has(source), 'Source lot unavailable');
    need(height - lot.height >= 10n, 'Source output not mature');
    need(input && input.offsets[claim.ringPos] === lot.globalIndex, 'Source is not the claimed native ring member');
    need(lotAcceptsImage(manifest,lot,input.keyImage), 'Source identity mismatch');
    need(!state.spends.has(input.keyImage), 'Source key image already spent');
    need(verifyClaim({manifest: id, context, claim, outputKey: lot.key, keyImage: input.keyImage, op: r.op}), 'Invalid ownership proof');
    return {source, lot, input, vin: claim.vin};
  });
  // Native input uniqueness also checked at block admission, independent of the record.
  need(new Set(claimed.map(c => c.input.keyImage)).size === claimed.length, 'Repeated claim image');
  const total = claimed.reduce((n, c) => n + c.lot.amount, 0n);
  const allocated = r.allocations.reduce((n, a) => n + a.amount, 0n);
  need(total === allocated + (r.op === 'BURN' ? r.amount : 0n), 'Token conservation failed');
  if (r.op === 'BURN') {
    need(!state.burns.has(r.redemption), 'Reused redemption');
    need(r.recipient !== '0'.repeat(64), 'Redemption recipient missing');
  }
  const lots = addLots(state, tx, r.allocations, height, recordId, outputIndices, context, manifest);
  // No mutation before all validation completes. Invalid overlays still spend
  // native inputs; applyBlock tracks those independently below.
  claimed.forEach(c => state.consumed.set(c.source, {txid: tx.txid, op: r.op, image: c.input.keyImage}));
  lots.forEach(l => state.lots.set(l.id, l));
  if (r.op === 'BURN') {
    state.burns.set(r.redemption, {txid: tx.txid, amount: r.amount, recipient: r.recipient});
    state.burned += r.amount;
  }
}
// Private ledger values are immutable. Reuse their canonical row encodings,
// while still hashing the complete exact state after every admitted block.
const canonicalTables = new WeakMap();
function cachedTable(id, map, keyBytes, make) {
  let cached = canonicalTables.get(map);
  if (!cached) { cached = {rows: new Map(), sorted: []}; canonicalTables.set(map, cached); }
  try {
  const added = [];
  for (const [key, value] of map) {
    const old = cached.rows.get(key);
    if (old && old.value === value) continue;
    const row = make(key, value), entry = {key, value, keyBytes: keyBytes(key), bytes: join(uint(row.length, 4), row)};
    cached.rows.set(key, entry); added.push(entry);
  }
  for (const key of cached.rows.keys()) if (!map.has(key)) cached.rows.delete(key);
  const kept = cached.sorted.filter(entry => cached.rows.get(entry.key) === entry);
  added.sort((a, b) => Buffer.compare(a.keyBytes, b.keyBytes));
  const sorted = []; let i = 0, j = 0;
  while (i < kept.length && j < added.length) sorted.push(Buffer.compare(kept[i].keyBytes, added[j].keyBytes) < 0 ? kept[i++] : added[j++]);
  while (i < kept.length) sorted.push(kept[i++]);
  while (j < added.length) sorted.push(added[j++]);
  cached.sorted = sorted;
  return Buffer.concat([uint(id, 1), uint(sorted.length, 8), ...sorted.map(entry => entry.bytes)]);
  } catch (error) { canonicalTables.delete(map); throw error; }
}
function stateBytes(state, id) {
  const hexKey = key => Buffer.from(key, 'hex');
  return join(domain('XN1-LOCAL-S2-STATE'), uint(2, 1), hex(id), uint(state.height, 8), hex(state.blockHash),
    uint(state.issued, 8), uint(state.burned, 8), uint(0, 8), uint(8, 1),
    cachedTable(1, state.lots, hexKey, (key, v) => join(Buffer.from(key, 'hex'), hex(v.key), hex(v.image), uint(v.amount, 8),
      uint(v.globalIndex, 8), uint(v.height, 8), hex(v.recordId))),
    cachedTable(2, state.consumed, hexKey, (key, v) => join(Buffer.from(key, 'hex'), hex(v.txid), uint(v.op === 'MOVE' ? 2 : 3, 1), hex(v.image))),
    cachedTable(3, state.spends, hexKey, (key, v) => join(hex(key), hex(v.txid), uint(v.vin, 2), uint(v.height, 8))),
    cachedTable(4, state.issuances, hexKey, (key, v) => join(hex(key), hex(v.lock), hex(v.txid), uint(v.amount, 8), uint(v.epoch, 4))),
    cachedTable(5, state.burns, hexKey, (key, v) => join(hex(key), hex(v.txid), uint(v.amount, 8), hex(v.recipient))),
    cachedTable(6, state.transactions, hexKey, (key, height) => join(hex(key), uint(height, 8))),
    cachedTable(7, state.outputIndices, key => uint(key, 8), (key, value) => join(uint(key, 8), Buffer.from(value, 'hex'))),
    join(uint(8, 1), uint(0, 8)));
}
// This is a local cache codec, not a consensus proof or server snapshot format.
// Change the verification version whenever admission rules change, so old
// authenticated caches cannot carry an earlier verification defect forward.
export const TOKEN_CHECKPOINT_CODEC_VERSION = 1;
export const TOKEN_CHECKPOINT_VERIFICATION_VERSION = 1;
export const MAX_TOKEN_CHECKPOINT_BYTES = 64 * 1024 * 1024;
export const MAX_TOKEN_CHECKPOINT_ROWS = 1_000_000;
const STATE_DOMAIN = domain('XN1-LOCAL-S2-STATE');
const ROW_LENGTHS = [156, 101, 74, 108, 104, 40, 44];
const KEY_LENGTHS = [36, 36, 32, 32, 32, 32, 8];
const STATE_HEADER_LENGTH = STATE_DOMAIN.length + 1 + 32 + 8 + 32 + 8 + 8 + 8 + 1;
function checkpointFits(state) {
  let count = 0, length = STATE_HEADER_LENGTH + 8 * 9;
  MAPS.forEach((name, i) => { count += state[name].size; length += state[name].size * (ROW_LENGTHS[i] + 4); });
  return count <= MAX_TOKEN_CHECKPOINT_ROWS && length <= MAX_TOKEN_CHECKPOINT_BYTES;
}
function checkpointHeight(value) {
  need(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), 'Canonical checkpoint height required');
  const height = BigInt(value); uint(height, 8); return height;
}
function coherentCheckpoint(state, manifest) {
  const {height, transactions, outputIndices, spends, lots, consumed, issuances, burns} = state;
  need(height >= manifest.height, 'Checkpoint precedes activation');
  if (height === manifest.height) need(state.blockHash === manifest.blockHash && MAPS.every(name => !state[name].size), 'Activation checkpoint is not empty');
  need(state.issued >= state.burned && (circulatingSupply(manifest.profile) ? state.issued - state.burned : state.issued) <= manifest.cap, 'Checkpoint supply exceeds manifest');
  const txs = new Map(), perHeight = new Map();
  for (const [txid, at] of transactions) {
    need(at > manifest.height && at <= height, 'Checkpoint transaction height is outside history');
    const count = (perHeight.get(at) ?? 0) + 1; need(count <= 10000, 'Checkpoint block transaction bound exceeded'); perHeight.set(at, count);
    txs.set(txid, {height: at, inputs: new Set(), outputs: new Map(), lots: [], consumed: [], issuance: null, burn: null});
  }
  const transaction = txid => { const tx = txs.get(txid); need(tx, 'Checkpoint references an unknown transaction'); return tx; };
  for (const [index, point] of outputIndices) {
    const tx = transaction(point.slice(0, 64)), vout = new Reader(Buffer.from(point.slice(64), 'hex')).u(4);
    need(vout < 4096 && !tx.outputs.has(vout), 'Checkpoint output index is repeated or out of range'); tx.outputs.set(vout, index);
  }
  for (const [image, spend] of spends) {
    const tx = transaction(spend.txid);
    need(spend.height === tx.height && spend.vin < 4096 && !tx.inputs.has(spend.vin) && image !== UNREVEALED_IMAGE, 'Checkpoint input provenance is invalid');
    tx.inputs.add(spend.vin);
  }
  for (const tx of txs.values()) {
    need(tx.inputs.size > 0 && tx.outputs.size >= 2, 'Checkpoint transaction observations are incomplete');
    for (let i = 0; i < tx.inputs.size; i++) need(tx.inputs.has(i), 'Checkpoint input sequence is incomplete');
    let previous = -1n;
    for (let i = 0; i < tx.outputs.size; i++) { const value = tx.outputs.get(i); need(typeof value === 'bigint' && value > previous, 'Checkpoint output sequence is incomplete or unordered'); previous = value; }
  }
  const images = new Set(), keys = new Set(); let outstanding = 0n;
  for (const [point, lot] of lots) {
    const tx = transaction(point.slice(0, 64));
    const vout = new Reader(Buffer.from(point.slice(64), 'hex')).u(4);
    need(lot.id === point && vout < 16 && lot.height === tx.height && outputIndices.get(lot.globalIndex) === point && lot.amount > 0n, 'Checkpoint lot provenance is invalid');
    need(lot.key !== UNREVEALED_IMAGE, 'Checkpoint lot output key is invalid');
    if (lot.image === UNREVEALED_IMAGE) need(offlineRecipients(manifest.profile), 'Checkpoint deferred identity is unsupported');
    else { need(!images.has(lot.image), 'Checkpoint lot identity is repeated'); images.add(lot.image); }
    if (offlineRecipients(manifest.profile)) { need(!keys.has(lot.key), 'Checkpoint lot output key is repeated'); keys.add(lot.key); }
    tx.lots.push(lot); if (!consumed.has(point)) outstanding += lot.amount;
  }
  const consumedImages = new Set();
  for (const [point, use] of consumed) {
    const lot = lots.get(point), tx = transaction(use.txid), spend = spends.get(use.image);
    need(lot && !consumedImages.has(use.image) && tx.height - lot.height >= 10n && spend?.txid === use.txid &&
      (lot.image === use.image || offlineRecipients(manifest.profile) && lot.image === UNREVEALED_IMAGE), 'Checkpoint consumed lot provenance is invalid');
    consumedImages.add(use.image); tx.consumed.push({amount: lot.amount, op: use.op});
  }
  const locks = new Set(); let issued = 0n, burned = 0n;
  for (const issuance of issuances.values()) {
    const tx = transaction(issuance.txid);
    need(!tx.issuance && !locks.has(issuance.lock) && issuance.amount > 0n && validCreditEpoch(manifest, issuance.epoch) &&
      (manifest.profile !== EXPIRING_CREDIT_PROFILE || tx.height <= BigInt(issuance.epoch)), 'Checkpoint issuance is invalid or repeated');
    locks.add(issuance.lock); tx.issuance = issuance; issued += issuance.amount;
  }
  for (const burn of burns.values()) {
    const tx = transaction(burn.txid);
    need(!tx.burn && burn.amount > 0n && burn.recipient !== UNREVEALED_IMAGE, 'Checkpoint burn is invalid or repeated');
    tx.burn = burn; burned += burn.amount;
  }
  for (const tx of txs.values()) {
    const allocated = tx.lots.reduce((n, lot) => n + lot.amount, 0n), claimed = tx.consumed.reduce((n, use) => n + use.amount, 0n);
    need(tx.lots.length <= 16 && tx.consumed.length <= 8 && tx.lots.every(lot => lot.recordId === tx.lots[0].recordId), 'Checkpoint allocation record identities or bounds differ');
    if (tx.issuance) need(!tx.consumed.length && !tx.burn && tx.lots.length === 1 && allocated === tx.issuance.amount, 'Checkpoint credit allocation differs');
    else if (tx.consumed.length) need(tx.consumed.every(use => use.op === (tx.burn ? 'BURN' : 'MOVE')) &&
      claimed === allocated + (tx.burn?.amount ?? 0n) && (tx.burn || tx.lots.length > 0), 'Checkpoint token conservation failed');
    else need(!tx.lots.length && !tx.burn, 'Checkpoint token allocation has no source');
  }
  need(issued === state.issued && burned === state.burned && outstanding === issued - burned, 'Checkpoint supply counters differ');
}
function decodeCheckpointState(data, manifest, id) {
  const r = new Reader(data), state = initial(manifest);
  need(r.take(STATE_DOMAIN.length).equals(STATE_DOMAIN) && r.u(1) === 2 && r.hex() === id, 'Checkpoint canonical state identity differs');
  state.height = r.u(8); state.blockHash = r.hex(); state.issued = r.u(8); state.burned = r.u(8);
  need(r.u(8) === 0n && r.u(1) === 8, 'Checkpoint reserved state fields differ');
  let total = 0;
  for (let table = 1; table <= 8; table++) {
    need(r.u(1) === table, 'Checkpoint table order differs');
    const count = r.u(8);
    if (table === 8) { need(count === 0n, 'Checkpoint reserved table must be empty'); continue; }
    const width = ROW_LENGTHS[table - 1], keyWidth = KEY_LENGTHS[table - 1];
    need(count <= BigInt(MAX_TOKEN_CHECKPOINT_ROWS - total) && count <= BigInt(Math.floor((r.data.length - r.at) / (width + 4))), 'Checkpoint table exceeds row or byte bound');
    total += Number(count); const map = state[MAPS[table - 1]]; let previous;
    for (let i = 0; i < Number(count); i++) {
      need(r.u(4) === width, 'Checkpoint row length differs');
      const rawKey = r.take(keyWidth);
      need(!previous || Buffer.compare(previous, rawKey) < 0, 'Checkpoint keys must be sorted and unique'); previous = rawKey;
      const key = table === 7 ? new Reader(rawKey).u(8) : rawKey.toString('hex'); let value;
      if (table === 1) value = {id: key, key: r.hex(), image: r.hex(), amount: r.u(8), globalIndex: r.u(8), height: r.u(8), recordId: r.hex()};
      else if (table === 2) { const txid = r.hex(), op = r.u(1); need(op === 2 || op === 3, 'Checkpoint consumed operation is invalid'); value = {txid, op: op === 2 ? 'MOVE' : 'BURN', image: r.hex()}; }
      else if (table === 3) value = {txid: r.hex(), vin: r.u(2), height: r.u(8)};
      else if (table === 4) value = {lock: r.hex(), txid: r.hex(), amount: r.u(8), epoch: r.u(4)};
      else if (table === 5) value = {txid: r.hex(), amount: r.u(8), recipient: r.hex()};
      else if (table === 6) value = r.u(8);
      else value = r.hex(36);
      map.set(key, value);
    }
  }
  r.done(); coherentCheckpoint(state, manifest);
  need(stateBytes(state, id).equals(data), 'Checkpoint state is not canonical'); return state;
}
export class PrototypeIndex {
  #manifest; #id; #state; #history = []; #applying = false; #historyLimit; #restoreBase; #stateHash = null;
  constructor(manifest) {
    this.#manifest = decodeManifest(encodeManifest(manifest));
    this.#manifest.issuers.forEach(publicPoint);
    this.#id = manifestId(this.#manifest); this.#state = initial(this.#manifest); this.#restoreBase = this.#manifest.height;
    // Retain confirmation display plus a bounded rewind window. Older forks
    // require canonical replay from activation; they never delete wallet holds.
    this.#historyLimit = Math.max(128, this.#manifest.depth);
  }
  get manifest() { return structuredClone(this.#manifest); }
  get id() { return this.#id; }
  checkpoint() { return {height:this.#state.height,blockHash:this.#state.blockHash}; }
  accountingSummary() { const {height,blockHash,issued,burned}=this.#state; return {height,blockHash,issued,burned}; }
  rewindWindow() { return {oldestHeight: this.#history[0]?.height ?? this.#state.height,
    retainedBlocks: this.#history.length, maximumBlocks: this.#historyLimit}; }
  snapshot() { return structuredClone(this.#state); }
  // Committed state is private and changes only at block commit or rewind.
  // Reuse its exact digest across the many read/approval guards at that height;
  // recomputing the entire history for each guard can exhaust its freshness.
  stateHash() { return this.#stateHash ??= hash(stateBytes(this.#state, this.#id)).toString('hex'); }
  canonicalState() { return stateBytes(this.#state, this.#id); }
  exportCheckpoint() {
    need(!this.#applying, 'Native block admission already in progress');
    if (!checkpointFits(this.#state)) return null;
    const state = this.canonicalState();
    return {codecVersion: TOKEN_CHECKPOINT_CODEC_VERSION, verificationVersion: TOKEN_CHECKPOINT_VERIFICATION_VERSION,
      manifest: this.#id, genesis: this.#manifest.genesis, checkpoint: {height: this.#state.height.toString(), blockHash: this.#state.blockHash},
      stateHash: hash(state).toString('hex'), state};
  }
  // Caller MUST authenticate this worker-created cache with the wallet's local
  // key before decoding, then validate fresh canonical ancestry before use,
  // classification or signing. An unkeyed state hash, server response or
  // arbitrary page message is never that authorization.
  static fromAuthenticatedCheckpoint(manifest, envelope, expectedCheckpoint) {
    exact(envelope, ['codecVersion', 'verificationVersion', 'manifest', 'genesis', 'checkpoint', 'stateHash', 'state']);
    exact(envelope.checkpoint, ['height', 'blockHash']); exact(expectedCheckpoint, ['height', 'blockHash']);
    need(envelope.codecVersion === TOKEN_CHECKPOINT_CODEC_VERSION && envelope.verificationVersion === TOKEN_CHECKPOINT_VERIFICATION_VERSION, 'Unsupported token checkpoint verification version');
    need(envelope.state instanceof Uint8Array && envelope.state.length <= MAX_TOKEN_CHECKPOINT_BYTES &&
      !(typeof SharedArrayBuffer !== 'undefined' && envelope.state.buffer instanceof SharedArrayBuffer), 'Checkpoint state exceeds supported byte bound');
    const index = new PrototypeIndex(manifest), height = checkpointHeight(envelope.checkpoint.height);
    hex(envelope.manifest); hex(envelope.genesis); hex(envelope.stateHash); hex(envelope.checkpoint.blockHash); hex(expectedCheckpoint.blockHash);
    need(envelope.manifest === index.#id && envelope.genesis === index.#manifest.genesis, 'Token checkpoint manifest or genesis differs');
    need(typeof expectedCheckpoint.height === 'bigint' && height === expectedCheckpoint.height && envelope.checkpoint.blockHash === expectedCheckpoint.blockHash, 'Private and token checkpoints differ');
    const data = bytes(envelope.state); need(hash(data).toString('hex') === envelope.stateHash, 'Token checkpoint state hash differs');
    const state = decodeCheckpointState(data, index.#manifest, index.#id);
    need(state.height === height && state.blockHash === envelope.checkpoint.blockHash, 'Canonical token checkpoint differs');
    index.#state = state; index.#restoreBase = height; return index;
  }
  previewTransaction(blob) {
    need(!this.#applying, 'Native block admission already in progress');
    // Read-only overlay validation for a wallet's proposed transaction. Native
    // range proofs, input signatures and payment amounts are checked by the
    // participant signer, not by this structural decoder. Never commit a
    // hypothetical block or fabricate usable output-index/provenance evidence.
    const tx = inspectCarrier(bytes(blob)), decoded = decodeCarrier(tx);
    need(decoded, 'Native token record missing');
    need(!this.#state.transactions.has(tx.txid), 'Repeated native transaction');
    const images = new Set();
    for (const input of tx.inputs) {
      publicPoint(input.keyImage);
      need(!images.has(input.keyImage) && !this.#state.spends.has(input.keyImage), 'Duplicate or spent native key image');
      images.add(input.keyImage);
    }
    const scratch = stageState(this.#state);
    // addLots only copies these values; no candidate state/provenance is exposed.
    applyRecord(scratch, tx, decoded, this.#manifest, this.#id, this.#state.height + 1n,
      tx.outputs.map(() => null));
    return {record: structuredClone(decoded.record), context: decoded.context,
      checkpoint: {height: this.#state.height, blockHash: this.#state.blockHash},
      signatureHash: tx.signatureHash, extraHash: hash(tx.extra).toString('hex')};
  }
  applyBlock(block) {
    need(!this.#applying, 'Native block admission already in progress');
    this.#applying = true;
    try {const work=this.#stageBlock(block);let step=work.next();while(!step.done)step=work.next(true);return step.value;}
    finally {this.#applying=false;}
  }
  // Trusted composed replay only. Await external authorization OUTSIDE the
  // invalid-overlay catch: an unavailable verifier aborts the whole block.
  // No state is committed until all callbacks and observations finish.
  async applyBlockWithPolicy(block,{beforeTransaction,authorizeRecord,afterTransaction}) {
    need(!this.#applying, 'Native block admission already in progress');
    need([beforeTransaction,authorizeRecord,afterTransaction].every(f=>typeof f==='function'),'Complete ordered native admission policy required');
    this.#applying=true;
    const work=this.#stageBlock(block);
    try {
      let step=work.next();
      while(!step.done){const e=step.value;let allowed=true;
        if(e.phase==='before')await beforeTransaction(e);
        else if(e.phase==='authorize'){allowed=await authorizeRecord(e);need(typeof allowed==='boolean','Exact record policy decision required');}
        else await afterTransaction(e);
        step=work.next(allowed);
      }
      return step.value;
    } finally {work.return();this.#applying=false;}
  }
  *#stageBlock(block) {
    exact(block, ['height', 'hash', 'parent', 'transactions']);
    need(typeof block.height === 'bigint' && block.height === this.#state.height + 1n && block.parent === this.#state.blockHash,
      'Noncontiguous block; rewind before replay');
    uint(block.height, 8); hex(block.hash); hex(block.parent);
    need(block.hash !== block.parent && Array.isArray(block.transactions) && block.transactions.length <= 10000, 'Invalid block');
    const next = stageState(this.#state), results = [];
    for (const [index,observation] of block.transactions.entries()) {
      exact(observation, ['bytes', 'outputIndices']);
      const tx = inspectNativeObservation(bytes(observation.bytes));
      need(!next.transactions.has(tx.txid), 'Repeated native transaction');
      const indices = observation.outputIndices;
      need(Array.isArray(indices) && indices.length === tx.outputs.length, 'Output indices missing');
      ordered(indices, x => x, 'Native output indices');
      indices.forEach(i => { need(typeof i === 'bigint', 'Exact output index required'); uint(i, 8); need(!next.outputIndices.has(i), 'Reused output index'); });
      const images = new Set();
      tx.inputs.forEach(i => {
        publicPoint(i.keyImage);
        need(!images.has(i.keyImage) && !next.spends.has(i.keyImage), 'Duplicate native key image'); images.add(i.keyImage);
      });
      yield {phase:'before',index,txid:tx.txid};
      let result = {txid: tx.txid, status: 'no-record'};
      let carrier,decoded;
      try {carrier=inspectCarrier(tx.data);decoded=decodeCarrier(carrier);}
      catch(error){result={txid:tx.txid,status:'rejected',reason:error.message};}
      const allowed=decoded?yield {phase:'authorize',index,tx:carrier,decoded}:true;
      try {
        if (decoded) {
          need(allowed===true,'Native record rejected by backing policy');
          applyRecord(next, tx, decoded, this.#manifest, this.#id, block.height, indices);
          result = {txid: tx.txid, status: 'accepted', op: decoded.record.op, recordId: decoded.recordId};
        }
      } catch (error) { result = {txid: tx.txid, status: 'rejected', reason: error.message}; }
      tx.inputs.forEach((input, vin) => next.spends.set(input.keyImage, {txid: tx.txid, vin, height: block.height}));
      next.transactions.set(tx.txid, block.height);
      indices.forEach((index, vout) => next.outputIndices.set(index, outpointKey({txid: tx.txid, vout})));
      results.push(result);
      yield {phase:'after',index,tx:carrier,decoded,result};
    }
    const prior = this.#state;
    const frame = {height: prior.height, blockHash: prior.blockHash, issued: prior.issued, burned: prior.burned,
      undo: Object.fromEntries(MAPS.map(name => [name, [...next[name].updates.keys()].map(key =>
        [key, prior[name].has(key), prior[name].get(key)])]))};
    // All fallible parsing, cryptography and policy checks finished above.
    // Publish the staged map changes in one synchronous admission boundary.
    for (const name of MAPS) for (const [key, value] of next[name].updates) prior[name].set(key, value);
    this.#history.push(frame);
    if (this.#history.length > this.#historyLimit) this.#history.shift();
    this.#state = {...prior, issued: next.issued, burned: next.burned, height: block.height, blockHash: block.hash};
    this.#stateHash = null;
    return results;
  }
  rewind(height, blockHash) {
    need(!this.#applying, 'Native block admission already in progress');
    need(typeof height === 'bigint' && height >= this.#manifest.height && height <= this.#state.height, 'Invalid rewind height');
    need(height >= this.#restoreBase, 'Ancestor precedes restored checkpoint; rebuild required');
    const candidate = height === this.#state.height ? this.#state : this.#history.find(s => s.height === height);
    need(candidate && candidate.blockHash === blockHash, 'Unknown ancestor; rebuild required');
    if (this.#state.height > height) this.#stateHash = null;
    while (this.#state.height > height) undoBlock(this.#state, this.#history.pop());
  }
  displaySnapshot() {
    // Empty until enough history beyond the activation checkpoint exists.
    const target = this.#state.height - BigInt(this.#manifest.depth) + 1n;
    if (target < this.#manifest.height) return null;
    if (target === this.#state.height) return this.snapshot();
    if (!this.#history.some(s => s.height === target)) return null;
    const state = {...this.#state, ...Object.fromEntries(MAPS.map(name => [name, new Map(this.#state[name])]))};
    for (let i = this.#history.length - 1; state.height > target; i--) undoBlock(state, this.#history[i]);
    return structuredClone(state);
  }
}
