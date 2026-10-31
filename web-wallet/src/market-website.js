// MONERO MARKET candidate (30 Oct 2026): the market inside the xmr20.org WEBSITE wallet. The same market host the extension
// runs (extension/src/market-host.js), on the same token worker with the market ops, opened with the website wallet's own
// Monero phrase (unlocked by its Solana wallet approval, see market-website-bridge.js). Differences from the extension:
//   - it runs in the page: sales are approved automatically only while a page with the unlocked wallet is open (no background);
//   - one market host per Monero account per browser (a Web Lock): a second tab is refused with a plain message;
//   - its encrypted journal lives in this site's localStorage under a per-account prefix (sealed with the engine's market key).
// Networks: the offline fakechain, stagenet, and mainnet only with an engine built with the market start block (31 Oct 2026: the
// market is live on mainnet, experimental); the engine itself refuses market signatures on mainnet without that start block.
import {createWorkerClient} from '../../engine/token/worker-client.js';import {openTokenWorker} from '../../engine/shared/market-open.js';
import {createPrivateJournal} from '../../engine/token/private-journal.js';
import {createMarketHost} from '../../engine/shared/market-host.js';

const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const tagOf=async address=>hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('XMR20-website-market|'+address))).slice(0,24);
const fail=(msg,status)=>Object.assign(Error(msg),{status});

/**
 * config: {base, node, params, api, asset} — base = URL of the folder with the market token worker, its engine and manifest;
 * node / params / api = the Monero node, the parameter server and the order book. address: the website wallet's Monero
 * address; getSeed(): its phrase (asked for once, when the market opens; never kept here). label: a public account label.
 */
export function createWebsiteMarket({config,address,label='Website wallet',getSeed,startHeight=0,onChange=()=>{},storage=globalThis.localStorage,locks=globalThis.navigator?.locks,log=(...a)=>console.warn('[market]',...a)}){
 let phase='idle',error=null,progress=null,client=null,host=null,closed=false,started=null,tag=null,network=null;
 const set=(p,e=null)=>{phase=p;error=e;onChange();};
 async function open(){
  if(!locks)throw Error('This browser cannot run the market wallet (no Web Locks).');
  tag=await tagOf(address);
  set('opening');
  return new Promise((resolve,reject)=>{
   // One market host per account per browser: a second tab is told so at once (before any unlock is asked for).
   locks.request('xmr20-market-host:'+tag,{ifAvailable:true},async lock=>{
    if(closed)return;
    if(!lock){const e=Error('Your market wallet is already open in another tab of this browser. Use that tab, or close it and connect again.');stop(e.message);reject(e);return;}
    try{
     let seed=await getSeed(),opened;
     try{({opened}=await openTokenWorker({
      spawn:()=>{let retired=false;const c=createWorkerClient('private-holder.worker.js',{spawn:name=>new Worker(config.base+name),onProgress:p=>{progress=p?.text||null;onChange();},onDead:()=>{if(!closed&&!retired)stop('The token wallet worker stopped. Reload the page to open the market again.');}});client=c;return {client:c,retire:()=>{retired=true;c.close();}};},
      open:c=>c.call('open',{seed,owner:address,backend:config.params,rpc:config.node,nativeStartHeight:Number(startHeight)||0},240000,{idle:true})}));}
     finally{seed='';}
     if(closed)return;
     if(!opened.marketJournalKey||!opened.market)throw Error('This token worker has no market support.');
     if(!['offline-fakechain','stagenet'].includes(opened.network?.kind)&&!(opened.network?.kind==='mainnet'&&opened.market?.activationHeight!=null))throw Error('Monero Market runs on mainnet only with the market engine that has the start block ('+opened.network?.kind+').');
     if(opened.nativeAddress!==address)throw Error('The unlocked phrase is not this wallet’s Monero account. Nothing was opened.');
     const ns='xmr20-market:'+tag+':';
     const store={async get(k){try{return JSON.parse(storage.getItem(ns+k)||'null');}catch{return null;}},async set(k,v){storage.setItem(ns+k,JSON.stringify(v));}};
     const journal=createPrivateJournal({store,journalKey:'xmr20-market-journal',saltKey:'xmr20-market-journal-salt',aad:'XMR20-market-journal-v1',lockName:'xmr20-market-journal-lock:'+tag});
     journal.unlockWithKey(opened.marketJournalKey);
     const r=await fetch(config.base+'parameters-manifest.json');if(!r.ok)throw Error('The market parameter manifest is missing.');const manifest=await r.json();
     const h=createMarketHost({client,journal,ids:{ownerKey:opened.ownerKey,nativeAddress:opened.nativeAddress,tokenAddress:opened.tokenAddress},manifest,marketUrl:config.api,finality:opened.market.finalityDepth,asset:config.asset,accountId:label,log,onChange});
     await h.start();if(closed)return;
     host=h;network=opened.network.kind;set('running');resolve();
     while(!closed){try{await host.tick();}catch(e){log('tick',e?.message||e);}await new Promise(r=>setTimeout(r,1000));}
    }catch(e){stop(e?.message||String(e));reject(e);}
   }).catch(e=>{stop(e?.message||String(e));reject(e);});
  });
 }
 function stop(reason=null){if(closed)return;closed=true;host?.close();client?.close();host=null;set(reason?'failed':'closed',reason);}
 const ready=()=>{if(!host||phase!=='running')throw fail('The market wallet is not open. Connect it again.',409);return host;};
 return {
  // Resolves once this tab runs the market; rejects when another tab already runs it, or opening fails.
  start(){started??=open();return started;},
  status:()=>({phase,error,progress,network}),
  handle:m=>ready().handle(m),
  approvals:()=>host?host.approvals():[],
  decide:(id,nonce,decision)=>ready().decide(id,nonce,decision),
  state:()=>ready().state(),
  activity:()=>host?host.activity():0,
  close:()=>stop(null),
  get address(){return address;},
 };
}
