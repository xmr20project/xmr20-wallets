// Mordinals worker of the XMR20 wallet (vendor/mordinals.worker.js, running vendor/mordinals.wasm). It holds the open account's Monero keys inside the engine,
// checks owner-list entries against them and signs claims and one-line Mordinals texts. It makes no network request
// besides loading its own files, and never returns a key.
//   open      {seed, owner}                      -> {address}
//   find      {owners, accounts?, indices?}      -> {checked, found}
//   claimSign {domain, body, outputKey, txPubKey, account, index} -> {c, r, outputKey}
//   sign      {text}                             -> {signature, address}
import {createHolderEngine} from '../../../engine/token/holder-engine.js';
let engine=null;
// The 25-word phrase gives the private spend key, the same way the wallet's holder worker reads it.
async function spendKeyHex(seed,owner){
 if(typeof seed!=='string'||seed.trim().split(/\s+/).length!==25)throw Error('Saved Monero wallet is unavailable.');
 importScripts('monero-0.11.16.js');const m=await self.monero_ts({print:()=>{},printErr:()=>{}});
 const clean=seed.trim().toLowerCase().replace(/\s+/g,' ');
 const p=await new Promise((resolve,reject)=>m.create_full_wallet(JSON.stringify({networkType:0,seed:clean,seedOffset:'',path:'',password:'',restoreHeight:0}),'mordinals-offline',v=>typeof v==='number'&&v>0?resolve(v):reject(Error('Monero keys unavailable.'))));
 try{if(m.get_address(p,0,0)!==owner)throw Error('Saved Monero wallet does not match this account.');
  const key=m.get_private_spend_key(p);if(!/^[0-9a-f]{64}$/.test(key||''))throw Error('Monero keys unavailable.');return key;}
 finally{await new Promise(r=>m.close(p,false,0,r));}}
self.onmessage=async({data})=>{if(typeof data?.id!=='string')return;const {id,action}=data;try{let result;
  if(action==='open'){
   if(engine)throw Error('Already open');const wasm=await WebAssembly.compileStreaming(fetch('mordinals.wasm')),e=await createHolderEngine({wasm});
   const d=e.call({op:'derive',root:await spendKeyHex(data.seed,data.owner)});data.seed='';
   if(d.nativeAddress!==data.owner)throw Error('Saved Monero wallet does not match this account.');engine=e;result={address:d.nativeAddress};}
  else if(!engine)throw Error('Mordinals keys are not open.');
  else if(action==='find')result=engine.call({op:'mordinalsFind',owners:data.owners,accounts:data.accounts,indices:data.indices});
  else if(action==='claimSign')result=engine.call({op:'mordinalsClaimSign',domain:data.domain,body:data.body,outputKey:data.outputKey,txPubKey:data.txPubKey,account:data.account,index:data.index});
  else if(action==='sign')result=engine.call({op:'mordinalsSign',text:data.text});
  else throw Error('Unknown action');
  self.postMessage({id,result});
 }catch(e){self.postMessage({id,error:String(e?.message||e).slice(0,600)});}finally{if(data)data.seed='';}};
