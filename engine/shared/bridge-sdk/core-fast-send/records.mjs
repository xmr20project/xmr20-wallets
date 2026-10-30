// A separate settlement domain. Legacy J3/native signing bytes are unchanged.
import {PublicKey} from '@solana/web3.js';
import {addresses,receiptAddress,transaction,decodeReceipt} from '../core-transferable/sdk.mjs';
import {digest,canonical,payload} from '../core-transferable/records.mjs';
import {moneroOwner} from '../core-next/records.mjs';
export const FAST_SEND='solana-settlement-v1';
export const SCHEMA='joint-solana-send-v1';
const need=(v,m)=>{if(!v)throw Error(m);};
const pk=x=>new PublicKey(x);
const hex=x=>{need(typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)&&!/^0+$/.test(x),'Nonzero fast-send nonce required.');return Buffer.from(x,'hex');};
const amount=x=>{need(typeof x==='string'&&/^[1-9][0-9]{0,13}$/.test(x)&&BigInt(x)<=50000000000000n,'Exact supported fast-send amount required.');const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(x));return b;};
// Reconstructible from immutable on-chain receipt fields and its pool. Existing
// instruction 4 already enforces both signatures, balances, backing and nonce.
// Domain separation identifies fast settlement without reinterpreting a native
// envelope or requiring a new program authority/instruction.
export function receiptCommitment({program,mint,verifier,from,to,nonce,gross}){
 need(from!==to,'Different fast-send positions required.');
 return digest(Buffer.concat([Buffer.from('XMR20-JOINT-SOLANA-SEND-V1\n'),...([program,mint,verifier,from,to].map(x=>pk(x).toBuffer())),hex(nonce),amount(gross)]));
}
export function validateIntent(i){
 const fields=['schema','network','program','mint','verifier','owner','recipient','fromMonero','toMonero','amount','nonce'];
 need(i&&Object.getPrototypeOf(i)===Object.prototype&&Object.keys(i).length===fields.length&&fields.every(k=>Object.hasOwn(i,k))&&i.schema===SCHEMA&&['mainnet-beta','local-svm'].includes(i.network),'Exact fast-send intent required.');
 for(const k of ['program','mint','verifier','owner','recipient'])need(typeof i[k]==='string'&&pk(i[k]).toBase58()===i[k],'Canonical public key required.');
 need(i.owner!==i.recipient&&i.owner!==i.verifier&&i.recipient!==i.verifier&&i.fromMonero!==i.toMonero,'Different linked holders required.');
 for(const k of ['fromMonero','toMonero'])moneroOwner(i[k]);
 amount(i.amount);hex(i.nonce);return i;
}
export function config(i){validateIntent(i);return {abi:3,network:i.network,program:i.program,mint:i.mint,verifier:i.verifier,owner:i.owner,binding:digest(i.fromMonero)};}
export function intentCommitment(i){const c=config(i);return receiptCommitment({...i,from:addresses(c).position.toBase58(),to:addresses({...c,owner:i.recipient}).position.toBase58(),gross:i.amount});}
export function proposal(i,block){validateIntent(i);need(block&&typeof block.blockhash==='string'&&Number.isSafeInteger(block.lastValidBlockHeight)&&block.lastValidBlockHeight>0,'Fresh fast-send blockhash required.');return {network:i.network,operation:'transfer',amount:i.amount,expectedFee:'0',nonce:i.nonce,commitment:intentCommitment(i),toOwner:i.recipient,blockhash:block.blockhash,lastValidBlockHeight:block.lastValidBlockHeight};}
export function exactReview(i,p){need(canonical(proposal(i,p))===canonical(p),'Fast-send review differs from the exact intent.');return transaction(config(i),p);}
export function operationId(i){return addresses(config(i)).position.toBase58()+':fast-send:'+i.nonce;}
// Explicit recovery preserves the original nonce and every transfer term. Both
// settlement domains consume the SAME immutable receipt PDA, so only one can win.
// This never deletes a native construction marker or retries native signing.
export function matchesNativeSend(envelope,intent){
 try{payload(envelope);validateIntent(intent);const r=envelope.record,c=config(intent);
  return r.op==='transfer'&&r.program===intent.program&&r.mint===intent.mint&&r.owner===intent.fromMonero&&r.to===intent.toMonero&&r.amount===intent.amount&&r.nonce===intent.nonce&&r.from===addresses(c).position.toBase58()&&r.into===addresses({...c,owner:intent.recipient}).position.toBase58();
 }catch{return false;}
}
export function nativeSendSettled(envelope,receipts){
 try{payload(envelope);const r=envelope.record;return r.op==='transfer'&&receipts.some(p=>p.settlement==='solana'&&p.kind===4&&p.from===r.from&&p.to===r.into&&p.nonce===r.nonce&&p.gross===r.amount&&p.net===r.amount&&p.fee==='0');}catch{return false;}
}
export function matchesReceipt(manifest,address,data){
 // A legacy kind-4 receipt with a native-envelope commitment is not a fast
 // transfer. Never infer fast settlement from an operation label alone.
 let r;try{r=decodeReceipt(data);}catch{return null;}
 if(r.kind!==4||r.net!==r.gross||r.fee!=='0'||r.from===r.to)return null;
 try{if(r.commitment!==receiptCommitment({...manifest,...r}))return null;}catch{return null;}
 const expected=PublicKey.findProgramAddressSync([Buffer.from('joint-v3-receipt'),pk(r.from).toBuffer(),hex(r.nonce)],pk(manifest.program))[0].toBase58();
 need(address===expected,'Fast-send receipt PDA differs.');return r;
}
export {receiptAddress};
