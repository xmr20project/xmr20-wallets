/* Native Monero keys-only wallet. No RPC, persistence or user-provided code.
 * Its HTTP CSP denies all network connections; WASM is embedded in the asset.
 * Native calls follow monero-ts 0.11.16 MoneroWalletKeys, pinned at build time.
 */
'use strict';
let network='stagenet',modulePromise,seed='',address='',revealed=false,finished=false,running=false;
const fail=()=>{throw Error('Wallet operation could not complete.');};
async function nativeModule(){
  if(!self.crypto?.getRandomValues||!self.isSecureContext)fail();
  if(!modulePromise){
    importScripts('./monero-0.11.16.js');
    modulePromise=monero_ts({print:()=>{},printErr:()=>{}});
  }
  return modulePromise;
}
function nativeCreate(m,config,restore=false){return new Promise((resolve,reject)=>{
  m[restore?'create_keys_wallet_from_seed':'create_keys_wallet_random'](JSON.stringify(config),p=>typeof p==='number'&&p>0?resolve(p):reject(Error('Wallet generation failed.')));
});}
function nativeClose(m,p){return new Promise((resolve,reject)=>m.close(p,false,0,e=>e?reject(Error('Wallet cleanup failed.')):resolve()));}
function forget(){seed='';address='';revealed=false;finished=false;}
self.onmessage=async({data})=>{
  if(running||!data||typeof data.id!=='string')return;
  running=true;
  try{
    let result;
    if(data.action==='generate'){
      if(seed||address)fail();
      network=data.network||'stagenet';if(!['stagenet','mainnet'].includes(network))fail();
      const networkType=network==='mainnet'?0:2;
      const m=await nativeModule();
      const p=await nativeCreate(m,{networkType,language:'English'});
      try{seed=m.get_seed(p);address=m.get_address(p,0,0);}finally{await nativeClose(m,p);}
      if(seed.trim().split(/\s+/).length!==25||address.length!==95)fail();
      // Verify recovery before offering the address. Never send private keys.
      const restored=await nativeCreate(m,{networkType,seed,seedOffset:''},true);
      try{if(m.get_address(restored,0,0)!==address)fail();}finally{await nativeClose(m,restored);}
      result={address,network,wordCount:25};
    }else if(data.action==='import'){
      if(seed||address)fail();
      network=data.network;if(!['stagenet','mainnet'].includes(network))fail();
      if(typeof data.seed!=='string'||data.seed.length>400||data.seed.trim().split(/\s+/).length!==25)fail();
      const m=await nativeModule();
      const requestedSeed=data.seed.trim().toLowerCase().replace(/\s+/g,' ');
      const restored=await nativeCreate(m,{networkType:network==='mainnet'?0:2,seed:requestedSeed,seedOffset:''},true);
      data.seed='';
      try{if(m.get_seed(restored).trim().toLowerCase().replace(/\s+/g,' ')!==requestedSeed)fail();address=m.get_address(restored,0,0);if(address.length!==95||(data.expectedAddress&&data.expectedAddress!==address))fail();}finally{await nativeClose(m,restored);}
      finished=true;
      result={address,network,restored:true};
    }else if(data.action==='reveal'){
      if(!seed||revealed||finished)fail();revealed=true;result={seed};
    }else if(data.action==='finish'){
      if(!seed||!revealed||finished)fail();finished=true;seed='';result={address,network};
    }else fail();
    self.postMessage({id:data.id,result});
  }catch{
    // Never forward native exception strings: these can contain input material.
    data.seed='';forget();self.postMessage({id:data.id,error:'Wallet generation could not complete. Close this panel and try again.'});
  }finally{data.seed='';running=false;}
};
