// Shared by the extension and website; no automatic approval on construction/read.
import {VersionedTransaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {canonical,digest,message,payload,commitment} from './records.mjs';
import {registerIdentity,identityAddresses} from './sdk.mjs';
import {verifyIdentityCustody} from './identity-proof.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const same=(a,b)=>Buffer.from(a).equals(Buffer.from(b));
export function createIdentityWalletClient({registry,runtime,provider,moneroSigner,signatureVerifier,proofChain,store}){
 need(provider?.publicKey&&moneroSigner?.address&&moneroSigner.sign&&signatureVerifier?.verify&&proofChain?.identityReviewFresh&&store?.load&&store.save,'Explicit identity wallet adapters required.');
 const owner=provider.publicKey.toBase58(),config={...registry,owner,binding:digest(moneroSigner.address)},scope=digest(canonical({registry,owner,moneroOwner:moneroSigner.address}));
 const reviews=new WeakMap();let busy=false,poisoned=false;
 const current=()=>{provider.assertCurrent?.();need(!poisoned&&provider.publicKey.toBase58()===owner,'Wallet changed or receipt unavailable. Reopen the original wallet.');};
 const load=()=>{current();const s=store.load()??{schema:'wallet-identity-owner-v1',scope,proofs:{},operations:{}};need(s.schema==='wallet-identity-owner-v1'&&s.scope===scope,'Recover the matching identity receipts.');return s;};
 const save=s=>{current();try{store.save(structuredClone(s));}catch{poisoned=true;throw Error('Identity receipt could not be saved. Nothing further was submitted.');}};
 const run=async fn=>{current();need(!busy,'An identity approval is already running.');busy=true;try{return await fn();}finally{busy=false;}};
 const fingerprint=r=>digest(canonical({config:r.config,proposal:r.proposal,envelope:r.envelope,reviewId:r.reviewId,bytes:Buffer.from(r.transaction.serialize()).toString('base64')}));
 function validateReview(r){
  need(canonical(r.config)===canonical(config)&&r.proposal.commitment===commitment(r.envelope),'Identity review differs from these wallets.');
  const tx=r.transaction,expected=registerIdentity(config,r.proposal),msg=tx.message.serialize();
  need(same(msg,expected.message.serialize())&&tx.signatures.length===2&&tx.signatures[0].every(b=>b===0)
   &&tx.message.staticAccountKeys[0].toBase58()===owner&&tx.message.staticAccountKeys[1].toBase58()===registry.verifier
   &&ed25519.verify(tx.signatures[1],msg,tx.message.staticAccountKeys[1].toBytes()),'Exact verifier identity authorization required.');
 }
 async function review(nonce){
  const record={p:'xmr20-identity',v:1,net:'mainnet',op:'link',owner:moneroSigner.address,to:owner,registry:registry.program,verifier:registry.verifier,nonce};message(record);
  await proofChain.verifyProgram(registry);current();let s=load(),envelope=s.proofs[nonce]?.envelope;
  if(envelope)need(canonical(envelope.record)===canonical(record),'Saved identity proof changed.');
  else{const signature=await moneroSigner.sign({record,message:message(record)},{schema:'wallet-identity-review-v1',config,moneroOwner:moneroSigner.address,expectedRecord:record});current();envelope={record,signature};payload(envelope);
   need(await signatureVerifier.verify(message(record),record.owner,signature),'Native identity signature differs from review.');current();s=load();s.proofs[nonce]={envelope};save(s);}
  const prepared=await runtime.authorize(envelope);current();need(canonical(prepared.envelope)===canonical(envelope),'Identity proof substituted by service.');validateReview(prepared);
  reviews.set(prepared,fingerprint(prepared));return prepared;
 }
 async function approve(review){
  const fingerprintBefore=reviews.get(review);need(fingerprintBefore&&fingerprint(review)===fingerprintBefore,'Open an unchanged identity review first.');validateReview(review);
  need(await proofChain.identityReviewFresh(config,review.proposal),'Identity review expired. Open a fresh review.');current();need(fingerprint(review)===fingerprintBefore,'Identity review changed.');
  const id=identityAddresses(config).identity.toBase58()+':identity:'+digest(payload(review.envelope)),s=load(),old=s.operations[id];
  if(old){const outcome=await proofChain.pendingOutcome({bytes:Buffer.from(old.bytes,'base64'),lastValidBlockHeight:old.proposal.lastValidBlockHeight});need(['expired','failed'].includes(outcome.kind),'Check the existing identity approval before approving again.');current();}
  const tx=await provider.signTransaction(VersionedTransaction.deserialize(review.transaction.serialize()));current();
  need(fingerprint(review)===fingerprintBefore&&same(tx.message.serialize(),review.transaction.message.serialize())&&tx.signatures.length===2
   &&tx.signatures.every((sig,i)=>ed25519.verify(sig,tx.message.serialize(),tx.message.staticAccountKeys[i].toBytes()))
   &&same(tx.signatures[1],review.transaction.signatures[1]),'Wallet changed the exact identity approval.');
  need(canonical(load())===canonical(s),'Identity receipts changed during approval. Reconcile the saved operation.');
  const bytes=Buffer.from(tx.serialize()).toString('base64');
  s.operations[id]={reviewId:review.reviewId,config,proposal:review.proposal,envelope:review.envelope,bytes,signature:bs58.encode(tx.signatures[0]),phase:'submission-unknown',attempts:old?[...(old.attempts??[]),{bytes:old.bytes,proposal:old.proposal,phase:old.phase}]:[]};save(s);
  const result=await runtime.submit({reviewId:review.reviewId,ownerSigned:tx.serialize()});current();need(result.operationId===id,'Service returned another identity operation.');return result;
 }
 async function check(id){
  const s=load(),job=s.operations[id];need(job,'Saved identity approval required.');
  const bytes=Buffer.from(job.bytes,'base64'),tx=VersionedTransaction.deserialize(bytes);
  need(same(tx.message.serialize(),registerIdentity(config,job.proposal).message.serialize())&&tx.signatures.length===2&&tx.signatures.every((sig,i)=>ed25519.verify(sig,tx.message.serialize(),tx.message.staticAccountKeys[i].toBytes()))&&bs58.encode(tx.signatures[0])===job.signature,'Saved identity approval changed.');
  let result;try{result=await runtime.reconcile(id);}catch(cause){
   const outcome=await proofChain.pendingOutcome({bytes,lastValidBlockHeight:job.proposal.lastValidBlockHeight});current();
   if(!['expired','failed'].includes(outcome.kind))throw cause;
   result={operationId:id,retryApprovalRequired:true,confirmed:false};
  }current();need(result.operationId===id,'Identity status changed.');
  if(result.confirmed){const independent=await proofChain.finalizedIdentity({config,proposal:job.proposal,bytes});need(independent?.confirmed&&independent.signature===job.signature,'Independent identity finality unavailable.');current();job.phase='finalized';}
  else if(result.retryApprovalRequired){const outcome=await proofChain.pendingOutcome({bytes,lastValidBlockHeight:job.proposal.lastValidBlockHeight});need(['expired','failed'].includes(outcome.kind),'Independent identity expiry unavailable.');current();job.phase='approval-expired';}
  save(s);return result;
 }
 async function lookup(address){
  current();const report=await runtime.snapshot();current();need(report?.schema==='wallet-identity-index-v1'&&report.complete===true&&canonical(report.registry)===canonical(registry)&&Array.isArray(report.identities),'Complete matching identity history required.');
  const matches=report.identities.filter(v=>v.moneroOwner===address);need(matches.length<=1,'Conflicting identity records.');if(!matches.length)return null;
  const entry=matches[0],r=entry.envelope?.record;
  need(r?.owner===address&&r.to===entry.solanaOwner&&Number.isSafeInteger(entry.confirmations)&&entry.confirmations>=10&&/^[a-f0-9]{64}$/.test(entry.txid),'Confirmed identity record required.');
  const verified=await verifyIdentityCustody({config:{...registry,owner:entry.solanaOwner,binding:digest(address)},envelope:entry.envelope,chain:proofChain,signatureVerifier});current();
  need(verified.identity===entry.identity&&verified.commitment===entry.commitment,'Identity report differs from finalized custody.');return structuredClone(entry);
 }
 async function retry(id){
  const s=load(),job=s.operations[id];need(job,'Saved identity approval required.');const tx=VersionedTransaction.deserialize(Buffer.from(job.bytes,'base64')),msg=tx.message.serialize();
  need(same(msg,registerIdentity(config,job.proposal).message.serialize())&&tx.signatures.length===2&&tx.signatures.every((sig,i)=>ed25519.verify(sig,msg,tx.message.staticAccountKeys[i].toBytes())),'Saved identity approval changed.');
  const outcome=await proofChain.pendingOutcome({bytes:tx.serialize(),lastValidBlockHeight:job.proposal.lastValidBlockHeight});need(['pending','finalized'].includes(outcome.kind),'Reconcile the expired or failed approval first.');current();
  return runtime.submit({reviewId:digest(msg),ownerSigned:tx.serialize()});
 }
 return Object.freeze({retry:id=>run(()=>retry(id)),review:nonce=>run(()=>review(nonce)),approve:r=>run(()=>approve(r)),check:id=>run(()=>check(id)),lookup,receipt:()=>structuredClone(load())});
}
