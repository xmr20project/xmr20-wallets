import {maxControl,fillMaximum,maximumRaw,TOKEN_TRANSFER_LIMIT} from '../../engine/token/max-amount.js';
import {pendingDebits} from './pending-debits.js';
import {login,walletRequest,jsonFetch,amount,units} from '../../engine/shared/core.js';
import {bridgeToken,bridgeOpen,validateBridgeQuote,validateBridgeReceipt,bridgeBurnReview,bridgeStatus} from './bridge-policy.js';
import {bridgeSolReserve,prepareBridgeSolana,signBridgeSolana,signedAttemptResolved} from './bridge-solana.js';
import {createJointEscrowUI} from './joint-escrow-ui.js';
import {createJointMainnetUI} from '../../engine/shared/joint-mainnet-ui.js';
import {createJointTransferableUI} from '../../engine/shared/joint-transferable-ui.js';
import {legacyReturnRoute} from './legacy-bridge-route.js';
export function createBridgeUI(d){
 const joint=typeof __XMR20_JOINT_PREVIEW__!=='undefined'&&__XMR20_JOINT_PREVIEW__?createJointEscrowUI(d):null;
 const previous=typeof __XMR20_JOINT_MAINNET_REVIEW__!=='undefined'&&__XMR20_JOINT_MAINNET_REVIEW__?createJointMainnetUI(d,{legacy:openStandard}):null;
 const mainnet=typeof __XMR20_JOINT_TRANSFERABLE_REVIEW__!=='undefined'&&__XMR20_JOINT_TRANSFERABLE_REVIEW__?createJointTransferableUI(d,{legacy:openStandard,previous:()=>previous.open()}):previous;
 let ctx=null,timer=null;
 function clear(){clearTimeout(timer);timer=null;ctx?.verification?.abort();mainnet?.clear();if(previous!==mainnet)previous?.clear();}
 function assert(c){d.same(c.epoch);const a=d.account();if(ctx!==c||a.id!==c.a.id||a.sol!==c.a.sol||a.xmr!==c.a.xmr)throw Error('Wallet account changed. Reopen Bridge.');}
 const fmt=(n,ticker)=>`${amount(n)} ${ticker}`;
 function show(c,title,html){clear();assert(c);d.show(title,`<div data-bridge-view="${c.id}">${html}</div>`);}
 const live=c=>ctx===c&&d.modal.open&&d.modal.querySelector(`[data-bridge-view="${c.id}"]`);
 function bind(c,id,fn){d.on(id,()=>void d.run(async()=>{assert(c);await fn();}));}
 function progress(text){const el=document.getElementById('progress');if(el)el.textContent=text;}
 function inlineError(c,text){if(!live(c))return;const el=d.modal.querySelector('#bridge-error');if(el){el.textContent=text;el.hidden=false;}}
 async function request(c,action,data={}){assert(c);const result=await walletRequest(c.token,action,data);assert(c);return result;}
 const local=c=>(d.vault().receipts||[]).filter(r=>r.kind==='bridge'&&r.accountId===c.a.id);
 async function saved(c,t,row){
  validateBridgeReceipt(t,c.a,row);let r=local(c).find(r=>r.intent===t.id);
  if(!r)r=await d.record({kind:'bridge',chain:'bridge',intent:t.id,row,direction:t.direction,amount:amount(t.amountRaw),symbol:row.ticker,to:t.direction==='sol-to-xmr'?c.a.xmr:c.a.sol,status:bridgeStatus(t)[0]});
  assert(c);r.transfer=t;r.row=row;r.status=bridgeStatus(t)[0];
  if(r.signed&&signedAttemptResolved(t,r.signed))delete r.signed;
  await d.persist();assert(c);return r;
 }
 function token(c,id){const l=c.catalog.find(l=>l.id===id);return bridgeToken({id,mint:l?.mint,deployment:l?.moneroTxid,ticker:l?.ticker||'Token',name:l?.name||'Token'},l);}
 async function reload(c){c.remote=await request(c,'account');if(!Array.isArray(c.remote.transfers))throw Error('Saved bridge lookup incomplete.');}
 async function open(options){if(options?.legacyReceiptId)return openStandard({receiptId:options.legacyReceiptId});if(mainnet){await mainnet.open(options);const route=legacyReturnRoute(d.rows(),{requestedMint:options?.mint,emptyNewBridge:!!d.modal.querySelector('#j3-refresh-holdings'),receipts:d.vault()?.receipts,account:d.account()});if(route)return openStandard(route);return;}if(typeof __XMR20_JOINT_PREVIEW__!=='undefined'&&__XMR20_JOINT_PREVIEW__){clear();joint.clear();d.show('Bridge','<p>Choose a bridge flow.</p><button class="secondary wide" id="bridge-standard">Existing token bridge</button><button class="secondary wide" id="bridge-joint">Joint escrow test</button><p class="subtle">Joint escrow runs locally with temporary test keys and tokens.</p>');d.on('bridge-standard',()=>void openStandard());d.on('bridge-joint',()=>void joint.open());return;}return openStandard();}
 async function openStandard(options={}){clear();joint?.clear();d.show('Bridge', '<p id="progress" class="busy">Loading bridge balances and saved transfers…</p>');await d.run(async epoch=>{
  const a=d.account();if(!a?.solSecret||!a.xmr||a.watch)throw Error('Select an account with a Solana key and a Monero address. Link both in Settings first.');
  const c={id:crypto.randomUUID(),a:{...a},epoch};ctx=c;c.token=await login(a);assert(c);
  const [remote,catalog]=await Promise.all([request(c,'account'),jsonFetch('https://api.xmr20.org/api/xmr20/tokens')]);assert(c);
  if(!Array.isArray(remote.transfers)||!Array.isArray(catalog.tokens))throw Error('Bridge data unavailable. Retry before starting a transfer.');c.remote=remote;c.catalog=catalog.tokens;
  if(options.receiptId){
   const transfer=remote.transfers.find(t=>t.id===options.receiptId&&t.owner===c.a.sol&&t.moneroAddress===c.a.xmr);
   if(!transfer)throw Error('Saved bridge unavailable. Keep its receipt; no new bridge was started.');
   status(c,await saved(c,transfer,token(c,transfer.launchId)));
  }else if(options.direction==='xmr-to-sol'){
   const row=options.mint?d.rows().find(r=>r.network==='monero'&&r.bridge!=='joint-v3'&&r.mint===options.mint&&BigInt(r.amountRaw)>0n):null;
   if(row)await form(c,{...token(c,row.id),amountRaw:row.amountRaw},'xmr-to-sol');else await choose(c,'xmr-to-sol');
  }else menu(c);
 });}
 function menu(c){
  const remote=c.remote.transfers.filter(t=>t.owner===c.a.sol&&t.moneroAddress===c.a.xmr&&bridgeOpen(t));
  const drafts=local(c).filter(r=>!r.transfer&&!remote.some(t=>t.id===r.intent));
  show(c,'Bridge',`<p class="subtle">${mainnet?'Withdraw existing legacy balances or finish a saved transfer.':'Move the same XMR20 token between your Solana and Monero accounts.'}</p>${mainnet?'':'<button class="secondary wide" id="bridge-to-xmr">Solana → Monero</button>'}<button class="secondary wide" id="bridge-to-sol">Monero → Solana</button><p class="subtle">SOL pays Solana network and account fees. The service publishes Monero records. Token fees appear before approval.</p>${remote.length||drafts.length?'<h3>Resume a bridge</h3>':''}${remote.map((t,i)=>`<button class="secondary wide" id="resume-bridge-${i}">${d.esc(fmt(t.amountRaw,c.catalog.find(l=>l.id===t.launchId)?.ticker||'Token'))}<small>${t.direction==='sol-to-xmr'?'To Monero':'To Solana'} · ${d.esc(bridgeStatus(t)[0])}</small></button>`).join('')}${drafts.map((r,i)=>`<button class="secondary wide" id="resume-draft-${i}">Check saved ${d.esc(r.symbol)} bridge</button>`).join('')}<p class="subtle">Experimental operator-attested bridge. Keep the expanded wallet open while approving; saved transfers can be resumed later.</p>`);
  bind(c,'bridge-to-xmr',()=>choose(c,'sol-to-xmr'));bind(c,'bridge-to-sol',()=>choose(c,'xmr-to-sol'));
  remote.forEach((t,i)=>bind(c,'resume-bridge-'+i,async()=>{const row=token(c,t.launchId),r=await saved(c,t,row);status(c,r);}));
  drafts.forEach((r,i)=>bind(c,'resume-draft-'+i,()=>recoverDraft(c,r)));
 }
 async function choose(c,direction){
  if(mainnet&&direction==='sol-to-xmr')throw Error('New legacy deposits are closed. Use the new bridge for XCAT.');
  if(direction==='xmr-to-sol'&&!c.a.xmrSeed)throw Error('Import this account’s Monero recovery phrase before bridging from Monero.');
  const network=direction==='sol-to-xmr'?'solana':'monero',rows=d.rows().filter(r=>r.network===network&&r.bridge!=='joint-v3'&&BigInt(r.amountRaw)>0n);
  show(c,direction==='sol-to-xmr'?'Bridge to Monero':'Bridge to Solana',`<p class="subtle">Choose a token on ${network==='solana'?'Solana':'Monero'}.</p>${rows.map((r,i)=>`<button class="secondary wide" id="bridge-token-${i}">${d.esc(fmt(r.amountRaw,r.ticker))}</button>`).join('')||'<p>No confirmed tokens available on this chain. Refresh wallet balances.</p>'}<button class="text-btn wide" id="bridge-back">Back</button>`);
  rows.forEach((r,i)=>bind(c,'bridge-token-'+i,()=>form(c,{...token(c,r.id),amountRaw:r.amountRaw},direction)));bind(c,'bridge-back',()=>menu(c));
 }
 async function form(c,row,direction){
  await reload(c);
  const pending=c.remote.transfers.filter(t=>t.owner===c.a.sol&&t.moneroAddress===c.a.xmr&&t.launchId===row.id&&t.direction===direction&&bridgeOpen(t));
  if(pending.length){if(pending.length>1){menu(c);return;}status(c,await saved(c,pending[0],row));return;}
  if(local(c).some(r=>r.row.id===row.id&&r.direction===direction&&!r.transfer)){menu(c);return;}
  if(mainnet&&direction==='sol-to-xmr')throw Error('New legacy deposits are closed. Recover a saved transfer instead.');
  if(c.remote.pair&&c.remote.pair.address!==c.a.xmr)throw Error('This Solana account is linked to a different Monero address on the service. Select the matching account; the existing link will not be replaced.');
  if(!c.remote.pair){show(c,'Link bridge accounts',`<p class="subtle">Register these public addresses for bridging. This does not move tokens. This service link cannot be replaced.</p><label>Solana</label><div class="address">${d.esc(c.a.sol)}</div><label>Monero</label><div class="address">${d.esc(c.a.xmr)}</div><button class="primary wide" id="bridge-link">Link these accounts</button>`);bind(c,'bridge-link',async()=>{const result=await request(c,'pair',{address:c.a.xmr});if(result.pair?.address!==c.a.xmr||result.pair?.owner!==c.a.sol)throw Error('Bridge account link mismatch.');await form(c,row,direction);});return;}
  show(c,'Bridge '+row.ticker,`<p class="subtle">${direction==='sol-to-xmr'?'Solana → Monero':'Monero → Solana'} · ${d.esc(c.a.name)}</p>${maxControl('bridge-amount','Amount ('+d.esc(row.ticker)+')')}<input id="bridge-amount" inputmode="decimal" placeholder="0.00" autocomplete="off"><p class="subtle">Indexed: ${d.esc(fmt(row.amountRaw||'0',row.ticker))}. Available balance will be checked.</p><p id="progress" class="busy"></p><button class="primary wide" id="bridge-review">Review bridge</button><button class="text-btn wide" id="bridge-back">Back</button>`);
  bind(c,'bridge-amount-max',async()=>{
   const input=document.getElementById('bridge-amount');progress('Checking maximum available amount…');
   await fillMaximum(input,async()=>{
    const q=validateBridgeQuote(await request(c,'bridgeQuote',{launchId:row.id,direction,amountRaw:'2'}),c.a,row,direction,'2');
    await reload(c);
    const reserved=direction==='xmr-to-sol'?pendingDebits(c.remote,c.a,row).reduce((n,t)=>n+BigInt(t.amountRaw),0n):c.remote.transfers.filter(t=>t.owner===c.a.sol&&t.launchId===row.id&&t.direction===direction&&bridgeOpen(t)).reduce((n,t)=>n+BigInt(t.amountRaw),0n);
    const raw=maximumRaw(q.balanceRaw,{reserved,limit:TOKEN_TRANSFER_LIMIT});
    if(raw!=='0')validateBridgeQuote(await request(c,'bridgeQuote',{launchId:row.id,direction,amountRaw:raw}),c.a,row,direction,raw);
    return raw;
   },{isCurrent:()=>live(c)&&input.isConnected});progress('');
  });
  bind(c,'bridge-back',()=>menu(c));bind(c,'bridge-review',async()=>{const raw=units(document.getElementById('bridge-amount').value,6).toString();progress('Checking your bridge balance and SOL for fees…');const fee=await bridgeSolReserve(c.a,row);assert(c);const quote=validateBridgeQuote(await request(c,'bridgeQuote',{launchId:row.id,direction,amountRaw:raw}),c.a,row,direction,raw);review(c,row,quote,fee);});
 }
 function review(c,row,q,fee){
  const expires=Date.now()+60000;
  show(c,'Review bridge',`<p class="subtle">${q.direction==='sol-to-xmr'?'Solana → Monero':'Monero → Solana'}</p><div class="review-line"><span>You send</span><strong>${d.esc(fmt(q.amountRaw,row.ticker))}</strong></div><div class="review-line"><span>Token fee</span><strong>${d.esc(fmt(q.transferTaxRaw,row.ticker))}</strong></div><div class="review-line"><span>You receive</span><strong>${d.esc(fmt(q.netReceivedRaw,row.ticker))}</strong></div><p class="subtle">Allow about ${amount(String(fee),9)} SOL for network/account costs. Exact Solana approval is checked before signing.</p><label>From</label><div class="address">${d.esc(q.from)}</div><label>To</label><div class="address">${d.esc(q.to)}</div><p class="notice">${q.direction==='xmr-to-sol'?'Approve Monero, wait for 10 confirmations, then approve the Solana unlock.':'Approve the Solana lock, then wait for the Monero inscription and 10 confirmations.'}</p><p id="progress" class="busy"></p><button class="primary wide" id="bridge-confirm">Confirm bridge details</button><button class="text-btn wide" id="bridge-back">Back</button>`);
  bind(c,'bridge-back',()=>form(c,row,q.direction));bind(c,'bridge-confirm',async()=>{
   if(Date.now()>expires)throw Error('Review expired. Review the amount again.');
   const id=crypto.randomUUID(),r=await d.record({kind:'bridge',chain:'bridge',intent:id,row,direction:q.direction,amount:amount(q.amountRaw),amountRaw:q.amountRaw,symbol:row.ticker,to:q.to,status:'Checking saved bridge'});assert(c);await recoverDraft(c,r);
  });
 }
 async function recoverDraft(c,r){
  progress('Saving bridge details…');
  const t=await request(c,'bridgeIntent',{id:r.intent,launchId:r.row.id,direction:r.direction,amountRaw:r.amountRaw});
  validateBridgeReceipt(t,c.a,r.row,{id:r.intent,direction:r.direction,raw:r.amountRaw});status(c,await saved(c,t,r.row));
 }
 function status(c,r){
  const t=r.transfer,[title,detail]=bridgeStatus(t),row=r.row;
  const solReady=t.direction==='sol-to-xmr'&&t.state==='reserved'||t.direction==='xmr-to-sol'&&t.state==='source_finalized'&&!t.destinationSignature;
  const burnReady=t.direction==='xmr-to-sol'&&t.state==='reserved';
  const links=[['Monero',t.sourceTxid||t.destinationTxid,'https://xmrchain.net/tx/'],['Solana',t.destinationSignature||t.sourceSignature,'https://solscan.io/tx/']].filter(([,hash])=>typeof hash==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,90}$|^[a-f0-9]{64}$/.test(hash));
  show(c,title,`<h3>${d.esc(fmt(t.amountRaw,row.ticker))}</h3><p class="subtle">${t.direction==='sol-to-xmr'?'Solana → Monero':'Monero → Solana'}</p><p>${d.esc(detail)}</p><div class="review-line"><span>You receive</span><strong>${d.esc(fmt(t.netReceivedRaw,row.ticker))}</strong></div><p id="progress" class="busy" role="status"></p><p id="bridge-error" class="notice" role="alert" hidden></p>${r.signed?'<p class="notice">Your previous signed approval is saved. Check and resume it before requesting another approval.</p><button class="primary wide" id="bridge-retry">Check saved approval</button>':solReady?'<button class="primary wide" id="bridge-prepare">Prepare Solana approval</button>':burnReady?'<button class="primary wide" id="bridge-burn">Approve Monero step</button>':''}${links.map(([chain,hash,url])=>`<p><a target="_blank" rel="noopener noreferrer" href="${url+d.esc(hash)}">${chain} transaction ↗</a></p>`).join('')}<button class="secondary wide" id="bridge-check">Refresh status</button><button class="text-btn wide" id="bridge-home">All bridges</button>`);
  bind(c,'bridge-check',()=>check(c,r,true));bind(c,'bridge-home',async()=>{await reload(c);menu(c);});
  bind(c,'bridge-retry',()=>retry(c,r));bind(c,'bridge-prepare',()=>prepare(c,r));
  bind(c,'bridge-burn',async()=>{
   if(!c.a.xmrSeed)throw Error('This account needs its Monero recovery phrase to approve.');
   await bridgeSolReserve(c.a,row);assert(c);const review=bridgeBurnReview(t,c.a,row);progress('Signing the Monero instruction locally…');
   const result=r.burnSignature?{signature:r.burnSignature}:await d.oneShot('burn.worker.js','signBurn',{seed:c.a.xmrSeed,review});assert(c);
   // Preserve the exact instruction/signature before a request can time out.
   r.burnSignature=result.signature;await d.persist();assert(c);progress('Submitting Monero approval. Keep this window open…');
   const next=await request(c,'authorizeBurn',{id:t.id,signature:r.burnSignature});status(c,await saved(c,next,row));
  });
  if(bridgeOpen(t)&&!solReady&&!burnReady&&!r.signed)schedule(c,r);
 }
 function schedule(c,r){clear();timer=setTimeout(async()=>{if(!live(c))return;if(d.isBusy()){schedule(c,r);return;}try{await check(c,r,false);}catch{if(live(c)){progress('Status delayed. Your bridge is saved; refresh to retry.');schedule(c,r);}}},15000);}
 async function check(c,r,advance){
  clear();let t;
  if(advance)t=await request(c,'advanceBridge',{id:r.intent});else{await reload(c);t=c.remote.transfers.find(t=>t.id===r.intent);if(!t)throw Error('Saved bridge unavailable. Keep its receipt.');}
  const updated=await saved(c,t,r.row);if(live(c))status(c,updated);
 }
 async function prepare(c,r){
  if(r.signed||r.transfer.destinationSignature||r.transfer.state==='complete'){status(c,r);return;}
  const errorView=d.modal.querySelector('#bridge-error');if(errorView){errorView.textContent='';errorView.hidden=true;}
  progress('Checking your saved bridge and preparing the Solana transaction…');const t=r.transfer,op=t.direction==='sol-to-xmr'?'Deposit':'Withdrawal';
  let p;c.verification=new AbortController();
  try{
   const response=await request(c,'prepare'+op,{id:t.id});assert(c);if(!live(c))throw Error('Bridge panel closed. Resume your saved bridge.');
   if(r.signed||r.transfer.destinationSignature||r.transfer.state!==t.state){status(c,r);return;}
   p=await prepareBridgeSolana(response,t,c.a,r.row,{signal:c.verification.signal,onStage:text=>{assert(c);if(live(c))progress(text);}});assert(c);if(!live(c))throw Error('Bridge panel closed. Resume your saved bridge.');
   if(r.signed||r.transfer.destinationSignature||r.transfer.state!==t.state){status(c,r);return;}
  }catch(error){
   if(live(c)){const view=d.modal.querySelector('#bridge-error');if(view){view.textContent=(error.message||'Preparation could not finish.')+' Your saved bridge is kept. Retry this preparation; '+(op==='Withdrawal'?'no second Monero burn is needed.':'do not start another bridge.');view.hidden=false;}}
   throw error;
  }
  show(c,'Approve Solana '+(op==='Deposit'?'lock':'unlock'),`<p>${d.esc(fmt(t.amountRaw,r.symbol))}</p><p class="subtle">${op==='Deposit'?'Locks your tokens for the Monero credit.':'Unlocks tokens after the confirmed Monero burn.'}</p><label>Solana account</label><div class="address">${d.esc(c.a.sol)}</div><div class="review-line"><span>Estimated SOL cost</span><strong>${amount(p.feeRaw,9)} SOL</strong></div><p id="progress" class="busy"></p><button class="primary wide" id="bridge-sign">Approve & ${op==='Deposit'?'lock':'unlock'}</button><button class="text-btn wide" id="bridge-back">Back</button>`);
  bind(c,'bridge-back',()=>status(c,r));bind(c,'bridge-sign',async()=>{
   if(r.signed||r.transfer.destinationSignature||r.transfer.state!==t.state){status(c,r);return;}
   try{
    const signed=signBridgeSolana(p,t,c.a,r.row);r.signed=signed;await d.persist();assert(c);progress('Submitting saved approval…');
    const next=await request(c,'submit'+signed.operation,{id:t.id,transaction:signed.transaction,ticket:signed.ticket});status(c,await saved(c,next,r.row));
   }catch(error){
    if(live(c)){
     status(c,r);
     const recorded=op==='Deposit'?r.transfer.sourceSignature:r.transfer.destinationSignature;
     if(r.signed||recorded){
      inlineError(c,'Your exact signed approval is kept. Its submission could not be confirmed here. Check its saved status; do not approve a new transaction.');
      // Reconcile only with a public account receipt. Never submit or retry a
      // payment automatically after a lost response.
      const attempt=r.signed;
      if(attempt)void request(c,'account').then(async remote=>{
       if(!live(c)||r.signed!==attempt)return;
       const next=remote.transfers?.find(value=>value.id===r.intent);
       const signature=attempt.operation==='Deposit'?next?.sourceSignature:next?.destinationSignature;
       if(!next||signature!==attempt.signature)return;
       const updated=await saved(c,next,r.row);if(live(c))status(c,updated);
      }).catch(()=>{});
     }else inlineError(c,(error.message||'This unsigned approval could not be signed.')+' Prepare a fresh approval for this same saved bridge.');
    }
    throw error;
   }
  });
 }
 async function retry(c,r){
  const s=r.signed;if(!s)throw Error('No saved approval. Refresh status.');
  const t=await request(c,'advanceBridge',{id:r.intent});await saved(c,t,r.row);
  if(!r.signed){status(c,r);return;}
  if(t.state==='complete'||t.sourceSignature&&s.operation==='Deposit'||t.destinationSignature&&s.operation==='Withdrawal')throw Error('A different submission is recorded. Keep the saved receipt for review.');
  progress('Resubmitting the same saved approval…');const next=await request(c,'submit'+s.operation,{id:r.intent,transaction:s.transaction,ticket:s.ticket});status(c,await saved(c,next,r.row));
 }
 return {open,refreshAssets:()=>mainnet?.refreshAssets?.(),clear(){clear();joint?.clear();if(ctx){ctx.a.solSecret='';ctx.a.xmrSeed='';ctx.token=null;}ctx=null;}};
}
