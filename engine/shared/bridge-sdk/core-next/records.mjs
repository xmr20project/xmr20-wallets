import {sha256} from '@noble/hashes/sha256';
import {PublicKey} from '@solana/web3.js';
import {checkMoneroAddress} from '../../address.js';
import {supportedMint} from './mint-policy.mjs';
export const CLAIM_DOMAIN='XMR20-JOINT-MAINNET-CLAIM-V2\n',BURN_DOMAIN='XMR20-JOINT-MAINNET-BURN-V2\n';
export const MAGIC=Buffer.from('XMR20J2');
const fields=['amount','mint','net','nonce','op','owner','p','position','program','solTx','to','v'];
export const digest=v=>Buffer.from(sha256(typeof v==='string'?new TextEncoder().encode(v):v)).toString('hex');
export const hashId=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)&&!/^0+$/.test(v);
export const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export function moneroOwner(address){if(checkMoneroAddress(address,'mainnet').kind!=='standard')throw Error('A standard public Monero address is required.');return address;}
export function validateRecord(r){
 if(!r||canonical(Object.keys(r).sort())!==canonical(fields)||r.p!=='xmr20-joint'||r.v!==2||r.net!=='mainnet'||!supportedMint(r.mint)||typeof r.solTx!=='string'||! /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(r.solTx)||!['claim','burn'].includes(r.op)||!hashId(r.nonce)||typeof r.amount!=='string'||! /^[1-9][0-9]{0,13}$/.test(r.amount)||BigInt(r.amount)>50_000_000_000_000n)throw Error('Invalid selected-mint joint claim record.');
 moneroOwner(r.owner);for(const k of ['position','to','program','mint']){const p=new PublicKey(r[k]);if(p.toBase58()!==r[k]||k==='to'&&!PublicKey.isOnCurve(p.toBytes()))throw Error('Invalid joint claim destination.');}return r;
}
export function message(r){validateRecord(r);return (r.op==='claim'?CLAIM_DOMAIN:BURN_DOMAIN)+canonical(r);}
export function payload(envelope){
 if(!envelope||canonical(Object.keys(envelope).sort())!==canonical(['record','signature'])||typeof envelope.signature!=='string'||!/^SigV2[1-9A-HJ-NP-Za-km-z]{80,110}$/.test(envelope.signature))throw Error('Invalid joint claim envelope.');validateRecord(envelope.record);
 const b=Buffer.concat([MAGIC,Buffer.from(canonical(envelope))]);if(b.length>960)throw Error('Joint claim carrier is too large.');return b;
}
export function carrier(envelope){const p=payload(envelope),total=Math.ceil(p.length/240),chunks=[];for(let i=0;i<total;i++){const c=Buffer.concat([Buffer.from('XM2'),Buffer.from([i,total]),p.subarray(i*240,(i+1)*240)]);chunks.push(Buffer.from([2,c.length<128?c.length:(c.length&127)|128,...(c.length<128?[]:[c.length>>7])]),c);}return Buffer.concat(chunks);}
export function decodeCarrier(extra){
 if(!Array.isArray(extra)||extra.length>1060||extra.some(n=>!Number.isInteger(n)||n<0||n>255))throw Error('Invalid Monero transaction extra.');const b=Buffer.from(extra);let at=0;const chunks=[];
 const take=n=>{if(n<0||at+n>b.length)throw Error('Truncated transaction extra.');const v=b.subarray(at,at+n);at+=n;return v;};
 const byte=()=>take(1)[0],varint=limit=>{let n=0;for(let i=0;i<10;i++){const x=byte();n+=(x&127)*2**(7*i);if(!(x&128)){if(!Number.isSafeInteger(n)||n>limit||i&&x===0)throw Error('Invalid extra length.');return n;}}throw Error('Invalid extra length.');};
 while(at<b.length){const tag=byte();if(tag===0){if(take(b.length-at).some(x=>x!==0))throw Error('Invalid extra padding.');}else if(tag===1)take(32);else if(tag===4)take(32*varint(16));else if(tag===2){const c=take(varint(255));if(c.subarray(0,3).equals(Buffer.from('XM2')))chunks.push(c);}else throw Error('Unknown transaction extra tag.');}
 if(!chunks.length)return null;const total=chunks[0][4];if(!total||total>4||chunks.length!==total||chunks.some((c,i)=>c.length<=5||c[3]!==i||c[4]!==total||c.length>245||i<total-1&&c.length!==245))throw Error('Invalid joint carrier fragments.');
 const p=Buffer.concat(chunks.map(c=>c.subarray(5)));if(p.length>960||!p.subarray(0,MAGIC.length).equals(MAGIC))throw Error('Wrong joint carrier domain.');const e=JSON.parse(p.subarray(MAGIC.length).toString('utf8'));if(!payload(e).equals(p))throw Error('Noncanonical joint carrier.');return e;
}
