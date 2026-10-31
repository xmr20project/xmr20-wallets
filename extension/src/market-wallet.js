// MONERO MARKET candidate (29 Oct 2026): the extension's own market window. Opened by the site broker for one connected
// website document (market-wallet.html?request=<id>); bound to that request, this account and this unlock session exactly
// like the earlier packaged market host (marketView / marketKeys / marketCheck / marketClose). It runs the token worker
// with the market ops, keeps the encrypted market journal and shows every approval here. Nothing in this window is
// reachable from the website: the background forwards only the bounded market.* methods over a runtime port.
// OFFLINE FAKECHAIN ONLY (the engine refuses other networks); the node, parameter server and order-book origins are
// compiled in at build time and are loopback addresses. Real trading disabled.
import {createWorkerClient} from '../../engine/token/worker-client.js';import {openTokenWorker} from '../../engine/shared/market-open.js';
import {createPrivateJournal} from '../../engine/token/private-journal.js';
import {createMarketHost} from '../../engine/shared/market-host.js';
import {serveMarketHost} from './market-host-channel.js';
import {MONERO_MARKET_ORIGIN} from './site-policy.js';
import {MARKET_HOST_LOCK,MARKET_ACTIVE_KEY} from './market-runner-control.js';
import {esc,exact,compact,T,X,short,lines,review,KIND_TITLE,PHASE_WORD,approveLabel,doneText} from '../../engine/shared/market-reviews.js';
// The order book may live on another origin than the page (stagenet test: api.xmr20.org); it defaults to the page origin (lab).
const API=typeof __XMR20_MONERO_MARKET_API__==='string'?__XMR20_MONERO_MARKET_API__:null;
const NODE=typeof __XMR20_MONERO_MARKET_NODE__==='string'?__XMR20_MONERO_MARKET_NODE__:null,PARAMS=typeof __XMR20_MONERO_MARKET_PARAMS__==='string'?__XMR20_MONERO_MARKET_PARAMS__:null,ASSET=typeof __XMR20_MONERO_MARKET_ASSET__==='string'?__XMR20_MONERO_MARKET_ASSET__:null;
const $=s=>document.querySelector(s);
const setHTML=(sel,html)=>{const el=$(sel);if(el.__html!==html){el.innerHTML=html;el.__html=html;return true;}return false;};
const live=t=>{const el=$('#wl-live');if(el.textContent!==t)el.textContent=t;};
const requestId=new URLSearchParams(location.search).get('request');
const store={async get(k){return (await chrome.storage.local.get(k))[k];},async set(k,v){await chrome.storage.local.set({[k]:v});}};
let host=null,client=null,current=null,done=null,busy=false,error=null,fatal=null,account=null,sessionId=null,closed=false,service=null;
async function call(action,args={}){const r=await chrome.runtime.sendMessage({channel:'xmr20-site-approval',requestId,action,...args});if(!r||r.error||!Object.hasOwn(r,'value'))throw Error(r?.error||'Market wallet changed or locked. Reopen from the website.');return r.value;}
function shutdown(reason){if(closed)return;closed=true;fatal=reason;host?.close();service?.close();client?.close();chrome.storage.onChanged.removeListener(changed);render();}
function changed(changes,area){
 if(area==='local'&&(changes['xmr20-lock-signal']||changes['xmr20-vault']))shutdown('Your wallet was locked or changed. Close this window and reopen the market from the website.');
 if(area==='session'&&changes['xmr20-unlocked-session']){const s=changes['xmr20-unlocked-session'].newValue;if(!s||s.id!==sessionId||s.activeId!==account?.id)shutdown('Your wallet was locked or the account changed. Close this window and reconnect.');}
 if(area==='session'&&changes['xmr20-site-connection']&&!changes['xmr20-site-connection'].newValue?.markets?.[requestId])shutdown('The website disconnected. Close this window.');
}
// Spare anchors (31 Oct 2026): what the wallet is doing about the anchor of the next lot or purchase.
function anchorLine(s){
 if(s.anchors?.mode!=='spare')return '';
 const waits=s.waiting.length||s.trades.some(t=>t.phase==='waiting-anchor');
 const text=s.anchors.error?`Anchor not made: ${s.anchors.error}`:waits?'Setting aside an anchor for your lot or purchase (about 20 minutes); it continues by itself.':s.anchors.ready?'An anchor is ready for your next lot or purchase.':s.anchors.coming?'An anchor for your next trade is on its way.':'';
 return text?`<p class="wl-note${s.anchors.error?' warn':''}">${esc(text)}</p>`:'';
}
function overview(){
 const s=host.state();
 const lots=s.lots.map(l=>`<div class="wl-row"><span>${esc(T(l.quantityAtoms))} XMR20 <small>${l.listed?'listed':l.tradable?'ready':`${l.confirmations}/${s.binding?host.state().trades[0]?.finalityDepth||'':''} confirmations`}</small></span><span class="mono">${esc(short(l.id))}</span></div>`).join('');
 const trades=s.trades.slice(0,6).map(t=>`<div class="wl-row"><span>${t.role==='buyer'?'Buy':'Sell'} ${esc(T(t.quantityAtoms))} XMR20 <small>${esc(PHASE_WORD(t.phase))}</small></span><span>${esc(X(t.totalPiconero))} XMR</span></div>`).join('');
 return `<h1 class="wl-title">Monero Market</h1><p class="wl-lead">${s.sync.state==='ready'?`Synced to block ${esc(String(s.sync.tipHeight))}. Approvals appear here.`:s.sync.state==='unavailable'?`Node unavailable: ${esc(s.sync.error)}`:({mainnet:'Syncing Monero (mainnet)…',stagenet:'Syncing the stagenet test chain…'}[s.binding.network]||'Syncing the offline test chain…')}</p>
  <div class="wl-rows"><h2>Your lots</h2>${lots||'<div class="wl-row"><small>No lots yet.</small></div>'}</div>
  <div class="wl-rows"><h2>Trades</h2>${trades||'<div class="wl-row"><small>No trades yet.</small></div>'}</div>
  ${anchorLine(s)}
  <p class="wl-note">${s.binding.network==='mainnet'?'Mainnet · real XMR and XMR20 · experimental':s.binding.network==='stagenet'?'Stagenet test · worthless test coins · mainnet market refused by the engine':'Offline fakechain only · synthetic test funds · real trading disabled'}. Experimental settlement, not independently reviewed.</p>`;
}
function render(){
 if(fatal){setHTML('#wl-body',`<p class="wl-empty">${esc(fatal)}</p>`);$('#wl-foot').hidden=true;live(fatal);return;}
 if(!host){setHTML('#wl-body',`<p class="wl-empty">${esc(error||'Opening the token wallet…')}</p>`);return;}
 const s=host.state(),b=s.balances,d=(v,f)=>v===null?'—':f(v);
 $('#wl-label').textContent=`${account?.name||'Account'} · ${short(s.binding.payoutAddress)}`;
 $('#b-open').textContent=d(b.openAtoms,a=>compact(a,6));$('#b-lots').textContent=d(b.lotAtoms,a=>compact(a,6));$('#b-private').textContent=d(b.privateAtoms,a=>compact(a,6));$('#b-xmr').textContent=d(b.nativeAvailablePiconero,a=>compact(a,12));
 const foot=$('#wl-foot');
 if(done){setHTML('#wl-body',`<div class="wl-done ${done.ok?'':'no'}">${esc(done.text)}</div><p class="wl-lead">You can close this window. While the wallet is unlocked, it keeps answering buyers in the background.</p><div class="wl-list"><button type="button" id="wl-back"><span>Back to overview</span><span>›</span></button></div>`);live(done.text);foot.hidden=true;$('#wl-back')?.addEventListener('click',()=>{done=null;current=null;render();});return;}
 const list=host.approvals();const a=list.find(x=>x.id===current)||(list.length===1?list[0]:null);
 if(!a){foot.hidden=true;const html=list.length?`<h1 class="wl-title">Waiting for you</h1><div class="wl-list">${list.map(x=>`<button type="button" data-id="${esc(x.id)}"><span>${esc(KIND_TITLE[x.kind]||x.kind)}</span><span>›</span></button>`).join('')}</div>`:overview();
  if(setHTML('#wl-body',html))live(list.length?`${list.length} request${list.length>1?'s':''} waiting for your approval`:'Monero Market wallet');return;}
 current=a.id;
 const fresh=setHTML('#wl-body',review(a));foot.hidden=false;
 if(fresh){live($('.wl-title')?.textContent||'Review');if(!busy)$('#wl-approve').focus();try{chrome.windows.getCurrent(w=>{if(w?.id!==undefined)chrome.windows.update(w.id,{focused:true,drawAttention:true});});}catch{}}
 $('#wl-error').hidden=!error;$('#wl-error').textContent=error||'';
 $('#wl-approve').disabled=busy;$('#wl-decline').disabled=busy;$('#wl-approve').textContent=busy?'Working…':approveLabel(a);
}
async function decide(decision){
 const a=host?.approvals().find(x=>x.id===current);if(!a||busy)return;busy=true;error=null;render();
 try{const res=await host.decide(a.id,a.nonce,decision);
  done={ok:decision==='approve',text:doneText(a,decision,res?.result)};}
 catch(e){error=e.message;}
 finally{busy=false;render();}
}
$('#wl-approve').addEventListener('click',()=>decide('approve'));
$('#wl-decline').addEventListener('click',()=>decide('decline'));
$('#wl-body').addEventListener('click',e=>{const b=e.target.closest('[data-id]');if(b){current=b.dataset.id;render();}});
window.addEventListener('pagehide',()=>{if(!closed){closed=true;host?.close();service?.close();client?.close();}chrome.runtime.sendMessage({channel:'xmr20-site-approval',requestId,action:'marketClose'}).catch(()=>{});},{once:true});
(async()=>{
 try{
  if(!/^[a-f0-9-]{36}$/.test(requestId||''))throw Error('Open the market from the connected website.');
  if(!MONERO_MARKET_ORIGIN||!NODE||!PARAMS||!ASSET)throw Error('This build has no Monero Market lab configuration.');
  const v=await call('marketView');account=v.account;sessionId=v.sessionId;chrome.storage.onChanged.addListener(changed);await call('marketCheck');
  const {opened}=await openTokenWorker({
   spawn:()=>{let retired=false;const c=createWorkerClient('private-holder.worker.js',{onProgress:p=>{if(!host&&p?.text){error=p.text;render();}},onDead:()=>{if(!retired)shutdown('The token wallet worker stopped. Close this window and reopen the market.');}});client=c;return {client:c,retire:()=>{retired=true;c.close();}};},
   open:async c=>{const keys=await call('marketKeys');try{if(keys.address!==account.monero)throw Error('Monero account changed.');return await c.call('open',{seed:keys.seed,owner:keys.address,backend:PARAMS,rpc:NODE,nativeStartHeight:0},240000,{idle:true});}finally{keys.seed='';}}});
  await call('marketCheck');
  if(!opened.marketJournalKey||!opened.market)throw Error('This token worker has no market support.');
  // Mainnet (owner, 31 Oct 2026): only with an engine built with the market start block (lots count from it for every reader built alike).
  if(!['offline-fakechain','stagenet'].includes(opened.network?.kind)&&!(opened.network?.kind==='mainnet'&&opened.market?.activationHeight!=null))throw Error('Monero Market runs on mainnet only in a build with the market start block ('+opened.network?.kind+').');
  $('#wl-chip').textContent={stagenet:'STAGENET TEST',mainnet:'MAINNET · EXPERIMENTAL'}[opened.network.kind]||'OFFLINE LAB';
  const journal=createPrivateJournal({store,journalKey:'xmr20-market-journal',saltKey:'xmr20-market-journal-salt',aad:'XMR20-market-journal-v1'});
  journal.unlockWithKey(opened.marketJournalKey);
  const params=await client.call('parameters',{},30000);
  const manifestR=await fetch(chrome.runtime.getURL('vendor/parameters-manifest.json'));const manifest=await manifestR.json();
  const asset=ASSET;
  const h=createMarketHost({client,journal,ids:{ownerKey:opened.ownerKey,nativeAddress:opened.nativeAddress,tokenAddress:opened.tokenAddress},manifest,marketUrl:API||MONERO_MARKET_ORIGIN,finality:opened.market.finalityDepth,asset,accountId:account.name,log:(...a)=>console.warn('[market]',...a),onChange:()=>{if(!busy)render();}});
  const check=setInterval(()=>{call('marketCheck').catch(e=>{clearInterval(check);shutdown(e.message);});},2000);
  // One Web Lock decides who runs the market host: this window while it is open, the background runner otherwise (it hands
  // over at its next step). The count published here tells the background to keep a runner going after this window closes.
  let reported=-1,reportedAt=0;
  const report=async()=>{const n=host.activity();if(n===reported&&Date.now()-reportedAt<60000)return;
   const all=(await chrome.storage.local.get(MARKET_ACTIVE_KEY))[MARKET_ACTIVE_KEY]||{};all[account.id]={count:n,at:Date.now()};
   await chrome.storage.local.set({[MARKET_ACTIVE_KEY]:all});reported=n;reportedAt=Date.now();};
  error='Taking over from the background market runner…';render();
  void navigator.locks.request(MARKET_HOST_LOCK,async()=>{
   if(closed)return;
   await h.start();host=h;
   service=serveMarketHost({handle:m=>host.handle(m)});
   error=null;render();
   while(!closed){try{await host.tick();}catch(e){console.warn('tick',e);}await report().catch(e=>console.warn('report',e));await new Promise(r=>setTimeout(r,1000));}
  }).catch(e=>shutdown(e?.message||String(e)));
  console.info('[market] parameters',params?.label);
 }catch(e){shutdown(e.message||String(e));}
})();
