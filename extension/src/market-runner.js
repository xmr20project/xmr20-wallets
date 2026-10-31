// MONERO MARKET candidate (30 Oct 2026): the offscreen market runner ("My wallet approves (while open)"). The background
// (market-runner-control.js) creates it while the wallet is unlocked and the active account has open market work. It runs the
// same market host as the market window, without any approval screen: buyers are answered and sales of listings made with
// sellerApproval 'auto' are approved by the wallet itself; anything that needs the user waits for the market window.
// One Web Lock decides which of the two runs the host: the market window takes it while open, the runner hands it over at its
// next step and takes it back when the window closes. Offscreen documents only have chrome.runtime, so keys, journal storage
// and the activity count go through the background. OFFLINE FAKECHAIN / STAGENET builds only (the engine refuses mainnet).
import {createWorkerClient} from '../../engine/token/worker-client.js';import {openTokenWorker} from '../../engine/shared/market-open.js';
import {createPrivateJournal} from '../../engine/token/private-journal.js';
import {createMarketHost} from '../../engine/shared/market-host.js';
import {MONERO_MARKET_ORIGIN} from './site-policy.js';
import {MARKET_HOST_LOCK} from './market-runner-control.js';
const API=typeof __XMR20_MONERO_MARKET_API__==='string'?__XMR20_MONERO_MARKET_API__:null;
const NODE=typeof __XMR20_MONERO_MARKET_NODE__==='string'?__XMR20_MONERO_MARKET_NODE__:null,PARAMS=typeof __XMR20_MONERO_MARKET_PARAMS__==='string'?__XMR20_MONERO_MARKET_PARAMS__:null,ASSET=typeof __XMR20_MONERO_MARKET_ASSET__==='string'?__XMR20_MONERO_MARKET_ASSET__:null;
const STEP_MS=3000;
async function call(action,args={}){const r=await chrome.runtime.sendMessage({channel:'xmr20-market-runner',action,...args});if(!r||r.error||!Object.hasOwn(r,'value'))throw Error(r?.error||'Market runner stopped.');return r.value;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let stopped=false,client=null,host=null;
const status=(state,detail='',ticks=0)=>call('status',{state,detail,ticks}).catch(()=>{});
function stop(reason){if(stopped)return;stopped=true;host?.close();client?.close();console.warn('[market runner] stopped:',reason);void status('stopped',reason);}
const windowWaiting=async()=>(await navigator.locks.query()).pending?.some(l=>l.name===MARKET_HOST_LOCK)===true;
(async()=>{
 try{
  if(!MONERO_MARKET_ORIGIN||!NODE||!PARAMS||!ASSET)throw Error('This build has no Monero Market configuration.');
  void status('opening');
  const keys=await call('open'),bind={sessionId:keys.sessionId,accountId:keys.accountId};
  let opened;
  try{({opened}=await openTokenWorker({
   spawn:()=>{let retired=false;const c=createWorkerClient('private-holder.worker.js',{onDead:()=>{if(!retired)stop('the token worker stopped');}});client=c;return {client:c,retire:()=>{retired=true;c.close();}};},
   open:c=>c.call('open',{seed:keys.seed,owner:keys.address,backend:PARAMS,rpc:NODE,nativeStartHeight:0},240000,{idle:true})}));}
  finally{keys.seed='';}
  await call('check',bind);
  if(!opened.marketJournalKey||!opened.market)throw Error('This token worker has no market support.');
  // Mainnet (owner, 31 Oct 2026): only with an engine built with the market start block (lots count from it for every reader built alike).
  if(!['offline-fakechain','stagenet'].includes(opened.network?.kind)&&!(opened.network?.kind==='mainnet'&&opened.market?.activationHeight!=null))throw Error('Monero Market runs on mainnet only in a build with the market start block.');
  const store={get:key=>call('store',{...bind,op:'get',key}),set:(key,value)=>call('store',{...bind,op:'set',key,value})};
  const journal=createPrivateJournal({store,journalKey:'xmr20-market-journal',saltKey:'xmr20-market-journal-salt',aad:'XMR20-market-journal-v1'});
  journal.unlockWithKey(opened.marketJournalKey);
  const manifest=await (await fetch(chrome.runtime.getURL('vendor/parameters-manifest.json'))).json();
  host=createMarketHost({client,journal,ids:{ownerKey:opened.ownerKey,nativeAddress:opened.nativeAddress,tokenAddress:opened.tokenAddress},manifest,marketUrl:API||MONERO_MARKET_ORIGIN,finality:opened.market.finalityDepth,asset:ASSET,accountId:keys.accountName,log:(...a)=>console.warn('[market runner]',...a)});
  const watch=setInterval(()=>{call('check',bind).catch(e=>{clearInterval(watch);stop(e.message);});},5000);
  let reported=-1,reportedAt=0,ticks=0,lastError='';
  void status('waiting','the market window is open');
  const report=async()=>{const n=host.activity();if(n===reported&&Date.now()-reportedAt<60000)return;await call('activity',{...bind,count:n});reported=n;reportedAt=Date.now();};
  while(!stopped){
   await navigator.locks.request(MARKET_HOST_LOCK,async()=>{
    await host.start();void status('running');
    while(!stopped&&!await windowWaiting()){
     try{await host.tick();ticks++;const e=host.syncError||'';if(e!==lastError||ticks%20===1){lastError=e;void status('running',e,ticks);}}catch(e){console.warn('[market runner] tick',e);void status('running','tick: '+(e?.message||e),ticks);}
     await report().catch(e=>console.warn('[market runner] report',e?.message||e));
     await sleep(STEP_MS);
    }
   });
   if(!stopped)void status('waiting','the market window is open');
  }
 }catch(e){stop(e?.message||String(e));}
})();
