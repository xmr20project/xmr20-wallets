// First block of the XMR20 bridge ledger (mined 28 September 2026). No XMR20 record exists before it, so a wallet
// with no saved height scans from here instead of block 0 (26 Oct 2026, owner request). A saved height, including 0, wins.
export const XMR20_MONERO_START=3772610;
export const MONERO_NODES=[{name:'Cake Wallet',url:'https://xmr-node.cakewallet.com:18081'},{name:'Seth for Privacy',url:'https://node.sethforprivacy.com'}];
export async function nativeNodeHeight(node=MONERO_NODES[0].url){
 if(!MONERO_NODES.some(n=>n.url===node))throw Error('Choose a supported node.');
 const r=await fetch(node+'/get_info',{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Node unavailable');const d=await r.json();
 if(d.status!=='OK'||d.mainnet!==true||d.nettype!=='mainnet'||!Number.isSafeInteger(d.height)||d.height<=0||d.offline===true||d.synchronized===false)throw Error('Mainnet node is not ready.');return d.height;
}
// Capture before creating the keys. A small rewind covers the creation interval
// and shallow reorganizations; never use today's height for an existing wallet.
export async function captureNativeRestoreHeight({readHeight=creationNodeHeight}={}){
 // A missing height must not block offline key generation. New keys cannot have
 // received anything before the XMR20 start, so that is the safe fallback.
 try{return await Promise.any(MONERO_NODES.map(async node=>{
  const height=await readHeight(node.url);
  if(!Number.isSafeInteger(height)||height<=20)throw Error('Invalid height');
  return height-20;
 }));}catch{return XMR20_MONERO_START;}
}
async function creationNodeHeight(node){
 const index=MONERO_NODES.findIndex(n=>n.url===node);
 if(index<0)throw Error('Choose a supported node.');
 const r=await fetch('/api/monero-height/'+index,{credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
 if(!r.ok)throw Error('Node unavailable');const d=await r.json();
 if(d.status!=='OK'||d.mainnet!==true||d.nettype!=='mainnet'||!Number.isSafeInteger(d.height)||d.height<=20||d.offline===true||d.synchronized===false)throw Error('Mainnet node is not ready.');
 return d.height;
}
export function nativeRestoreHeight(address){
 try{const raw=localStorage.getItem('xmr20-native-birth:'+address);if(!/^\d+$/.test(raw||''))return XMR20_MONERO_START;const height=Number(raw);return Number.isSafeInteger(height)?height:XMR20_MONERO_START;}catch{return XMR20_MONERO_START;}
}
export function saveNativeRestoreHeight(address,height){
 try{if(!Number.isSafeInteger(height)||height<0)return false;const key='xmr20-native-birth:'+address;localStorage.setItem(key,String(height));return localStorage.getItem(key)===String(height);}catch{return false;}
}
// 28 Oct 2026: `onCheckpoint({cache,height})` receives the worker's saved scan progress; `open({...,cache})` resumes from it.
// 28 Oct 2026 (owner: send XMR from the website): the worker is the installed extension's native worker, so the client also
// carries its send actions (prepare/prepareMax review a transaction without relaying it; relay sends only that reviewed one;
// checkCarriers is the explicit coin check). Requests run one at a time in order (a send waits for a running sync instead of
// failing as busy), and worker error codes are kept on the Error.
const TIMEOUTS={open:120000,sync:300000,prepare:150000,prepareMax:150000,prepareSplit:150000,checkCarriers:150000,relay:180000};
export function createNativeBalanceClient({workerFactory=()=>new Worker(new URL('../monero-native/native.worker.js',location.href).pathname),onProgress=()=>{},onCheckpoint=()=>{}}={}){
 const worker=workerFactory(),pending=new Map();let disposed=false,lane=Promise.resolve();
 function dispose(){if(disposed)return;disposed=true;worker.terminate();for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Monero wallet locked.'));}pending.clear();}
 worker.onerror=()=>dispose();
 worker.onmessage=({data})=>{const p=pending.get(data?.id);if(!p)return;if(data.checkpoint){onCheckpoint(data.checkpoint);return;}if(data.progress){if(p.idle){clearTimeout(p.timer);p.timer=setTimeout(()=>dispose(),p.idle);}onProgress(data.progress);return;}clearTimeout(p.timer);pending.delete(data.id);if(data.error)p.reject(Object.assign(Error(data.error),{code:data.code,count:data.count}));else p.resolve(data.result);};
 function send(action,args){if(disposed)return Promise.reject(Error('Monero wallet is locked.'));return new Promise((resolve,reject)=>{const id=crypto.randomUUID(),wait=TIMEOUTS[action]||90000,idle=action==='sync'?wait:0,timer=setTimeout(()=>dispose(),wait);pending.set(id,{resolve,reject,timer,idle});worker.postMessage({id,action,...args});});}
 function request(action,args={}){const run=lane.then(()=>send(action,args));lane=run.catch(()=>{});return run;}
 return {open:args=>request('open',args),sync:node=>request('sync',{node}),prepare:args=>request('prepare',args),prepareMax:args=>request('prepareMax',args),prepareSplit:args=>request('prepareSplit',args),
  checkCarriers:args=>request('checkCarriers',args),relay:args=>request('relay',args),cancel:()=>request('cancel'),dispose,get alive(){return !disposed;}};
}
