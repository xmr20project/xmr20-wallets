// Saved XMR20 scan progress for the holder worker (27 Oct 2026). Two kinds of entry in one IndexedDB store on this device:
//   pool:<manifest sha256>:<engine>          the token pool's record log and recent block hashes. Public chain data, the same
//                                             for every account; each account's worker resumes from it. Every record in it is
//                                             verified again when it is replayed, so the entry cannot create balances.
//   native:<manifest sha256>:<account id>    the account's own Monero outputs (carrier fees), sealed with AES-GCM under a key
//                                             derived from the account's root inside the worker; unreadable without the phrase.
// Losing or refusing an entry only costs a rescan (from the pool start, or from the account's first height for its outputs).
const DB='xmr20-holder-scan',STORE='progress',enc=new TextEncoder(),dec=new TextDecoder();
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
function db(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore(STORE);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function run(mode,fn){const d=await db();try{return await new Promise((resolve,reject)=>{const t=d.transaction(STORE,mode);const r=fn(t.objectStore(STORE));t.oncomplete=()=>resolve(r?.result);t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);});}finally{d.close();}}
// The sealing key: HKDF-SHA256 over the account root, bound to the parameter manifest. Non-extractable; the root is not kept.
export async function progressKey(root,manifestSha256){
 const material=await crypto.subtle.importKey('raw',root,'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:enc.encode('XMR20-holder-scan-progress-v1'),info:enc.encode(manifestSha256)},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function accountTag(ownerKey,manifestSha256){return hex(await crypto.subtle.digest('SHA-256',enc.encode('XMR20-holder-scan-account|'+manifestSha256+'|'+ownerKey))).slice(0,32);}
export function createProgressStore({manifestSha256,engineVersion,account,key}){
 const poolId=`pool:${manifestSha256}:${engineVersion}`,nativeId=`native:${manifestSha256}:${account}`;
 const aad=enc.encode(nativeId);
 return {
  async load(){
   const [pool,sealed]=await Promise.all([run('readonly',s=>s.get(poolId)).catch(()=>null),run('readonly',s=>s.get(nativeId)).catch(()=>null)]);
   let native=null;
   if(sealed?.iv&&sealed?.data){try{native=JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:sealed.iv,additionalData:aad},key,sealed.data)));}catch{native=null;}}
   return {pool:pool&&Array.isArray(pool.log)?pool:null,native};
  },
  async save({pool,native}){
   if(pool)await run('readwrite',s=>s.put({...pool,savedAt:Date.now()},poolId));
   if(native){const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,enc.encode(JSON.stringify(native)));await run('readwrite',s=>s.put({iv,data,savedAt:Date.now()},nativeId));}
  },
  // Rescan: forget this account's outputs and the shared pool progress (every account rebuilds the pool once afterwards).
  async clear(){await run('readwrite',s=>{s.delete(poolId);return s.delete(nativeId);});},
 };
}
