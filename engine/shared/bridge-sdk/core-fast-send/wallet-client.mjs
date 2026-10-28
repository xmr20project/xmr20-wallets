import {VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {canonical,digest,message} from '../core-transferable/records.mjs';
import {addresses,approveMoveExternal} from '../core-transferable/sdk.mjs';
import {FAST_SEND,SCHEMA,config,operationId,validateIntent,matchesNativeSend} from './records.mjs';
import {checkedApproval} from './runtime.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
// Composes with the existing owner controller's account checks, action lock and
// durable public receipt store. No native signing or publishing method is used.
export function createFastWallet({manifest,runtime,provider,moneroAddress,proofChain,verifyDeployment,verifyRecipient,signatureVerifier,load,save,current,run,onProgress}){
 need(manifest.fastSend===FAST_SEND&&proofChain.fastReviewFresh&&proofChain.finalizedOperation&&proofChain.pendingOutcome,'Independent fast-send proof adapters required.');
 const owner=provider.publicKey.toBase58(),reviews=new WeakMap();
 function guard(intent){const s=load(),jobs=Object.values(s.operations),fast=Object.values(s.fastOperations??{}),recover=[];
  need(!jobs.some(j=>j.phase==='submission-unknown'),'Recover the saved bridge or Monero send before a fast send.');
  for(const [nonce,p]of Object.entries(s.proofs))if(['transfer','burn'].includes(p.envelope?.record?.op)&&!jobs.some(j=>j.proposal?.nonce===nonce&&j.phase==='finalized')&&!fast.some(j=>j.phase==='finalized'&&matchesNativeSend(p.envelope,j.intent))){
   need(matchesNativeSend(p.envelope,intent),'Recover the saved bridge or Monero send before a fast send.');recover.push(p.envelope);
  }
  need(!Object.values(s.fastOperations??{}).some(j=>j.phase==='submission-unknown'),'Recover the saved fast send before another approval.');
  return recover;
 }
 async function snapshot(intent,preparedReport){
  const report=preparedReport??await runtime.snapshot();current();need(report.complete===true&&canonical(report.manifest)===canonical(manifest)&&Array.isArray(report.reconciliation),'Fresh complete reconciled fast-send snapshot required.');
  const c=config(intent),from=report.positions?.find(p=>p.position===addresses(c).position.toBase58()),to=report.positions?.find(p=>p.position===addresses({...c,owner:intent.recipient}).position.toBase58());
  need(from?.solanaOwner===owner&&from.moneroOwner===moneroAddress&&from.available===from.balance&&BigInt(from.available)>=BigInt(intent.amount)&&to?.moneroOwner===intent.toMonero&&to.solanaOwner===intent.recipient,'Confirmed linked holders and available balance required.');
  for(const [cfg,address] of [[c,moneroAddress],[{...c,owner:intent.recipient,binding:digest(intent.toMonero)},intent.toMonero]]){
   const link=report.accepted?.find(e=>e.envelope?.record?.op==='link'&&e.envelope.record.owner===address&&e.envelope.record.to===cfg.owner)?.envelope;need(link,'Confirmed wallet link proof required.');await verifyRecipient(cfg,address,link);current();
  }
  return report;
 }
 function job(key){const j=load().fastOperations?.[key];need(j&&operationId(j.intent)===key&&j.intent.owner===owner&&j.intent.fromMonero===moneroAddress&&['network','program','mint','verifier'].every(k=>j.intent[k]===manifest[k]),'Matching saved fast-send receipt required.');checkedApproval(j.intent,j.proposal,Buffer.from(j.bytes,'base64'));return j;}
 async function check(key){const j=job(key),bytes=Buffer.from(j.bytes,'base64');await verifyDeployment(config(j.intent));current();
  // Server status cannot establish finality or allow a replacement approval.
  const finalized=await proofChain.finalizedOperation({config:config(j.intent),proposal:j.proposal,bytes});current();
  let result,phase;
  if(finalized){need(finalized.confirmed===true&&finalized.signature===bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]),'Independent fast-send confirmation differs.');result={...finalized,operationId:key,settlement:'solana'};phase='finalized';}
  else{need(j.phase!=='finalized','Saved finality could not be verified.');const out=await proofChain.pendingOutcome({bytes,lastValidBlockHeight:j.proposal.lastValidBlockHeight});current();phase=['failed','expired'].includes(out.kind)?'approval-expired':'submission-unknown';result={operationId:key,pending:phase==='submission-unknown',retryApprovalRequired:phase==='approval-expired',settlement:'solana'};}
  const s=load();need(s.fastOperations?.[key]?.bytes===j.bytes,'Saved fast-send receipt changed.');s.fastOperations[key].phase=phase;s.fastOperations[key].result=result;save(s);return result;
 }
 return Object.freeze({
  review:input=>run(async()=>{current();need(input&&Object.keys(input).every(k=>['to','recipient','amount','nonce'].includes(k))&&['to','amount','nonce'].every(k=>Object.hasOwn(input,k)),'Exact recipient, amount and nonce required.');
   // Optional UI mapping is only a display hint. Approval below authenticates
   // the exact recipient against the fresh preparation and independent link.
   let recipient=input.recipient;if(!recipient){const report=await runtime.snapshot();current();need(report.complete===true&&canonical(report.manifest)===canonical(manifest),'Matching complete fast-send snapshot required.');recipient=report.positions?.find(p=>p.moneroOwner===input.to)?.solanaOwner;}need(recipient,'Registered recipient required.');
   const intent={schema:SCHEMA,network:manifest.network,program:manifest.program,mint:manifest.mint,verifier:manifest.verifier,owner,recipient,fromMonero:moneroAddress,toMonero:input.to,amount:input.amount,nonce:input.nonce};validateIntent(intent);
   const recover=guard(intent),previous=load().fastOperations?.[operationId(intent)];need(!previous||previous.phase==='approval-expired'&&canonical(previous.intent)===canonical(intent),'Recover the exact saved fast-send receipt.');
   const review={intent,settlement:'solana',tokenFee:'0',...(recover.length?{recoversNativeSend:true}:{})};reviews.set(review,canonical(review));return review;
  }),
  approve:review=>run(async()=>{const expected=reviews.get(review);need(expected&&canonical(review)===expected,'Review the exact fast send first.');const unchanged=()=>{current();need(canonical(review)===expected,'Fast-send review changed.');};const recover=guard(review.intent);
   for(const e of recover){need(await signatureVerifier?.verify(message(e.record),e.record.owner,e.signature),'Saved native recovery signature is invalid.');unchanged();}
   const intent=structuredClone(review.intent);onProgress('Checking your linked wallets and exact amount…');await verifyDeployment(config(intent));unchanged();
   const p=await runtime.fastPrepare(intent);unchanged();need(canonical(p.intent)===canonical(intent)&&canonical(p.config)===canonical(config(intent)),'Fast-send review changed.');checkedApproval(intent,p.proposal,p.transaction.serialize(),{signed:false});
   // The fresh verifier preparation carries its own full snapshot; do not
   // replay the same history in another HTTP request before signing.
   need(p.report,'Fresh preparation snapshot required.');await snapshot(intent,p.report);unchanged();
   need(await proofChain.fastReviewFresh(p.config,p.proposal),'Fast-send approval is too close to expiry. Review again.');unchanged();guard(intent);
   onProgress('Approve this Solana-settled send in your wallet…');const tx=await approveMoveExternal(p.config,p.proposal,p.transaction.serialize(),provider);unchanged();checkedApproval(intent,p.proposal,tx.serialize());
   const s=load(),key=operationId(intent),old=s.fastOperations?.[key];need(!old||old.phase==='approval-expired'&&canonical(old.intent)===canonical(intent),'Recover the saved fast send.');
   (s.fastOperations??={})[key]={intent,proposal:p.proposal,bytes:Buffer.from(tx.serialize()).toString('base64'),phase:'submission-unknown',ownerSignature:bs58.encode(tx.signatures[0]),attempts:old?[...(old.attempts??[]),{bytes:old.bytes,proposal:old.proposal,phase:old.phase}]:[]};save(s);
   onProgress('Sending your saved transaction to Solana…');const result=await runtime.fastSubmit({intent,proposal:p.proposal,ownerSigned:tx.serialize()});current();need(result.operationId===key,'Fast-send response changed.');return check(key);
  }),
  check:key=>run(()=>check(key)),
  retry:key=>run(async()=>{const result=await check(key);if(!result.pending)return result;const j=job(key);onProgress('Checking the saved fast send…');
   // Idempotent submit recovers a request lost before server journaling; no new
   // intent, nonce, blockhash, signature or amount is created by recovery.
   await runtime.fastSubmit({intent:j.intent,proposal:j.proposal,ownerSigned:Buffer.from(j.bytes,'base64')});current();const status=await runtime.fastReconcile(key);current();need(status.operationId===key,'Fast-send status changed.');if(status.pending)await runtime.fastRetry(key);current();return check(key);
  })
 });
}
