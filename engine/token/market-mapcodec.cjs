// MONERO MARKET candidate (30 Oct 2026): browser copy of operations/nft-reader-wire-fix-20261006/build/mapcodec.cjs (sha256 6d23798b8a5a2f9007d4c0069d45195f23564a7d6330e73667369fa27d373fef).
// Only change: it requires the browser range coder (market-rc.cjs). tests/codec-browser.test.mjs checks byte equality.
// Context-modelled palette-index map coder (integer range coder, deterministic).
// mode 0: symbol coded with bit-tree under context = left neighbour.
// mode 3: "same as left?" bit (ctx: was previous cell same-as-left, and does up==left),
//         else "same as up?" bit, else symbol bit-tree under context = left.
'use strict';
const { Encoder, Decoder, newProbs } = require('./market-rc.cjs');

function makeModel(n, mode) {
  const nbits = Math.log2(n) | 0;
  return { n, nbits, mode, probs: newProbs((n + 1) * (1 << nbits) + 64) };
}
function neigh(idx, i, w, n) {
  const x = i % w, y = (i / w) | 0;
  return [x ? idx[i - 1] : n, y ? idx[i - w] : n, (x && y) ? idx[i - w - 1] : n];
}
function encodeMap(idx, w, h, n, mode = 3) {
  const M = makeModel(n, mode), enc = new Encoder(), base = (n + 1) * (1 << M.nbits);
  let prevSame = 0;
  for (let i = 0; i < w * h; i++) {
    const [L, U, UL] = neigh(idx, i, w, n), v = idx[i];
    if (mode === 0) { enc.encodeTree(M.probs, L << M.nbits, M.nbits, v); continue; }
    const c1 = base + prevSame * 4 + (U === L ? 1 : 0) + (UL === L ? 2 : 0);
    const sameL = (L !== n && v === L) ? 1 : 0;
    enc.encodeBit(M.probs, c1, sameL ^ 1); prevSame = sameL;
    if (sameL) continue;
    if (U !== n && U !== L) {
      const sameU = v === U ? 1 : 0; enc.encodeBit(M.probs, base + 8 + (UL === U ? 1 : 0), sameU ^ 1);
      if (sameU) continue;
    }
    enc.encodeTree(M.probs, L << M.nbits, M.nbits, v);
  }
  return enc.finish();
}
function decodeMap(buf, pos, w, h, n, mode = 3) {
  const M = makeModel(n, mode), dec = new Decoder(buf, pos), base = (n + 1) * (1 << M.nbits), idx = new Uint8Array(w * h);
  let prevSame = 0;
  for (let i = 0; i < w * h; i++) {
    const [L, U, UL] = neigh(idx, i, w, n);
    if (mode === 0) { idx[i] = dec.decodeTree(M.probs, L << M.nbits, M.nbits); continue; }
    const c1 = base + prevSame * 4 + (U === L ? 1 : 0) + (UL === L ? 2 : 0);
    const sameL = dec.decodeBit(M.probs, c1) ^ 1; prevSame = sameL;
    if (sameL) { if (L === n) throw new Error('invalid map stream'); idx[i] = L; continue; }
    if (U !== n && U !== L) {
      const sameU = dec.decodeBit(M.probs, base + 8 + (UL === U ? 1 : 0)) ^ 1;
      if (sameU) { idx[i] = U; continue; }
    }
    const v = dec.decodeTree(M.probs, L << M.nbits, M.nbits);
    if (v === L || (U !== n && U !== L && v === U)) throw new Error('non-canonical map stream');
    idx[i] = v;
  }
  return { idx, end: dec.pos };
}
module.exports = { encodeMap, decodeMap };
