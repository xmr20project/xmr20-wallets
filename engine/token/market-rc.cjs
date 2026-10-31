// MONERO MARKET candidate (30 Oct 2026): browser copy of operations/nft-reader-wire-fix-20261006/build/rc.cjs (sha256 09c86637a10859e949a365156f618d6667ce6b609ad88af669e32ff2aa62fadd).
// Only change: finish() returns a Uint8Array instead of a Node Buffer. tests/codec-browser.test.mjs checks byte equality.
// Deterministic integer binary range coder (LZMA style) with bit-tree symbols.
// Shared by the encoder and the decoder; integer-only, no floating point.
'use strict';
const kTop = 1 << 24, kBits = 11, kOne = 1 << kBits, kShift = 4; // fast adaptation for tiny payloads

class Encoder {
  constructor() { this.low = 0; this.range = 0xFFFFFFFF; this.cache = 0; this.cacheSize = 1; this.out = []; }
  shiftLow() {
    if (this.low < 0xFF000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0;
      let temp = this.cache;
      do { this.out.push((temp + carry) & 0xFF); temp = 0xFF; } while (--this.cacheSize !== 0);
      this.cache = (this.low >>> 24) & 0xFF;
    }
    this.cacheSize++;
    this.low = (this.low & 0x00FFFFFF) * 256; // keep as Number, may exceed 2^32 to signal carry
  }
  encodeBit(probs, i, bit) {
    const p = probs[i];
    const bound = (this.range >>> kBits) * p;
    if (bit === 0) { this.range = bound; probs[i] = p + ((kOne - p) >> kShift); }
    else { this.low += bound; this.range -= bound; probs[i] = p - (p >> kShift); }
    while (this.range < kTop) { this.range = (this.range * 256) >>> 0; this.shiftLow(); }
  }
  encodeTree(probs, base, nbits, sym) {
    let m = 1;
    for (let i = nbits - 1; i >= 0; i--) { const bit = (sym >> i) & 1; this.encodeBit(probs, base + m, bit); m = (m << 1) | bit; }
  }
  finish() { for (let i = 0; i < 5; i++) this.shiftLow(); return Uint8Array.from(this.out); }
}

class Decoder {
  constructor(buf, pos = 0) {
    this.buf = buf; this.pos = pos; this.range = 0xFFFFFFFF; this.code = 0;
    for (let i = 0; i < 5; i++) this.code = ((this.code * 256) + this.next()) % 0x100000000;
  }
  next() { return this.pos < this.buf.length ? this.buf[this.pos++] : 0; }
  decodeBit(probs, i) {
    const p = probs[i];
    const bound = (this.range >>> kBits) * p; let bit;
    if (this.code < bound) { this.range = bound; probs[i] = p + ((kOne - p) >> kShift); bit = 0; }
    else { this.code -= bound; this.range -= bound; probs[i] = p - (p >> kShift); bit = 1; }
    while (this.range < kTop) { this.range = (this.range * 256) >>> 0; this.code = ((this.code * 256) + this.next()) % 0x100000000; }
    return bit;
  }
  decodeTree(probs, base, nbits) {
    let m = 1;
    for (let i = 0; i < nbits; i++) m = (m << 1) | this.decodeBit(probs, base + m);
    return m - (1 << nbits);
  }
}

function newProbs(n) { const a = new Uint16Array(n); a.fill(kOne >> 1); return a; }

module.exports = { Encoder, Decoder, newProbs };
