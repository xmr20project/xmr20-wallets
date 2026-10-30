import {Connection} from '@solana/web3.js';
import {walletIdentityRegistry as identityRegistry} from './joint-deployment.js';
import {createIdentitySolanaAdapter} from './bridge-sdk/core-universal-link/solana-adapter.mjs';
import {createIdentityHttpClient} from './bridge-sdk/core-universal-link/runtime-api.mjs';
import {createIdentityWalletClient} from './bridge-sdk/core-universal-link/wallet-client.mjs';
import {createActivationWalletClient} from './bridge-sdk/core-universal-link/activation-client.mjs';
import {identityReceiptStore,activationReceiptStore} from './bridge-sdk/core-universal-link/browser-receipts.mjs';
import {digest} from './bridge-sdk/core-universal-link/records.mjs';
import {jointAccountProvider} from './joint-account.js';
import {bridgeReadFetch} from './bridge-read-fetch.js';
const defaults={createIdentitySolanaAdapter,createIdentityHttpClient,createIdentityWalletClient,createActivationWalletClient,identityReceiptStore,activationReceiptStore};
// A routing hint only. The link UI still validates receipts and live status.
export function hasSavedUniversalLink(account,{storage=localStorage}={}){
 const receipt=identityReceiptStore({registry:identityRegistry,owner:account.sol,moneroOwner:account.xmr,storage}).load();
 return Object.values(receipt?.operations??{}).some(job=>job.config?.owner===account.sol&&job.phase!=='approval-expired');
}
export function createUniversalLinkUI(d,{endpoint,rpcEndpoint,privateTestPolicy,onBack,adapters=defaults,setTimer=setTimeout,clearTimer=clearTimeout}){
 let current;const esc=d.esc,$=id=>d.getElement?d.getElement(id):document.getElementById(id);
 const clear=()=>{if(current){current.abort.abort();clearTimer(current.timer);current=null;}};
 const assert=s=>{d.same(s.epoch);const a=d.account();if(current!==s||s.abort.signal.aborted||!d.modal.open||a.sol!==s.owner||a.xmr!==s.monero||a.id!==s.accountId)throw Error('Wallet changed or closed. Your saved approvals are kept.');};
 const jobs=s=>Object.entries(s.client.receipt().operations).filter(([,j])=>j.config.owner===s.owner);
 const activationJobs=s=>Object.entries(s.activation.receipt().operations).filter(([,j])=>j.config.mint===s.mint&&j.moneroOwner===s.recipient);
 const unresolved=s=>jobs(s).some(([,j])=>j.phase!=='approval-expired')||activationJobs(s).some(([,j])=>j.phase==='submission-unknown');
 const bind=(s,id,fn)=>d.on(id,()=>void act(s,fn));
 async function act(s,fn){if(s.busy||d.isBusy?.())return;s.busy=true;s.error='';paint(s);try{await d.run(async()=>{try{assert(s);if(!navigator.locks)throw Error('Use a current Chrome browser for protected approvals.');await navigator.locks.request(s.store.key,{ifAvailable:true},async lock=>{if(!lock)throw Error('Another window is approving this wallet link.');assert(s);await navigator.locks.request(s.activationStore.key,{ifAvailable:true},async activationLock=>{if(!activationLock)throw Error('Another window is preparing a token account.');await fn();assert(s);});});}catch(e){if(current===s)s.error=e.message;}});}catch(e){if(current===s)s.error=e.message;}finally{if(current===s){s.busy=false;paint(s);schedule(s);}}}
 async function refresh(s){
  assert(s);const saved=jobs(s).at(-1),activation=activationJobs(s).at(-1);
  if(activation&&activation[1].phase==='submission-unknown'){const r=await s.activation.check(activation[0]);assert(s);if(r.confirmed)s.activated=true;}
  if(saved&&saved[1].phase!=='approval-expired'){
   if(saved[1].phase!=='finalized')await s.client.check(saved[0]);assert(s);
   if(jobs(s).at(-1)?.[1].phase==='approval-expired'){s.progress=null;s.identity=await s.client.lookup(s.recipient);}
   else s.progress=await s.runtime.progress(saved[0]);assert(s);
   if(s.progress?.phase==='complete')s.identity=await s.client.lookup(s.recipient);
  }else s.identity=await s.client.lookup(s.recipient);
  // For sender-paid activation, the recipient's global identity is independent
  // of the sender's own pending setup, which must not block a legacy send.
  if(s.recipient!==s.monero)s.identity=await s.client.lookup(s.recipient);
  assert(s);if(s.identity&&s.recipient===s.monero&&s.identity.solanaOwner!==s.owner){s.identity=null;s.checked=false;throw Error('This Monero address is linked to another Solana wallet. Reopen the original wallet pair. Existing token balances and recovery remain available.');}s.checked=true;
  // Activation preparation is unsigned; expose its exact rent before approval.
  if(s.identity&&s.mint&&!s.activated&&!s.activationReview&&activation?.[1].phase!=='submission-unknown')s.activationReview=await s.activation.review({mint:s.mint,recipient:s.recipient});
  assert(s);
  if((s.activated||s.identity&&!s.mint)&&!s.continued){s.continued=true;setTimer(()=>{if(current===s){clear();onBack?.();}},0);}
 }
 function schedule(s){clearTimer(s.timer);if(current!==s||s.busy||s.activated)return;const pending=jobs(s).some(([,j])=>j.phase!=='approval-expired')&&!s.identity||activationJobs(s).some(([,j])=>j.phase==='submission-unknown');if(!pending)return;
  s.timer=setTimer(()=>{if(current!==s)return;if(document.hidden||d.isBusy?.()){schedule(s);return;}void act(s,()=>refresh(s));},10000);
 }
 function paint(s){
  assert(s);const saved=jobs(s).at(-1),activation=activationJobs(s).at(-1),p=s.progress,txid=p?.publication?.txid,count=p?.publication?.confirmations;
  let body='',pendingLink=false;
  if(s.activated)body='<h3>Token ready</h3><p>The recipient’s token account is ready. Continue to review the exact transfer.</p><button class="primary wide" id="identity-back">Continue</button>';
  else if(s.activationReview)body=`<h3>Prepare ${esc(s.symbol||'token')} account</h3><p>Create this token’s receiving account once. Your Solana wallet pays the setup fee; no tokens move.</p><div class="review-line"><span>Estimated account cost</span><strong>${(s.activationReview.proposal.rentLamports/1e9).toFixed(6)} SOL</strong></div><button class="primary wide" id="identity-activate-approve" ${s.busy?'disabled':''}>Enable token</button>`;
  else if(activation?.[1].phase==='submission-unknown')body='<h3>Preparing token account</h3><p class="joint-busy" data-loading="true" role="status">Waiting for Solana confirmation…</p><p>Your approval is saved. No new approval is needed while its result is unknown.</p>';
  else if(s.identity){
   const own=s.recipient===s.monero;
   body=`<h3>${own?'Wallets linked':'Recipient is linked'}</h3><p>${own?'This wallet pair is linked for supported XMR20 tokens. You won’t repeat identity setup for each token.':'The recipient can receive supported tokens without linking again.'}</p>${s.mint?`<button class="primary wide" id="identity-activate" ${s.busy?'disabled':''}>Prepare ${esc(s.symbol||'token')} account</button><p class="subtle">You pay the Solana account cost. No tokens move during setup.</p>`:'<button class="primary wide" id="identity-back">Done</button>'}`;
  }else if(s.recipient!==s.monero&&s.checked)body='<h3>Recipient has not linked yet</h3><p>Ask the recipient to choose Link your wallets once in their wallet. They need a confirmed universal link before you can prepare this token for them.</p>';
  else if(s.review)body=`<h3>Confirm your wallet link</h3><p>Link these wallets once to use the earlier bridge; the link is public and permanent. SOL setup fees apply, and no tokens move.</p><button class="primary wide" id="identity-approve" ${s.busy?'disabled':''}>Link wallets</button>`;
  else if(saved&&saved[1].phase!=='approval-expired'){
   pendingLink=true;
   const published=typeof txid==='string'&&/^[a-f0-9]{64}$/.test(txid);
   const knownCount=published&&Number.isSafeInteger(count)&&count>=0;
   const solanaConfirmed=saved[1].phase==='finalized'||['finalized','monero-pending','complete'].includes(p?.phase);
   const status=published?(knownCount&&count>=10?'Monero confirmations complete. Finishing your wallet link…':'Waiting for Monero confirmations…'):!p?'Checking your saved wallet link…':solanaConfirmed?'Preparing Monero publication…':'Waiting for Solana confirmation…';
   body=`<h3>Linking your wallets</h3><p class="joint-busy" data-loading="true" role="status">${status}</p><div class="review-line"><span>Monero confirmations</span><strong>${published?(knownCount?Math.min(count,10)+'/10':'Checking…'):p?'Awaiting publication':'Checking…'}</strong></div>${published?`<a href="https://xmrchain.net/tx/${esc(txid)}" target="_blank" rel="noopener noreferrer">View Monero transaction</a><p class="subtle">${knownCount&&count>=10?'Confirmations are complete. Checking that your wallet link is ready.':'Allow about 20 minutes for ten confirmations after publication. Network timing varies.'}</p>`:p?`<p class="subtle">${solanaConfirmed?'Your Solana approval is confirmed. ':''}Monero confirmations start once your wallet link is published.</p>`:''}<p>You can close the wallet. Your approved link continues in the background.</p>`;
  }else body=`<h3>Link wallets</h3><p>Link these wallets once to use the earlier bridge; the link is public and permanent. SOL setup fees apply, and no tokens move.</p><button class="primary wide" id="identity-review" ${s.busy||!s.checked?'disabled':''}>Link wallets</button>`;
  const details=`<details><summary>Wallet link details</summary><label>Solana wallet${s.recipient!==s.monero?' paying for setup':''}</label><div class="address">${esc(s.owner)}</div><label>Monero ${s.recipient!==s.monero?'recipient':'wallet'}</label><div class="address">${esc(s.recipient)}</div><p class="subtle">The deployment wallet can upgrade this bridge. Transfers still need their own approvals.</p></details>`;
  d.show('Link wallets',`<div class="joint-transferable universal-link">${body}${s.busy&&!pendingLink?'<p class="subtle joint-busy" data-loading="true" role="status">Checking the exact wallet link…</p>':''}${s.error?`<p role="alert">${esc(s.error)}</p><button class="secondary wide" id="identity-check" ${s.busy?'disabled':''}>Check saved status</button>`:''}${details}<details id="identity-recovery"><summary>Activity & recovery</summary>${saved?`<a href="https://solscan.io/tx/${esc(saved[1].signature)}" target="_blank" rel="noopener noreferrer">View wallet link on Solana</a>`:''}${activation?`<a href="https://solscan.io/tx/${esc(activation[1].signature)}" target="_blank" rel="noopener noreferrer">View account setup on Solana</a>`:''}${saved?.[1].phase==='submission-unknown'?'<button class="text-btn wide" id="identity-resend">Resend saved wallet link</button>':''}<button class="secondary wide" id="identity-check-saved" ${s.busy?'disabled':''}>Check status</button>${activation?.[1].phase==='submission-unknown'?'<button class="text-btn wide" id="identity-activation-retry">Resend saved account setup</button>':''}<button class="text-btn wide" id="identity-export">Save public recovery receipts</button><label for="identity-import">Import public recovery receipts</label><input id="identity-import" type="file" accept=".json,application/json"></details>${s.activated||s.identity&&!s.mint?'':`<button class="text-btn wide" id="identity-back" ${s.busy?'disabled':''}>${unresolved(s)?'Back':'Cancel'}</button>`}</div>`);
  bind(s,'identity-review',async()=>{const proof=Object.values(s.client.receipt().proofs).at(-1);const r=await s.client.review(proof?.envelope.record.nonce??digest(crypto.randomUUID()));assert(s);await s.client.approve(r);await refresh(s);});
  bind(s,'identity-approve',async()=>{const r=s.review;s.review=null;await s.client.approve(r);await refresh(s);});
  bind(s,'identity-activate',async()=>{s.activationReview=await s.activation.review({mint:s.mint,recipient:s.recipient});});
  bind(s,'identity-activate-approve',async()=>{const r=s.activationReview;s.activationReview=null;await s.activation.approve(r);await refresh(s);});
  for(const id of ['identity-check','identity-check-saved'])bind(s,id,()=>refresh(s));
  bind(s,'identity-resend',async()=>{await s.client.retry(saved[0]);await refresh(s);});
  bind(s,'identity-activation-retry',async()=>{await s.activation.retry(activation[0]);await refresh(s);});
  d.on('identity-back',()=>{if(s.busy)return;clear();onBack?.();});
  d.on('identity-export',()=>{assert(s);const value={schema:'wallet-link-recovery-v1',identity:s.client.receipt(),activation:s.activation.receipt()},url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='xmr20-wallet-link-public-receipts.json';a.click();setTimer(()=>URL.revokeObjectURL(url),30000);});
  const input=$('identity-import');if(input)input.onchange=()=>void act(s,async()=>{const f=input.files[0];if(!f||f.size>2000000)throw Error('Choose public recovery receipts under 2 MB.');const v=JSON.parse(await f.text());assert(s);if(v?.schema!=='wallet-link-recovery-v1'||s.store.load()||s.activationStore.load())throw Error('Keep existing receipts. Import only into the matching wallet with no saved identity receipts.');s.store.save(v.identity);s.activationStore.save(v.activation);await refresh(s);});
 }
 async function open({mint,symbol,recipient}={}){
  clear();await d.run(async epoch=>{const a=d.account(),s={epoch,accountId:a.id,owner:a.sol,monero:a.xmr,recipient:recipient||a.xmr,mint,symbol,abort:new AbortController(),busy:false,checked:false};current=s;
   const guard=()=>assert(s),provider=d.provider?d.provider(guard):jointAccountProvider({account:d.account,assert:guard});
   s.store=adapters.identityReceiptStore({registry:identityRegistry,owner:s.owner,moneroOwner:s.monero});s.activationStore=adapters.activationReceiptStore({registry:identityRegistry,payer:s.owner});
   s.runtime=adapters.createIdentityHttpClient({signal:s.abort.signal,fetcher:(p,o)=>fetch(endpoint+p,o)});
   const chain=adapters.createIdentitySolanaAdapter({connection:new Connection(d.rpcEndpoint??rpcEndpoint,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:bridgeReadFetch({signal:s.abort.signal})}),manifest:identityRegistry,privateTestPolicy});
   const signatureVerifier={verify:async(text,address,signature)=>{assert(s);const r=await d.oneShot('joint-transferable.worker.js','verify-wallet-identity-v1',{text,address,signature});assert(s);return r.good===true;}};
   s.client=adapters.createIdentityWalletClient({registry:identityRegistry,runtime:s.runtime,provider,proofChain:chain,store:s.store,signatureVerifier,moneroSigner:{address:s.monero,sign:async(review,context)=>{assert(s);const r=d.signMonero?await d.signMonero(review,context,s.abort.signal):await d.oneShot('joint-transferable.worker.js','sign-wallet-identity-v1',{seed:d.account().xmrSeed,review,context});assert(s);return r.signature;}}});
   s.activation=adapters.createActivationWalletClient({registry:identityRegistry,runtime:s.runtime,provider,identityClient:s.client,chain,store:s.activationStore});
   s.busy=true;paint(s);try{if(!navigator.locks)throw Error('Use a current Chrome browser for protected approvals.');await navigator.locks.request(s.activationStore.key,{ifAvailable:true},async lock=>{if(!lock)throw Error('Another window is preparing a token account.');assert(s);await refresh(s);});}catch(e){if(current===s)s.error=e.message;}finally{if(current===s){s.busy=false;paint(s);schedule(s);}}
  });
 }
 return {open,clear};
}
