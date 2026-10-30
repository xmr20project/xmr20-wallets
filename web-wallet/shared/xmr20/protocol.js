// XMR20 bridge experiment. Integer base units, six decimals, one fixed supply.
export const SUPPLY = 1_000_000_000_000_000n;
export const TRANSFER_LIMIT = 50_000_000_000_000n;
export const CONFIRMATIONS = 10;
export const DOMAIN = 'MOUSE-ROAD-XMR20-STAGENET-BRIDGE-V1\n';
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function units(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) throw Error('Enter a token amount with at most 6 decimals.');
  const [whole, fraction = ''] = value.split('.');
  const raw = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (raw <= 0n || raw > TRANSFER_LIMIT) throw Error('Each transfer must be greater than zero and at most 50,000,000 tokens (5%).');
  return raw.toString();
}
export function rawAmount(value, limit = TRANSFER_LIMIT) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value) || BigInt(value) > limit) throw Error('Invalid token amount.');
  return BigInt(value);
}
export function displayAmount(raw = '0') {
  const n = BigInt(raw), fraction = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return (n / 1_000_000n).toLocaleString('en-US') + (fraction ? '.' + fraction : '');
}
export function ticker(value) {
  const s = String(value || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(s)) throw Error('Use a ticker of 1–10 letters or numbers, starting with a letter.');
  return s;
}
export function launchState(row) {
  if (row.halted) return 'Review required';
  if (row.solanaFinalized) return row.launchTiming==='quick'&&!(row.proofVerified&&row.confirmations>=CONFIRMATIONS)?'Live on Solana · inscription pending':'Launched';
  if (row.solanaSignature) return 'Launching on Solana';
  if (row.confirmations >= CONFIRMATIONS && row.proofVerified) return 'Inscribed';
  if (row.moneroTxid) return 'Inscribing';
  if (row.retryRequired) return 'Inscription retry required';
  if(row.feePolicy==='prepay-v1'&&!row.launchFee?.finalized)return row.launchFee?.signature?'Payment confirming':'Awaiting inscription fee';
  return 'Reserved';
}
export function bridgeState(row) {
  const labels = row.direction==='sol-to-xmr'
    ? {reserved:'Awaiting Solana approval',source_pending:'Confirming Solana lock',source_finalized:'Preparing Monero inscription',destination_pending:'Confirming Monero inscription'}
    : row.direction==='xmr-to-sol'
      ? {reserved:'Awaiting Monero authorization',source_pending:'Confirming Monero burn',source_finalized:'Awaiting Solana unlock approval',destination_pending:'Confirming Solana unlock'}
      : {};
  return ({...labels,complete:'Complete',halted:'Review required'})[row.state] || 'Review required';
}
