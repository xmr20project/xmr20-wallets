'use strict';
let busy=false;
for(const name of ['log','info','warn','error','debug'])console[name]=()=>{};
self.onmessage=async({data})=>{if(busy)return;busy=true;let m,p;try{
 if(!['create','restore'].includes(data.action))throw Error();
 importScripts('./monero-0.11.16.js');m=await monero_ts({print:()=>{},printErr:()=>{}});
 const config={networkType:0,language:'English',seed:data.seed,seedOffset:''};
 p=await new Promise((resolve,reject)=>m[data.action==='create'?'create_keys_wallet_random':'create_keys_wallet_from_seed'](JSON.stringify(config),p=>p>0?resolve(p):reject(Error())));
 const address=m.get_address(p,0,0),seed=m.get_seed(p);if(address.length!==95||seed.trim().split(/\s+/).length!==25)throw Error();
 self.postMessage({id:data.id,result:{address,seed}});
 }catch{self.postMessage({id:data.id,error:'Could not create or restore Monero keys. Check the 25-word phrase.'});}finally{data.seed='';if(m&&p)await new Promise(resolve=>m.close(p,false,0,resolve));self.close();}};
