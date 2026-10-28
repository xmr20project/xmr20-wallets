// Public-data verification only. BigInt operations are NOT suitable for secret
// wallet signing. No secret-key/proof-generation API is exported here.
import {Buffer} from 'buffer';
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {domain, hash, hex, join, le, need, uint} from './bytes.mjs';
import {outpointKey,validCreditEpoch} from './records.mjs';

const Point = ed25519.ExtendedPoint;
const P = (1n << 255n) - 19n;
export const ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
const mod = x => ((x % P) + P) % P;
function pow(x, e) {
  let y = 1n; x = mod(x);
  for (; e > 0n; e >>= 1n, x = mod(x * x)) if (e & 1n) y = mod(y * x);
  return y;
}
export function publicPoint(value) {
  const raw = hex(value);
  const p = Point.fromHex(raw, false);
  need(Buffer.from(p.toRawBytes()).equals(raw) && !p.isSmallOrder() && p.isTorsionFree(), 'Invalid prime-order point');
  return p;
}
// Legacy Monero biased_hash_to_ec, same field map as monero-oxide Point::biased_hash.
// Verified against the pinned upstream Monero tests; not RFC9380 hash-to-curve.
export function legacyHashToPoint(value) {
  const r = le(keccak_256(hex(value))) % P;
  const u0 = mod(-486662n * pow(1n + 2n * r * r, P - 2n));
  const g = mod(u0 * u0 * u0 + 486662n * u0 * u0 + u0);
  const square = pow(g, (P - 1n) / 2n) !== P - 1n;
  const u = square ? u0 : mod(-u0 - 486662n);
  need(mod(u + 1n) !== 0n, 'Exceptional hash-to-point input');
  const y = mod((u - 1n) * pow(u + 1n, P - 2n));
  const encoded = uint(y, 32); if (square) encoded[31] |= 128;
  return Point.fromHex(encoded, false).multiply(8n);
}
export function claimMessage(manifest, context, claim, outputKey, keyImage, op) {
  need(op === 'MOVE' || op === 'BURN', 'Invalid claim domain');
  return hash(domain(`XN1-LOCAL-S2-${op}-CLAIM`), hex(manifest), hex(context),
    uint(claim.vin, 2), uint(claim.ringPos, 1), Buffer.from(outpointKey(claim.source), 'hex'), hex(outputKey), hex(keyImage));
}
export function claimChallenge(message, outputKey, keyImage, a, b) {
  return le(hash(domain('XN1-LOCAL-S2-DLEQ'), message, hex(outputKey), hex(keyImage),
    Buffer.from(a.toRawBytes()), Buffer.from(b.toRawBytes()))) % ORDER;
}
export function verifyClaim({manifest, context, claim, outputKey, keyImage, op}) {
  return verifyRelation(claimMessage(manifest, context, claim, outputKey, keyImage, op), claim, outputKey, keyImage);
}
export function recipientMessage(manifest, context, allocation, outputKey) {
  return hash(domain('XN1-LOCAL-S2-RECEIVE'), hex(manifest), hex(context), uint(allocation.vout, 2),
    uint(allocation.amount, 8), hex(outputKey), hex(allocation.image));
}
export function verifyRecipient({manifest, context, allocation, outputKey}) {
  return verifyRelation(recipientMessage(manifest, context, allocation, outputKey), allocation, outputKey, allocation.image);
}
function verifyRelation(message, proof, outputKey, keyImage) {
  try {
    const p = publicPoint(outputKey), image = publicPoint(keyImage);
    const c = le(hex(proof.c)), s = le(hex(proof.s));
    need(c < ORDER && s < ORDER, 'Noncanonical proof scalar');
    const hp = legacyHashToPoint(outputKey);
    const a = Point.BASE.multiplyUnsafe(s).add(p.multiplyUnsafe(c));
    const b = hp.multiplyUnsafe(s).add(image.multiplyUnsafe(c));
    return c === claimChallenge(message, outputKey, keyImage, a, b);
  } catch { return false; }
}
export function creditMessage(record, context, outputKey) {
  return join(domain('XN1-LOCAL-S2-CREDIT'), hex(record.manifest), hex(context), hex(record.issuance),
    hex(record.lock), uint(record.epoch, 4), uint(record.vout, 2), uint(record.amount, 8), hex(outputKey));
}
export function verifyCredit(record, context, outputKey, manifest) {
  if (!validCreditEpoch(manifest,record.epoch) || record.signatures.length < manifest.threshold) return false;
  const message = creditMessage(record, context, outputKey);
  return record.signatures.every(s => {
    try {
      const issuer = manifest.issuers[s.signer]; publicPoint(issuer);
      return ed25519.verify(hex(s.signature, 64), message, hex(issuer), {zip215: false});
    } catch { return false; }
  });
}
