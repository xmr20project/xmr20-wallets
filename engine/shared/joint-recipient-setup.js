import {Connection} from '@solana/web3.js';
import {identityRegistry} from './bridge-sdk/core-universal-link/mainnet-config.mjs';
import {createIdentitySolanaAdapter} from './bridge-sdk/core-universal-link/solana-adapter.mjs';
import {createIdentityHttpClient} from './bridge-sdk/core-universal-link/runtime-api.mjs';
import {createIdentityWalletClient} from './bridge-sdk/core-universal-link/wallet-client.mjs';
import {createActivationWalletClient} from './bridge-sdk/core-universal-link/activation-client.mjs';
import {identityReceiptStore,activationReceiptStore} from './bridge-sdk/core-universal-link/browser-receipts.mjs';
import {bridgeReadFetch} from './bridge-read-fetch.js';

// The same verified activation client and durable receipts as Link wallets.
// This adapter cannot create a wallet identity or sign a Monero transfer.
export function createRecipientSetup(d,{provider,endpoint,rpcEndpoint,privateTestPolicy,signal,assertCurrent}){
 const a=d.account(),store=activationReceiptStore({registry:identityRegistry,payer:a.sol});
 const runtime=createIdentityHttpClient({signal,fetcher:(p,o)=>fetch(endpoint+p,o)});
 const chain=createIdentitySolanaAdapter({connection:new Connection(d.rpcEndpoint??rpcEndpoint,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:bridgeReadFetch({signal})}),manifest:identityRegistry,privateTestPolicy});
 const identityClient=createIdentityWalletClient({registry:identityRegistry,runtime,provider,proofChain:chain,
  store:identityReceiptStore({registry:identityRegistry,owner:a.sol,moneroOwner:a.xmr}),
  moneroSigner:{address:a.xmr,sign:async()=>{throw Error('Recipient must link their own wallets.');}},
  signatureVerifier:{verify:async(text,address,signature)=>{assertCurrent();const r=await d.oneShot('joint-transferable.worker.js','verify-wallet-identity-v1',{text,address,signature});assertCurrent();return r.good===true;}}
 });
 const activation=createActivationWalletClient({registry:identityRegistry,runtime,provider,identityClient,chain,store});
 return recipientSetupFlow({activation,assertCurrent,signal,lock:fn=>{
  if(!navigator.locks)throw Error('Use a current Chrome browser for protected approvals.');
  return navigator.locks.request(store.key,{ifAvailable:true},lock=>{if(!lock)throw Error('Another window is preparing a token account. Try again when it finishes.');assertCurrent();return fn();});
 }});
}

// One explicit send click may approve the reviewed rent, then wait for finality.
// No approval is persisted here: only the activation client's signed receipt is.
export function recipientSetupFlow({activation,assertCurrent,signal,lock=fn=>fn(),attempts=30,delay=2000,
 wait=ms=>new Promise((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(Error('Send closed. Saved account approvals are kept.'));},timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();})}){
 const plans=new WeakSet();let busy=false;
 const current=()=>{assertCurrent();if(signal.aborted)throw Error('Send closed. Saved account approvals are kept.');};
 const saved=(mint,recipient)=>Object.entries(activation.receipt().operations).filter(([,j])=>j.config.mint===mint&&j.moneroOwner===recipient&&j.phase!=='approval-expired').at(-1);
 const exclusive=async fn=>{current();if(busy)throw Error('Recipient setup is already running.');busy=true;try{return await lock(async()=>{current();return fn();});}finally{busy=false;}};
 return Object.freeze({
  needsReview:plan=>!plans.has(plan),
  prepare:({mint,recipient})=>exclusive(async()=>{
   const job=saved(mint,recipient);
   const review=job?null:await activation.review({mint,recipient});current();
   const plan=Object.freeze({mint,recipient,review,operationId:job?.[0]??review.operationId,rentLamports:review?.proposal.rentLamports??null});plans.add(plan);return plan;
  }),
  confirm:plan=>exclusive(async()=>{
   if(!plans.has(plan))throw Error('Review the recipient account cost before sending.');
   let job=saved(plan.mint,plan.recipient);
   if(job&&job[0]!==plan.operationId)throw Error('Recipient setup changed. Review the send again.');
   if(!job){
    if(!plan.review)throw Error('Account approval expired. Review the send again.');
    // Never sign this plan twice, including after an ambiguous submission reply.
    plans.delete(plan);
    try{await activation.approve(plan.review);}catch(e){current();if(!saved(plan.mint,plan.recipient))throw e;}
    current();job=saved(plan.mint,plan.recipient);
    if(!job||job[0]!==plan.operationId)throw Error('Saved account approval is unavailable. Check recovery before continuing.');
    plans.add(plan);
   }
   let retried=false;
   for(let i=0;i<attempts;i++){
    let result;
    try{result=await activation.check(plan.operationId);}
    catch(e){
     current();if(retried)throw e;retried=true;
     // A request may have been lost before reaching the service. Retry only
     // the journaled bytes, after the client's independent expiry check.
     await activation.retry(plan.operationId);current();
     result=await activation.check(plan.operationId);
    }
    current();
    if(result.retryApprovalRequired){plans.delete(plan);throw Error('Account approval expired. Review the send again.');}
    if(result.confirmed)return;
    if(i+1<attempts){await wait(delay);current();}
   }
   throw Error('Account setup is still confirming. Its approval is saved. Continue this send to check again; no new setup approval is needed.');
  })
 });
}
