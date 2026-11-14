// SOL -> wXMR in the website wallet (10 Nov 2026), the way wxmr.io's "wXMR on Solana" swap does it: a Jupiter quote and swap
// for SOL -> wXMR. wxmr.io adds its own 0.5% fee; this asks Jupiter directly for the same route, with no extra fee. The connected Phantom or Solflare signs and sends; wXMR then sits in
// the wallet's wXMR row, whose Bridge turns it into native XMR through wxmr.io.
// Before the wallet is asked to sign, the quote must be exactly what was asked for (SOL in, wXMR out, the amount, exact-in, the
// slippage), and the transaction must be paid by this wallet and call only the programs a Jupiter SOL swap uses.
import {VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';

export const WSOL = 'So11111111111111111111111111111111111111112';
export const WXMR_MINT = 'WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp';
export const JUPITER_API = 'https://api.jup.ag/swap/v1';
export const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const SLIPPAGE_BPS = 50;
// Kept back by Max: the wXMR account's rent the first time (about 0.00204 SOL), the temporary wrapped-SOL account (returned at the
// end), the network fee and a priority fee of at most 0.001 SOL.
export const RESERVE_LAMPORTS = 5_000_000n;
export const MIN_LAMPORTS = 1_000_000n;            // 0.001 SOL
// The other way (11 Nov 2026), wXMR -> SOL: the same Jupiter route reversed. direction is 'sol-wxmr' or 'wxmr-sol'.
export const MIN_WXMR_RAW = 10_000_000n;           // 0.00001 wXMR
export const WXMR_SOL_FEE_LAMPORTS = 3_000_000n;   // SOL this wallet needs for the network fee and the temporary SOL account
const PAIR = {'sol-wxmr': [WSOL, WXMR_MINT], 'wxmr-sol': [WXMR_MINT, WSOL]};
export const MAX_PRIORITY_LAMPORTS = 1_000_000;
const PROGRAMS = new Set([
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  JUPITER_PROGRAM,
]);
const need = (ok, message) => { if (!ok) throw Error(message); };
const digits = v => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);

// "0.25" -> 250000000n; null when it is not an amount of SOL (at most 9 decimals).
export function parseSol(text) {
  const t = String(text ?? '').trim().replace(/,/g, '');
  if (!/^(0|[1-9][0-9]*)?(\.[0-9]{0,9})?$/.test(t) || t === '' || t === '.') return null;
  const [w, f = ''] = t.split('.');
  return BigInt(w || '0') * 1_000_000_000n + BigInt(f.padEnd(9, '0'));
}
export const solText = lamports => { const n = BigInt(lamports), f = String(n % 1_000_000_000n).padStart(9, '0').replace(/0+$/, ''); return String(n / 1_000_000_000n) + (f ? '.' + f : ''); };
// "0.05" -> 50000000000n; null when it is not an amount of wXMR (at most 12 decimals).
export function parseWxmr(text) {
  const t = String(text ?? '').trim().replace(/,/g, '');
  if (!/^(0|[1-9][0-9]*)?(\.[0-9]{0,12})?$/.test(t) || t === '' || t === '.') return null;
  const [w, f = ''] = t.split('.');
  return BigInt(w || '0') * 10n ** 12n + BigInt(f.padEnd(12, '0'));
}
export const wxmrText = (raw, places = 6) => { const n = BigInt(raw), f = String(n % 10n ** 12n).padStart(12, '0').slice(0, places).replace(/0+$/, ''); return String(n / 10n ** 12n) + (f ? '.' + f : ''); };
export const maxSwapLamports = balance => { const b = BigInt(balance ?? 0); return b > RESERVE_LAMPORTS ? b - RESERVE_LAMPORTS : 0n; };

export function checkQuote(q, lamports, direction = 'sol-wxmr') {
  need(q && typeof q === 'object', 'No quote from Jupiter. Try again.');
  need(PAIR[direction] && q.inputMint === PAIR[direction][0] && q.outputMint === PAIR[direction][1], 'Jupiter quoted another pair. Nothing was signed.');
  need(q.swapMode === 'ExactIn' && q.inAmount === String(lamports), 'Jupiter quoted another amount. Nothing was signed.');
  need(digits(q.outAmount) && digits(q.otherAmountThreshold) && BigInt(q.otherAmountThreshold) > 0n && BigInt(q.otherAmountThreshold) <= BigInt(q.outAmount),
    'Jupiter returned an unusable quote. Try again.');
  need(q.slippageBps === SLIPPAGE_BPS, 'Jupiter quoted another slippage. Nothing was signed.');
  need(Array.isArray(q.routePlan) && q.routePlan.length > 0, 'Jupiter found no route. Try another amount.');
  return q;
}
export const quoteSolToWxmr = (lamports, options) => quoteSwap(lamports, 'sol-wxmr', options);
export async function quoteSwap(raw, direction, {fetcher = globalThis.fetch} = {}) {
  const amount = BigInt(raw);
  need(PAIR[direction], 'Unknown swap direction.');
  if (direction === 'sol-wxmr') need(amount >= MIN_LAMPORTS, 'Swap at least 0.001 SOL.'); else need(amount >= MIN_WXMR_RAW, 'Swap at least 0.00001 wXMR.');
  const url = `${JUPITER_API}/quote?inputMint=${PAIR[direction][0]}&outputMint=${PAIR[direction][1]}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&swapMode=ExactIn&restrictIntermediateTokens=true`;
  const r = await fetcher(url);
  const q = await r.json().catch(() => null);
  need(r.status !== 429, 'Jupiter is busy. Try again in a few seconds.');
  need(r.ok, q?.error || 'Jupiter has no quote right now. Try again.');
  return checkQuote(q, amount, direction);
}

// The unsigned transaction Jupiter built: paid and signed by this wallet only, and every top-level instruction one of the programs
// a Jupiter SOL swap uses (compute budget, wrapping SOL, the wXMR account, one Jupiter route). Programs cannot come from lookup
// tables, so they are all among the transaction's own keys.
export function checkSwapTransaction(tx, owner) {
  const m = tx.message, keys = m.staticAccountKeys.map(k => k.toBase58());
  need(keys[0] === owner && m.header.numRequiredSignatures === 1, 'The swap is not paid by this wallet. Nothing was signed.');
  let routes = 0;
  for (const ix of m.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    need(program !== undefined && PROGRAMS.has(program), 'The swap calls an unexpected program. Nothing was signed.');
    if (program === JUPITER_PROGRAM) routes++;
  }
  need(routes === 1, 'The swap must have exactly one Jupiter route. Nothing was signed.');
  return tx;
}
export async function buildSolToWxmrSwap(quote, owner, {fetcher = globalThis.fetch} = {}) {
  const r = await fetcher(`${JUPITER_API}/swap`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({
    quoteResponse: quote, userPublicKey: owner, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {priorityLevelWithMaxLamports: {maxLamports: MAX_PRIORITY_LAMPORTS, priorityLevel: 'high'}},
  })});
  const j = await r.json().catch(() => null);
  need(r.status !== 429, 'Jupiter is busy. Try again in a few seconds.');
  need(r.ok && typeof j?.swapTransaction === 'string', j?.error || 'Jupiter could not build the swap. Try again.');
  const tx = VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, 'base64'));
  return {tx: checkSwapTransaction(tx, owner), lastValidBlockHeight: j.lastValidBlockHeight};
}
