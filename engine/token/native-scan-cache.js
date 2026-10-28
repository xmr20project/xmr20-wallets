// Checkpointed Monero scan state. Each entry is the opaque wallet cache that the
// pinned library encrypts inside the worker with a key derived from the
// recovery phrase; this module never sees keys or the phrase. Losing an entry
// only costs a rescan from the restore height, so every failure here is soft.
import {MONERO_NODES} from '../monero/monero-node.js';
const DB_NAME='xmr20-native-scan',STORE='cache',VERSION=1;
export function nativeScanKey(account){
 if(!account||typeof account.id!=='string'||typeof account.xmr!=='string'||account.xmr.length!==95||!Number.isSafeInteger(account.height)||account.height<0)return null;
 return account.id+':'+account.xmr+':'+account.height;
}
export function createNativeScanCache({indexedDB=globalThis.indexedDB}={}){
 let db=null;
 function open(){
  if(db)return Promise.resolve(db);
  if(!indexedDB)return Promise.reject(Error('Scan cache unavailable'));
  return new Promise((resolve,reject)=>{
   const request=indexedDB.open(DB_NAME,VERSION);
   request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);};
   request.onsuccess=()=>{db=request.result;db.onclose=()=>{db=null;};db.onversionchange=()=>{db.close();db=null;};resolve(db);};
   request.onerror=()=>reject(request.error||Error('Scan cache unavailable'));
   request.onblocked=()=>reject(Error('Scan cache blocked'));
  });
 }
 async function transaction(mode,operate){
  const database=await open();
  return new Promise((resolve,reject)=>{
   const tx=database.transaction(STORE,mode),request=operate(tx.objectStore(STORE));
   tx.oncomplete=()=>resolve(request?.result);
   tx.onerror=()=>reject(tx.error||Error('Scan cache failed'));
   tx.onabort=()=>reject(tx.error||Error('Scan cache aborted'));
  });
 }
 return {
  async load(key){
   if(!key)return null;
   try{const row=await transaction('readonly',store=>store.get(key));return row&&row.cache instanceof Uint8Array&&row.cache.length?row:null;}catch{return null;}
  },
  async save(key,cache,{height=null,address=null,node=null}={}){
   if(!key||!(cache instanceof Uint8Array)||!cache.length)return false;
   try{await transaction('readwrite',store=>store.put({cache,height:Number.isSafeInteger(height)?height:null,address,node:MONERO_NODES.some(n=>n.url===node)?node:null,savedAt:Date.now()},key));return true;}catch{return false;}
  },
  async clear(key){
   try{await transaction('readwrite',store=>key?store.delete(key):store.clear());return true;}catch{return false;}
  },
  async keys(){try{return await transaction('readonly',store=>store.getAllKeys());}catch{return [];}}
 };
}
