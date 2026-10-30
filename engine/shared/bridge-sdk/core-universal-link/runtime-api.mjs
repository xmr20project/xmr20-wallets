import {VersionedTransaction} from '@solana/web3.js';
const need=(v,m)=>{if(!v)throw Error(m);};
const fields=(v,names)=>need(v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...names].sort().join(','),'Exact identity request fields required.');
const bytes=value=>{need(typeof value==='string'&&value.length<=4000&&Buffer.from(value,'base64').toString('base64')===value,'Canonical identity transaction bytes required.');return Buffer.from(value,'base64');};
export function identityRoute(path){const m=typeof path==='string'&&path.match(/^\/api\/wallet-identity\/(snapshot|authorize|submit|reconcile|progress|activation-prepare|activation-submit|activation-reconcile|activation-retry)$/);return m?{action:m[1]}:null;}
export function createIdentityApi({runtime,index,activation}){
 return async(action,input={})=>{
  need(identityRoute('/api/wallet-identity/'+action),'Identity method is not permitted.');
  if(action.startsWith('activation-')){
   need(activation,'Asset activation is not enabled.');
   if(action==='activation-prepare'){fields(input,['mint','recipient','payer']);const r=await activation.prepare(input);return {...r,transaction:Buffer.from(r.transaction.serialize()).toString('base64')};}
   if(action==='activation-submit'){fields(input,['reviewId','transaction']);return activation.submit({reviewId:input.reviewId,payerSigned:bytes(input.transaction)});}
   fields(input,['operationId']);need(typeof input.operationId==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}:activation:[a-f0-9]{64}$/.test(input.operationId),'Activation operation identifier required.');
   return activation[action==='activation-retry'?'retry':'reconcile'](input.operationId);
  }
  if(action==='snapshot'){fields(input,[]);return index.snapshot();}
  if(action==='authorize'){fields(input,['envelope']);const r=await runtime.authorize(input.envelope);return {...r,transaction:Buffer.from(r.transaction.serialize()).toString('base64')};}
  if(action==='submit'){fields(input,['reviewId','transaction']);need(typeof input.reviewId==='string'&&/^[a-f0-9]{64}$/.test(input.reviewId),'Identity review identifier required.');return runtime.submit({reviewId:input.reviewId,ownerSigned:bytes(input.transaction)});}
  if(['reconcile','progress'].includes(action)){fields(input,['operationId']);need(typeof input.operationId==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}:identity:[a-f0-9]{64}$/.test(input.operationId),'Identity operation identifier required.');return runtime[action](input.operationId);}
  throw Error('Identity method is not permitted.');
 };
}
export function createIdentityHttpClient({fetcher=fetch,signal}){
 const call=async(action,input)=>{
  const response=await fetcher('/api/wallet-identity/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),credentials:'omit',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});
  const text=await response.text();need(text.length<=1000000&&response.ok,'Wallet linking is temporarily unavailable. Your saved approval is kept.');return JSON.parse(text);
 };
 return Object.freeze({prepareActivation:async input=>{const r=await call('activation-prepare',input);return {...r,transaction:VersionedTransaction.deserialize(bytes(r.transaction))};},submitActivation:({reviewId,payerSigned})=>call('activation-submit',{reviewId,transaction:Buffer.from(payerSigned).toString('base64')}),reconcileActivation:operationId=>call('activation-reconcile',{operationId}),retryActivation:operationId=>call('activation-retry',{operationId}),snapshot:()=>call('snapshot',{}),authorize:async envelope=>{const r=await call('authorize',{envelope});return {...r,transaction:VersionedTransaction.deserialize(bytes(r.transaction))};},submit:({reviewId,ownerSigned})=>call('submit',{reviewId,transaction:Buffer.from(ownerSigned).toString('base64')}),reconcile:operationId=>call('reconcile',{operationId}),progress:operationId=>call('progress',{operationId})});
}
