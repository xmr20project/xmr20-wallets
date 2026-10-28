import {Buffer} from 'buffer';
import {bytes, domain, exact, hash, hex, join, need, ordered, Reader, uint} from './bytes.mjs';

// Deliberately not a production profile. No production manifest is shipped.
export const LOCAL_PROFILE = 0xff02;
// Separately identified successor: cap means outstanding token units, permitting
// burn/bridge-out followed by a new backed deposit. S2's lifetime cap is unchanged.
export const CIRCULATING_PROFILE = 0xff03;
// New, unactivated profile. Offline recipients need not publish a key image
// until spending or listing; a native ownership proof is mandatory then.
export const OFFLINE_RECEIVER_PROFILE = 0xff04;
// S5 preserves S4 receiving/transfer rules. CREDIT.epoch is the inclusive
// creation deadline (Monero height); created tokens themselves never expire.
// This separate manifest profile leaves all earlier protocol bytes unchanged.
export const EXPIRING_CREDIT_PROFILE = 0xff05;
export const offlineRecipients = profile => [OFFLINE_RECEIVER_PROFILE,EXPIRING_CREDIT_PROFILE].includes(profile);
export const circulatingSupply = profile => profile===CIRCULATING_PROFILE||offlineRecipients(profile);
export const validCreditEpoch = (manifest,epoch) => manifest.profile===EXPIRING_CREDIT_PROFILE
  ? Number.isSafeInteger(epoch)&&BigInt(epoch)>manifest.height&&epoch<8000000 : epoch===0;
export const MAX_RECORD = 960;
const MAGIC = Buffer.from('XN1');
const OPS = {CREDIT: 1, MOVE: 2, BURN: 3};
const NAMES = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));
const common = ['op', 'manifest'];
const fields = {
  CREDIT: [...common, 'issuance', 'lock', 'epoch', 'vout', 'amount', 'image', 'c', 's', 'signatures'],
  MOVE: [...common, 'claims', 'allocations'],
  BURN: [...common, 'claims', 'amount', 'redemption', 'recipient', 'allocations'],
};
const positive = n => { need(typeof n === 'bigint' && n > 0n, 'Positive bigint amount required'); return uint(n, 8); };
export const outpointKey = o => join(hex(o.txid), uint(o.vout, 4)).toString('hex');

export function encodeManifest(m) {
  exact(m, ['genesis', 'asset', 'height', 'blockHash', 'decimals', 'cap', 'depth', 'profile',
    'issuerScheme', 'threshold', 'issuers', 'recovery', 'identity', 'bridgeDomain']);
  need([LOCAL_PROFILE,CIRCULATING_PROFILE,OFFLINE_RECEIVER_PROFILE,EXPIRING_CREDIT_PROFILE].includes(m.profile) && m.issuerScheme === 1 && m.recovery === 0 && m.identity === (offlineRecipients(m.profile)?0xfc:0xfd),
    'Only local Ed25519/no-recovery/recipient-proof profile is implemented');
  need(Array.isArray(m.issuers) && m.issuers.length > 0 && m.issuers.length <= 8 &&
    Number.isInteger(m.threshold) && m.threshold > 0 && m.threshold <= m.issuers.length, 'Invalid issuer threshold');
  ordered(m.issuers, x => x, 'Issuer keys');
  need(m.decimals >= 0 && m.decimals <= 18 && m.depth >= 1, 'Invalid precision or depth');
  return join(domain('XN1-MANIFEST'), uint(2, 1), hex(m.genesis), hex(m.asset), uint(m.height, 8),
    hex(m.blockHash), uint(m.decimals, 1), positive(m.cap), uint(m.depth, 2), uint(m.profile, 2),
    uint(m.issuerScheme, 1), uint(m.threshold, 1), uint(m.issuers.length, 1), ...m.issuers.map(x => hex(x)),
    uint(m.recovery, 1), uint(m.identity, 1), hex(m.bridgeDomain));
}
export const manifestId = m => hash(encodeManifest(m)).toString('hex');
export function decodeManifest(data) {
  const r = new Reader(data);
  need(r.take(13).equals(domain('XN1-MANIFEST')) && r.u(1) === 2, 'Unknown manifest');
  const m = {genesis: r.hex(), asset: r.hex(), height: r.u(8), blockHash: r.hex(), decimals: r.u(1),
    cap: r.u(8), depth: r.u(2), profile: r.u(2), issuerScheme: r.u(1), threshold: r.u(1)};
  m.issuers = Array.from({length: r.u(1)}, () => r.hex());
  m.recovery = r.u(1); m.identity = r.u(1); m.bridgeDomain = r.hex();
  r.done(); encodeManifest(m); return m;
}
function encodeClaims(claims, zero) {
  need(Array.isArray(claims) && claims.length >= 1 && claims.length <= 8, 'Invalid claim count');
  ordered(claims, x => x.vin, 'Claims');
  const sources = new Set();
  return join(uint(claims.length, 1), ...claims.map(c => {
    exact(c, ['vin', 'ringPos', 'source', 'c', 's']); exact(c.source, ['txid', 'vout']);
    need(c.ringPos < 16, 'Unsupported ring position');
    const source = outpointKey(c.source);
    need(!sources.has(source), 'Duplicate source'); sources.add(source);
    // Even zeroing mode validates original field encodings first.
    const proof = join(hex(c.c), hex(c.s));
    return join(uint(c.vin, 2), uint(c.ringPos, 1), Buffer.from(source, 'hex'), zero ? Buffer.alloc(64) : proof);
  }));
}
function recipientProof(a, zero) {
  const proof = join(hex(a.c), hex(a.s));
  return join(hex(a.image), zero ? Buffer.alloc(64) : proof);
}
function encodeAllocations(allocations, allowEmpty, zero) {
  need(Array.isArray(allocations) && allocations.length <= 16 && (allowEmpty || allocations.length > 0), 'Invalid allocation count');
  ordered(allocations, x => x.vout, 'Allocations');
  return join(uint(allocations.length, 1), ...allocations.map(a => {
    exact(a, ['vout', 'amount', 'image', 'c', 's']); return join(uint(a.vout, 2), positive(a.amount), recipientProof(a, zero));
  }));
}
export function encodeRecord(record, {zeroProofs = false} = {}) {
  need(Object.hasOwn(fields, record?.op), 'Unsupported operation; RECOVER is disabled');
  exact(record, fields[record.op]);
  let body;
  if (record.op === 'CREDIT') {
    const sigs = record.signatures;
    need(Array.isArray(sigs) && sigs.length > 0 && sigs.length <= 8, 'Invalid signature count');
    ordered(sigs, x => x.signer, 'Signers');
    body = join(hex(record.issuance), hex(record.lock), uint(record.epoch, 4), uint(record.vout, 2),
      positive(record.amount), recipientProof(record, zeroProofs), uint(sigs.length, 1), ...sigs.map(s => {
        exact(s, ['signer', 'signature']); const sig = hex(s.signature, 64);
        return join(uint(s.signer, 1), zeroProofs ? Buffer.alloc(64) : sig);
      }));
  } else {
    body = join(encodeClaims(record.claims, zeroProofs), ...(record.op === 'BURN' ?
      [positive(record.amount), hex(record.redemption), hex(record.recipient)] : []),
    encodeAllocations(record.allocations, record.op === 'BURN', zeroProofs));
  }
  const result = join(MAGIC, uint(2, 1), uint(OPS[record.op], 1), uint(body.length, 2), hex(record.manifest), body);
  need(result.length <= MAX_RECORD, 'Record exceeds carrier budget'); return result;
}
export function decodeRecord(data) {
  const r = new Reader(data);
  need(r.data.length <= MAX_RECORD && r.take(3).equals(MAGIC) && r.u(1) === 2, 'Unknown record');
  const op = NAMES[r.u(1)]; need(op, 'Unsupported operation; RECOVER is disabled');
  const size = r.u(2); need(r.data.length === 39 + size, 'Wrong record length');
  const record = {op, manifest: r.hex()};
  if (op === 'CREDIT') {
    Object.assign(record, {issuance: r.hex(), lock: r.hex(), epoch: r.u(4), vout: r.u(2), amount: r.u(8), image: r.hex(), c: r.hex(), s: r.hex()});
    record.signatures = Array.from({length: r.u(1)}, () => ({signer: r.u(1), signature: r.hex(64)}));
  } else {
    record.claims = Array.from({length: r.u(1)}, () => ({vin: r.u(2), ringPos: r.u(1),
      source: {txid: r.hex(), vout: r.u(4)}, c: r.hex(), s: r.hex()}));
    if (op === 'BURN') Object.assign(record, {amount: r.u(8), redemption: r.hex(), recipient: r.hex()});
    record.allocations = Array.from({length: r.u(1)}, () => ({vout: r.u(2), amount: r.u(8), image: r.hex(), c: r.hex(), s: r.hex()}));
  }
  r.done(); need(encodeRecord(record).equals(bytes(data)), 'Noncanonical record'); return record;
}
