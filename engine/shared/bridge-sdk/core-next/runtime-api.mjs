import {VersionedTransaction} from '@solana/web3.js';
const need=(v,m)=>{if(!v)throw Error(m);};
const fields=(value,list)=>need(value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===list.sort().join(','),'Unexpected public bridge request fields.');
const bytes=s=>{need(typeof s==='string'&&s.length<4000&&Buffer.from(s,'base64').toString('base64')===s,'Invalid signed bridge transaction.');return Buffer.from(s,'base64');};
const prepared=p=>({config:p.config,proposal:p.proposal,transaction:Buffer.from(p.transaction.serialize()).toString('base64')});
// Public owner-authorized API. No key import, generic signing, arbitrary relay,
// private wallet diagnostics or caller-supplied "confirmed" flags.
export function createRuntimeApi({runtime,manifest,checkReadiness}){
 need(runtime&&typeof checkReadiness==='function','A configured runtime and fresh readiness check are required.');
 return async(action,input={})=>{
  if(action==='readiness'){fields(input,[]);await checkReadiness();return {schema:'joint-mainnet-readiness-v2',ready:true,manifest};}
  await checkReadiness();
  if(action==='prepare-deposit'){fields(input,['owner','moneroAddress','id','amount']);return prepared(await runtime.prepareDeposit(input));}
  if(action==='submit-deposit'||action==='release'){fields(input,['config','proposal','transaction']);const ownerSigned=bytes(input.transaction);VersionedTransaction.deserialize(ownerSigned);return action==='release'?runtime.release({...input,ownerSigned}):runtime.submitDeposit({...input,ownerSigned});}
  if(action==='deposit-status'){fields(input,['signature']);return runtime.depositStatus(input.signature);}
  if(action==='deposit-outcome'){fields(input,['config']);return runtime.depositOutcome(input.config);}
  if(action==='publish'){fields(input,['envelope']);return runtime.publish(input.envelope);}
  if(action==='snapshot'){fields(input,[]);return runtime.snapshot();}
  if(action==='prepare-return'){fields(input,['position','owner','burnTxid','amount']);return prepared(await runtime.prepareReturn(input));}
  if(action==='reconcile'){fields(input,['position','burnTxid']);return runtime.reconcile(input.position,input.burnTxid);}
  if(action==='retry-return'){fields(input,['position']);return runtime.retryPending(input.position);}
  throw Error('Bridge method is not permitted.');
 };
}
export function createRuntimeHttpClient({fetcher=fetch,endpoint='/api/joint-mainnet',signal}={}){
 need(endpoint.startsWith('/')&&!endpoint.startsWith('//'),'Use the explicit same-origin bridge API.');
 // A request can perform several fresh proofs and durable publication steps.
 // Its transport deadline is separate from the unchanged 30-second proof age.
 async function call(action,input={}){const r=await fetcher(endpoint+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),credentials:'omit',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});need(r.ok,'Bridge service is unavailable. Keep the saved receipt and retry its status.');const s=await r.text();need(s.length<=1000000,'Bridge response exceeds the public limit.');return JSON.parse(s);}
 const prepare=async(action,input)=>{const p=await call(action,input);need(typeof p.transaction==='string'&&p.transaction.length<4000,'Invalid bridge review.');return {...p,transaction:VersionedTransaction.deserialize(bytes(p.transaction))};};
 return Object.freeze({readiness:()=>call('readiness'),prepareDeposit:i=>prepare('prepare-deposit',i),submitDeposit:i=>call('submit-deposit',{config:i.config,proposal:i.proposal,transaction:Buffer.from(i.ownerSigned).toString('base64')}),depositStatus:signature=>call('deposit-status',{signature}),depositOutcome:config=>call('deposit-outcome',{config}),publish:envelope=>call('publish',{envelope}),snapshot:()=>call('snapshot'),prepareReturn:i=>prepare('prepare-return',i),release:i=>call('release',{config:i.config,proposal:i.proposal,transaction:Buffer.from(i.ownerSigned).toString('base64')}),reconcile:(position,burnTxid)=>call('reconcile',{position,burnTxid}),retryPending:position=>call('retry-return',{position})});
}
