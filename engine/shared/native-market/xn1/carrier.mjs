// Structural decoding is not Monero consensus validation. Callers must obtain
// complete, canonical native transactions/output indices from a validating node.
import {Buffer} from 'buffer';
import {keccak_256} from '@noble/hashes/sha3';
import {bytes, domain, hash, hex, join, need, Reader, uint, varint} from './bytes.mjs';
import {decodeRecord, encodeRecord, MAX_RECORD} from './records.mjs';

const MARKER = Buffer.from([0x7f, 0x58, 0x4e, 0x31]);
const RAW_MARKER = Buffer.from('XN1');
export function framePayload(payload) {
  const p = bytes(payload);
  need(p.length > 0 && p.length <= MAX_RECORD, 'Invalid payload size');
  const count = Math.ceil(p.length / 240), parts = [];
  for (let i = 0; i < count; i++) {
    const content = join(MARKER, uint(i, 1), uint(count, 1), p.subarray(i * 240, (i + 1) * 240));
    parts.push(Buffer.from([2]), varint(content.length), content);
  }
  return join(...parts);
}
export function extractPayload(extra) {
  const r = new Reader(extra); need(r.data.length <= 1060, 'Local relay extra budget exceeded');
  const chunks = [];
  while (r.at < r.data.length) {
    const tag = r.u(1);
    if (tag === 0) {
      need(r.take(r.data.length - r.at).every(x => x === 0), 'Invalid extra padding');
    } else if (tag === 1) r.take(32);
    else if (tag === 4) r.take(32 * Number(r.varint(16n)));
    else if (tag === 2) {
      const length = Number(r.varint(255n)), start = r.at, content = r.take(length);
      need(!content.subarray(0, 3).equals(RAW_MARKER), 'Raw XN1 framing is not supported');
      if (content.subarray(0, 4).equals(MARKER)) chunks.push({content, start});
    } else throw new Error('Unknown extra tag in local profile');
  }
  if (!chunks.length) return null;
  const count = chunks[0].content[5];
  need(count >= 1 && count <= 4 && chunks.length === count && chunks.every(({content: c}, i) =>
    c.length > 6 && c.length <= 246 && c[4] === i && c[5] === count && (i === count - 1 || c.length === 246)),
  'Invalid XN1 fragments');
  return {payload: join(...chunks.map(c => c.content.subarray(6))), chunks};
}
export function inspectCarrier(blob) {
  const data = bytes(blob); need(data.length > 0 && data.length <= 2_000_000, 'Invalid carrier size');
  const r = new Reader(data);
  need(r.varint() === 2n && r.varint() === 0n, 'Only unlocked Monero v2 is supported');
  const inputCount = Number(r.varint(128n)); need(inputCount > 0, 'Inputs missing');
  const inputs = [];
  for (let i = 0; i < inputCount; i++) {
    need(r.u(1) === 2 && r.varint() === 0n && r.varint(16n) === 16n, 'Only 16-member RingCT inputs supported');
    let index = 0n;
    const offsets = Array.from({length: 16}, (_, j) => {
      const delta = r.varint(); need(j === 0 || delta > 0n, 'Repeated ring member');
      index += delta; uint(index, 8); return index;
    });
    inputs.push({offsets, keyImage: r.hex()});
  }
  const outputCount = Number(r.varint(16n)); need(outputCount >= 2, 'At least two native outputs required');
  const outputs = Array.from({length: outputCount}, () => {
    need(r.varint() === 0n, 'Only confidential outputs supported');
    const tag = r.u(1); need(tag === 2 || tag === 3, 'Unsupported output type');
    return {key: r.hex(), viewTag: tag === 3 ? r.u(1) : null};
  });
  const extraLength = Number(r.varint(1060n)), extraStart = r.at, extra = r.take(extraLength);
  const prefixEnd = r.at;
  need(r.u(1) === 6, 'Only Bulletproof+ RingCT is supported');
  const fee = r.varint(); r.take(outputCount * 8);
  outputs.forEach(o => { o.commitment = r.hex(); });
  const baseEnd = r.at;
  // One aggregated range proof, as produced by the pinned wallet profile.
  need(r.varint(1n) === 1n, 'Only one aggregated range proof supported');
  const proofFixed = r.take(192);
  const rounds = Number(r.varint(10n));
  need(rounds === 6 + Math.ceil(Math.log2(outputCount)), 'Invalid range proof coverage');
  const proofL = r.take(rounds * 32); need(r.varint(10n) === BigInt(rounds), 'Mismatched range proof vectors');
  const proofR = r.take(rounds * 32);
  const proofEnd = r.at;
  r.take(inputCount * (16 * 32 + 64)); r.take(inputCount * 32); r.done();
  const txid = Buffer.from(keccak_256(join(keccak_256(data.subarray(0, prefixEnd)),
    keccak_256(data.subarray(prefixEnd, baseEnd)), keccak_256(data.subarray(baseEnd))))).toString('hex');
  // Monero's signing serialization omits the proof count and L/R lengths.
  // It also excludes CLSAGs/pseudo-outs, unlike the final transaction hash.
  const signatureHash = Buffer.from(keccak_256(join(keccak_256(data.subarray(0, prefixEnd)),
    keccak_256(data.subarray(prefixEnd, baseEnd)), keccak_256(join(proofFixed, proofL, proofR))))).toString('hex');
  return {txid, signatureHash, inputs, outputs, fee, extra: Buffer.from(extra), data,
    extraStart, prefixEnd, baseEnd, proofEnd};
}
export function decodeCarrier(inspected) {
  const framed = extractPayload(inspected.extra);
  if (!framed) return null;
  const record = decodeRecord(framed.payload), normalized = encodeRecord(record, {zeroProofs: true});
  const prefix = Buffer.from(inspected.data.subarray(0, inspected.prefixEnd));
  for (let i = 0; i < framed.chunks.length; i++) {
    normalized.subarray(i * 240, (i + 1) * 240).copy(prefix, inspected.extraStart + framed.chunks[i].start + 6);
  }
  const context = hash(domain('XN1-LOCAL-S2-CARRIER'), hex(record.manifest),
    prefix, inspected.data.subarray(inspected.prefixEnd, inspected.proofEnd)).toString('hex');
  const recordId = hash(domain('XN1-RECORD'), hex(record.manifest), hex(inspected.txid), framed.payload).toString('hex');
  return {record, context, recordId, payload: framed.payload};
}
