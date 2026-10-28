import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {canonical,digest} from '../core-transferable/records.mjs';
import {addresses,receiptAddress} from '../core-transferable/sdk.mjs';
import {FAST_SEND,validateIntent,config,proposal,exactReview,operationId} from './records.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const terminal=j=>['finalized','expired','failed'].includes(j.phase);
export function checkedApproval(intent,p,bytes,{signed=true}={}){
 const expected=exactReview(intent,p),tx=VersionedTransaction.deserialize(bytes),msg=tx.message.serialize();
 need(Buffer.from(msg).equals(Buffer.from(expected.message.serialize()))&&tx.signatures.length===2&&ed25519.verify(tx.signatures[1],msg,new PublicKey(intent.verifier).toBytes())&&(signed?ed25519.verify(tx.signatures[0],msg,new PublicKey(intent.owner).toBytes()):tx.signatures[0].every(x=>x===0)),'Exact fast-send signatures and transaction required.');return tx;
}
// Uses the host runtime's shared mutation lock. Separate durable journal and
// operation namespace preserve native sends, including unknown constructions.
export function createFastRuntime({manifest,chain,verifier,store,observe,checkFresh,guardLegacy,run,ready,newApprovalsEnabled=false}){
 need(manifest.fastSend===FAST_SEND&&[observe,checkFresh,guardLegacy,run,ready].every(f=>typeof f==='function')&&store?.load&&store?.save&&chain?.authorizationExpired,'Explicit fast settlement dependencies required.');
 need(typeof newApprovalsEnabled==='boolean','Explicit fast-send approval policy required.');
 let poisoned=false;const pinned=canonical(manifest);
 const check=i=>{validateIntent(i);need(canonical(manifest)===pinned&&['network','program','mint','verifier'].every(k=>i[k]===manifest[k]),'Fast-send deployment differs.');return config(i);};
 const load=()=>{need(!poisoned,'Fast-send journal failed. Stop and reconcile.');const s=store.load()??{schema:'joint-fast-runtime-v1',manifest:pinned,reviews:{},operations:{}};need(s.schema==='joint-fast-runtime-v1'&&s.manifest===pinned&&s.reviews&&s.operations,'Matching fast-send journal required.');return s;};
 const save=s=>{try{store.save(structuredClone(s));}catch{poisoned=true;throw Error('Fast-send journal failed. No further relay is permitted.');}};
 function checkedJob(key,j){need(j&&operationId(j.intent)===key&&canonical(j.config)===canonical(check(j.intent))&&['submission-unknown','finalized','failed','expired'].includes(j.phase),'Matching saved fast-send operation required.');return checkedApproval(j.intent,j.proposal,Buffer.from(j.bytes,'base64'));}
 async function reconcile(key){await ready();const s=load(),j=s.operations[key],tx=checkedJob(key,j),bytes=tx.serialize();
  const result=await chain.finalizedOperation({config:j.config,proposal:j.proposal,bytes});
  if(result){need(result.confirmed===true,'Independent Solana finality required.');j.phase='finalized';j.result=result;save(s);return {...result,operationId:key,settlement:'solana'};}
  need(j.phase!=='finalized','Previously finalized receipt unavailable.');
  const outcome=await chain.pendingOutcome({bytes,lastValidBlockHeight:j.proposal.lastValidBlockHeight});
  if(['failed','expired'].includes(outcome.kind)){j.phase=outcome.kind;save(s);return {operationId:key,retryApprovalRequired:true,pending:false,settlement:'solana'};}
  return {operationId:key,pending:true,settlement:'solana'};
 }
 // Only an authenticated owner-signed submission reserves a source. Public
 // preview requests must not let strangers lock somebody else's wallet. Two
 // independently approved transactions remain subject to the program's atomic
 // balance/nonce checks; previews cannot authorize execution by themselves.
 async function guard(position,matchingIntent){
  let s=load();
  for(const [key,j] of Object.entries(s.operations))if(addresses(check(j.intent)).position.toBase58()===position&&!terminal(j)){
   await reconcile(key);s=load();need(terminal(s.operations[key]),'A saved fast send is unresolved. Recover it before another move.');
  }
  if(!matchingIntent)return null;
  for(const r of Object.values(s.reviews).reverse())if(!r.expired&&canonical(r.intent)===canonical(matchingIntent)){
   checkedApproval(r.intent,r.proposal,Buffer.from(r.authorization,'base64'),{signed:false});
   if(!await chain.authorizationExpired(config(r.intent),r.proposal))return r;
   r.expired=true;save(s);
  }
  return null;
 }
 async function prepare(intent){need(newApprovalsEnabled,'New fast-send approvals are paused. Saved transactions remain recoverable.');const c=check(intent),key=operationId(intent),position=addresses(c).position.toBase58();
  const prior=load().operations[key];if(prior){checkedJob(key,prior);need(canonical(prior.intent)===canonical(intent),'Saved fast-send intent changed.');if(!terminal(prior))await reconcile(key);need(['expired','failed'].includes(load().operations[key].phase),'Saved fast send needs reconciliation.');}
  const {e,ledger}=await observe();
  const from=ledger.positions.get(position),to=ledger.positions.get(addresses({...c,owner:intent.recipient}).position.toBase58());
  need(from?.solanaOwner===intent.owner&&from.moneroOwner===intent.fromMonero&&from.available===from.balance&&BigInt(from.available)>=BigInt(intent.amount)&&to?.solanaOwner===intent.recipient&&to.moneroOwner===intent.toMonero,'Confirmed linked holders and available balance required.');
  const report={schema:'joint-index-v3',complete:true,manifest,positions:[...ledger.positions.values()],accepted:ledger.accepted,pending:ledger.pending,reconciliation:ledger.reconciliation,fastTransfers:ledger.fastTransfers};
  await guardLegacy(position,ledger,intent);const active=await guard(position,intent);
  need(await chain.readAccount(receiptAddress(c,intent.nonce).toBase58())===null,'This send nonce already settled. Check the existing transfer.');await checkFresh(e);
  if(active)return {report,intent:structuredClone(intent),config:c,proposal:active.proposal,reviewId:digest(exactReview(intent,active.proposal).message.serialize()),transaction:VersionedTransaction.deserialize(Buffer.from(active.authorization,'base64'))};
  const {network,blockhash,lastValidBlockHeight,...terms}=proposal(intent,{blockhash:new PublicKey(new Uint8Array(32)).toBase58(),lastValidBlockHeight:1});
  const p=await chain.prepare(c,terms);need(canonical(p.config)===canonical(c),'Fast-send preparation changed config.');
  const expected=exactReview(intent,p.proposal);need(Buffer.from(expected.message.serialize()).equals(Buffer.from(p.transaction.message.serialize())),'Fast-send preparation changed transaction.');
  // Finish freshness immediately before the verifier signature. No signing
  // authority or generic message-signing endpoint is exposed to callers.
  await checkFresh(e);p.transaction.sign([verifier]);checkedApproval(intent,p.proposal,p.transaction.serialize(),{signed:false});
  const id=digest(expected.message.serialize()),s=load();s.reviews[id]={intent:structuredClone(intent),proposal:p.proposal,authorization:Buffer.from(p.transaction.serialize()).toString('base64')};save(s);
  return {...p,report,intent:structuredClone(intent),reviewId:id};
 }
 async function submit({intent,proposal:p,ownerSigned}){const c=check(intent),tx=checkedApproval(intent,p,ownerSigned),id=operationId(intent),s=load(),review=s.reviews[digest(tx.message.serialize())];
  need(review&&!review.expired&&canonical(review.intent)===canonical(intent)&&canonical(review.proposal)===canonical(p),'Saved exact fast-send review required.');
  const authorization=checkedApproval(intent,p,Buffer.from(review.authorization,'base64'),{signed:false});need(Buffer.from(authorization.signatures[1]).equals(Buffer.from(tx.signatures[1])),'Verifier approval changed.');
  const bytes=Buffer.from(tx.serialize()).toString('base64'),old=s.operations[id];
  if(old){checkedJob(id,old);need(canonical(old.intent)===canonical(intent),'Saved fast-send intent changed.');
   if(!['expired','failed'].includes(old.phase)){need(old.bytes===bytes,'Saved fast-send bytes changed.');return reconcile(id);}
   need(old.bytes!==bytes,'Expired approval cannot be submitted again.');
  }
  need(!Object.entries(s.operations).some(([key,j])=>key!==id&&j.intent.owner===intent.owner&&!terminal(j)),'Another fast-send submission is unresolved.');
  s.operations[id]={intent:structuredClone(intent),config:c,proposal:p,bytes,phase:'submission-unknown',attempts:old?[...(old.attempts??[]),{bytes:old.bytes,proposal:old.proposal,phase:old.phase}]:[]};save(s);
  const signature=await chain.submit(c,p,tx);s.operations[id].signature=signature;save(s);return {operationId:id,signature,confirmed:false,settlement:'solana'};
 }
 return Object.freeze({guard,prepare:i=>run(()=>prepare(i)),submit:i=>run(()=>submit(i)),reconcile:key=>run(()=>reconcile(key)),retry:key=>run(async()=>{
  const r=await reconcile(key);if(!r.pending)return r;const s=load(),j=s.operations[key],tx=checkedJob(key,j);
  const outcome=await chain.pendingOutcome({bytes:tx.serialize(),lastValidBlockHeight:j.proposal.lastValidBlockHeight});need(outcome.kind==='pending','Reconcile before resending saved fast-send bytes.');
  const signature=await chain.submit(j.config,j.proposal,tx);j.signature=signature;save(s);return {operationId:key,signature,confirmed:false,settlement:'solana'};
 })});
}
