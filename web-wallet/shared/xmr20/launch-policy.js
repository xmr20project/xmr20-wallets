// The inscription service fee is separate from the 2% trading fee.
export const LAUNCH_FEE_LAMPORTS = 10_000_000n;
export const LAUNCH_TREASURY = '9vZiiEC6Gryxih4U3peuWGvAsFE4kkX3VFyjw4tgbmuS';
// Conservative launch rent/network ceiling plus the guarded swap's 0.005 SOL reserve.
export const LAUNCH_RESERVE_LAMPORTS = 105_000_000n;
export function solLamports(value) {
  if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,9})?$/.test(value))throw Error('Enter a SOL amount with at most 9 decimal places.');
  const [whole,part='']=value.split('.');return BigInt(whole)*1_000_000_000n+BigInt(part.padEnd(9,'0'));
}
export function solText(n) {n=BigInt(n);return `${n/1_000_000_000n}.${String(n%1_000_000_000n).padStart(9,'0')}`.replace(/\.?0+$/,'')||'0';}
export function spendableSol(balance,percent=100) {
  if(!/^(0|[1-9][0-9]*)$/.test(String(balance))||![25,50,75,100].includes(percent))throw Error('SOL balance unavailable.');
  const remaining=BigInt(balance)-LAUNCH_FEE_LAMPORTS-LAUNCH_RESERVE_LAMPORTS;
  return solText((remaining>0n?remaining:0n)*BigInt(percent)/100n);
}
