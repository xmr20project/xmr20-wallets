// Explicit account-rent approval; opening a wallet never invokes this client.
import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {canonical,digest} from './records.mjs';
import {activateAsset} from './sdk.mjs';
import {addresses} from '../core-transferable/sdk.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const same=(a,b)=>Buffer.from(a).equals(Buffer.from(b));
export function createActivationWalletClient({registry,runtime,provider,identityClient,chain,store}){
 const payer=provider.publicKey.toBase58(),scope=digest(canonical({registry,payer})),reviews=new WeakMap();let busy=false,poisoned=false;
 const current=()=>{provider.assertCurrent?.();need(!poisoned&&provider.publicKey.toBase58()===payer,'Wallet changed or activation receipts unavailable.');};
 const load=()=>{current();const s=store.load()??{schema:'wallet-activation-owner-v1',scope,operations:{}};need(s.schema==='wallet-activation-owner-v1'&&s.scope===scope,'Wrong activation receipts.');return s;};
 const save=s=>{try{current();store.save(structuredClone(s));}catch{poisoned=true;throw Error('Activation receipt could not be saved. Nothing further was submitted.');}};
 const run=async fn=>{current();need(!busy,'Activation already running.');busy=true;try{return await fn();}finally{busy=false;}};
 const idFor=r=>addresses(r.config).position.toBase58()+':activation:'+digest(canonical({payer,identityCommitment:r.proposal.identityCommitment}));
 const fingerprint=r=>digest(canonical({...r,transaction:Buffer.from(r.transaction.serialize()).toString('base64')}));
 function checked(r,signed=false){
  const c=r.config,p=r.proposal,tx=r.transaction,msg=tx.message.serialize();
  need(canonical(c)===canonical({...registry,abi:3,mint:c.mint,owner:c.owner,binding:digest(r.moneroOwner)})&&p.payer===payer
   &&Number.isSafeInteger(p.rentLamports)&&p.rentLamports>=0&&p.rentLamports<=30000000&&r.operationId===idFor(r),'Exact activation wallets and bounded rent required.');
  need(same(msg,activateAsset(c,p).message.serialize())&&tx.signatures.length===2&&tx.message.staticAccountKeys[0].toBase58()===payer&&tx.message.staticAccountKeys[1].toBase58()===registry.verifier
   &&ed25519.verify(tx.signatures[1],msg,tx.message.staticAccountKeys[1].toBytes())
   // Wallet adapters promise a base58 address, not the complete web3 PublicKey
   // interface. Verify against the pinned payer, still checked by current().
   &&(signed?ed25519.verify(tx.signatures[0],msg,new PublicKey(payer).toBytes()):tx.signatures[0].every(b=>b===0)),'Exact activation transaction required.');
 }
 async function identity(r){const entry=await identityClient.lookup(r.moneroOwner);current();need(entry&&entry.solanaOwner===r.config.owner&&entry.commitment===r.proposal.identityCommitment,'Confirmed recipient identity changed.');}
 async function review({mint,recipient}){
  const r=await runtime.prepareActivation({mint,recipient,payer});current();need(r.config.mint===mint&&r.moneroOwner===recipient,'Activation recipient or asset changed.');checked(r);await identity(r);reviews.set(r,fingerprint(r));return r;
 }
 async function approve(r){
  const pin=reviews.get(r);need(pin&&pin===fingerprint(r),'Open an unchanged activation review first.');checked(r);await identity(r);
  need(await chain.identityReviewFresh(r.config,r.proposal),'Activation review expired. Open a fresh review.');current();need(pin===fingerprint(r),'Activation review changed.');
  const s=load(),old=s.operations[r.operationId];if(old){const outcome=await chain.pendingOutcome({bytes:Buffer.from(old.bytes,'base64'),lastValidBlockHeight:old.proposal.lastValidBlockHeight});need(['expired','failed'].includes(outcome.kind),'Check the saved activation before approving again.');current();}
  const tx=await provider.signTransaction(VersionedTransaction.deserialize(r.transaction.serialize()));current();checked({...r,transaction:tx},true);
  need(pin===fingerprint(r)&&same(tx.signatures[1],r.transaction.signatures[1])&&canonical(load())===canonical(s),'Activation or receipts changed during approval.');
  const bytes=Buffer.from(tx.serialize()).toString('base64'),{transaction,...publicReview}=r;
  s.operations[r.operationId]={...publicReview,bytes,signature:bs58.encode(tx.signatures[0]),phase:'submission-unknown',attempts:old?[...(old.attempts??[]),{bytes:old.bytes,proposal:old.proposal,phase:old.phase}]:[]};save(s);
  const result=await runtime.submitActivation({reviewId:r.reviewId,payerSigned:tx.serialize()});current();need(result.operationId===r.operationId,'Service returned another activation.');return result;
 }
 async function check(id){const s=load(),job=s.operations[id];need(job,'Saved activation required.');const bytes=Buffer.from(job.bytes,'base64');checked({...job,transaction:VersionedTransaction.deserialize(bytes)},true);
  let result;try{result=await runtime.reconcileActivation(id);}catch(cause){
   const outcome=await chain.pendingOutcome({bytes,lastValidBlockHeight:job.proposal.lastValidBlockHeight});current();
   if(!['expired','failed'].includes(outcome.kind))throw cause;
   result={operationId:id,retryApprovalRequired:true,confirmed:false};
  }current();need(result.operationId===id,'Activation status changed.');
  if(result.confirmed){const verified=await chain.finalizedActivation({config:job.config,proposal:job.proposal,bytes});need(verified?.confirmed&&verified.signature===job.signature,'Independent activation finality unavailable.');job.phase='finalized';}
  else if(result.retryApprovalRequired){const outcome=await chain.pendingOutcome({bytes,lastValidBlockHeight:job.proposal.lastValidBlockHeight});need(['expired','failed'].includes(outcome.kind),'Independent activation expiry unavailable.');job.phase='approval-expired';}
  current();save(s);return result;
 }
 async function retry(id){const s=load(),job=s.operations[id];need(job?.phase==='submission-unknown','Check the saved activation first.');checked({...job,transaction:VersionedTransaction.deserialize(Buffer.from(job.bytes,'base64'))},true);const outcome=await chain.pendingOutcome({bytes:Buffer.from(job.bytes,'base64'),lastValidBlockHeight:job.proposal.lastValidBlockHeight});need(['pending','finalized'].includes(outcome.kind),'Reconcile the activation before retrying.');current();return runtime.submitActivation({reviewId:job.reviewId,payerSigned:Buffer.from(job.bytes,'base64')});}
 return Object.freeze({review:i=>run(()=>review(i)),approve:r=>run(()=>approve(r)),check:id=>run(()=>check(id)),retry:id=>run(()=>retry(id)),receipt:()=>structuredClone(load())});
}
