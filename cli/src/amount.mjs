import {need} from './errors.mjs';
// First block of the XMR20 ledger (28 Sep 2026): a wallet imported without a known height scans from here.
export const XMR20_MONERO_START=3772610;
// The extension's and xmr20.org's limit for one XMR send's network fee: 0.0001 XMR.
export const MAX_XMR_FEE=100000000n;
// Checks a typed amount. With decimals it returns the exact amount in atomic units (XMR has 12 decimals); token amounts are
// passed to the engine as typed (it converts them with the token's own decimals).
export function checkAmount(text,decimals=null){
 need(typeof text==='string'&&/^(0|[1-9][0-9]{0,18})(\.[0-9]{1,12})?$/.test(text.trim()),'Enter the amount as a plain number, for example 0.5 or 10.');
 if(decimals==null)return text.trim();
 const [whole,fraction='']=text.trim().split('.');need(fraction.length<=decimals,`Use at most ${decimals} decimal places.`);
 const raw=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0'));need(raw>0n,'Enter an amount greater than zero.');return String(raw);
}
export function formatUnits(raw,decimals=6){if(raw==null)return '—';const n=BigInt(raw),base=10n**BigInt(decimals),f=(n%base).toString().padStart(decimals,'0').replace(/0+$/,'');return (n/base).toLocaleString('en-US')+(f?'.'+f:'');}
