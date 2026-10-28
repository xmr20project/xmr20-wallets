// A new identity domain. Old token-scoped signatures never authorize universal linking.
import {PublicKey} from '@solana/web3.js';
import {canonical, digest, moneroOwner, hashId} from '../core-next/records.mjs';
export {canonical, digest};
export const DOMAIN = 'XMR20-WALLET-IDENTITY-MAINNET-V1\n';
export const MAGIC = Buffer.from('XMR20I1');
const fields = ['p','v','net','op','owner','to','registry','verifier','nonce'];
const need = (value, message) => { if (!value) throw Error(message); };
export function validateRecord(record) {
  need(record && Object.getPrototypeOf(record) === Object.prototype
    && Object.keys(record).sort().join(',') === [...fields].sort().join(','), 'Exact identity fields required; no token or financial permission.');
  need(record.p === 'xmr20-identity' && record.v === 1 && record.net === 'mainnet'
    && record.op === 'link' && hashId(record.nonce), 'Wrong identity domain or nonce.');
  moneroOwner(record.owner);
  for (const name of ['to','registry','verifier']) {
    need(typeof record[name] === 'string' && new PublicKey(record[name]).toBase58() === record[name], 'Canonical Solana key required.');
  }
  need(PublicKey.isOnCurve(new PublicKey(record.to).toBytes()) && record.to !== record.verifier
    && record.verifier !== PublicKey.default.toBase58(), 'Distinct identity owner/verifier required.');
  return record;
}
export function message(record) { return DOMAIN + canonical(validateRecord(record)); }
export function payload(envelope) {
  need(envelope && Object.getPrototypeOf(envelope) === Object.prototype
    && Object.keys(envelope).sort().join(',') === 'record,signature'
    && typeof envelope.signature === 'string' && /^SigV2[1-9A-HJ-NP-Za-km-z]{80,110}$/.test(envelope.signature), 'Exact signed identity envelope required.');
  validateRecord(envelope.record);
  const bytes = Buffer.concat([MAGIC, Buffer.from(canonical(envelope))]);
  need(bytes.length <= 960, 'Identity carrier payload too large.');
  return bytes;
}
export function commitment(envelope) { payload(envelope); return digest(canonical(envelope)); }
export function decodePayload(bytes) {
  const value = Buffer.from(bytes);
  need(value.length <= 960 && value.subarray(0, MAGIC.length).equals(MAGIC), 'Wrong identity carrier domain.');
  const envelope = JSON.parse(value.subarray(MAGIC.length).toString('utf8'));
  need(payload(envelope).equals(value), 'Noncanonical identity payload.');
  return envelope;
}
