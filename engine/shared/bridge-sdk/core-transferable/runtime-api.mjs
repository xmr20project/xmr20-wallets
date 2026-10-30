import {VersionedTransaction} from '@solana/web3.js';
const need=(v,m)=>{if(!v)throw Error(m);};
const fields=(v,allowed,required=allowed)=>{need(v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(v,k)),'Unexpected transferable request fields.');};
const bytes=s=>{need(typeof s==='string'&&s.length<4000&&Buffer.from(s,'base64').toString('base64')===s,'Invalid public transaction encoding.');return Buffer.from(s,'base64');};
const serialize=p=>({...p,transaction:Buffer.from(p.transaction.serialize()).toString('base64')});
// Only fixed public classifications are shown. Never copy upstream error text,
// response bodies, URLs or arbitrary reason values into a wallet message.
const publicFailures=new Map([
 ['fast-approvals-paused',['send-paused','New fast sends are paused. Your balances and saved transaction recovery remain available.']],
 ['saved-native-send-unresolved',['native-send-recovery-required','Your earlier Monero send still needs recovery. Its saved approval is kept; check that transfer before starting a fast send.']],
 ['saved-fast-send-unresolved',['fast-send-recovery-required','A saved fast send is still pending. Check that transfer before starting another.']],
 ['index-catch-up-required',['index-sync','Bridge syncing recent Monero blocks. Saved approvals are kept.']],
 ...['index-evidence-stale','index-page-stale'].map(reason=>[reason,['index-sync','The bridge is refreshing confirmed Monero history. Saved approvals are kept.']]),
 ['launch-evidence-stale',['bridge-verification-delayed','The token verification took too long. Your saved approvals are kept. Check status before approving again.']],
 ...['native-transactions-incomplete','native-coverage-incomplete','native-membership-changed'].map(reason=>[reason,['bridge-verification-incomplete','The bridge could not finish checking Monero records. Your saved approvals are kept. Check status again.']]),
 ...['native-checkpoint-disagreement','native-height-disagreement','index-checkpoint-changed','index-anchor-changed','index-deep-reorganization'].map(reason=>[reason,['bridge-verification-conflict','The bridge paused because its chain checks disagree. Your saved approvals are kept. Check status before approving again.']]),
 ['carrier-not-ready',['bridge-not-ready','The bridge’s Monero service is still preparing. Your saved approvals are kept. Check status shortly.']],
 ['protected-transport-unavailable',['bridge-service-unavailable','The bridge’s verification service is temporarily unavailable. Your saved approvals are kept. Check status again.']],
 ['verification-unavailable',['bridge-verification-unavailable','The bridge could not verify this request. Your saved approvals are kept. Check status before approving again.']]
]);
// Existing clients retain their pinned manifest and native-send flow. The
// server still replays every settlement receipt; capability negotiation changes
// the response profile, never balances, custody or proof requirements.
function legacyReport(report){if(!report?.manifest?.fastSend)return report;const {fastSend,...manifest}=report.manifest;return {...report,manifest};}
export function createRuntimeApi({runtime}){
 return async(action,input={})=>{
  if(['fast-snapshot','fast-readiness'].includes(action)){fields(input,[]);need(runtime.fast,'Fast Solana settlement is not enabled.');return runtime[action.slice(5)]();}
  if(action.startsWith('fast-')){
   need(runtime.fast,'Fast Solana settlement is not enabled.');
   if(action==='fast-prepare'){fields(input,['intent']);return serialize(await runtime.fast.prepare(input.intent));}
   if(action==='fast-submit'){fields(input,['intent','proposal','transaction']);return runtime.fast.submit({intent:input.intent,proposal:input.proposal,ownerSigned:bytes(input.transaction)});}
   if(['fast-reconcile','fast-retry'].includes(action)){fields(input,['operationId']);return runtime.fast[action.slice(5)](input.operationId);}
   throw Error('Fast-send method is not permitted.');
  }
  if(action==='readiness'){fields(input,[]);return legacyReport(await runtime.readiness());}
  if(action==='progress'){fields(input,['operationId']);return runtime.progress(input.operationId);}
  if(action==='snapshot'){fields(input,[]);return legacyReport(await runtime.snapshot());}
  if(action==='prepare'){
   fields(input,['operation','envelope','actor','recipient','amount','nonce','authorize'],['operation']);
   if(Object.hasOwn(input,'authorize')){fields(input,['operation','envelope','authorize']);need(input.authorize===true&&['transfer','release'].includes(input.operation)&&input.envelope?.record?.op===(input.operation==='transfer'?'transfer':'burn'),'Only an exact holder move may be preauthorized.');return serialize(await runtime.authorizeMove(input.envelope));}
   if(['register','transfer','release'].includes(input.operation))fields(input,['operation','envelope']);else fields(input,['operation','actor','recipient','amount','nonce']);
   return serialize(await runtime.prepare(input));
  }
  if(action==='authorize-registration'){fields(input,['envelope']);return serialize(await runtime.authorizeRegistration(input.envelope));}
  if(action==='submit'){fields(input,['config','proposal','envelope','transaction']);return runtime.submit({config:input.config,proposal:input.proposal,envelope:input.envelope,ownerSigned:bytes(input.transaction)});}
  if(action==='publish'){fields(input,['envelope']);return runtime.publish(input.envelope);}
  if(action==='reconcile'){fields(input,['operationId']);return runtime.reconcile(input.operationId);}
  if(action==='retry'){fields(input,['operationId']);return runtime.retry(input.operationId);}
  throw Error('Transferable bridge method is not permitted.');
 };
}
// A snapshot has no request body and describes the same service state for every
// concurrent reader, so one in-flight read is shared per scope and mint. Results
// are never retained: each later call issues a fresh request. The shared fetch
// is aborted only when every subscriber has gone.
const sharedSnapshots=new Map();let clientInstances=0;
function sharedRead(key,start,signal){
 if(signal?.aborted)return Promise.reject(signal.reason);
 let entry=sharedSnapshots.get(key);
 if(!entry){
  const controller=new AbortController();entry={controller,subscribers:0};
  entry.promise=start(controller.signal).finally(()=>{if(sharedSnapshots.get(key)===entry)sharedSnapshots.delete(key);});
  entry.promise.catch(()=>{});sharedSnapshots.set(key,entry);
 }
 entry.subscribers++;
 return new Promise((resolve,reject)=>{
  let done=false;
  const leave=()=>{if(done)return;done=true;signal?.removeEventListener('abort',onAbort);if(--entry.subscribers===0){
   // A closed view must not strand a reopened one behind an aborted fetch.
   // Detach before aborting: its later settlement cannot evict a fresh read.
   if(sharedSnapshots.get(key)===entry)sharedSnapshots.delete(key);entry.controller.abort(signal?.reason);
  }};
  const onAbort=()=>{reject(signal.reason);leave();};
  if(signal?.aborted){onAbort();return;}
  signal?.addEventListener('abort',onAbort,{once:true});
  entry.promise.then(value=>{resolve(value);leave();},error=>{reject(error);leave();});
 });
}
export function createRuntimeHttpClient({fetcher=fetch,endpoint,signal,shareKey,fastSettlement=false}){
 need(typeof endpoint==='string'&&/^\/api\/joint-transferable\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(endpoint),'Explicit same-origin transferable mint endpoint required.');
 const snapshotKey=(typeof shareKey==='string'?'shared:'+shareKey:'instance:'+(++clientInstances))+'|'+endpoint+'|'+(fastSettlement?'fast':'legacy');
 async function call(action,input={},requestSignal=signal){
  const mutation=!['readiness','progress','snapshot','fast-readiness','fast-snapshot'].includes(action);
  // Do not let a read begun before or during a mutation supply the next
  // signing/balance check. Existing readers keep their own result and signal.
  if(mutation)sharedSnapshots.delete(snapshotKey);
  try{const r=await fetcher(endpoint+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),credentials:'omit',redirect:'error',cache:'no-store',signal:requestSignal?AbortSignal.any([requestSignal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});const text=await r.text();need(text.length<=1000000,'Oversized public bridge response.');
  if(!r.ok){
   let known;try{if(r.status===503)known=publicFailures.get(JSON.parse(text)?.reason);}catch{}
   const error=Error(known?.[1]??'Transferable service unavailable. Keep the public recovery receipt.');
   if(known)error.code=known[0];throw error;
  }
  return JSON.parse(text);
 }catch(error){if(error?.name==='TimeoutError'){const timeout=Error('The bridge took too long to respond. Your saved approvals are kept. Check status before approving again.');timeout.name='TimeoutError';timeout.code='bridge-timeout';throw timeout;}throw error;}finally{if(mutation)sharedSnapshots.delete(snapshotKey);}}
 return Object.freeze({fastPrepare:async intent=>{const p=await call('fast-prepare',{intent});return {...p,transaction:VersionedTransaction.deserialize(bytes(p.transaction))};},fastSubmit:i=>call('fast-submit',{intent:i.intent,proposal:i.proposal,transaction:Buffer.from(i.ownerSigned).toString('base64')}),fastReconcile:operationId=>call('fast-reconcile',{operationId}),fastRetry:operationId=>call('fast-retry',{operationId}),readiness:()=>call(fastSettlement?'fast-readiness':'readiness'),progress:operationId=>call('progress',{operationId}),snapshot:()=>sharedRead(snapshotKey,shared=>call(fastSettlement?'fast-snapshot':'snapshot',{},shared),signal),prepare:async i=>{const p=await call('prepare',i);return {...p,transaction:VersionedTransaction.deserialize(bytes(p.transaction))};},authorizeRegistration:async envelope=>{const p=await call('authorize-registration',{envelope});return {...p,transaction:VersionedTransaction.deserialize(bytes(p.transaction))};},authorizeMove:async envelope=>{const p=await call('prepare',{operation:envelope.record.op==='transfer'?'transfer':'release',envelope,authorize:true});return {...p,transaction:VersionedTransaction.deserialize(bytes(p.transaction))};},submit:i=>call('submit',{config:i.config,proposal:i.proposal,envelope:i.envelope,transaction:Buffer.from(i.ownerSigned).toString('base64')}),publish:envelope=>call('publish',{envelope}),reconcile:operationId=>call('reconcile',{operationId}),retry:operationId=>call('retry',{operationId})});
}
