import {showNativeFundingSetup} from './native-funding-setup.js';
import {checkNativeFee,checkConversionPreparation} from './native-action-approval.js';
import {createJointCreditPreview} from './joint-credit-preview.js';
import {createNativePageLayout} from './native-page-layout.js';
import {NATIVE_MARKET_CONFIGURATION} from './website/native-market-config.js';
import {createOperatorCustodyClient} from './native-market/wallet/operator-custody-client.mjs';
import {createNativeSendClient} from './native-market/wallet/native-send-client.mjs';
import {OPERATOR_DISCLOSURE} from './native-market/operator-policy.mjs';
import {createConversionBalanceReader} from './native-conversion-balance.js';
import {compactTokenBalance} from './token-display.js';
import {finishedSetups,markSetupFinished} from './native-setup-status.js';
import {nativeBridgePanels,bindNativeBridgePanels,setPanelAvailable,setPanelReceive,setPanelFee,setPanelImage} from './native-bridge-panels.js';

const exact=(raw,decimals=6)=>{const n=BigInt(raw),scale=10n**BigInt(decimals),fraction=(n%scale).toString().padStart(decimals,'0').replace(/0+$/,'');return String(n/scale)+(fraction?'.'+fraction:'');};
const units=value=>{if(!/^(0|[1-9][0-9]*)(\.[0-9]{0,6})?$/.test(value))throw Error('Enter an exact amount with up to 6 decimal places.');const [whole,fraction='']=value.split('.'),n=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));if(n<=0n)throw Error('Enter an amount greater than zero.');return String(n);};
const nonce=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');

// Optional custody boundary. This surface is never used for Monero peer sends
// or trades. Native funding is saved before any holder custody signature.
export function createNativeConversionPage({client,account,signCustody,assertCurrent,token={symbol:'XMR20'},setup=false,savedOnly=false,initialSource='deposit',onComplete,
 bridge=createOperatorCustodyClient({configuration:NATIVE_MARKET_CONFIGURATION,assertCurrent}),
 api=createNativeSendClient({operation:'credit',assertCurrent}),readBalance=createConversionBalanceReader({assertCurrent}),container=document.body,onClose=()=>window.close(),setupStore,setupManifest=NATIVE_MARKET_CONFIGURATION?.manifestId,onSwitch,
 resumeFrom='Activity → Finish Monero setup',onBridgeState}){
 // Where a saved bridge is resumed differs between the extension and the website.
 const resumePath=String(resumeFrom).replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
 const symbol=String(token.symbol||'XMR20').replace(/^\$/,'');
 container.classList.add('native-send-window');
 const root=document.createElement('main');root.id='native-send';root.classList.add('native-conversion-page');
 root.innerHTML='<div class="native-send-head"><h1>Move to Monero</h1><button type="button" data-close aria-label="Close bridge">×</button></div><div class="native-token-mark" aria-hidden="true">M</div><p class="native-send-message" role="status" aria-live="polite"></p><div class="native-send-content"></div><p class="native-send-error" role="alert" hidden></p>';
 container.replaceChildren(root);root.querySelector('[data-close]').onclick=onClose;
 const content=root.querySelector('.native-send-content'),message=root.querySelector('.native-send-message'),error=root.querySelector('.native-send-error');
 const layout=createNativePageLayout(root,client);
 let closed=false,busy=false,timer,nativeTerminal=false,saved=[],finished=new Set(),tokenImage,prepared,plan,custody,review,assembled,signAttempted=false,refundPlan,refund,quotePreview,autoComplete=null,completed=false,draftAmount='',timing={},builtNote='';
 const current=()=>{if(closed)throw Error('Bridge window closed.');assertCurrent();};
 const text=(selector,value)=>{content.querySelector(selector).textContent=value;};
 async function run(fn){
  if(closed||busy)return;busy=true;error.hidden=true;layout.setBusy(true);
  
  try{current();await fn();current();}
  catch(e){if(!closed){clearInterval(timer);layout.setWaiting(false);if(!prepared&&!signAttempted&&showNativeFundingSetup({error:e,account,layout,content,message,retry:()=>void run(recheckFunding)})){error.hidden=true;return;}message.textContent='';error.textContent=['TimeoutError','AbortError'].includes(e?.name)?'The bridge check took too long. Your saved approvals are kept. Please retry or reopen your saved bridge.':e.message||'Your saved bridge can be resumed after reconnecting.';error.hidden=false;}}
  finally{busy=false;layout.setBusy(false);}
 }
 async function sync(){
  await client.unlock();current();
  let result;message.textContent='Syncing Monero history…';
  do{result=await client.sync();current();if(!result.ready)message.textContent='Syncing Monero history · block '+result.height+' of '+result.targetHeight;}while(!result.ready);
  return result;
 }
 async function fundingReady(){
  const funding=await client.feeFundingStatus();current();
  if(funding?.address!==account.monero||typeof funding.ready!=='boolean')throw Error('The fee balance did not match this Monero wallet. Nothing was signed.');
  if(!funding.ready&&funding.reason==='reserved'){saved=await client.operatorCreditPreparations();current();if(reservedTransfers(funding))return false;}
  return !showNativeFundingSetup({funding,account,layout,content,message,retry:()=>void run(recheckFunding)});
 }
 async function recheckFunding(){await sync();if(await fundingReady())await form();}
 function recoveryList(){
  if(!saved.length)return;
  const list=document.createElement('details');list.className='native-send-recovery';list.open=savedOnly;
  const summary=document.createElement('summary');summary.textContent='Saved entries';list.append(summary);
  for(const row of saved){
   const button=document.createElement('button');button.type='button';button.className='native-secondary';
   const done=finished.has(row.preparationId);
   button.textContent=compactTokenBalance(row.quote.net)+' '+symbol+(row.completion?(row.completion.evidence?.status==='cancelled'?' · Cancelled':' · Refunded'):done?' · Complete':' · Resume');button.title=exact(row.quote.net)+' '+symbol;
   button.disabled=Boolean(row.completion)||done;if(button.disabled)button.dataset.disabled='true';
   button.onclick=()=>run(()=>resume(row));list.append(button);
  }layout.append(list);
 }
 async function resume(row){
  prepared=await client.recoverOperatorCreditPreparation({preparationId:row.preparationId});plan=prepared.plan;
  root.querySelector('h1').textContent=plan.request.kind==='migrate-output'?'Finish Monero setup':'Bridge to Monero';
  const recover=()=>client.recoverPreparedCarrier({preparationId:row.preparationId,kind:'issuance'});
  let prior;try{prior=await recover();}catch(e){
   if(e.message!=='Sync native history before carrier reassembly')throw e;
   await sync();prior=await recover();
  }
  if(prior.state==='signed'){assembled=prior;progress();await checkNative();startChecks(checkNative);return;}
  if(prior.state==='signing-unknown'){recoveryOptions();throw Error('A signing attempt was interrupted. Keep this wallet’s encrypted recovery file; do not create another bridge for these funds.');}
  await sync();
  custody=await bridge.prepare(plan);await showCustody();
 }
 // XMR reserved by a bridge this wallet started but never signed on Monero: show that
 // exact transfer so it can be continued instead of a generic "reserved" notice.
 function reservedTransfers(funding){
  const rows=saved.filter(row=>!row.completion&&!finished.has(row.preparationId)&&row.claims?.issuance===row.preparationId);
  if(!rows.length)return false;
  root.querySelector('h1').textContent='Bridge to Monero';
  const height=Number(funding.height),grouped=v=>{const [whole,fraction]=exact(v).split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction?'.'+fraction:'');};
  layout.render('<h2 class="native-funding-title">Finish your saved bridge</h2><p class="native-send-help">Your XMR fee is reserved for a bridge you already started. Continue it to send these tokens to Monero, or cancel it to start a new one.</p><div class="native-reserved-list" data-reserved></div>');
  const list=content.querySelector('[data-reserved]');
  for(const row of rows){
   const card=document.createElement('div');card.className='native-reserved-transfer';
   card.innerHTML='<div class="native-reserved-head"><span class="native-token-mark native-reserved-mark"></span><div><p class="native-reserved-amount"></p><p class="native-reserved-route"></p></div></div><dl class="native-send-costs"><div><dt>You receive on Monero</dt><dd data-net></dd></div><div><dt>Status</dt><dd data-status></dd></div></dl><div class="native-send-actions"><button type="button" class="native-secondary" data-cancel-saved>Cancel bridge</button><button type="button" class="native-primary" data-continue>Continue</button></div>';
   const mark=card.querySelector('.native-reserved-mark');
   if(tokenImage){const img=document.createElement('img');img.src=tokenImage;img.alt='';mark.replaceChildren(img);}else mark.textContent=symbol.slice(0,1);
   card.querySelector('.native-reserved-amount').textContent=grouped(row.quote.gross)+' '+symbol;
   card.querySelector('.native-reserved-route').textContent='Solana → Monero · '+(account.monero?account.monero.slice(0,6)+'…'+account.monero.slice(-6):'this Monero wallet');
   card.querySelector('[data-net]').textContent=grouped(row.quote.net)+' '+symbol;
   const left=Number(row.quote.creationDeadline)-20-height,button=card.querySelector('[data-continue]');
   const expired=Number.isSafeInteger(left)&&row.quote.creationDeadline&&left<=0;
   card.querySelector('[data-status]').textContent=expired?'Expired before Solana approval':'Waiting for your Solana approval'+(Number.isSafeInteger(left)&&row.quote.creationDeadline?' · about '+Math.max(1,Math.round(left*2/60))+' h left':'');
   if(expired){button.disabled=true;button.dataset.disabled='true';button.textContent='Expired';}
   else button.onclick=()=>run(()=>resume(row));
   card.querySelector('[data-cancel-saved]').onclick=()=>confirmCancel(card,row);
   list.append(card);
  }
  message.textContent='';return true;
 }
 // Cancel needs one confirmation; the wallet then proves the Solana deposit never
 // happened and can no longer happen before it frees the reserved XMR.
 function confirmCancel(card,row){
  const actions=card.querySelector('.native-send-actions');
  actions.innerHTML='<button type="button" class="native-secondary" data-keep>Keep it</button><button type="button" class="native-primary" data-confirm-cancel>Yes, cancel</button>';
  const note=document.createElement('p');note.className='native-send-help';note.dataset.cancelNote='';
  note.textContent='Cancel this bridge? Your '+symbol+' stays in your Solana wallet and the reserved XMR is freed. Checking Solana takes about 2 minutes.';
  actions.before(note);
  actions.querySelector('[data-keep]').onclick=()=>void run(async()=>{if(await fundingReady())await form();});
  actions.querySelector('[data-confirm-cancel]').onclick=()=>run(()=>cancelSaved(row));
 }
 async function cancelSaved(row){
  message.textContent='Checking your saved bridge…';
  const recovered=await client.recoverOperatorCreditPreparation({preparationId:row.preparationId});current();
  // The service's view only gives a clearer message; the wallet checks Solana itself.
  const status=await bridge.status(recovered.plan).catch(()=>null);current();
  if(status?.status==='finalized')throw Error('Your deposit already reached Solana, so this bridge can’t be cancelled. Press Continue to receive your tokens on Monero.');
  await sync();current();
  message.textContent='Making sure your Solana approval can no longer go through…';layout.setWaiting(true);
  try{await client.cancelOperatorCreditPreparation({preparationId:row.preparationId});current();}finally{layout.setWaiting(false);}
  saved=await client.operatorCreditPreparations();current();
  if(await fundingReady())await form();
  message.textContent='Bridge cancelled. Your reserved XMR is free and your '+symbol+' stayed on Solana.';
 }
 async function form(){
  message.textContent='';
  root.querySelector('h1').textContent=setup?'Enable Monero sends':'Bridge to Monero';
  const sourceKind=setup?'migrate-output':initialSource;
  layout.render((setup?'<p class="native-send-review-amount native-conversion-total" data-setup-amount>Checking your tokens…</p>':nativeBridgePanels({symbol,image:tokenImage,source:sourceKind==='migrate-output'?'Previously bridged':'Solana',destination:'Monero',destinationNote:'Your Monero wallet',value:draftAmount,canSwitch:typeof onSwitch==='function'}))+(setup?'<dl class="native-send-costs" data-quote hidden><div><dt>Token fee</dt><dd data-fee></dd></div><div><dt>You receive</dt><dd data-net></dd></div></dl>':'')+(setup?'<dl class="native-send-costs"><div><dt>Monero network fee</dt><dd>Up to 0.0001 XMR</dd></div><div><dt>XMR with record</dt><dd>0.000001 XMR</dd></div><div><dt>Solana fees</dt><dd>Network & account costs</dd></div></dl>':'')+'<details class="native-send-disclosure"><summary>Bridge trust & details</summary>'+(setup?'':'<dl class="native-send-costs"><div><dt>Monero network fee</dt><dd>Up to 0.0001 XMR</dd></div><div><dt>XMR with record</dt><dd>0.000001 XMR</dd></div><div><dt>Solana fees</dt><dd>Network & account costs</dd></div></dl>')+'<p data-trust></p><div class="native-send-costs"><span>Exact token amount</span><span data-exact-amount></span></div><label>Monero destination</label><div class="native-send-address" data-destination></div></details><p class="native-action-terms">Managed bridge: withdrawals rely on XMR20. Up to 0.000101 XMR plus SOL costs.</p><div class="native-send-actions"><button class="native-primary" data-next data-disabled="true" type="button">'+(setup?'Enable Monero sends':'Bridge')+'</button></div>');
  text('[data-trust]',OPERATOR_DISCLOSURE.summary+' '+OPERATOR_DISCLOSURE.risk+' '+OPERATOR_DISCLOSURE.conversion);
  text('[data-destination]',account.monero||'Your selected Monero wallet');
  if(!setup)bindNativeBridgePanels(content,{onSwitch});
  const input=content.querySelector('input'),source=content.querySelector('select'),balance=content.querySelector('[data-balance]'),button=content.querySelector('[data-next]');
  let amountText=draftAmount,kind=sourceKind;
  if(input){input.value=amountText?compactTokenBalance(units(amountText)):'';}if(source)source.value=kind;
  const terms=()=>{try{return {kind,owner:account.solana,amount:units(amountText)};}catch{return null;}};
  quotePreview?.close();quotePreview=createJointCreditPreview({isCurrent:()=>!closed&&button.isConnected,prepare:value=>bridge.quote(value),changed:state=>{
   const value=terms(),ready=quotePreview?.matches(value);const retry=state.status==='error';button.dataset.disabled=String(!ready&&!retry);button.disabled=busy||!ready&&!retry;button.textContent=retry?'Retry fee check':setup?'Enable Monero sends':'Bridge';if(setup)content.querySelector('[data-quote]').hidden=!ready;
   if(ready){const net=BigInt(value.amount)-BigInt(state.value.fee);text('[data-exact-amount]',exact(value.amount)+' '+symbol);
    if(setup){text('[data-fee]',compactTokenBalance(state.value.fee)+' '+symbol);text('[data-net]',compactTokenBalance(String(net))+' '+symbol);content.querySelector('[data-net]').title=exact(net)+' '+symbol;}
    else{setPanelReceive(content,net,exact(net)+' '+symbol);setPanelFee(content,'Fee '+compactTokenBalance(state.value.fee),'Token fee '+exact(state.value.fee)+' '+symbol);}}
   else if(!setup){setPanelReceive(content,undefined);setPanelFee(content);}
   message.textContent=state.status==='loading'?'Checking bridge fee…':state.status==='error'?state.error:'';
  }});
  const update=()=>{draftAmount=amountText;error.hidden=true;quotePreview.request(terms());};
  const maximum=async()=>{
   const requestedKind=kind;if(balance){balance.hidden=false;balance.textContent='Checking available tokens…';}
   const raw=await readBalance({kind:requestedKind,account});current();if(kind!==requestedKind||!button.isConnected)return;
   if(typeof raw!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(raw)||BigInt(raw)>18446744073709551615n)throw Error('Your balance could not be checked. Try again.');
   const available=BigInt(raw),maximum=available>50000000000000n?50000000000000n:available;
   amountText=maximum?exact(maximum):'';
   if(input){input.value=maximum?compactTokenBalance(String(maximum)):'';input.title=maximum?exact(maximum)+' '+symbol:'';}
   if(balance)balance.textContent='Available: '+compactTokenBalance(raw)+(maximum<available?' · 50M max per bridge':'');
   if(setup){text('[data-setup-amount]',compactTokenBalance(String(maximum))+' '+symbol);content.querySelector('[data-setup-amount]').title=exact(maximum)+' '+symbol;if(!maximum){onComplete?.();return;}}
   update();
  };
  if(input){input.oninput=()=>{amountText=input.value;update();};input.onfocus=()=>{input.value=amountText;};input.onblur=()=>{try{input.value=compactTokenBalance(units(amountText));}catch{}};}
  if(source)source.onchange=()=>{kind=source.value;amountText='';input.value='';input.removeAttribute('title');balance.hidden=true;update();};
  const max=content.querySelector('[data-max]');if(max)max.onclick=()=>run(maximum);
  button.onclick=()=>run(async()=>{
   if(quotePreview.state.status==='error'){quotePreview.retry();return;}
   const request=terms();if(!request||!quotePreview.matches(request))throw Error('Wait for the current amount and fee before bridging.');
   const quote=quotePreview.state.value,approved={...request,fee:quote.fee};
   message.textContent='Preparing your bridge…';await sync();current();if(!await fundingReady())return;
   prepared=await client.prepareOperatorCredit({request:{...approved,nonce:nonce(),carrierPiconero:'1000000',maximumFeePiconero:'100000000'}});current();
   prepared=await client.recoverOperatorCreditPreparation({preparationId:prepared.preparationId});current();
   checkConversionPreparation(prepared,approved);plan=prepared.plan;
   if(account.monero&&plan.record.owner!==account.monero)throw Error('The receiving Monero wallet changed. Nothing was signed.');
   custody=await bridge.prepare(plan);current();
   autoComplete={planId:plan.id,maximumFee:'100000000'};
   quotePreview.close();
   if(custody.status==='finalized'){await nativeReview();return;}
   if(!custody.proposal){custodyProgress();startChecks(checkCustody);return;}
   await approveCustody();
  });recoveryList();
  if(setup)await maximum();else{update();
   // Display only and outside the busy lock: a failed read leaves "Available: —", never zero.
   void readBalance({kind,account}).then(raw=>{if(!closed&&button.isConnected&&kind===sourceKind&&typeof raw==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(raw))setPanelAvailable(content,raw);}).catch(()=>{});
  }
 }
 async function approveCustody(){
  current();
  if(prepared.quote.creationDeadline){const checkpoint=await sync();if(Number(checkpoint.height)+20>=prepared.quote.creationDeadline)throw Error('This bridge preparation expired. Reopen its saved receipt before approving again.');}
  message.textContent='Submitting your bridge approval…';
  const signed=await signCustody({plan,proposal:custody.proposal});current();
  custodyProgress();custody=await bridge.approve(plan,signed.transaction);current();report({stage:'solana'});await showCustody();
 }
 async function showCustody(){
  current();clearInterval(timer);
  if(custody.status==='finalized'){await nativeReview();return;}
  if(!custody.proposal){custodyProgress();startChecks(checkCustody);return;}
  layout.setWaiting(false);message.textContent='Review the move to Monero.';
  layout.render('<p class="native-send-review-amount"></p><label>Monero destination</label><div class="native-send-address"></div><dl class="native-send-costs"><div><dt>Token fee</dt><dd data-fee></dd></div><div><dt>You receive</dt><dd data-net></dd></div><div><dt>Monero network fee</dt><dd data-xmr></dd></div></dl><p class="native-send-help">SOL network and account costs also apply. Confirming converts the amount shown into the new Monero token system.</p><p class="native-send-help" data-trust></p><div class="native-send-actions"><button class="native-secondary" data-cancel type="button">Cancel</button><button class="native-primary" data-approve type="button">Confirm</button></div>');
  text('.native-send-review-amount',exact(plan.request.amount)+' '+symbol);
  text('.native-send-address',plan.record.owner);text('[data-fee]',exact(plan.request.fee)+' '+symbol);
  text('[data-net]',exact(plan.record.amount)+' '+symbol);text('[data-xmr]',exact(prepared.quote.nativeFee,12)+' XMR');
  text('[data-trust]',OPERATOR_DISCLOSURE.risk+' Existing linked-claim protection ends for this converted amount.');
  content.querySelector('[data-cancel]').onclick=onClose;
  content.querySelector('[data-approve]').onclick=()=>run(async()=>{autoComplete={planId:plan.id,maximumFee:prepared.quote.nativeFee};await approveCustody();});
 }
 // One tracker from Solana approval to Monero confirmations, so a long in-browser build
 // or a pending publish is visible before the explorer link exists.
 const STEPS=[['Solana deposit','Waiting for Solana to confirm your deposit…','Confirmed on Solana'],
  ['Monero transaction','Building and signing it in this browser. This can take 1–2 minutes; keep this tab open.','Built and signed'],
  ['Send to Monero','Sending it to the Monero network…','Accepted by the Monero network'],
  ['Monero confirmations','Waiting for 10 confirmations, about 20 minutes.','Confirmed']];
 const steps=(active,detail)=>'<ol class="native-bridge-steps">'+STEPS.map(([title,doing,done],i)=>'<li class="'+(i<active?'done':i===active?'active':'pending')+'"'+(i===active?' aria-current="step"':'')+'><span class="native-step-mark" aria-hidden="true">'+(i<active?'✓':i+1)+'</span><div><strong>'+title+'</strong>'+(i<=active?'<span>'+(i<active?done+(i===1?builtNote:''):detail||doing)+'</span>':'')+'</div></li>').join('')+'</ol>';
 // Display-only progress for the host wallet's pending row; never affects the bridge.
 const report=update=>{try{if(prepared?.preparationId&&plan?.record?.amount)onBridgeState?.({preparationId:prepared.preparationId,amountRaw:plan.record.amount,...update});}catch{}};
 const setSteps=(active,detail)=>{const list=content.querySelector('.native-bridge-steps');if(list)list.outerHTML=steps(active,detail);};
 // How long each part of the Monero step took, shown once it is built, so slow parts can be found.
 async function timed(name,work){const start=Date.now();try{return await work();}finally{timing[name]=Date.now()-start;}}
 const span=ms=>{const s=Math.max(1,Math.round(ms/1000));return s<60?s+' s':Math.floor(s/60)+' min '+s%60+' s';};
 const timingNote=t=>[t.service,t.catchUp,t.build,t.sign].every(Number.isFinite)?' in '+span(Math.max(t.service,t.catchUp)+t.build+t.sign)+
  ' (bridge service '+span(t.service)+' · wallet catch-up '+span(t.catchUp)+' · building '+span(t.build)+' · signing '+span(t.sign)+')':'';
 function custodyProgress(){
  message.textContent='Waiting for Solana to confirm your approval.';layout.setWaiting(true);
  layout.render(steps(0)+'<p class="native-send-help">Your approval is saved. Keep this wallet open, or resume from '+resumePath+' later.</p><div class="native-send-actions"><button class="native-secondary" data-check type="button">Check status</button><button class="native-primary" data-resume type="button" aria-label="Resume saved bridge">Resume</button></div>');
  content.querySelector('[data-check]').onclick=()=>run(checkCustody);
  content.querySelector('[data-resume]').onclick=()=>run(async()=>{custody=await bridge.prepare(plan);if(!custody.proposal&&custody.status!=='finalized')custody=await bridge.retry(plan);await showCustody();});
 }
 async function checkCustody(){custody=await bridge.status(plan);current();if(custody.status==='finalized'){clearInterval(timer);await nativeReview();}else if(['failed','expired'].includes(custody.status)){clearInterval(timer);layout.setWaiting(false);message.textContent='This Solana attempt expired or failed. Resume to review a fresh approval.';}}
 async function nativeReview(){
  // Keep Check status / Resume on screen: a failed build is retried from here.
  if(!content.querySelector('.native-bridge-steps'))custodyProgress();
  setSteps(1);report({stage:'building'});layout.setWaiting(false);message.textContent='Requesting the credit for your saved approval…';
  try{
   // Custody confirmation/issuance can outlast the signing checkpoint, and a
   // prior verification error closes the worker. Reopen and incrementally
   // refresh before reviewing the same saved preparation; never reserve anew.
   // The service request and the wallet catch-up are independent, so they run
   // together; both settle before any failure is shown, so the wallet is idle.
   timing={};const [issued,synced]=await Promise.allSettled([timed('service',()=>bridge.issue(plan)),timed('catchUp',sync)]);current();
   for(const outcome of [issued,synced])if(outcome.status==='rejected')throw outcome.reason;
   message.textContent='Checking your saved approval and preparing the Monero record…';
   review=await timed('build',()=>client.constructOperatorIssuedCredit({preparationId:prepared.preparationId,signature:issued.value.signature}));current();
  }catch(e){recoveryOptions();throw e;}
  if(autoComplete?.planId===plan.id&&!signAttempted){checkNativeFee(review,autoComplete.maximumFee);await publishCredit();return;}
  layout.render('<p class="native-send-review-amount"></p><p class="native-send-help">Your backing is saved on Solana. Publish the matching Monero record to receive your tokens. After 10 confirmations, you can send and trade using only your Monero wallet.</p><dl class="native-send-costs"><div><dt>Monero network fee</dt><dd></dd></div></dl><div class="native-send-actions"><button class="native-primary" data-publish type="button">Complete bridge</button></div>');
  text('.native-send-review-amount',exact(plan.record.amount)+' '+symbol);text('dd',exact(review.fee,12)+' XMR');message.textContent='Ready to complete your bridge.';
  content.querySelector('[data-publish]').onclick=()=>run(publishCredit);
  recoveryOptions();
 }
 async function publishCredit(){
  current();if(signAttempted)throw Error('Reopen the saved bridge to recover the previous signing attempt.');
  signAttempted=true;const signing=Date.now(),signed=await client.signCarrier({reviewHandle:review.handle});current();
  assembled=await client.assembleCarrier({reviewHandle:review.handle,reservationId:signed.reservationId});current();timing.sign=Date.now()-signing;
  builtNote=timingNote(timing);
  report({stage:'sending',txid:assembled.txid});progress();const result=await api.publish({transaction:assembled.transaction,retry:false});renderNative(result);if(result.confirmed)await completeBridge();startChecks(checkNative);
 }
 function progress(){
  clearInterval(timer);nativeTerminal=false;layout.setWaiting(true);message.textContent='Publishing your saved Monero record…';
  layout.render(steps(2)+'<p class="native-send-review-amount"></p><dl class="native-send-costs" hidden><div><dt>Monero confirmations</dt><dd>—</dd></div></dl><p class="native-send-help">The exact signed transaction is saved. You can close this window and resume it from '+resumePath+'.</p><div class="native-send-actions"><button class="native-secondary" data-check type="button">Check status</button><button class="native-primary" data-retry type="button" hidden>Publish</button></div>');
  text('.native-send-review-amount',exact(plan.record.amount)+' '+symbol);
  content.querySelector('[data-check]').onclick=()=>run(checkNative);
  recoveryOptions();
 }
 function renderNative(value){
	  const tracked=['accepted','mempool','confirming','confirmed','rejected'].includes(value.status);
	  const retryableStage=value.failureStage===undefined||/^(?:peer-admission|state-changed|validate-peer-[01]-(?:transport|rejected)|relay-peer-0-(?:transport|rejected))$/.test(value.failureStage);
	  const fixedRejection=value.status==='submission-unknown'&&!retryableStage;
	  const accepted=['accepted','mempool','confirming','confirmed'].includes(value.status);
	  if(assembled?.txid)report({stage:value.confirmed?'confirmed':value.status==='rejected'?'rejected':accepted?'confirming':'sending',txid:assembled.txid,...(accepted&&Number.isSafeInteger(value.confirmations)?{confirmations:value.confirmations,required:value.requiredConfirmations}:{})});
	  setSteps(value.confirmed?4:accepted?3:2,accepted&&!value.confirmed&&value.confirmations!==undefined?Math.min(value.confirmations,value.requiredConfirmations)+' of '+value.requiredConfirmations+' confirmations · about '+Math.max(2,2*(value.requiredConfirmations-value.confirmations))+' min left':undefined);
	  // The explorer link appears on the "Send to Monero" step once a node has the transaction.
	  const sent=content.querySelector('.native-bridge-steps li:nth-child(3)>div>span');
	  if(tracked&&sent&&assembled?.txid){const link=document.createElement('a');link.className='native-send-explorer';link.href='https://xmrchain.net/tx/'+assembled.txid;link.target='_blank';link.rel='noopener noreferrer';link.textContent='View on xmrchain ↗';sent.append(' · ',link);}
	  text('dd',tracked&&value.confirmations!==undefined?Math.min(value.confirmations,value.requiredConfirmations)+' / '+value.requiredConfirmations:'Not seen');
	  message.textContent=value.confirmed?'Bridge complete. Your tokens are available on Monero.':value.status==='rejected'?'The Monero transaction was mined, but its token credit was not accepted. Check recovery below.':value.status==='not-found'?'Your signed credit is saved. Publish it to continue.':fixedRejection?'The saved transaction was not accepted by the Monero node. Keep this receipt and check recovery below.':value.status==='submission-unknown'?'The last publish could not be verified. Retry the same saved transaction.':value.status==='unavailable'?'Monero status is temporarily unavailable. Your signed transaction is saved; check again before retrying.':'Waiting for '+value.requiredConfirmations+' Monero confirmations. Each new block moves this forward.';
	  layout.setWaiting(!value.confirmed&&['accepted','mempool','confirming'].includes(value.status));
  const retry=content.querySelector('[data-retry]');retry.hidden=!['not-found','submission-unknown'].includes(value.status);
	  if(fixedRejection)retry.hidden=true;
	  retry.textContent=value.status==='submission-unknown'?'Retry publish':'Publish';
  retry.onclick=()=>run(async()=>renderNative(await api.publish({transaction:assembled.transaction,retry:value.status!=='not-found'})));
  if(value.confirmed)void markSetupFinished({manifest:setupManifest,preparationId:prepared?.preparationId,store:setupStore});
  nativeTerminal=value.confirmed||value.status==='rejected';
  if(nativeTerminal)clearInterval(timer);
  if(value.confirmed)content.querySelector('[data-recover-bridge]')?.remove();
 }
 function recoveryOptions(){
  const deadline=prepared?.quote?.creationDeadline;
  if(!deadline||content.querySelector('[data-recover-bridge]'))return;
  const details=document.createElement('details');details.className='native-send-recovery';details.dataset.recoverBridge='';
  const summary=document.createElement('summary');summary.textContent='Unfinished bridge recovery';details.append(summary);
  const explanation=document.createElement('p');explanation.className='native-send-help';
  explanation.textContent='If the initial Monero credit never completes, you can review a refund after block '+deadline+' is confirmed. Tokens already created on Monero never expire. Refunds return to the original Solana holder; token and SOL network fees apply.';
  const button=document.createElement('button');button.type='button';button.className='native-secondary';button.textContent='Check refund availability';
  button.onclick=()=>run(async()=>{
   clearInterval(timer);
   if(review&&!signAttempted){await client.discardCarrierReview({reviewHandle:review.handle});review=null;}
   const checkpoint=await sync();
   if(Number(checkpoint.height)<deadline)throw Error('Refunds become available after block '+deadline+' is confirmed. Your saved bridge can still be completed before its deadline.');
   const quoted=await bridge.refundQuote(plan);refundPlan=quoted.plan;
   refund=await bridge.prepareRefund(refundPlan);await showRefund();
  });
  details.append(explanation,button);layout.append(details);
 }
 async function showRefund(){
  clearInterval(timer);
  if(refund.status==='finalized'){
   await client.completeOperatorRefund({preparationId:prepared.preparationId,plan:refundPlan});current();
   layout.render('<p class="native-send-review-amount"></p><p class="native-send-help">Returned to the original Solana holder. The saved bridge and signing receipts are retained.</p><button class="native-primary" data-done type="button">Done</button>');
   text('.native-send-review-amount',exact(refund.receipt.net)+' '+symbol);message.textContent='Bridge refund complete.';
   content.querySelector('[data-done]').onclick=onClose;return;
  }
  message.textContent=refund.proposal?'Review your bridge refund.':'Confirming your refund on Solana…';
  layout.render('<p class="native-send-review-amount"></p><label>Original Solana holder</label><div class="native-send-address"></div><dl class="native-send-costs"><div><dt>Token fee</dt><dd data-fee></dd></div><div><dt>You receive</dt><dd data-net></dd></div></dl><p class="native-send-help">SOL network and account costs also apply. This returns an unfinished bridge entry; it does not withdraw tokens already created on Monero.</p><div class="native-send-actions"><button class="native-secondary" data-check type="button">Check status</button><button class="native-primary" data-refund type="button"></button></div>');
  text('.native-send-review-amount',exact(refundPlan.record.amount)+' '+symbol);text('.native-send-address',refundPlan.request.owner);
  text('[data-fee]',exact(refundPlan.fee)+' '+symbol);text('[data-net]',exact(String(BigInt(refundPlan.record.amount)-BigInt(refundPlan.fee)))+' '+symbol);
  text('[data-refund]',refund.proposal?'Confirm refund':'Resume');
  content.querySelector('[data-check]').onclick=()=>run(checkRefund);
  content.querySelector('[data-refund]').onclick=()=>run(async()=>{
   if(refund.proposal){const signed=await signCustody({plan:refundPlan,proposal:refund.proposal});refund=await bridge.approveRefund(refundPlan,signed.transaction);}
   else refund=await bridge.retryRefund(refundPlan);
   await showRefund();
  });
  if(!refund.proposal)startChecks(checkRefund);
 }
 async function checkRefund(){refund=await bridge.refundStatus(refundPlan);if(refund.status==='finalized')await showRefund();else if(['expired','failed'].includes(refund.status)){const quote=await bridge.refundQuote(plan);refundPlan=quote.plan;refund=await bridge.prepareRefund(refundPlan);await showRefund();}}
 async function completeBridge(){await sync();await client.inventory();current();message.textContent='Bridge complete. Your tokens are available on Monero.';if(!completed){completed=true;onComplete?.();}}
 async function checkNative(){const value=await api.status({txid:assembled.txid});current();renderNative(value);if(value.confirmed)await completeBridge();}
 function startChecks(fn){clearInterval(timer);if(fn===checkNative&&nativeTerminal)return;timer=setInterval(()=>{if(!document.hidden)void run(fn);},5000);}
 return Object.freeze({
  async open(){if(savedOnly)root.querySelector('h1').textContent='Finish Monero setup';await run(async()=>{if(!account.solana||typeof signCustody!=='function')throw Error('Bridge entry needs the Solana holder. Monero sends and trades do not.');await client.unlock();saved=await client.operatorCreditPreparations();finished=await finishedSetups({manifest:setupManifest,rows:saved,store:setupStore});current();if(savedOnly){root.querySelector('h1').textContent='Finish Monero setup';message.textContent='';layout.render('<p class="native-send-help">'+(saved.length?'Choose your saved entry to finish moving the tokens to Monero. They may not appear in your balance until this finishes.':'No saved setup was found for this wallet on this device. Select the wallet you used when enabling Monero sends.')+'</p>');recoveryList();return;}await form();});},
  setTokenImage(image){if(closed||typeof image!=='string'||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)||image.length>700000)return;tokenImage=image;setPanelImage(content,image);const img=document.createElement('img');img.src=image;img.alt='';root.querySelector('.native-token-mark').replaceChildren(img);for(const mark of root.querySelectorAll('.native-reserved-mark'))mark.replaceChildren(img.cloneNode());},
  close(){closed=true;autoComplete=null;quotePreview?.close();clearInterval(timer);layout.close();}
 });
}
