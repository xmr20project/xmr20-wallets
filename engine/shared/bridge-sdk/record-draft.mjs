import {addresses,net,sameConfig} from './sdk.mjs';
import {digest,moneroOwner,hashId,message,canonical,validateRecord} from './claim-record.mjs';
export function validateRecordContext(c){
 if(!c||Object.keys(c).sort().join(',')!=='config,depositNet,moneroOwner'||c.config?.network!=='local-svm'||digest(moneroOwner(c.moneroOwner))!==c.config.binding||!hashId(c.config.id)||typeof c.depositNet!=='string'||! /^[1-9][0-9]{0,13}$/.test(c.depositNet)||BigInt(c.depositNet)>50_000_000_000_000n||net(c.depositNet)<=0n)throw Error('Invalid local record binding.');
 addresses(c.config);return structuredClone(c);
}
export function recordReview(context,operation,amount,nonce){
 const c=validateRecordContext(context),r={p:'xmr20-joint',v:1,net:'local-svm',op:operation,position:addresses(c.config).position.toBase58(),owner:c.moneroOwner,to:c.config.owner,amount,nonce};validateRecord(r);
 if(operation==='claim'&&(amount!==c.depositNet||nonce!==c.config.id)||operation==='burn'&&(BigInt(amount)>BigInt(c.depositNet)||nonce===c.config.id))throw Error('The record exceeds or changes its original deposit.');
 return {record:r,message:message(r)};
}
export function checkRecordReview(context,review){
 if(!review||Object.keys(review).sort().join(',')!=='message,record')throw Error('Invalid record review.');
 const expected=recordReview(context,review.record?.op,review.record?.amount,review.record?.nonce);
 if(canonical(expected)!==canonical(review))throw Error('The record differs from the review.');return expected;
}
export function sameRecordContext(a,b){return sameConfig(a.config,b.config)&&a.moneroOwner===b.moneroOwner&&a.depositNet===b.depositNet;}
export function checkRecordState(s,depositNet=null){
 const raw=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,13})$/.test(v)&&BigInt(v)<=50_000_000_000_000n;
 if(!s||!raw(s.remainingClaim)||!Array.isArray(s.burns)||s.burns.length>64||s.claimTxid!==null&&!hashId(s.claimTxid))throw Error('Invalid test record status. Refresh before signing.');
 let total=BigInt(s.remainingClaim);const seen=new Set();for(const b of s.burns){if(!hashId(b.txid)||seen.has(b.txid)||!raw(b.amount)||BigInt(b.amount)<=0n)throw Error('Invalid test burn status.');seen.add(b.txid);total+=BigInt(b.amount);}
 if(s.claimTxid===null&&(total!==0n||s.burns.length)||depositNet&&s.claimTxid&&total!==BigInt(depositNet))throw Error('The test claim does not match its approved deposit.');return structuredClone(s);
}
