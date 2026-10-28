// Local XN1 S1 profile. No network, wallet or production activation code.
import {Buffer} from 'buffer';
import {sha256} from '@noble/hashes/sha256';

export function need(condition, message) {
  if (!condition) throw new Error(message);
}
export function bytes(value, size) {
  need(value instanceof Uint8Array, 'Byte array required');
  need(size === undefined || value.length === size, `Expected ${size} bytes`);
  return Buffer.from(value);
}
export function hex(value, size = 32) {
  need(typeof value === 'string' && new RegExp(`^[0-9a-f]{${size * 2}}$`).test(value), 'Canonical hex required');
  return Buffer.from(value, 'hex');
}
export function uint(value, width) {
  need(typeof value === 'bigint' || Number.isSafeInteger(value), 'Exact integer required');
  let n = BigInt(value);
  need(n >= 0n && n < (1n << BigInt(width * 8)), 'Integer out of range');
  const result = Buffer.alloc(width);
  for (let i = 0; i < width; i++, n >>= 8n) result[i] = Number(n & 255n);
  return result;
}
export function le(value) {
  return [...value].reverse().reduce((n, b) => (n << 8n) | BigInt(b), 0n);
}
export const join = (...values) => Buffer.concat(values);
export const hash = (...values) => Buffer.from(sha256(join(...values)));
export const domain = name => Buffer.from(`${name}\0`, 'ascii');
export const ZERO32 = Buffer.alloc(32);
export function exact(object, fields) {
  need(object && Object.getPrototypeOf(object) === Object.prototype &&
    Object.keys(object).sort().join(',') === fields.slice().sort().join(','), 'Exact record fields required');
}
export function ordered(values, key, label) {
  for (let i = 1; i < values.length; i++) need(key(values[i - 1]) < key(values[i]), `${label} must be sorted and unique`);
}
export class Reader {
  constructor(data) { this.data = bytes(data); this.at = 0; }
  take(n) {
    need(Number.isSafeInteger(n) && n >= 0 && this.at + n <= this.data.length, 'Truncated bytes');
    const result = this.data.subarray(this.at, this.at + n);
    this.at += n;
    return result;
  }
  u(width) { const n = le(this.take(width)); return width === 8 ? n : Number(n); }
  hex(n = 32) { return this.take(n).toString('hex'); }
  done() { need(this.at === this.data.length, 'Trailing bytes'); }
  varint(limit = (1n << 64n) - 1n) {
    let n = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.u(1);
      n |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) {
        need(n <= limit && (!i || b !== 0), 'Noncanonical or excessive varint');
        return n;
      }
    }
    throw new Error('Excessive varint');
  }
}
export function varint(value) {
  let n = le(uint(value, 8));
  const out = [];
  do { const b = Number(n & 127n); n >>= 7n; out.push(b | (n ? 128 : 0)); } while (n);
  return Buffer.from(out);
}
