// LOCAL CANDIDATE. New domain: never reinterpret J3 or XN1 authorizations.
import {sha256} from '@noble/hashes/sha256';
import {ed25519} from '@noble/curves/ed25519';
import {checkMoneroAddress} from '../../address.js';

export const SCHEMA='xmr20-monero-account-draft-v1';
export const need=(ok,message)=>{if(!ok)throw Error(message);};
export const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
export const digest=value=>Buffer.from(sha256(typeof value==='string'?new TextEncoder().encode(value):value)).toString('hex');
export const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&!/^0+$/.test(value);
export function exact(value,fields){need(value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...fields].sort().join(','),'Exact protocol fields required.');}
export function amount(value,{zero=false}={}){need(typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=18446744073709551615n&&(zero||BigInt(value)>0n),'Canonical atomic amount required.');return BigInt(value);}
export function address(value,network){const r=checkMoneroAddress(value,network);need(r.valid&&['standard','subaddress'].includes(r.kind),'Standard Monero address or subaddress required; integrated addresses are not supported by this draft.');return value;}
export function manifest(value){
 exact(value,['schema','network','genesis','asset','activation','cap','decimals','confirmationDepth','issuers','threshold']);
 need(value.schema===SCHEMA&&['mainnet','stagenet'].includes(value.network)&&hash(value.genesis)&&hash(value.asset),'Explicit network and asset domain required.');
 exact(value.activation,['height','hash']);need(Number.isSafeInteger(value.activation.height)&&value.activation.height>=0&&hash(value.activation.hash),'Pinned activation checkpoint required.');
 amount(value.cap);need(value.decimals===6&&Number.isSafeInteger(value.confirmationDepth)&&value.confirmationDepth>=10&&value.confirmationDepth<=1000,'Explicit six-decimal, confirmed settlement policy required.');
 need(Array.isArray(value.issuers)&&value.issuers.length>=1&&value.issuers.length<=3&&value.issuers.every(hash)&&value.issuers.every((key,i)=>i===0||key>value.issuers[i-1]),'Sorted distinct issuance keys required.');
 need(Number.isInteger(value.threshold)&&value.threshold>=1&&value.threshold<=value.issuers.length,'Issuance quorum required.');return value;
}
export const manifestId=value=>digest('XMR20-MONERO-ACCOUNT-MANIFEST-DRAFT-V1\n'+canonical(manifest(value)));
const common=['schema','manifest','op','amount'];
export function record(r,m){
 const extra={credit:['to','lock'],transfer:['owner','to','sequence','validUntil'],burn:['owner','destination','sequence','validUntil']}[r?.op];
 need(extra,'Unknown token operation.');exact(r,[...common,...extra]);need(r.schema===SCHEMA&&r.manifest===manifestId(m),'Wrong asset or protocol domain.');amount(r.amount);
 if(r.op==='credit'){address(r.to,m.network);need(hash(r.lock),'Unique irrevocable backing lock required.');}
 else{
  address(r.owner,m.network);amount(r.sequence,{zero:true});need(Number.isSafeInteger(r.validUntil)&&r.validUntil>m.activation.height,'Bounded approval height required.');
  if(r.op==='transfer'){address(r.to,m.network);need(r.owner!==r.to,'Different recipient required.');}
  else need(hash(r.destination),'Exact 32-byte Solana redemption destination required.');
 }
 return r;
}
export function message(r,m){record(r,m);return 'XMR20-MONERO-ACCOUNT-'+r.op.toUpperCase()+'-DRAFT-V1\n'+canonical(r);}
export function envelope(e,m){
 const r=record(e?.record,m);exact(e,r.op==='credit'?['record','signatures']:['record','signature']);
 if(r.op==='credit'){
  need(Array.isArray(e.signatures)&&e.signatures.length>=m.threshold&&e.signatures.length<=m.issuers.length,'Issuance quorum missing.');
  e.signatures.forEach((s,i)=>{exact(s,['index','signature']);need(Number.isInteger(s.index)&&s.index>=0&&s.index<m.issuers.length&&(i===0||s.index>e.signatures[i-1].index)&&typeof s.signature==='string'&&/^[a-f0-9]{128}$/.test(s.signature),'Canonical issuer signatures required.');});
 }else need(typeof e.signature==='string'&&/^SigV2[1-9A-HJ-NP-Za-km-z]{80,110}$/.test(e.signature),'Monero spend signature required.');
 return e;
}
export async function verify(e,m,verifier){
 envelope(e,m);const text=message(e.record,m);
 if(e.record.op==='credit')return e.signatures.every(s=>ed25519.verify(s.signature,new TextEncoder().encode(text),m.issuers[s.index],{zip215:false}));
 need(typeof verifier?.verify==='function','Independent Monero spend-signature verifier required.');
 return await verifier.verify(text,e.record.owner,e.signature)===true;
}
export function payload(e,m){envelope(e,m);const bytes=Buffer.from('XMR20A1'+canonical(e));need(bytes.length<=960,'Token record exceeds carrier budget.');return bytes;}
export const operationId=(e,m)=>digest(payload(e,m));
export function carrier(e,m){const bytes=payload(e,m),count=Math.ceil(bytes.length/240),out=[];for(let i=0;i<count;i++){const c=Buffer.concat([Buffer.from('XA1'),Buffer.from([i,count]),bytes.subarray(i*240,(i+1)*240)]);out.push(Buffer.from([2,(c.length&127)|(c.length>=128?128:0),...(c.length>=128?[c.length>>7]:[])]),c);}return Buffer.concat(out);}
export function decodeCarrier(extra,m){
 need(Array.isArray(extra)&&extra.length<=1060&&extra.every(n=>Number.isInteger(n)&&n>=0&&n<=255),'Bounded transaction extra required.');const b=Buffer.from(extra),parts=[];let at=0;
 const take=n=>{need(Number.isSafeInteger(n)&&n>=0&&at+n<=b.length,'Truncated extra.');const v=b.subarray(at,at+n);at+=n;return v;};
 const number=max=>{let n=0;for(let i=0;i<10;i++){const c=take(1)[0];n+=(c&127)*2**(7*i);if(!(c&128)){need(Number.isSafeInteger(n)&&n<=max&&(!i||c!==0),'Canonical extra length required.');return n;}}throw Error('Invalid extra length.');};
 while(at<b.length){const tag=take(1)[0];if(tag===0)need(take(b.length-at).every(n=>n===0),'Invalid padding.');else if(tag===1)take(32);else if(tag===4)take(number(16)*32);else if(tag===2){const c=take(number(255));if(c.subarray(0,3).equals(Buffer.from('XA1')))parts.push(c);}else throw Error('Unsupported extra tag.');}
 if(!parts.length)return null;const count=parts[0][4];need(count>=1&&count<=4&&parts.length===count&&parts.every((c,i)=>c.length>5&&c.length<=245&&c[3]===i&&c[4]===count&&(i===count-1||c.length===245)),'Complete ordered token fragments required.');
 const bytes=Buffer.concat(parts.map(c=>c.subarray(5)));need(bytes.length<=960&&bytes.subarray(0,7).toString()==='XMR20A1','Wrong carrier domain.');const e=JSON.parse(bytes.subarray(7).toString());need(payload(e,m).equals(bytes),'Canonical token payload required.');return e;
}
