// The CLI's page inside its own headless Chromium (no window, no extension, no website). It hosts the same engine the
// extension and xmr20.org run: the Monero worker (engine/monero) for XMR, and the token module (engine/token) through the
// headless layer (engine/headless) for XMR20. The terminal side (src/engine.mjs) calls window.cli.* and answers reviews.
// Keys stay in this page and its workers; nothing here relays without an approved review.
import {createHeadlessTokens} from '../../engine/headless/token-ops.js';
import {createWorkerClient} from '../../engine/token/worker-client.js';
import {createNativeBalanceClient,MONERO_NODES} from '../../engine/monero/native-wallet-client.js';
import {amount,units,importSol} from '../../engine/shared/core.js';
import {compactTokenBalance} from '../../engine/shared/token-display.js';

const ENGINE='/engine/';
const spawn=name=>new Worker(ENGINE+name);
const workerClient=(file,hooks={})=>createWorkerClient(file,{...hooks,spawn});
const oneShot=(file,action,args)=>{const c=workerClient(file);return c.call(action,args,120000).finally(()=>c.close());};
const progress=text=>{void window.cliProgress?.(String(text||'').slice(0,300));};
// Saved pending operations and the encrypted journal live in the CLI's data folder (src/engine.mjs writes them).
const store={async get(k){const v=await window.cliStoreGet(k);return v==null?null:JSON.parse(v);},async set(k,v){await window.cliStoreSet(k,JSON.stringify(v));}};
const toBase64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);};
const fromBase64=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
async function journalSecret(seed){const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('XMR20-cli-private-journal-v1\n'+seed.trim().split(/\s+/).join(' ')));return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('');}

let account=null,xmr=null,tokens=null,node=MONERO_NODES[0].url,solLamports=null,secret=null;
const need=(v,m)=>{if(!v)throw Error(m);};
async function xmrSync(){need(xmr,'Open the wallet first.');return xmr.sync(node);}
window.cli={
 // Monero keys: 'create' makes a new 25-word wallet; 'restore' checks a phrase and returns its address.
 keys:(action,seed='')=>oneShot('keys.worker.js',action,{seed}),
 async open({wallet,cache}){need(!xmr,'Already open.');
  account={id:wallet.id,sol:wallet.sol.address,solSecret:wallet.sol.secret,xmr:wallet.xmr.address,xmrSeed:wallet.xmr.seed,height:wallet.xmr.restoreHeight};
  secret=await journalSecret(account.xmrSeed);
  xmr=createNativeBalanceClient({workerFactory:()=>spawn('native.worker.js'),onProgress:p=>{if(p?.phase==='scan'||Number.isFinite(p?.height))progress(`XMR scan: block ${p.height??'?'}${p.target?' / '+p.target:''}`);else if(p?.phase)progress('XMR: '+p.phase);},
   onCheckpoint:cp=>{if(cp?.cache instanceof Uint8Array&&cp.cache.length)void window.cliSaveCheckpoint(toBase64(cp.cache),cp.height??null);}});
  const opened=await xmr.open({seed:account.xmrSeed,address:account.xmr,restoreHeight:account.height,node,cache:cache?fromBase64(cache):null});
  node=opened.node||node;
  tokens=createHeadlessTokens({account:()=>account,oneShot,workerClient,store,secret:()=>secret,endpoint:location.origin+'/api/private-bridge',node:location.origin+'/api/private-node',
   amount,units,compactTokenBalance,importSol,solBalance:()=>solLamports,onProgress:progress,
   splitXmr:{prepare:async()=>{await xmrSync();return xmr.prepareSplit({node,carrierLookup:'local'});},
    checkCoins:()=>xmr.checkCarriers({node,carrierLookup:'node'}),
    relay:async review=>{const sent=await xmr.relay({reviewId:review.id,node});void xmrSync().catch(()=>{});return sent;}}});
  return {address:opened.address,node,restored:opened.restored,cacheRejected:opened.cacheRejected};},
 // The first sync also runs the worker's local coin check (as the extension and xmr20.org do), so XMR20 carrier coins are
 // recognised before anything is spent.
 async xmrSync({first=false}={}){let b=await xmrSync();if(first){try{await xmr.checkCarriers({node,carrierLookup:'local'});b=await xmrSync();}catch{}}return b;},
 xmrPrepare:({to,amountRaw,max})=>max?xmr.prepareMax({to,node,carrierLookup:'local'}):xmr.prepare({to,amountRaw,node,carrierLookup:'local'}),
 xmrCheckCoins:()=>xmr.checkCarriers({node,carrierLookup:'node'}),
 xmrRelay:({reviewId})=>xmr.relay({reviewId,node}),
 xmrCancel:()=>xmr.cancel(),
 setSolBalance(v){solLamports=/^\d{1,20}$/.test(String(v??''))?String(v):null;},
 tokensSync:()=>tokens.sync(),
 tokensSummary:()=>tokens.summary(),
 tokenOp(name,args){const allowed=['send','makePrivate','makeOpen','enablePrivate','bridgeToMonero','bridgeToSolana','publishPending','abandonPending','payPayoutFee'];
  need(allowed.includes(name),'Unsupported token operation.');return tokens[name](args);},
 approve:()=>tokens.approve(),
 cancel:()=>tokens.cancel(),
 async close(){try{tokens?.close();}catch{}try{xmr?.dispose();}catch{}tokens=xmr=null;account=null;secret=null;return true;}
};
window.cliReady=true;
