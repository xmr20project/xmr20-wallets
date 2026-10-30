// New ABI-3 domains; historical XMR20 and ABI-2 signing bytes are unchanged.
import {PublicKey} from '@solana/web3.js';
import {digest,canonical,moneroOwner} from '../core-next/records.mjs';
export {digest,canonical};
const need=(v,m)=>{if(!v)throw Error(m);};
const fields={link:['p','v','net','op','owner','to','mint','program','nonce'],credit:['p','v','net','op','owner','by','mint','program','nonce','amount','into'],transfer:['p','v','net','op','owner','to','mint','program','nonce','amount','from','into'],burn:['p','v','net','op','owner','to','mint','program','nonce','amount','from']};
const publicKey=v=>{need(typeof v==='string'&&new PublicKey(v).toBase58()===v,'Canonical Solana address required.');return v;};
export function validateRecord(r){
 need(r&&Object.getPrototypeOf(r)===Object.prototype&&fields[r.op]&&Object.keys(r).sort().join(',')===fields[r.op].slice().sort().join(','),'Exact transferable record fields required.');
 need(r.p==='xmr20-joint'&&r.v===3&&r.net==='mainnet'&&typeof r.nonce==='string'&&/^[a-f0-9]{64}$/.test(r.nonce)&&!/^0+$/.test(r.nonce),'Wrong transferable domain or nonce.');
 moneroOwner(r.owner);publicKey(r.mint);publicKey(r.program);
 if(r.op==='link'||r.op==='burn')need(PublicKey.isOnCurve(new PublicKey(publicKey(r.to)).toBytes()),'Linked wallet must have a signing key.');
 if(r.op==='credit')publicKey(r.by);
 if(r.op==='transfer'){moneroOwner(r.to);need(r.owner!==r.to,'A different Monero recipient required.');}
 for(const name of ['from','into'])if(Object.hasOwn(r,name))publicKey(r[name]);
 if(r.op!=='link')need(typeof r.amount==='string'&&/^[1-9][0-9]{0,13}$/.test(r.amount)&&BigInt(r.amount)<=50000000000000n,'Exact transferable amount required.');
 return r;
}
export function message(r){validateRecord(r);return 'XMR20-JOINT-MAINNET-'+r.op.toUpperCase()+'-V3\n'+canonical(r);}
export function commitment(e){validateRecord(e?.record);need(Object.keys(e).sort().join(',')===(e.record.op==='credit'?'record':'record,signature')&&(e.record.op==='credit'||typeof e.signature==='string'&&/^SigV2[1-9A-HJ-NP-Za-km-z]{80,110}$/.test(e.signature)),'Exact public transferable envelope required.');
 if(e.record.op!=='credit')return digest(canonical(e));
 const r=e.record,amount=Buffer.alloc(8);amount.writeBigUInt64LE(BigInt(r.amount));return digest(Buffer.concat([Buffer.from('XMR20-JOINT-CREDIT-V3\n'),new PublicKey(r.program).toBuffer(),new PublicKey(r.mint).toBuffer(),new PublicKey(r.into).toBuffer(),new PublicKey(r.by).toBuffer(),Buffer.from(r.nonce,'hex'),amount]));
}
export function payload(e){commitment(e);const b=Buffer.from('XMR20J3'+canonical(e));need(b.length<=960,'Transferable record exceeds carrier limit.');return b;}
export function carrier(e){
 const p=payload(e),total=Math.ceil(p.length/240),parts=[];
 for(let i=0;i<total;i++){const b=Buffer.concat([Buffer.from('XM3'),Buffer.from([i,total]),p.subarray(i*240,(i+1)*240)]);parts.push(Buffer.from([2,(b.length&127)|(b.length>=128?128:0),...(b.length>=128?[b.length>>7]:[])]),b);}
 return Buffer.concat(parts);
}
export function extractCarrierPayload(extra){
 need(Array.isArray(extra)&&extra.length<=1060&&extra.every(x=>Number.isInteger(x)&&x>=0&&x<=255),'Invalid transferable transaction extra.');
 const b=Buffer.from(extra),chunks=[];let at=0;
 const take=n=>{need(n>=0&&at+n<=b.length,'Truncated transferable extra.');const out=b.subarray(at,at+n);at+=n;return out;};
 const number=max=>{let n=0;for(let i=0;i<10;i++){const x=take(1)[0];n+=(x&127)*2**(7*i);if(!(x&128)){need(Number.isSafeInteger(n)&&n<=max&&(!i||x!==0),'Noncanonical extra length.');return n;}}throw Error('Invalid extra length.');};
 while(at<b.length){const tag=take(1)[0];if(tag===0)need(take(b.length-at).every(x=>x===0),'Invalid extra padding.');else if(tag===1)take(32);else if(tag===4)take(32*number(16));else if(tag===2){const c=take(number(255));if(c.subarray(0,3).equals(Buffer.from('XM3')))chunks.push(c);}else throw Error('Unknown extra tag.');}
 if(!chunks.length)return null;
 const total=chunks[0][4];need(total>0&&total<=4&&chunks.length===total&&chunks.every((c,i)=>c.length>5&&c.length<=245&&c[3]===i&&c[4]===total&&(i===total-1||c.length===245)),'Invalid transferable fragments.');
 const p=Buffer.concat(chunks.map(c=>c.subarray(5)));need(p.length<=960&&p.subarray(0,7).equals(Buffer.from('XMR20J3')),'Wrong transferable carrier domain.');
 return p;
}
export function decodeCarrier(extra){
 const p=extractCarrierPayload(extra);if(p===null)return null;
 const e=JSON.parse(p.subarray(7).toString('utf8'));need(payload(e).equals(p),'Noncanonical transferable payload.');return e;
}
