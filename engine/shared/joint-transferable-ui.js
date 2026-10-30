import {matchesNativeSend} from './bridge-sdk/core-fast-send/records.mjs';
import {createRecipientSetup} from './joint-recipient-setup.js';
import {createUniversalLinkUI,hasSavedUniversalLink} from './universal-link-ui.js';
import {bridgeTokenPanels,bridgeInputDisplay,moneroSendView} from './joint-bridge-view.js';
import {readBridgeDisplay,saveBridgeDisplay} from './bridge-display.js';
import {requestLifetime,untilClosed} from './request-lifetime.js';
import {bridgeReadFetch} from './bridge-read-fetch.js';
import {inputAmount,maximumRaw,TOKEN_TRANSFER_LIMIT} from '../token/max-amount.js';
import {solanaTokenMaximum} from './solana-max.js';
import {Connection} from '@solana/web3.js';
import {discoveredAssets,jointTokenLabel,loadJointCatalog,rememberJointAsset,savedJointAssets,XMR20_MINT} from './joint-bridge-assets.js';
import {walletBridgeAssets,hasBridgeRecovery,isBridgeHolding} from './joint-wallet-assets.js';
import {jointAmount,jointUnits} from './joint-mainnet-ui.js';
// Display only (26 Oct 2026): exact amount with thousands separators and no trailing zeros. Inputs keep jointUnits.
const jointShow=n=>{const [whole,fraction]=jointUnits(n).split('.');const grouped=whole.replace(/\B(?=(\d{3})+(?!\d))/g,','),trimmed=fraction.replace(/0+$/,'');return trimmed?grouped+'.'+trimmed:grouped;};
import {jointAccountProvider} from './joint-account.js';
import {jointProgress} from './joint-progress.js';
import {createReviewWait} from './joint-review-wait.js';
import {jointWaiting} from './joint-waiting.js';
import {jointService,bridgeConnectionMessage} from './joint-service.js';
import {createJointCreditPreview} from './joint-credit-preview.js';
import {createJointReturnFlow} from './joint-return-flow.js';
import {walletManifest as transferableManifest,universalLinkEnabled} from './joint-deployment.js';
import {canonical,digest} from './bridge-sdk/core-transferable/records.mjs';
import {moneroOwner} from './bridge-sdk/core-next/records.mjs';
import {addresses,receiptAddress} from './bridge-sdk/core-transferable/sdk.mjs';
import {publicReceiptStore} from './bridge-sdk/core-transferable/browser-receipts.mjs';
import {createSolanaAdapter} from './bridge-sdk/core-transferable/solana-adapter.mjs';
import {createRuntimeHttpClient} from './bridge-sdk/core-transferable/runtime-api.mjs';
import {createWalletClient} from './bridge-sdk/core-transferable/wallet-client.mjs';
import {PRIVATE_TEST_POLICY,WALLET_TEST_POLICY,privateTestConfig} from './bridge-sdk/core-transferable/private-test.mjs';
import {supportedMint} from './bridge-sdk/core-next/mint-policy.mjs';
const privateBuild=typeof __XMR20_JOINT_PRIVATE_TEST__!=='undefined'&&__XMR20_JOINT_PRIVATE_TEST__;
const walletTestBuild=typeof __XMR20_JOINT_WALLET_TEST__!=='undefined'&&__XMR20_JOINT_WALLET_TEST__;
const services={createSolanaAdapter,createRuntimeHttpClient,createWalletClient,publicReceiptStore};
const nonce=()=>digest(crypto.randomUUID());
export function createJointTransferableUI(d,{legacy,previous,adapters=services,privateTest=privateBuild,walletTest=walletTestBuild,setTimer=setTimeout,clearTimer=clearTimeout,previewOptions={},reviewWaitOptions={},lifetimeOptions={},endpoint:serviceEndpoint,snapshotShareKey,loadCatalog=adapters===services?loadJointCatalog:null,linkOptions={}}={}){
 const {enabled:linkEnabled=universalLinkEnabled,hasSaved:hasSavedLink=hasSavedUniversalLink,createUI:createLinkUI=createUniversalLinkUI,createRecipientSetup:setupRecipient=createRecipientSetup}=linkOptions;
 privateTest=privateTest||walletTest;const limitedTest=privateTest&&!walletTest;
 const testPolicy=walletTest?WALLET_TEST_POLICY:privateTest?PRIVATE_TEST_POLICY:undefined,{endpoint,rpcEndpoint}=jointService({privateTest,walletTest,endpoint:serviceEndpoint});
 const canSign=a=>d.canSign?d.canSign(a):!!(a?.solSecret&&a.xmrSeed&&!a.watch);
 const tokenBalance=(owner,mint)=>d.tokenBalance?d.tokenBalance(owner,mint):solanaTokenMaximum(owner,mint);
 let current=null,working=false,identityUI=null;
 const $=id=>d.getElement?d.getElement(id):document.getElementById(id),esc=d.esc;
 const progressDocument={getElementById:$,get hidden(){return document.hidden;},addEventListener:(...args)=>document.addEventListener(...args),removeEventListener:(...args)=>document.removeEventListener(...args)};
 function clear(){identityUI?.clear();identityUI=null;current?.lifetime?.close();current?.returnFlow?.close();current?.preview?.close();current?.reviewWait?.close();clearTimer(current?.pollTimer);current?.progress?.stop();current?.abort.abort();current=null;working=false;}
 function assert(s){d.same(s.epoch);const a=d.account();if(current!==s||s.abort.signal.aborted||!d.modal.open||a?.id!==s.accountId||a.sol!==s.owner||a.xmr!==s.monero||!canSign(a))throw Error('Wallet changed or locked. Reopen Bridge with the original linked account.');}
 async function openUniversal(s,{recipient,mint=s?.asset?.mint,symbol=s?.asset?.symbol}={}){
  const back=s?.asset?{mint:s.asset.mint,rows:s.sourceRows,amountRaw:(()=>{try{return jointAmount(s.value,s.asset.symbol);}catch{return undefined;}})(),direction:s.operation==='transfer'?'xmr-to-xmr':s.operation==='release'?'xmr-to-sol':'sol-to-xmr',recipient:s.recipient}:{};
  clear();identityUI=createLinkUI(d,{endpoint,rpcEndpoint,privateTestPolicy:testPolicy,onBack:()=>open({...back,skipLinkResume:true})});
  await identityUI.open({recipient,mint,symbol});
 }
 function recipientSetupReview(s,busy){
  const plan=s.recipientPlan,cost=plan?.rentLamports;
  return `${plan?`<div class="review-line"><span>Recipient account setup</span><strong>${cost===null?'Already approved':(cost/1e9).toFixed(9)+' SOL'}</strong></div><p class="subtle">${cost===null?'Your saved setup approval will be checked before the send continues.':'You pay this one-time account cost plus the Solana network fee. We’ll prepare the recipient’s account, then continue this exact send.'} Keep this panel open to continue automatically.</p>`:''}<button class="primary wide" id="${plan?'j3-publish':'j3-review-recipient'}" ${busy?'disabled':''}>${busy?'Preparing your send…':plan?'Confirm and send':'Review send'}</button>`;
 }
 async function prepareRecipient(s){
  assert(s);const review=s.nativeReview;if(!linkEnabled||!review?.to)return;
  if(s.recipientSetupTarget!==review.to&&s.report?.positions?.some(p=>p.moneroOwner===review.to))return;
  s.recipientPlan=null;s.progress.stage('Checking the recipient’s account and setup cost…');
  s.recipientSetup??=setupRecipient(d,{provider:s.provider,endpoint,rpcEndpoint,privateTestPolicy:testPolicy,signal:s.abort.signal,assertCurrent:()=>{assert(s);s.lifetime.assert();}});
  const plan=await s.recipientSetup.prepare({mint:s.asset.mint,recipient:review.to});assert(s);
  if(s.nativeReview!==review)throw Error('Send details changed. Review the send again.');s.recipientPlan=plan;
 }
 async function publishNative(s){
  read(s);if(pendingMoves(s).some(([id])=>id!==s.recoverNativeNonce)){s.nativeReview=null;return;}
  const review=s.nativeReview,plan=s.recipientPlan;
  if(plan){
   if(plan.mint!==s.asset.mint||plan.recipient!==review?.to)throw Error('Recipient changed. Review the send again.');
   await readiness(s);assert(s);
   const source=s.report.positions.find(p=>p.position===addresses(s.config).position.toBase58());
   if(review.to===s.monero)throw Error('Choose a different linked Monero wallet.');
   if(!source||BigInt(source.available)<BigInt(review.amount))throw Error('Insufficient confirmed Monero token balance.');
   s.progress.stage('Preparing the recipient’s token account…');
   try{if(!s.report.positions.some(p=>p.moneroOwner===review.to))await s.recipientSetup.confirm(plan);}catch(e){if(s.recipientSetup.needsReview(plan))s.recipientPlan=null;throw e;}
   assert(s);if(s.nativeReview!==review)throw Error('Send details changed. Review the send again.');
   // Activation finality alone is insufficient. Keep the normal independently
   // verified complete snapshot and exact source/destination checks before signing.
   s.progress.stage('Account ready. Checking the exact send…');
  }
  s.ready=false;
  for(let attempt=0;;attempt++){
   try{if(review.to&&s.client.fast){const prepared=await s.client.fast.review({...review,...(s.report?.positions?.find(p=>p.moneroOwner===review.to)?.solanaOwner?{recipient:s.report.positions.find(p=>p.moneroOwner===review.to).solanaOwner}:{})});const result=await s.client.fast.approve(prepared);assert(s);if(result.confirmed)s.completedFast=result.operationId;}else await s.client.publishMove(review,{validateSnapshot:async report=>{await s.chain.verifyProgram();acceptReport(s,report);}});break;}
   catch(e){
    assert(s);read(s);
    if(!plan||attempt>=5||e.message!=='Registered recipient required.'||s.saved?.proofs?.[review.nonce])throw e;
    s.progress.stage('Account confirmed. Waiting for the bridge index…');
    await untilClosed(new Promise(resolve=>setTimer(resolve,2000)),s.abort.signal);assert(s);
   }
  }
  read(s);s.nativeReview=null;s.recipientPlan=null;
 }
 async function refreshFast(s){
  if(!s.client.fast)return;
  for(const [id,j] of Object.entries(s.saved?.fastOperations??{}))if(j.phase==='submission-unknown'){
   const result=await s.client.fast.check(id);assert(s);read(s);if(result.confirmed){s.completedFast=id;s.ready=false;}
  }
 }
 function pendingFast(s){return Object.entries(s.saved?.fastOperations??{}).filter(([,j])=>j.phase==='submission-unknown');}
 function configFor(a,mint){const manifest=transferableManifest(mint);return {abi:3,network:manifest.network,program:manifest.program,mint,verifier:manifest.verifier,owner:a.sol,binding:digest(a.xmr)};}
 function choices(a,rows,selectedMint,metadata=[],receiveSetup=false){
  if(receiveSetup)return discoveredAssets([...rows,...savedJointAssets(),...metadata,...(selectedMint?[{mint:selectedMint}]:[])]).filter(v=>v.key!=='previous-xcat'&&(!limitedTest||v.mint===testPolicy.mint));
  const known=savedJointAssets(),recoveryMints=[];
  for(const asset of discoveredAssets([...rows,...known]).filter(v=>v.key!=='previous-xcat'&&(!limitedTest||v.mint===testPolicy.mint))){
   try{if(hasBridgeRecovery(adapters.publicReceiptStore({config:configFor(a,asset.mint),moneroOwner:a.xmr}).load()))recoveryMints.push(asset.mint);}
   catch{recoveryMints.push(asset.mint);}
  }
  return walletBridgeAssets(rows,{metadata:[...known,...metadata],recoveryMints,selectedMint}).filter(v=>!limitedTest||v.mint===testPolicy.mint);
 }
 function paintEmpty(s){
  assert(s);d.show('Bridge',`<div class="joint-transferable"><h3>${s.requestedMint?'Waiting for this token’s balance':'No bridgeable tokens found'}</h3><p>${s.requestedMint?'The selected token will appear when its Solana or new Monero bridge balance is available. Your selected token and amount are kept.':'Tokens you hold on Solana or in the new Monero bridge will appear here when balances update.'}</p><button class="primary wide" id="j3-receive-setup">${s.savedLink?'View wallet link':'Link your wallets'}</button><p class="subtle">No token balance is needed to link. Your Solana wallet needs SOL for network and account fees.</p>${d.refreshHoldings?'<button class="secondary wide" id="j3-refresh-holdings">Refresh balances</button>':''}${s.error?`<p role="alert">${esc(s.error)}</p>`:''}<details id="j3-receipts"><summary>Receipts and recovery</summary><label for="j3-import-empty">Import public recovery receipts</label><input id="j3-import-empty" type="file" accept=".json,application/json"></details><details id="j3-other"><summary>Other bridge balances</summary>${previous?'<button class="text-btn wide" id="j3-previous">Previous joint bridge balances</button>':''}<button class="text-btn wide" id="j3-legacy">Legacy bridge withdrawals</button></details></div>`);
  d.on('j3-receive-setup',()=>linkEnabled?openUniversal(s):open({mint:s.requestedMint||XMR20_MINT,rows:s.sourceRows,receiveSetup:true}));
  d.on('j3-refresh-holdings',()=>{const button=$('j3-refresh-holdings');button.disabled=true;void Promise.resolve().then(()=>d.refreshHoldings()).then(()=>{assert(s);refreshAssets();}).catch(()=>{if(current===s&&!s.abort.signal.aborted){s.error='Balances could not refresh. Your recovery receipts are kept.';paintEmpty(s);}}).finally(()=>{if(current===s&&$('j3-refresh-holdings'))$('j3-refresh-holdings').disabled=false;});});
  d.on('j3-previous',()=>{clear();previous();});d.on('j3-legacy',()=>{clear();legacy();});
  if($('j3-import-empty'))$('j3-import-empty').onchange=e=>{const file=e.target.files[0];void (async()=>{try{
   if(!file||file.size>1000000)throw Error('Choose public receipts under 1 MB.');const value=JSON.parse(await file.text());assert(s);
   const a=d.account(),mint=value?.config?.mint,config=configFor(a,mint);if(limitedTest)privateTestConfig(config,testPolicy);
   const store=adapters.publicReceiptStore({config,moneroOwner:a.xmr});if(store.load())throw Error('Keep the current receipts before importing another backup.');store.save(value);
   const asset=discoveredAssets([{mint}]).find(v=>v.mint===mint);rememberJointAsset(asset);await open({mint});
  }catch(e){if(current===s&&!s.abort.signal.aborted){s.error=e.message;paintEmpty(s);}}})();};
 }
 function refreshAssets(){
  const s=current;if(!s||s.abort.signal.aborted||!d.modal.open)return;
  try{assert(s);const a=d.account(),assets=choices(a,d.rows?.()??s.sourceRows,s.empty?undefined:s.asset.mint,s.metadata,s.receiveSetup);
   if(s.empty){if((s.requestedMint?assets.some(asset=>asset.mint===s.requestedMint):assets.length)&&!d.isBusy?.())void open({mint:s.requestedMint,rows:s.sourceRows,amountRaw:s.requestedAmount,direction:s.requestedDirection}).catch(()=>{});return;}
   s.assets=assets;s.asset=assets.find(a=>a.mint===s.asset.mint)||s.asset;paint(s,true);
  }catch{/* A closed or changed account cannot receive another account's choices. */}
 }
 function read(s){assert(s);s.saved=s.store.load();if(hasUnresolved(s))s.lifetime?.submitted();s.receiptError=false;if(s.nativeReview&&(s.saved?.proofs?.[s.nativeReview.nonce]&&s.recoverNativeNonce!==s.nativeReview.nonce||Object.values(s.saved?.fastOperations??{}).some(j=>j.intent.nonce===s.nativeReview.nonce&&j.phase!=='approval-expired')))s.nativeReview=null;if(s.review&&Object.values(s.saved?.operations||{}).some(j=>j.phase!=='approval-expired'&&j.proposal.operation===s.review.proposal.operation&&j.proposal.nonce===s.review.proposal.nonce))s.review=null;}
 function hasUnresolved(s){return pendingFast(s).length>0||Object.values(s.saved?.operations||{}).some(j=>j.phase==='submission-unknown')||pendingMoves(s).length>0||pendingBackground(s).length>0;}
 async function cancelDraft(s,expired=false){
  if(current!==s)return;
  read(s);if(hasUnresolved(s)){s.notice='This request has already been submitted. Its recovery receipt is kept.';paint(s,true);return;}
  // A late wallet approval must fail the old session's assert before submission.
  // Reopening reads submitted receipts and never deletes or replays them.
  const finishing=s.task;clear();await finishing;
  if(current)return;
  await open({mint:s.asset.mint,rows:s.sourceRows,receiveSetup:s.receiveSetup,direction:s.operation==='release'?'xmr-to-sol':s.operation==='transfer'?'xmr-to-xmr':'sol-to-xmr',notice:expired?'Unsigned request expired after 10 minutes. You can start a new one.':'Request cancelled. You can start a new one.'});
 }
 function pendingMoves(s){const jobs=Object.values(s.saved?.operations||{}),submitted=([id])=>jobs.some(j=>j.proposal.nonce===id&&['transfer','release'].includes(j.proposal.operation)&&j.phase==='submission-unknown');return Object.entries(s.saved?.proofs||{}).filter(([id,p])=>['transfer','burn'].includes(p.envelope.record.op)&&!Object.values(s.saved?.fastOperations??{}).some(j=>['submission-unknown','finalized'].includes(j.phase)&&matchesNativeSend(p.envelope,j.intent))&&!jobs.some(j=>j.proposal.nonce===id&&j.proposal.operation===(p.envelope.record.op==='burn'?'release':'transfer')&&j.phase==='finalized')).sort((a,b)=>Number(submitted(b))-Number(submitted(a)));}
 function acceptReport(s,report){assert(s);if(report.schema!=='joint-index-v3'||report.complete!==true||canonical(report.manifest)!==canonical(s.manifest)||canonical(report.privateTestPolicy??null)!==canonical(testPolicy??null))throw Error('Complete verified bridge history is required.');s.report=report;s.ready=true;s.syncing=false;saveBridgeDisplay({sol:s.owner,xmr:s.monero},s.manifest,report);}
 async function readiness(s){s.ready=false;s.progress.stage('Reading confirmed bridge history…');const [report]=await Promise.all([s.client.snapshot(),s.chain.verifyProgram()]);acceptReport(s,report);}
 function failed(s,e){if(linkEnabled&&e?.message==='Registered recipient required.'&&s.nativeReview?.to)s.recipientSetupTarget=s.nativeReview.to;s.syncing=e?.code==='index-sync';if(s.syncing)s.ready=false;s.error=s.syncing?'':bridgeConnectionMessage(e);}
 async function act(s,fn){if(working||s.checking||s.polling||s.preview?.running||d.isBusy?.())return;s.preview?.pause();working=s;s.error='';s.progress.start('Checking wallet…');paint(s);await (s.task=d.run(async()=>{try{assert(s);if(!navigator.locks)throw Error('Use a current Chrome browser for protected approvals.');await navigator.locks.request(s.store.key,{ifAvailable:true},async lock=>{if(!lock)throw Error('Another window is approving this linked account.');await untilClosed(Promise.resolve().then(()=>{assert(s);return fn();}),s.abort.signal);assert(s);});}catch(e){if(current===s&&!s.abort.signal.aborted)failed(s,e);}finally{s.progress.stop();if(working===s)working=false;if(current===s&&!s.abort.signal.aborted&&d.modal.open){try{read(s);}catch{s.ready=false;s.review=null;s.receiptError=true;}paint(s);schedule(s);requestPreview(s);}}}));}
 function bind(s,id,fn){d.on(id,()=>{s.lifetime?.touch();return void act(s,fn);});}
 function submittedMoves(s){return Object.entries(s.saved?.operations||{}).filter(([,j])=>['transfer','release'].includes(j.proposal.operation)&&j.phase==='submission-unknown');}
 // Checking an already signed Solana operation does not need a native-history
 // replay. Reconcile it first, so a stale receipt cannot trap a completed return
 // behind a slow balance refresh or cause another signing prompt.
 async function refreshSubmittedMoves(s){
  if(!s.client.check)return;
  for(const [id] of submittedMoves(s).reverse()){
   s.progress.stage('Checking saved Solana confirmation…');
   const result=await s.client.check(id);assert(s);read(s);
   if(result.confirmed){s.completedMove=id;s.ready=false;}
   paint(s,true);
  }
 }
 function backgroundJobs(s){return Object.entries(s.saved?.operations||{}).filter(([,j])=>['register','deposit','donate'].includes(j.proposal.operation)&&j.phase!=='approval-expired');}
 function finishedBackground(s,id,j){return s.completed?.has(id)||j.phase==='finalized'&&j.background?.phase==='complete';}
 function pendingBackground(s){return backgroundJobs(s).filter(([id,j])=>j.background?.enabled&&!finishedBackground(s,id,j));}
 async function refreshBackground(s,{manual=false}={}){
  if(!s.client.backgroundStatus)return;
  const terminal=[],delayed=[];
  // Fetch all cheap public progress first, newest first. An old completed link
  // must never conceal a newer deposit behind a slow full-history refresh.
  for(const [id,j] of backgroundJobs(s).reverse()){
   if(finishedBackground(s,id,j))continue;
   const r=await s.client.backgroundStatus(id);assert(s);s.backgroundChecked=true;if(r.accepted&&r.backgroundEnabled)s.error='';read(s);paint(s,true);
   if(r.accepted&&r.backgroundEnabled&&['complete','approval-required'].includes(r.phase))terminal.push([id,r]);
   if(r.accepted&&r.backgroundEnabled&&r.phase==='delayed'&&s.saved?.operations[id]?.publication?.txid){
    const key=id+':'+(r.checkedAt??'unknown'),attempts=s.delayedChecks??=new Set();
    if(manual||!attempts.has(key)){attempts.add(key);delayed.push(id);}
   }
  }
  let changed=false;
  for(const [id,r] of terminal){
   s.progress.stage('Checking saved Solana approval…');const outcome=await s.client.check(id);assert(s);read(s);
   if(r.phase==='complete'&&outcome.confirmed){(s.completed??=new Set()).add(id);changed=true;}
   paint(s,true);
  }
  // A published record can be confirmed before the worker updates its status.
  // Check each delayed observation once; manual status checks may try again.
  // Completion is session-local and requires both exact custody and fresh history.
  const confirmed=[];
  for(const id of delayed){
   s.progress.stage('Checking saved Solana approval…');const outcome=await s.client.check(id);assert(s);read(s);
   const job=s.saved?.operations[id];if(outcome.confirmed===true&&job?.phase==='finalized'&&job.envelope)confirmed.push({id,envelope:canonical(job.envelope)});
  }
  if(confirmed.length){
   await readiness(s);read(s);
   for(const {id,envelope} of confirmed){const job=s.saved?.operations[id];if(job?.phase==='finalized'&&canonical(job.envelope)===envelope&&s.report.accepted?.some(entry=>entry.envelope&&canonical(entry.envelope)===envelope))(s.completed??=new Set()).add(id);}
   paint(s,true);
  }
  if(changed&&!confirmed.length&&!pendingBackground(s).length)await readiness(s);
 }

 function schedule(s){
  clearTimer(s.pollTimer);
  if(s.syncing&&!pendingBackground(s).length&&!pendingFast(s).length){
   // A failed read never replays an approval. Retry only the verified snapshot
   // and deployment read, with at most one request and one timer per open UI.
   s.pollTimer=setTimer(async()=>{
    if(current!==s||s.abort.signal.aborted||!d.modal.open)return;
    if(working||s.checking||s.polling||s.preview?.running||d.isBusy?.()||document.hidden){schedule(s);return;}
    s.checking=true;s.progress.start('Checking bridge synchronization…');paint(s,true);
    try{await readiness(s);s.error='';s.pollError=false;}
    catch(e){if(current===s&&!s.abort.signal.aborted)failed(s,e);}
    finally{s.checking=false;s.progress.stop();if(current===s&&!s.abort.signal.aborted&&d.modal.open){paint(s,true);schedule(s);requestPreview(s);}}
   },15000);s.pollTimer?.unref?.();return;
  }
  if(s.returnFlow?.active){
   s.pollTimer=setTimer(()=>{if(current!==s||s.abort.signal.aborted||!d.modal.open){s.returnFlow.close();return;}if(working||s.checking||s.polling||s.preview?.running||d.isBusy?.()||document.hidden){schedule(s);return;}void act(s,()=>advanceReturn(s));},60000);s.pollTimer?.unref?.();return;
  }
  if(!pendingFast(s).length&&!submittedMoves(s).length&&(!s.client.backgroundStatus||!backgroundJobs(s).some(([id,j])=>!finishedBackground(s,id,j)&&j.background?.phase!=='needs-attention')))return;
  s.pollTimer=setTimer(async()=>{
   if(current!==s||s.abort.signal.aborted||!d.modal.open)return;
   if(working||s.checking||s.polling||s.preview?.running||d.isBusy?.()||document.hidden){schedule(s);return;}
   s.preview?.pause();s.polling=true;paint(s,true);
   try{await refreshFast(s);await refreshSubmittedMoves(s);await refreshBackground(s);if((s.completedMove||s.completedFast)&&!s.ready&&!submittedMoves(s).length&&!pendingBackground(s).length)await readiness(s);s.pollError=false;}
   catch(e){if(current===s){failed(s,e);s.pollError=!s.syncing;}}
   finally{s.polling=false;if(current===s&&!s.abort.signal.aborted&&d.modal.open){paint(s,true);schedule(s);requestPreview(s);}}
  // Saved-operation progress is a cheap read (tens of milliseconds). Poll it
  // every five seconds while only background jobs are pending; saved Solana
  // confirmation checks keep the fifteen-second cadence. Hidden tabs skip reads.
  },pendingFast(s).length||!submittedMoves(s).length&&pendingBackground(s).length?5000:15000);s.pollTimer?.unref?.();
 }

 function creditInput(s){
  if(pendingFast(s).length||s.receiveSetup||!s.ready||s.receiptError||s.review||s.nativeReview||pendingMoves(s).length||!['deposit','donate'].includes(s.operation)||!s.report?.positions?.some(p=>p.position===addresses(s.config).position.toBase58())||pendingBackground(s).length)return null;
  const latest=Object.values(s.saved?.operations||{}).reverse().find(j=>['deposit','donate'].includes(j.proposal.operation));if(latest&&latest.phase!=='finalized')return null;
  try{const amount=jointAmount(s.value,s.asset.symbol),recipient=s.operation==='donate'?moneroOwner(s.recipient.trim()):s.monero;if(limitedTest&&(s.operation!=='deposit'||BigInt(amount)>BigInt(testPolicy.maxGrossAtomic)))return null;return {operation:s.operation,recipient,amount};}catch{return null;}
 }
 function returnInput(s){
  if(pendingFast(s).length||!s.ready||s.receiptError||s.review||s.nativeReview||s.returnFlow?.active||s.returnFlow?.state.phase==='complete'||pendingBackground(s).length)return null;
  const moves=pendingMoves(s),first=moves[0];
  if(first){const [id,p]=first;if(p.envelope.record.op!=='burn'||Object.values(s.saved.operations||{}).some(j=>j.proposal.nonce===id&&j.proposal.operation==='release'&&j.phase==='submission-unknown'))return null;return {operation:'release',amount:p.envelope.record.amount,recipient:s.owner,savedNonce:id};}
  if(s.operation!=='release'||!s.report?.positions?.some(p=>p.position===addresses(s.config).position.toBase58()))return null;
  try{const amount=jointAmount(s.value,s.asset.symbol);if(limitedTest&&BigInt(amount)>BigInt(testPolicy.maxGrossAtomic))return null;return {operation:'release',amount,recipient:s.owner};}catch{return null;}
 }
 function previewInput(s){return returnInput(s)??creditInput(s);}
 function returnDetails(s,resume=false){
  if(!s.ready)return '<p class="subtle">'+(s.syncing?'Your return is saved. Its fee and status will update when synchronization finishes.':'Your return is saved. Reconnect to check its fee and continue.')+'</p>';
  const input=returnInput(s),preview=s.preview?.state,quote=s.preview?.matches(input)?preview.value:null,symbol=esc(s.asset.symbol);
  return (quote?`<div class="bridge-fee-line"><span>Token fee</span><span>${jointShow(quote.fee)} ${symbol}</span></div>${resume?`<div class="review-line"><span>Arrives on Solana</span><strong>${jointShow(BigInt(quote.amount)-BigInt(quote.fee))} ${symbol}</strong></div>`:''}<details id="j3-transaction-details"><summary>Return details</summary><label>To your Solana wallet</label><div class="address">${esc(quote.destination)}</div><p class="subtle">${d.externalWallet?'Your connected wallet approves the final Solana step. Keep this page open to continue.':'The return completes automatically for these exact terms while your wallet is open and unlocked. Closing or locking pauses completion.'} SOL network and account costs are additional.</p></details>`:`<p class="subtle joint-busy" data-loading="${preview?.status==='loading'}" data-paused="${document.hidden}" role="status">${preview?.status==='error'?esc(preview.error):'Checking the amount and token fee…'}</p>`)+`<button class="primary wide" id="j3-return" ${working||s.checking||s.polling||!quote?'disabled':''}>${resume?'Resume return':'Bridge to Solana'}</button><p class="subtle">Allow about 20 minutes for 10 Monero confirmations. Keep your wallet open${d.externalWallet?'':' and unlocked'}.</p>`;

 }
 async function advanceReturn(s){
  const flow=s.returnFlow;await flow.advance();assert(s);read(s);if(flow.state.phase==='complete')await readiness(s);
 }
 async function startReturn(s){
  const input=returnInput(s);if(!input||!s.preview.matches(input))throw Error('Wait for the current return amount and fee.');
  const quote=s.preview.state.value;s.returnFlow?.close();
  const flow=createJointReturnFlow({config:s.config,moneroOwner:s.monero,amount:quote.amount,fee:quote.fee,nonce:quote.nonce,client:s.client,load:()=>s.store.load(),snapshot:async()=>{await readiness(s);return s.report;},assertCurrent:()=>assert(s),approve:async review=>{s.returnSigning=flow;try{await s.client.approveMove(review);}finally{s.returnSigning=null;}}});
  s.returnFlow=flow;s.preview.request(null);s.returnSigning=flow;
  try{await flow.start();}finally{s.returnSigning=null;read(s);}
  // Confirmation checks and the final exact approval are continued by the
  // session timer. A recovered, already confirmed record can proceed now.
  if(input.savedNonce)await advanceReturn(s);
 }
 function requestPreview(s){if(current===s&&!s.abort.signal.aborted&&d.modal.open&&!working&&!s.checking&&!s.polling)s.preview?.request(previewInput(s));estimateFee(s);}
 // Current token fee from independent finalized chain reads, shown as soon as
 // an amount is typed, before and while the fresh history/exact review loads.
 // Display only: never an authorization input and never enables the button.
 function estimateFee(s){
  if(current!==s||s.abort.signal.aborted||!d.modal.open||!['deposit','donate'].includes(s.operation)||s.review||s.nativeReview)return;
  let amount;try{amount=jointAmount(s.value,s.asset.symbol);}catch{s.feeEstimate=null;return;}
  if(limitedTest&&BigInt(amount)>BigInt(testPolicy.maxGrossAtomic))return;
  const recipient=s.operation==='donate'?s.recipient.trim():s.monero;
  if(s.feeEstimate?.amount===amount&&s.feeEstimate.recipient===recipient)return;
  if(s.feeEstimating?.amount===amount)return;s.feeEstimating={amount};
  void s.chain.fee(amount).then(fee=>{if(current===s&&!s.abort.signal.aborted&&d.modal.open&&s.feeEstimating?.amount===amount){s.feeEstimate={amount,recipient,fee};paint(s,true);}}).catch(()=>{}).finally(()=>{if(s.feeEstimating?.amount===amount)s.feeEstimating=null;});
 }
 async function submitReview(s,r){
  s.progress.stage(r.proposal.operation==='register'?'Verifying registration before signing…':'Preparing and submitting your approval…');
  const result=r.proposal.operation==='register'?await s.client.approveRegistration(r):['deposit','donate'].includes(r.proposal.operation)?await s.client.approveCredit(r):await s.client.approveMove(r);
  s.review=null;s.preview?.request(null);read(s);paint(s);await checkOperation(s,result.operationId);
 }
 async function requireReady(s){s.ready=false;await readiness(s);}
 async function reviewSavedMove(s,id){
  s.moveWaiting=null;await requireReady(s);read(s);const proof=s.saved?.proofs?.[id];if(!proof)throw Error('Saved Monero approval is missing. Keep your recovery receipt.');
  const confirmed=s.report.accepted?.some(p=>canonical(p.envelope)===canonical(proof.envelope))||s.report.pending?.some(p=>p.operation===proof.envelope.record.op&&p.receipt===receiptAddress(s.config,id).toBase58());
  if(!confirmed){s.moveWaiting=id;return;}
  s.moveWaiting=null;s.review=await s.client.reviewMove(id);
 }
 async function checkOperation(s,id,result,manual=false){if(s.client.backgroundStatus&&['register','deposit','donate'].includes(s.saved?.operations[id]?.proposal.operation)){const r=await s.client.backgroundStatus(id);read(s);if(r.accepted&&r.backgroundEnabled){await refreshBackground(s,{manual});return;}}s.progress.stage('Checking saved Solana approval…');const r=result??await s.client.check(id);read(s);if(r.confirmed&&['transfer','release'].includes(s.saved?.operations[id]?.proposal.operation)){s.completedMove=id;s.ready=false;}paint(s);if(!r.confirmed)return;if(['register','deposit','donate'].includes(s.saved?.operations[id]?.proposal.operation)){s.progress.stage('Publishing the saved Monero record…');await s.client.publishCreditOrLink(id);read(s);paint(s);}await readiness(s);read(s);}
 function paint(s,passive=false){assert(s);const expanded=['j3-linked','j3-receipts','j3-other','j3-actions','j3-transaction-details','j3-about'].filter(id=>$(id)?.open);const active=document.activeElement,focused=active?.id&&$(active.id)===active?active.id:undefined,selection=['j3-amount','j3-recipient'].includes(focused)?[active.selectionStart,active.selectionEnd]:null,asset=s.asset,symbol=esc(asset.symbol),busy=working||s.checking||s.polling,disabled=busy?'disabled':'',editDisabled=working?'disabled':'',approval=busy||!s.ready?'disabled':'',position=(s.report??s.displayReport)?.positions?.find(p=>p.position===addresses(s.config).position.toBase58()),registered=!!position,formReady=registered||!linkEnabled&&!s.report;
  if(working&&focused&&!s.focusTarget)s.focusTarget=focused;
  const solHolding=d.rows?.().find(r=>r.network==='solana'&&r.mint===asset.mint),solBalance=s.solBalance??solHolding?.amountRaw;
  // A missing or stale snapshot is never presented as a verified zero.
  const moneroBalance=position?.available??(s.ready&&s.report?'0':undefined);
  const returning=s.operation==='release',peer=s.operation==='transfer';
  const preview=s.preview?.matches(previewInput(s))?s.preview.state.value:null;
  const proposal=preview?.proposal,quoteAmount=proposal?.amount??preview?.amount,quoteFee=proposal?.expectedFee??preview?.fee??'0';
  const receiveRaw=quoteAmount!==undefined?(BigInt(quoteAmount)-BigInt(quoteFee)).toString():undefined;
  const panels=({editable=false,linking=false,sendRaw,receive=receiveRaw,operation=s.operation}={})=>{
   const returning=operation==='release',peer=operation==='transfer',recipient=peer||operation==='donate';
   if(peer)return moneroSendView({fastSettlement:!!s.client.fast,esc,asset,image:d.tokenImage?.(asset.mint),review:!editable,amountRaw:sendRaw,value:s.value,recipient:s.recipient,balance:moneroBalance,stale:!s.ready,focused:focused==='j3-amount',disabled:!!working,maxDisabled:!!working||!!s.maxLoading});
   return bridgeTokenPanels({esc,asset,assets:s.assets,labelFor:a=>jointTokenLabel(a,s.assets),image:d.tokenImage?.(asset.mint),source:returning||peer?'Monero':'Solana',destination:returning?'Solana':'Monero',sourceBalance:returning||peer?moneroBalance:solBalance,destinationBalance:recipient?undefined:returning?solBalance:moneroBalance,sourceStale:returning||peer?!s.ready:s.solBalance===undefined,destinationStale:returning?s.solBalance===undefined:!s.ready,recipient,value:s.value,amountFocused:focused==='j3-amount',sendRaw,receiveRaw:receive,editable,pickerDisabled:!!working||!!s.review||!!s.nativeReview,swapDisabled:!!busy||!registered||peer||s.operation==='donate',maxDisabled:!!working||!!s.maxLoading,linking});
  };
  const recipient=['donate','transfer'].includes(s.operation)?`<label for="j3-recipient">Recipient Monero address</label><input id="j3-recipient" value="${esc(s.recipient)}" autocomplete="off" ${editDisabled}><p class="subtle">The recipient needs a confirmed wallet link for this token.</p>`:'';
  const actions=`<details id="j3-actions"><summary>More actions</summary><label for="j3-operation">Action</label><select id="j3-operation" ${editDisabled}><option value="deposit" ${s.operation==='deposit'?'selected':''}>Bridge to my Monero wallet</option><option value="donate" ${s.operation==='donate'?'selected':''}>Airdrop to a registered Monero wallet</option><option value="transfer" ${s.operation==='transfer'?'selected':''}>Send to another Monero wallet</option><option value="release" ${s.operation==='release'?'selected':''}>Bridge back to my Solana wallet</option></select></details>`;
  let reviewWaitKey=null;
  let content=formReady?panels({editable:true})+(peer?'':recipient)+`${s.operation==='release'?'<div id="j3-return-preview"></div>':['deposit','donate'].includes(s.operation)?'<div id="j3-credit-preview"></div>':`<div class="monero-send-actions"><button type="button" class="secondary" id="j3-send-cancel">Cancel</button><button class="primary wide" id="j3-review" ${approval}>Next</button></div>`}`+(peer?'':actions):!s.report?'<p role="status" class="joint-busy" data-loading="true">Checking wallet setup…</p>':(linkEnabled?'':panels({linking:true,sendRaw:solBalance,receive:moneroBalance,operation:'deposit'}))+`<div class="bridge-link-intro"><h3>Link wallets first</h3><p>Link these wallets once before using this earlier bridge. No token balance is needed; SOL setup fees apply.</p></div><button class="primary wide" id="j3-register" ${approval}>Link your wallets</button>`;
  if(s.receiveSetup&&(registered||!s.report))content=panels({linking:true,sendRaw:solBalance,receive:moneroBalance,operation:'deposit'})+(s.ready&&registered?`<h3>Ready to receive ${symbol}</h3><p>Your wallets are linked. Share your Monero address with the sender. No token deposit is required.</p><label>Receiving Monero address</label><div class="address">${esc(s.monero)}</div>`:'<p class="subtle">Checking your wallet link… No token balance is needed.</p>');
  if(formReady&&['deposit','donate'].includes(s.operation)){
   const input=creditInput(s),preview=s.preview?.state,quote=s.preview?.matches(input)?preview.value:null;
   let typed=null;try{typed=jointAmount(s.value,s.asset.symbol);}catch{}
   const estimate=!quote&&typed&&s.feeEstimate&&s.feeEstimate.amount===typed&&s.feeEstimate.recipient===(s.operation==='donate'?s.recipient.trim():s.monero)?s.feeEstimate:null;
   if(!quote&&typed&&preview?.status==='loading')reviewWaitKey=JSON.stringify([s.operation,typed,s.recipient]);
   const details=quote?`<div class="bridge-fee-line"><span>Token fee</span><span>${jointShow(quote.proposal.expectedFee||'0')} ${symbol}</span></div><details id="j3-transaction-details"><summary>Transfer details</summary><label>To ${s.operation==='deposit'?'your':'the recipient’s'} Monero wallet</label><div class="address">${esc(quote.envelope.record.owner)}</div><p class="subtle">SOL network and account costs are additional. ${d.externalWallet?'Your connected wallet will show the Solana transaction for approval.':'This button signs and sends from your selected account.'}</p></details>`:`${estimate?`<div class="bridge-fee-line"><span>Token fee (current rate)</span><span>${jointShow(estimate.fee)} ${symbol}</span></div>`:''}<p class="subtle joint-busy" data-loading="${preview?.status==='loading'||!!(estimate&&!s.ready)}" data-paused="${document.hidden}" role="status" aria-atomic="true">${reviewWaitKey?'<span id="j3-review-wait">':''}${preview?.status==='loading'?(estimate?'Confirming the exact review with the bridge…':'Checking token fee…'):preview?.status==='error'?esc(preview.error):estimate&&!s.ready?'Checking the bridge before the exact review…':limitedTest?'Enter an amount up to 1 XMR20.':'Enter an amount to preview.'}${reviewWaitKey?'</span>':''}</p>`;
   content=content.replace('<div id="j3-credit-preview"></div>',details+(reviewWaitKey?'<p class="subtle" id="j3-review-estimate">Estimated wait: 15–40 seconds. Timing can vary.</p>':'')+`<div id="j3-credit-feedback"></div><button class="primary wide" id="j3-bridge" ${busy||!s.ready||!quote?'disabled':''}>${s.operation==='donate'?'Send airdrop':'Bridge to Monero'}</button>`);
  }
  if(formReady&&s.operation==='release')content=content.replace('<div id="j3-return-preview"></div>',returnDetails(s));
  const recipientTarget=s.nativeReview?.to||s.recipient.trim();
  const recipientNeedsAsset=linkEnabled&&['transfer','donate'].includes(s.operation)&&(()=>{try{moneroOwner(recipientTarget);return s.recipientSetupTarget===recipientTarget||s.ready&&!s.report.positions.some(p=>p.moneroOwner===recipientTarget);}catch{return false;}})();
  if(recipientNeedsAsset&&!peer)content+='<button class="secondary wide" id="j3-prepare-recipient">Prepare recipient for this token</button><p class="subtle">Uses the recipient’s existing wallet link. You review the Solana account cost first.</p>';
  const jobs=Object.entries(s.saved?.operations||{}),registrationIndex=jobs.findIndex(([,j])=>j.proposal.operation==='register'),registration=jobs[registrationIndex]?.[1];
  if(!registered&&registration&&(s.report||!finishedBackground(s,jobs[registrationIndex][0],registration)))content=`<h3>Wallet linking</h3><p role="status">${registration.phase==='approval-expired'?'The previous registration approval expired or failed. Review a new approval to continue.':registration.phase==='finalized'?'Solana registration confirmed. Waiting for your Monero wallet link: allow about 20 minutes for 10 Monero confirmations after publication. Once linked, you can bridge tokens or receive Monero transfers.':'Your registration approval is saved, but confirmation is not yet known. Check its status before approving again.'}</p>${registration.phase==='approval-expired'?`<button class="primary wide" id="j3-renew-${registrationIndex}" ${approval}>Review new approval</button>`:`<button class="primary wide" id="j3-check-${registrationIndex}" ${disabled}>Check registration status</button>`}`;
  const funding=jobs.map(([id,j],i)=>({id,j,i})).reverse().find(({j})=>['deposit','donate'].includes(j.proposal.operation));
  if(funding&&funding.j.phase!=='finalized'){const {j,i}=funding,expired=j.phase==='approval-expired';content=`<h3>${expired?'Deposit approval expired':'Checking your deposit'}</h3><p role="status">${expired?'This approval did not complete. Review a fresh approval to try the same deposit again.':'Your signed deposit is saved. Check its result before approving another deposit.'}</p><div class="review-line"><span>Amount</span><strong>${jointShow(j.proposal.amount)} ${symbol}</strong></div><button class="primary wide" id="${expired?'j3-renew-':'j3-check-'}${i}" ${expired?approval:disabled}>${expired?'Review deposit again':'Check deposit status'}</button>`;}
  const automatic=pendingBackground(s);
  if(automatic.length){
   content=automatic.map(([id,j])=>{
    const phase=j.background.phase,link=j.proposal.operation==='register',title=phase==='complete'?(link?'Wallets connected':'Monero credit confirmed'):phase==='approval-required'?'Checking expired approval':link?'Wallet linking':'Bridging to Monero';
    return `<h3>${title}</h3>${!link&&!['approval-required','solana-pending','delayed','needs-attention'].includes(phase)?`<div class="review-line"><span>Pending on Monero</span><strong>${jointShow(j.envelope.record.amount)} ${symbol}</strong></div>`:''}${jointWaiting(j,esc,{paused:document.hidden,updatesUnavailable:s.pollError||!s.backgroundChecked})}`;
   }).join('');
  }
  // A missing snapshot is an unknown balance, not evidence that registration
  // needs to start again. Saved pending funding keeps its own recovery view.
  if(s.report&&!registered&&registration&&finishedBackground(s,jobs[registrationIndex][0],registration)&&!automatic.length)content='<h3>Check your wallet link</h3><p>Your saved registration is complete, but this history check did not find the linked balance. Refresh the bridge status before continuing. Do not register again.</p>';
  if(!s.report&&!automatic.length&&(!funding||funding.j.phase==='finalized'))content=(s.operation==='release'?'<h3>Checking your return</h3>':'')+'<p class="subtle">'+(s.syncing?'Balances update when the bridge has checked the latest confirmed history. You can choose a token and enter an amount.':busy?'Refreshing balances in the background. You can choose a token and enter an amount.':'Your balance could not be verified. Last known balances are for display; reconnect before approving.')+'</p>'+content;
  const pendingMovesList=pendingMoves(s);
  if(pendingMovesList.length)content=pendingMovesList.slice(0,1).map(([id,p],i)=>{
   const returning=p.envelope.record.op==='burn',job=jobs.find(([,j])=>j.proposal.nonce===id&&j.proposal.operation===(returning?'release':'transfer')),unknown=job?.[1].phase==='submission-unknown',nextStep=returning?'Then resume this return and approve the Solana step.':'Then choose Check transfer and continue, and approve the Solana step.';
   if(!returning&&!unknown&&s.client.fast)return `<h3>Finish your send</h3><div class="review-line"><span>Amount</span><strong>${jointShow(p.envelope.record.amount)} ${symbol}</strong></div><p>Your previous attempt did not finish. Continue this same amount to the same recipient using Solana settlement.</p><p class="subtle">The saved attempt is kept. Shared transaction protection prevents both attempts from completing.</p><div id="j3-move-feedback"></div><button class="primary wide" id="j3-recover-fast-${i}" ${disabled}>Review send</button>`;
   return `<h3>${returning?'Returning to Solana':'Sending on Monero'}</h3><div class="review-line"><span>Amount</span><strong>${jointShow(p.envelope.record.amount)} ${symbol}</strong></div><p role="status">${unknown?'Your Solana approval is saved. Check its result before approving again.':p.result?.txid?(s.moveWaiting===id?'The latest history check has not confirmed this record yet. ':'')+'Your Monero record is submitted. Waiting for 10 Monero confirmations — allow about 20 minutes after publication. Network timing can vary. '+nextStep+' No new Monero approval is needed.':s.moveWaiting===id?'Your Monero approval is saved, but its publication has not been found in the confirmed history yet. Check the saved record before trying again.':'Your Monero approval is saved, but publication is not yet confirmed. Check the saved record before trying again.'}</p>${returning&&!unknown?returnDetails(s,true):`<div id="j3-move-feedback"></div><button class="primary wide" id="j3-resume-move-${i}" ${unknown?disabled:approval}>${unknown?'Check Solana confirmation':'Check transfer and continue'}</button>`}${p.result?.txid?`<p><a href="https://xmrchain.net/tx/${esc(p.result.txid)}" target="_blank" rel="noopener noreferrer">View Monero record</a></p>`:''}${pendingMovesList.length>1?'<p class="subtle">Additional saved records are in Receipts and recovery. Continue this saved request; do not start another.</p>':''}`;
  }).join('');
  const completedMove=s.saved?.operations?.[s.completedMove];
  if(completedMove?.phase==='finalized'){
   const returned=completedMove.proposal.operation==='release',amount=BigInt(completedMove.proposal.amount)-BigInt(completedMove.proposal.expectedFee||'0');
   const receipt=completedMove.result?.signature||completedMove.ownerSignature;
   const confirmation=`<h3>${returned?'Returned to Solana':'Transfer confirmed'}</h3><div class="review-line"><span>${returned?'Returned amount':'Transferred amount'}</span><strong>${jointShow(amount)} ${symbol}</strong></div><p role="status">${returned?'Your return is confirmed on Solana.':'Your transfer is confirmed.'}</p>${receipt?`<p><a href="https://solscan.io/tx/${esc(receipt)}" target="_blank" rel="noopener noreferrer">View Solana transaction</a></p>`:''}`;
   content=confirmation+(s.ready||pendingMovesList.length?content:'<p class="subtle">Refreshing balances. This completed transaction does not need another approval.</p>');
  }
  if(s.returnFlow?.active||s.returnFlow?.state.phase==='complete'){
   const r=s.returnFlow.state,done=r.phase==='complete';
   // 26 Oct 2026: visible step progress, the Monero record link once it exists, and an honest message (with the exact
   // retry) when the saved record never reached the Monero network instead of an endless confirmation wait.
   const proof=s.store?.load?.()?.proofs?.[r.nonce],txid=/^[a-f0-9]{64}$/.test(proof?.result?.txid||'')?proof.result.txid:null,unpublished=!txid&&r.phase==='waiting';
   const at={publishing:0,waiting:txid?1:0,preparing:2,approving:2,submitted:3,complete:4}[r.phase]??0;
   // Extension only (d.notifyReturn): a background watcher reads public history and notifies when the burn is confirmed.
   const watching=typeof d.notifyReturn==='function';
   if(watching&&txid&&r.phase==='waiting'&&!(s.watchedReturns??=new Set()).has(r.nonce)){s.watchedReturns.add(r.nonce);try{d.notifyReturn({action:'watch',mint:s.asset.mint,nonce:r.nonce,receipt:receiptAddress(s.config,r.nonce).toBase58(),amount:jointShow(BigInt(r.amount)-BigInt(r.fee)),symbol:s.asset.symbol});}catch{}}
   if(watching&&r.phase==='complete'){try{d.notifyReturn({action:'done',nonce:r.nonce});}catch{}}
   const step=(i,label,extra='')=>`<li class="${i<at?'done':i===at?(unpublished&&i===0?'blocked':'active'):'todo'}"><span class="bridge-step-dot" aria-hidden="true"></span><span>${label}</span>${extra}</li>`;
   const steps=`<ol class="bridge-steps" aria-label="Return progress">${step(0,txid?'Monero record published':'Publish your Monero record',txid?`<a href="https://xmrchain.net/tx/${esc(txid)}" target="_blank" rel="noopener noreferrer">View Monero transaction ↗</a>`:'')}${step(1,'10 Monero confirmations',at===1?'<small>About 20 minutes after publication</small>':'')}${step(2,'Solana approval')}${step(3,'Arrives on Solana')}</ol>`;
   content=`<h3>${done?'Returned to Solana':'Returning to Solana'}</h3><div class="review-line"><span>${done?'Returned amount':'Arrives on Solana'}</span><strong>${jointShow(BigInt(r.amount)-BigInt(r.fee))} ${symbol}</strong></div>${steps}${unpublished?'<p role="status">Your Monero record has not reached the network yet, so there is nothing to confirm. Retry the exact saved record; your approved amount and destination stay the same.</p><button class="secondary wide" id="j3-return-retry">Retry exact Monero record</button>':''}<p role="status"${unpublished?' hidden':''}>${{publishing:'Publishing your approved Monero record…',waiting:d.externalWallet?'Waiting for 10 Monero confirmations — allow about 20 minutes after publication. Network timing can vary. Your connected wallet will then ask for the Solana approval.':'Waiting for 10 Monero confirmations — allow about 20 minutes after publication. Network timing can vary. Your Solana return will be approved automatically for these exact terms.',preparing:'Preparing your Solana return…',approving:'Verifying and signing your approved return…',submitted:'Waiting for Solana confirmation…',complete:'Your return is confirmed on Solana.'}[r.phase]}</p>${done?'':`<p class="subtle">${watching&&txid&&r.phase==='waiting'?'You can close the wallet while Monero confirms. You’ll get a notification when it’s ready; then open the wallet, go to Bridge and press Resume return. It finishes for these exact terms.':'Keep this wallet open and unlocked. If it closes or locks, reopen and resume your saved return.'}</p><button class="text-btn wide" id="j3-pause-return">Pause automatic completion</button>`}`;
  }
  if(s.returnFlow?.state.phase==='paused')content='<p role="status">Automatic completion is paused. Your saved record is kept.</p>'+content;
  if(s.pollError)content='<p class="subtle" role="status">Status updates are temporarily unavailable. Saved approvals are kept; no new approval is needed to check again.</p>'+content;
  if(s.nativeReview)content=`<h3 id="j3-review-title" tabindex="-1">${peer&&s.client.fast?'Review send':'Review Monero record'}</h3>${panels({sendRaw:s.nativeReview.amount,receive:null,operation:s.nativeReview.to?'transfer':'release'})}<details id="j3-transaction-details"><summary>Transfer details</summary><div class="review-line"><span>Exact amount</span><strong>${jointShow(s.nativeReview.amount)} ${symbol}</strong></div><label>Destination</label><div class="address">${esc(s.nativeReview.to||s.owner)}</div><p>${peer&&s.client.fast?'Settles on Solana between linked wallets. No Monero confirmation wait for this send. Your Solana wallet and the verifier both approve the exact amount. SOL network fees apply.':'After publishing, allow about 20 minutes for 10 Monero confirmations, then approve the Solana step. Publishing this record alone does not transfer tokens.'}</p></details><div id="j3-native-feedback"></div>${peer&&s.client.fast?'<p class="subtle">Settles on Solana. SOL network fees apply.</p>':''}${s.recoverNativeNonce?'<p class="subtle">Continues your saved send to the same recipient. Only one attempt can settle.</p>':''}${peer&&linkEnabled&&(recipientNeedsAsset||s.recipientPlan)?recipientSetupReview(s,busy):recipientNeedsAsset?`<p>Check the recipient’s wallet link and prepare their ${symbol} account. A confirmed wallet link does not need to be repeated.</p><button class="primary wide" id="j3-prepare-recipient" ${busy?'disabled':''}>Check recipient setup</button>`:`<button class="primary wide" id="j3-publish" ${busy?'disabled':''}>${working===s?(peer&&s.client.fast?'Preparing send…':'Approving Monero record…'):peer&&s.client.fast?'Send tokens':'Approve Monero record'}</button>`}`;
  if(s.review){const p=s.review.proposal,fee=p.expectedFee||'0',linking=p.operation==='register',title={register:'Link your wallets',deposit:'Review bridge',donate:'Review airdrop',transfer:'Review transfer',release:'Review return'}[p.operation],destination=p.operation==='release'?s.owner:p.operation==='transfer'?s.review.envelope.record.to:s.review.envelope.record.owner;
   content=`<h3 id="j3-review-title" tabindex="-1">${title}</h3>${panels({linking,sendRaw:linking?solBalance:p.amount,receive:linking?moneroBalance:(BigInt(p.amount)-BigInt(fee)).toString(),operation:linking?'deposit':p.operation})}${linking?'<p class="bridge-link-copy">One-time setup for this token. Approve the link, then allow about 20 minutes for 10 Monero confirmations. No tokens move during linking.</p>':''}<details id="j3-transaction-details"><summary>${linking?'Wallet link details':'Transfer details'}</summary>${p.amount?`<div class="review-line"><span>Gross amount</span><strong>${jointShow(p.amount)} ${symbol}</strong></div><div class="review-line"><span>Token fee</span><strong>${jointShow(fee)} ${symbol}</strong></div><div class="review-line"><span>Net amount</span><strong>${jointShow(BigInt(p.amount)-BigInt(fee))} ${symbol}</strong></div>`:''}<label>Destination</label><div class="address">${esc(destination)}</div><p class="subtle">SOL network and account costs are additional. ${d.externalWallet?'Your connected wallet will ask you to approve this exact transaction.':'Your selected extension account approves this exact transaction.'} ${['transfer','release','register'].includes(p.operation)?'The verifier must also sign.':''}</p>${linking?'<p class="subtle">The link is permanent and public. This approval creates accounts; it does not move tokens.</p>':''}</details><button class="primary wide" id="j3-confirm" ${approval}>${linking?'Link your wallets':'Approve & continue'}</button>`;
  }
  const fastJobs=Object.entries(s.saved?.fastOperations??{});
  const fastWaiting=fastJobs.find(([,j])=>j.phase==='submission-unknown');
  const fastDone=s.saved?.fastOperations?.[s.completedFast];
  if(fastWaiting&&!pendingMovesList.length){const [id,j]=fastWaiting;content=`<h3>Confirming your send</h3><p class="joint-busy" data-loading="true" role="status">Waiting for Solana confirmation…</p><p>Your signed transaction is saved. You can close the wallet and check it later.</p><div class="review-line"><span>Exact amount</span><strong>${jointShow(j.intent.amount)} ${symbol}</strong></div><button class="primary wide" id="j3-fast-check" ${disabled}>Check send status</button>`;}
  if(fastDone?.phase==='finalized')content=`<h3>Send confirmed</h3><p role="status">Ownership has settled on Solana.</p><div class="review-line"><span>Transferred</span><strong>${jointShow(fastDone.intent.amount)} ${symbol}</strong></div><p><a href="https://solscan.io/tx/${esc(fastDone.ownerSignature)}" target="_blank" rel="noopener noreferrer">View Solana transaction</a></p><button class="secondary wide" id="j3-fast-done">Done</button>`;
  const proofs=Object.entries(s.saved?.proofs||{}).filter(([,p])=>['transfer','burn'].includes(p.envelope.record.op));
  let receipts=(automatic.length?`<button class="secondary wide" id="j3-background" ${disabled}>Check status now</button>`:'')+jobs.map(([id,j],i)=>`<p>${esc({register:'Wallet registration',deposit:'Deposit',donate:'Airdrop',transfer:'Transfer',release:'Return to Solana'}[j.proposal.operation])} · ${esc({'submission-unknown':'Confirmation not yet known','approval-expired':'Approval expired or failed',finalized:'Confirmed on Solana'}[j.phase]||'Check status')}${j.proposal.amount?' · '+jointShow(j.proposal.amount)+' '+symbol:''}</p>${!registered&&j===registration||j===funding?.j&&j.phase!=='finalized'?'':`<button class="secondary wide" id="j3-check-${i}" ${disabled}>Check transaction status</button>`}${j.phase==='submission-unknown'?`<button class="text-btn wide" id="j3-retry-${i}" ${approval}>Resend the same signed transaction</button>`:''}${j.phase==='approval-expired'&&j!==registration&&j!==funding?.j?`<button class="text-btn wide" id="j3-renew-${i}" ${approval}>Review new approval</button>`:''}<a href="https://solscan.io/tx/${esc(j.result?.signature||j.ownerSignature)}" target="_blank" rel="noopener noreferrer">View Solana transaction</a>${j.publication?.txid?`<a href="https://xmrchain.net/tx/${esc(j.publication.txid)}" target="_blank" rel="noopener noreferrer">View Monero link record</a>`:''}`).join('');
  receipts+=fastJobs.map(([id,j],i)=>`<p>Solana-settled send · ${esc(j.phase==='finalized'?'Confirmed':j.phase==='approval-expired'?'Approval expired or failed':'Confirmation not yet known')} · ${jointShow(j.intent.amount)} ${symbol}</p><a href="https://solscan.io/tx/${esc(j.ownerSignature)}" target="_blank" rel="noopener noreferrer">View Solana transaction</a>${j.phase==='submission-unknown'?`<button class="secondary wide" id="j3-fast-retry-${i}" ${disabled}>Check and resend saved transaction</button>`:j.phase==='approval-expired'?`<button class="secondary wide" id="j3-fast-renew-${i}" ${approval}>Review send again</button>`:''}`).join('');
  receipts+=proofs.length?'<h3>Saved Monero approvals</h3>':'';
  receipts+=proofs.map(([id,p],i)=>{const complete=jobs.some(([,j])=>j.proposal.nonce===id&&j.proposal.operation===(p.envelope.record.op==='burn'?'release':'transfer')&&j.phase==='finalized');return `<p>${p.envelope.record.op==='transfer'?'Holder transfer':'Return'} · ${jointShow(p.envelope.record.amount)} ${symbol}${complete?' · Completed':''}</p>${complete?'':`<button class="secondary wide" id="j3-move-${i}" ${approval}>Check confirmations and review Solana step</button><button class="text-btn wide" id="j3-proof-${i}" ${approval}>Retry exact Monero record</button>`}${p.result?.txid?`<a href="https://xmrchain.net/tx/${esc(p.result.txid)}" target="_blank" rel="noopener noreferrer">Monero receipt</a>`:''}`;}).join('');
  if(s.receiptError)content='<p role="alert">Saved approvals could not be read. Reopen Bridge before approving anything. Keep your recovery receipts.</p>';
  if(limitedTest)content=content.replace(/<option value="(?:donate|transfer)"[^>]*>[^<]*<\/option>/g,'');
  if(s.catalogError)content='<p class="subtle">Token names could not refresh. Your held tokens and saved transfers remain available.</p>'+content;
  const testNotice=walletTest?'<p>Bridge testing · Any linked wallet and verified XMR20 token. This program is upgradeable: the deployment wallet can change its code.</p>':privateTest?'<p>Private 1 XMR20 test. The deployment wallet can still change this program. Public bridging remains disabled. The total funding allowance stays at 1 XMR20 after a return.</p>':'';
  // Put the single live phase/error at the action the user is looking at.
  // Registration/return views keep their existing feedback position.
  const feedbackId=['j3-credit-feedback','j3-native-feedback','j3-move-feedback'].find(id=>content.includes(`id="${id}"`)),creditFeedback=Boolean(feedbackId),feedback=`<p id="progress" class="busy joint-busy" data-loading="${busy}" data-paused="${document.hidden}" role="status" tabindex="-1">${s.progress.render(esc)}</p>${s.error?`<p class="joint-error" role="alert">${esc(s.error)}</p>`:''}`;
  if(feedbackId)content=content.replace(`<div id="${feedbackId}"></div>`,`<div id="${feedbackId}">${feedback}</div>`);
  const cancelId=s.review||s.nativeReview?'j3-cancel':'j3-cancel-request';
  const sendDraft=peer&&content.includes('monero-send-form')&&!hasUnresolved(s)&&!s.review&&!s.nativeReview;
  // Keep receipts intact while the ordinary linking screen focuses on progress.
  // Failed/unavailable checks expose recovery immediately; nothing is discarded.
  const linkingProgress=automatic.length===1&&automatic[0][1].proposal.operation==='register'&&['solana-pending','publishing','monero-pending','delayed','complete'].includes(automatic[0][1].background.phase)&&!s.pollError&&!s.error&&!s.review&&!s.nativeReview;
  const status=s.syncing?'Syncing recent Monero blocks… This updates automatically.':s.checking?'Checking your wallets…':submittedMoves(s).length?'Waiting for Solana confirmation…':automatic.length?(linkingProgress?'':'Your bridge is in progress.'):!s.ready?'Bridge connection unavailable.':'';
  d.show(peer?'Send $'+asset.symbol.replace(/^\$/,''):'Bridge',`<div class="joint-transferable${peer?' monero-send':''}${linkingProgress?' bridge-link-wait':''}">${peer?'':'<p class="bridge-intro">Move tokens between Solana and Monero.</p>'}${status?`<p class="subtle" role="status">${status}</p>`:''}${creditFeedback?'':feedback}${!s.ready&&!s.syncing&&!automatic.length&&!submittedMoves(s).length&&!busy?`<button class="secondary wide" id="j3-ready">Reconnect bridge</button>`:''}${s.notice?`<p role="status">${esc(s.notice)}</p>`:''}${content}${!hasUnresolved(s)&&!sendDraft?`<button type="button" class="text-btn wide bridge-cancel" id="${cancelId}">Cancel</button>`:''}<div class="bridge-secondary"${linkingProgress||sendDraft||peer?' hidden':''}><details id="j3-linked"><summary>Wallets & token</summary><label>Solana</label><div class="address">${esc(s.owner)}</div><label>Monero</label><div class="address">${esc(s.monero)}</div><label>Token mint</label><div class="address">${esc(asset.mint)}</div></details><details id="j3-receipts"><summary>Activity & recovery</summary>${receipts}${s.preview?.state.status==='error'?`<button class="secondary wide" id="j3-quote-retry" ${disabled}>Check amount again</button>`:''}${s.ready?`<button class="secondary wide" id="j3-ready" ${disabled}>Refresh bridge status</button>`:''}${s.saved?`<button class="text-btn wide" id="j3-export" ${disabled}>Save public recovery receipts</button>`:'<label for="j3-import">Import public recovery receipts</label><input id="j3-import" type="file" accept=".json,application/json">'}<p class="subtle">${!hasUnresolved(s)?'Unsigned requests expire after 10 minutes. Closing this panel cancels the draft.':'This request has already been submitted. You can close this panel; its recovery receipt is kept.'}</p></details><details id="j3-about"><summary>About this bridge</summary>${testNotice}<p class="subtle">Wallet links and token transfers are public. SOL network and account fees apply. Transfers and returns require your linked Solana approval and the verifier’s signature. The verifier can refuse; lost keys can leave tokens locked.</p></details>${!s.receiveSetup&&!hasUnresolved(s)?`<button class="text-btn wide" id="j3-receive-setup" ${disabled}>${universalLinkEnabled?'Wallet link':'Link another token'}</button>`:''}<details id="j3-other"><summary>Other bridge balances</summary>${previous?`<button class="text-btn wide" id="j3-previous" ${disabled}>Previous joint bridge balances</button>`:''}<button class="text-btn wide" id="j3-legacy" ${disabled}>Legacy bridge withdrawals</button></details></div></div>`);
  for(const id of expanded){if($(id))$(id).open=true;}
  if($('j3-token'))$('j3-token').onchange=e=>{if(!working)void open({mint:e.target.value,rows:s.assets,receiveSetup:s.receiveSetup});};
  s.reviewWait?.sync($('j3-review-wait')?reviewWaitKey:null);
  d.on('j3-swap',()=>{if(working||s.checking||s.polling||!registered||!['deposit','release'].includes(s.operation))return;s.lifetime?.touch();s.operation=s.operation==='deposit'?'release':'deposit';s.value='';s.amountRevision=(s.amountRevision||0)+1;requestPreview(s);paint(s);});
  if($('j3-operation'))$('j3-operation').onchange=e=>{s.lifetime?.touch();s.notice='';s.operation=e.target.value;if(limitedTest&&s.operation==='release'&&position)s.value=jointUnits(position.available);requestPreview(s);paint(s);};
  const updateSendNext=()=>{if(!peer||!$('j3-review'))return;let valid=false;try{const raw=jointAmount(s.value,asset.symbol);moneroOwner(s.recipient.trim());valid=BigInt(raw)>0n&&moneroBalance!==undefined&&BigInt(raw)<=BigInt(moneroBalance);}catch{}$('j3-review').disabled=!!busy||!s.ready||!valid;};
  updateSendNext();
  d.on('j3-send-cancel',()=>cancelDraft(s));
  if($('j3-amount')){const input=$('j3-amount');input.onfocus=()=>{input.value=s.value;};input.onblur=()=>{input.value=bridgeInputDisplay(s.value);};}
  if($('j3-amount'))$('j3-amount').oninput=e=>{s.lifetime?.touch();s.notice='';s.amountRevision=(s.amountRevision||0)+1;s.value=e.target.value;updateSendNext();requestPreview(s);};
  if($('j3-recipient'))$('j3-recipient').oninput=e=>{s.lifetime?.touch();s.notice='';s.recipient=e.target.value;updateSendNext();requestPreview(s);if(universalLinkEnabled){try{moneroOwner(s.recipient.trim());paint(s,true);}catch{}}};
  d.on('j3-amount-max',async()=>{
   if(working||s.maxLoading)return;const value=s.value,operation=s.operation,revision=s.amountRevision;let edited=false;
   const oldInput=$('j3-amount');if(oldInput)oldInput.addEventListener?.('input',()=>{edited=true;},{once:true});
   s.maxLoading=true;s.error='';paint(s,true);
   try{
    const raw=['deposit','donate'].includes(operation)?maximumRaw(s.solBalance!==undefined&&Date.now()-s.solBalanceAt<5000?s.solBalance:await tokenBalance(s.owner,asset.mint),{limit:testPolicy?.maxGrossAtomic??TOKEN_TRANSFER_LIMIT}):maximumRaw(position?.available,{limit:TOKEN_TRANSFER_LIMIT});
    assert(s);if(!edited&&s.amountRevision===revision&&s.value===value&&s.operation===operation){if(raw==='0')throw Error('No spendable tokens are available.');s.value=inputAmount(raw);}
   }catch(e){if(current===s&&!s.abort.signal.aborted)s.error=e.message;}
   finally{s.maxLoading=false;if(current===s&&!s.abort.signal.aborted&&d.modal.open){paint(s,true);requestPreview(s);}}
  });
  d.on('j3-receive-setup',()=>{if(!working&&!s.checking&&!s.polling&&!hasUnresolved(s))return universalLinkEnabled?openUniversal(s):open({mint:s.asset.mint,rows:s.metadata,receiveSetup:true});});
  bind(s,'j3-ready',()=>requireReady(s));
  bind(s,'j3-background',()=>refreshBackground(s,{manual:true}));
  bind(s,'j3-return',()=>startReturn(s));
  d.on('j3-cancel-request',()=>cancelDraft(s));
  d.on('j3-pause-return',()=>{s.returnFlow?.pause();clearTimer(s.pollTimer);if(!working){paint(s);requestPreview(s);}});
  bind(s,'j3-return-retry',async()=>{const id=s.returnFlow?.state.nonce;if(!id)return;await requireReady(s);await s.client.retryProof(id);});
  bind(s,'j3-bridge',async()=>{const input=creditInput(s);if(!input||!s.preview.matches(input))throw Error('Wait for the current amount and fee before bridging.');const review=s.preview.state.value;try{await submitReview(s,review);}finally{s.preview.request(null);}});
  bind(s,'j3-quote-retry',async()=>{s.preview.retry();});
  if(linkEnabled)d.on('j3-register',()=>{if(!working&&!s.checking&&!s.polling)void openUniversal(s,{mint:s.asset.mint,symbol:s.asset.symbol});});else bind(s,'j3-register',async()=>{s.progress.stage('Preparing wallet registration…');s.review=await s.client.reviewRegistration(nonce());});
  bind(s,'j3-review',async()=>{read(s);if(pendingMoves(s).length)throw Error('Continue your saved return or transfer before creating another.');const amount=jointAmount(s.value,asset.symbol);if(limitedTest&&(!['deposit','release'].includes(s.operation)||BigInt(amount)>BigInt(testPolicy.maxGrossAtomic)))throw Error('This private test permits a deposit of at most 1 XMR20 and its return.');if(['deposit','donate'].includes(s.operation)){const recipient=s.operation==='donate'?moneroOwner(s.recipient.trim()):s.monero;s.review=await s.client.reviewCredit({recipient,amount,nonce:nonce()});}else{s.nativeReview={amount,nonce:nonce(),...(s.operation==='transfer'?{to:moneroOwner(s.recipient.trim())}:{})};s.recipientPlan=null;if(s.operation==='transfer')await prepareRecipient(s);}});
  bind(s,'j3-publish',()=>publishNative(s));
  bind(s,'j3-review-recipient',()=>prepareRecipient(s));
  d.on('j3-prepare-recipient',()=>{if(!working&&!s.checking&&!s.polling)void openUniversal(s,{recipient:recipientTarget,mint:s.asset.mint,symbol:s.asset.symbol});});
  bind(s,'j3-confirm',()=>submitReview(s,s.review));
  d.on('j3-cancel',()=>cancelDraft(s));
  bind(s,'j3-fast-check',()=>refreshFast(s));
  d.on('j3-fast-done',()=>{if(!working){clear();d.modal.close();}});
  fastJobs.forEach(([id,j],i)=>{bind(s,'j3-fast-retry-'+i,async()=>{const result=await s.client.fast.retry(id);assert(s);read(s);if(result.confirmed)s.completedFast=id;});bind(s,'j3-fast-renew-'+i,async()=>{s.operation='transfer';s.recipient=j.intent.toMonero;s.value=jointUnits(j.intent.amount);s.nativeReview={to:j.intent.toMonero,amount:j.intent.amount,nonce:j.intent.nonce};s.recipientPlan=null;});});
  jobs.forEach(([id,j],i)=>{bind(s,'j3-check-'+i,()=>checkOperation(s,id,undefined,true));bind(s,'j3-retry-'+i,async()=>{s.progress.stage('Checking the saved approval before retrying…');await checkOperation(s,id,await s.client.retrySubmission(id));});bind(s,'j3-renew-'+i,async()=>{s.progress.stage('Preparing a new approval…');s.review=j.proposal.operation==='register'?await s.client.reviewRegistration(j.proposal.nonce):['deposit','donate'].includes(j.proposal.operation)?await s.client.reviewCredit({recipient:j.envelope.record.owner,amount:j.proposal.amount,nonce:j.proposal.nonce}):await s.client.reviewMove(j.proposal.nonce);});});
  proofs.forEach(([id],i)=>{bind(s,'j3-move-'+i,()=>reviewSavedMove(s,id));bind(s,'j3-proof-'+i,async()=>{await requireReady(s);await s.client.retryProof(id);});});
  pendingMovesList.forEach(([id],i)=>bind(s,'j3-recover-fast-'+i,async()=>{read(s);const p=s.saved?.proofs?.[id],r=p?.envelope?.record;if(!s.client.fast||r?.op!=='transfer'||Object.values(s.saved.operations??{}).some(j=>j.phase==='submission-unknown'))throw Error('Check the saved Solana approval first.');s.recoverNativeNonce=id;s.operation='transfer';s.recipient=r.to;s.value=jointUnits(r.amount);s.nativeReview={to:r.to,amount:r.amount,nonce:id};s.recipientPlan=null;}));
  pendingMovesList.forEach(([id],i)=>bind(s,'j3-resume-move-'+i,async()=>{read(s);const job=Object.entries(s.saved?.operations||{}).find(([,j])=>j.proposal.nonce===id&&['transfer','release'].includes(j.proposal.operation));if(job?.[1].phase==='submission-unknown'){await checkOperation(s,job[0]);return;}await reviewSavedMove(s,id);}));
  for(const [id,fn] of [['j3-legacy',legacy],['j3-previous',previous]])d.on(id,()=>{if(!working&&!s.checking){clear();void fn?.();}});
  d.on('j3-export',()=>{assert(s);const url=URL.createObjectURL(new Blob([JSON.stringify(s.client.receipt(),null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='xmr20-transferable-public-receipts.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);});
  if($('j3-import'))$('j3-import').onchange=e=>{const f=e.target.files[0];void act(s,async()=>{if(!f||f.size>1000000)throw Error('Choose public receipts under 1 MB.');const v=JSON.parse(await f.text());assert(s);if(s.store.load())throw Error('Keep the current receipts before importing another backup.');s.store.save(v);});};
  const target=working?$('progress'):s.review||s.nativeReview?$('j3-review-title'):$(s.focusTarget||focused)||$('modal-title');if(target&&!passive){if(!['INPUT','BUTTON','SELECT','A'].includes(target.tagName))target.tabIndex=-1;target.focus({preventScroll:!working});}if(passive&&selection&&$(focused)){const input=$(focused);input.focus({preventScroll:true});if(selection.every(Number.isInteger))input.setSelectionRange?.(...selection);}if(!working)s.focusTarget=null;
 }
 async function open({mint,rows=[],amountRaw,direction,notice,receiveSetup=false,recipient:initialRecipient='',skipLinkResume=false}={}){clear();let opened,resumeLink;d.show(direction==='xmr-to-xmr'?'Send tokens':'Bridge','<p id="progress" class="busy joint-busy" data-loading="true" role="status">Checking the selected linked wallets…</p>');await d.run(async epoch=>{const a=d.account();if(!canSign(a)){d.show('Bridge','<p>Select an account with local Solana and Monero keys.</p><button class="secondary wide" id="j3-settings">Open Settings</button>');d.on('j3-settings',d.settings);return;}moneroOwner(a.xmr);
  if(mint&&!supportedMint(mint))throw Error('Select a valid token mint.');if(mint&&limitedTest&&mint!==testPolicy.mint)throw Error('This private test supports XMR20 only.');
  const holdingRows=d.rows?.()??rows,clickedHolding=rows.some(row=>row.mint===mint&&isBridgeHolding(row));
  const assets=choices(a,holdingRows,receiveSetup?mint:clickedHolding?mint:undefined,rows,receiveSetup),heldMints=new Set(holdingRows.filter(isBridgeHolding).map(row=>row.mint)),asset=mint?assets.find(v=>v.mint===mint):assets.find(asset=>heldMints.has(asset.mint))||assets[0];
  if(!asset){const s={empty:true,epoch,accountId:a.id,owner:a.sol,monero:a.xmr,sourceRows:rows,metadata:rows,requestedMint:mint,requestedAmount:amountRaw,requestedDirection:direction,abort:new AbortController()};current=s;
   if(linkEnabled){
    // Token discovery can be empty while the separately scoped identity is pending.
    // Corrupt receipts must open recovery, never masquerade as a fresh link.
    try{s.savedLink=hasSavedLink(a);}catch{s.savedLink=true;}
    if(s.savedLink&&!skipLinkResume&&!mint&&!direction){resumeLink=s;return;}
   }
   paintEmpty(s);return;}
  if(!direction){const held=[...(d.rows?.()??rows),...(clickedHolding?rows:[])].filter(row=>row.mint===asset.mint&&isBridgeHolding(row));if(!held.some(row=>row.network==='solana')&&held.some(row=>row.network==='monero'))direction='xmr-to-sol';}
  mint=asset.mint;const manifest=transferableManifest(mint),config=configFor(a,mint);if(privateTest)privateTestConfig(config,testPolicy);const s={epoch,receiveSetup,accountId:a.id,owner:a.sol,monero:a.xmr,assets,asset,sourceRows:rows,metadata:rows,manifest,config,abort:new AbortController(),ready:false,checking:true,value:amountRaw?jointUnits(amountRaw):direction==='xmr-to-xmr'&&!limitedTest?'':'1',operation:direction==='xmr-to-sol'?'release':direction==='xmr-to-xmr'&&!limitedTest?'transfer':'deposit',recipient:initialRecipient};current=s;opened=s;s.notice=notice;s.lifetime=requestLifetime({...lifetimeOptions,onExpire:()=>{if(current===s)void cancelDraft(s,true);}});
  s.reviewWait=createReviewWait({...reviewWaitOptions,getElement:()=>$('j3-review-wait'),isCurrent:()=>current===s&&!s.abort.signal.aborted&&d.modal.open,esc});
  s.progress=jointProgress({document:progressDocument,isCurrent:()=>current===s&&!s.abort.signal.aborted&&d.modal.open});s.store=adapters.publicReceiptStore({config,moneroOwner:s.monero});const assertSigning=()=>{assert(s);s.lifetime.assert();s.returnSigning?.assertActive();};s.provider=d.provider?d.provider(assertSigning):jointAccountProvider({account:d.account,assert:assertSigning});
  s.runtime=adapters.createRuntimeHttpClient({fastSettlement:manifest.fastSend==='solana-settlement-v1',endpoint:'/api/joint-transferable/'+mint,signal:s.abort.signal,fetcher:(p,o)=>fetch(endpoint+p,o),shareKey:snapshotShareKey??endpoint});s.chain=adapters.createSolanaAdapter({connection:new Connection(d.rpcEndpoint??rpcEndpoint,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:bridgeReadFetch({signal:s.abort.signal,onRetry:()=>{assert(s);s.progress.stage('Solana connection interrupted. Retrying verification…');}})}),manifest,privateTestPolicy:testPolicy});
  s.client=adapters.createWalletClient({onProgress:text=>{assert(s);const reviewingNative=Boolean(s.nativeReview);read(s);s.progress.stage(text);if(reviewingNative&&!s.nativeReview)paint(s,true);},manifest,runtime:s.runtime,provider:s.provider,store:s.store,proofChain:s.chain,verifyDeployment:async config=>{assert(s);if(config&&(config.abi!==3||config.program!==manifest.program||config.mint!==mint||config.verifier!==manifest.verifier))throw Error('Changed bridge deployment.');await s.chain.verifyProgram();assert(s);},moneroSigner:{address:s.monero,async sign(review){assert(s);s.returnSigning?.assertActive();const context={schema:'joint-owner-review-v3',config:s.config,moneroOwner:s.monero,expectedRecord:review.record},r=d.signMonero?await d.signMonero(review,context,s.abort.signal,{onProgress:text=>{assert(s);s.progress.stage(text);}}):await d.oneShot('joint-transferable.worker.js','sign-owner-record-v3',{seed:d.account().xmrSeed,review,context});assert(s);s.returnSigning?.assertActive();return r.signature;}},signatureVerifier:{async verify(text,address,signature){assert(s);const r=await d.oneShot('joint-transferable.worker.js',universalLinkEnabled&&text.startsWith('XMR20-WALLET-IDENTITY-MAINNET-V1\n')?'verify-wallet-identity-v1':'verify-owner-record-v3',{text,address,signature});assert(s);return r.good===true;}}});
  s.preview=createJointCreditPreview({...previewOptions,isCurrent:()=>{try{assert(s);return true;}catch{return false;}},prepare:async input=>{assert(s);if(input.operation==='release'){const fee=await s.chain.fee(input.amount);assert(s);return {kind:'return',amount:input.amount,fee,destination:s.owner,nonce:input.savedNonce??nonce()};}// Show the current Token-2022 fee from independent chain reads within about a
  // second while the exact service review (complete history, recipient proof,
  // fresh blockhash) loads. The estimate never enables the button or signs.
  estimateFee(s);
  const review=await s.client.reviewCredit({recipient:input.recipient,amount:input.amount,nonce:nonce()});assert(s);return review;},changed:state=>{if(current===s&&!s.abort.signal.aborted&&d.modal.open){
   if(state.status==='error'&&state.errorCode==='index-sync'){
    failed(s,{code:'index-sync'});
    // Discard the unusable quote. Only a fresh complete snapshot may request
    // another quote for the still-editable amount; neither step signs.
    s.preview.request(null);schedule(s);
   }
   paint(s,true);
  }}});
  s.displayReport=readBridgeDisplay({sol:s.owner,xmr:s.monero},s.manifest,testPolicy);read(s);s.progress.start('Verifying the program and complete bridge history…');paint(s);
 });
 // The host serializes d.run; opening inside it would silently skip the link UI.
 if(resumeLink){assert(resumeLink);await openUniversal(resumeLink);return;}
 const s=opened;if(!s)return;
 if(adapters===services)void tokenBalance(s.owner,s.asset.mint).then(raw=>{assert(s);s.solBalance=raw;s.solBalanceAt=Date.now();paint(s,true);}).catch(()=>{});
 rememberJointAsset(s.asset);if(loadCatalog&&!limitedTest)void loadCatalog({signal:s.abort.signal}).then(rows=>{if(current!==s||s.abort.signal.aborted||!d.modal.open)return;s.metadata=[...s.metadata,...rows];refreshAssets();rememberJointAsset(s.asset);}).catch(()=>{if(current===s&&!s.abort.signal.aborted){s.catalogError=true;paint(s,true);}});try{await refreshFast(s);await refreshSubmittedMoves(s);await refreshBackground(s);if(!s.ready&&!pendingBackground(s).length&&!submittedMoves(s).length)await readiness(s);}catch(e){if(current===s){s.ready=false;failed(s,e);}}finally{s.progress.stop();s.checking=false;if(current===s&&!s.abort.signal.aborted&&d.modal.open){paint(s,true);schedule(s);requestPreview(s);if(linkEnabled&&s.ready&&s.report&&!s.report.positions?.some(p=>p.position===addresses(s.config).position.toBase58())&&!hasUnresolved(s)&&!skipLinkResume)void openUniversal(s,{mint:s.asset.mint,symbol:s.asset.symbol});}}}
 return {open,clear,refreshAssets};
}
