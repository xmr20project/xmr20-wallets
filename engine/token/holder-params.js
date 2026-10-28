// Authenticated parameter loading for the holder engine.
//
// Trust model: the parameter MANIFEST (format XMR20-PARAMS-2) ships with the
// build. It pins, for the intended protocol version, circuits, ledger domain
// and network: the exact byte length, sha256 and verifying key of each proving
// key file and of parameters.json. The parameter server is an untrusted
// transport: nothing it says about its own files (sizes, checksums,
// configuration) is used as a trust anchor. Every file - freshly downloaded or
// read back from the local cache - is hashed over its complete contents and
// compared with the manifest BEFORE it is parsed or handed to the engine; the
// engine (wasm) repeats the length and sha256 check before deserializing.
// Rejected bytes are never cached; a cached entry that fails is deleted.
//
// Environment-agnostic: the worker supplies an IndexedDB cache, Node tests an
// in-memory one.
const hexOf=buf=>[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
export async function sha256Hex(bytes){return hexOf(await crypto.subtle.digest('SHA-256',bytes));}
export const PARAMETER_FILES={0:'spend',1:'output'};
export class ParameterRejected extends Error{constructor(message,detail={}){super(message);this.name='ParameterRejected';Object.assign(this,detail);}}
// Validate the shipped manifest's shape and, when the build pinned it, its hash.
export async function checkManifest(manifestBytes,{expectedSha256=null}={}){
 const digest=await sha256Hex(manifestBytes);
 if(expectedSha256&&digest!==expectedSha256)throw new ParameterRejected(`The parameter manifest in this build does not match the hash compiled into it (${digest.slice(0,16)}… vs ${expectedSha256.slice(0,16)}…). The build is inconsistent; parameters cannot be trusted.`);
 const m=JSON.parse(new TextDecoder().decode(manifestBytes));
 if(m.format!=='XMR20-PARAMS-2')throw new ParameterRejected('Unknown parameter manifest format '+m.format);
 for(const name of ['spend','output']){const f=m.files?.[name];if(!f||!/^[0-9a-f]{64}$/.test(f.sha256)||!(f.bytes>0)||typeof f.vk!=='string'||!/^groth16pk1/.test(f.keyId||''))throw new ParameterRejected('Parameter manifest lacks a complete pin for '+name);}
 if(!/^[0-9a-f]{64}$/.test(m.parametersJson?.sha256||''))throw new ParameterRejected('Parameter manifest lacks the parameters.json pin');
 if(!m.config?.domain||m.config.domain!==m.ledgerDomain)throw new ParameterRejected('Parameter manifest ledger domain is inconsistent');
 return {manifest:m,sha256:digest};
}
export function createParameterLoader({manifest,engine,fetch:f=globalThis.fetch,cache=null,baseUrl,onProgress=()=>{},log=()=>{}}){
 const cacheKey=slot=>`${manifest.format}:${manifest.ledgerDomain}:${PARAMETER_FILES[slot]}:${manifest.files[PARAMETER_FILES[slot]].sha256}`;
 const authenticate=async(expected,bytes,source)=>{
  if(bytes.length!==expected.bytes)throw new ParameterRejected(`Parameter file ${expected.path} (${source}) rejected before use: ${bytes.length} bytes, the shipped manifest pins ${expected.bytes} bytes (missing, truncated or substituted file).`,{source,reason:'length',received:bytes.length,expected:expected.bytes});
  const digest=await sha256Hex(bytes);
  if(digest!==expected.sha256)throw new ParameterRejected(`Parameter file ${expected.path} (${source}) rejected before use: sha256 ${digest.slice(0,16)}… does not match the shipped manifest (${expected.sha256.slice(0,16)}…).`,{source,reason:'sha256',received:digest,expected:expected.sha256});
  return digest;};
 // FIX (review L1): the TRUSTED expected length (from the shipped manifest) bounds the stream. The buffer is allocated once at
 // that size; the first byte beyond it cancels the response and rejects; a short stream is rejected as truncated. Nothing the
 // server announces is trusted. Authentication (sha256) still happens before any parse or use.
 async function download(path,{expectedBytes,onBytes=()=>{}}={}){
  if(!(Number.isInteger(expectedBytes)&&expectedBytes>0))throw new ParameterRejected(`Download of ${path} refused: the shipped manifest gives no trusted length for it.`,{source:'download',reason:'no-expected-length'});
  const r=await f(baseUrl+path,{signal:AbortSignal.timeout(600000)});
  if(!r.ok)throw new ParameterRejected(`Parameter file ${path} is missing from the parameter server (HTTP ${r.status}).`,{source:'download',reason:'missing',status:r.status});
  const declared=Number(r.headers.get('content-length'))||0;
  if(declared&&declared!==expectedBytes){await r.body?.cancel?.().catch(()=>{});throw new ParameterRejected(`Parameter file ${path} rejected before download: the server announces ${declared} bytes, the shipped manifest pins ${expectedBytes}.`,{source:'download',reason:'length',received:declared,expected:expectedBytes});}
  const reader=r.body.getReader();const bytes=new Uint8Array(expectedBytes);let got=0,last=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;
    if(got+value.length>expectedBytes){await reader.cancel().catch(()=>{});throw new ParameterRejected(`Parameter file ${path} rejected during download: the server sent more than the ${expectedBytes} bytes pinned by the shipped manifest; the stream was cancelled at ${got+value.length} bytes and nothing was kept.`,{source:'download',reason:'oversized',received:got+value.length,expected:expectedBytes});}
    bytes.set(value,got);got+=value.length;if(got-last>8_000_000){last=got;onBytes(got,expectedBytes);}}}
  catch(e){if(e instanceof ParameterRejected)throw e;throw new ParameterRejected(`Download of ${path} was interrupted after ${got} bytes (${e.message}). Nothing was kept; it will be downloaded again.`,{source:'download',reason:'interrupted',received:got});}
  if(got!==expectedBytes)throw new ParameterRejected(`Parameter file ${path} rejected: the server sent ${got} bytes, the shipped manifest pins ${expectedBytes} (truncated or substituted file).`,{source:'download',reason:'length',received:got,expected:expectedBytes});
  return bytes;}
 // parameters.json: raw bytes authenticated against the manifest, then parsed.
 // The returned configuration is passed to the engine as `served` so the engine
 // can refuse a server that announces a different ledger/version.
 async function loadServedConfig(){
  const exp=manifest.parametersJson;
  const bytes=await download('/params/parameters.json',{expectedBytes:exp.bytes});
  if(bytes.length!==exp.bytes)throw new ParameterRejected(`Served parameters.json rejected: ${bytes.length} bytes, the shipped manifest pins ${exp.bytes}. The parameter server serves another version or ledger.`,{source:'download',reason:'length'});
  const digest=await sha256Hex(bytes);if(digest!==exp.sha256)throw new ParameterRejected(`Served parameters.json rejected: sha256 ${digest.slice(0,16)}… differs from the shipped manifest (${exp.sha256.slice(0,16)}…). The parameter server serves another version or ledger.`,{source:'download',reason:'sha256'});
  return JSON.parse(new TextDecoder().decode(bytes));}
 const loaded={};
 async function loadProvingKey(slot){
  if(loaded[slot])return loaded[slot];
  const name=PARAMETER_FILES[slot],expected=manifest.files[name];let bytes=null,source='download';
  if(cache){try{const hit=await cache.get(cacheKey(slot));if(hit){onProgress({phase:'params',text:`Checking the cached ${name} proving parameters against the hashes shipped with this build…`});
    try{await authenticate(expected,hit,'cache');bytes=hit;source='cache';}
    catch(e){log({event:'cache-rejected',name,reason:e.reason,received:e.received});await cache.delete(cacheKey(slot)).catch(()=>{});onProgress({phase:'params',text:`Cached ${name} parameters failed authentication and were discarded. Downloading again…`});}}}
   catch(e){log({event:'cache-unavailable',message:e.message});}}
  if(!bytes){
   onProgress({phase:'params',text:`Downloading the ${name} proving parameters (public, ${Math.round(expected.bytes/1e6)} MB) from the parameter server…`});
   bytes=await download('/params/'+expected.path,{expectedBytes:expected.bytes,onBytes:(got,total)=>onProgress({phase:'params',text:`Downloading ${name} proving parameters… ${Math.round(got/1e6)}${total?' of '+Math.round(total/1e6):''} MB`})});
   onProgress({phase:'params',text:`Authenticating the ${name} proving parameters against the hashes shipped with this build…`});
   await authenticate(expected,bytes,'download');
   if(cache){try{await cache.put(cacheKey(slot),bytes);}catch(e){log({event:'cache-write-failed',message:e.message});}}}
  onProgress({phase:'params',text:`Loading the authenticated ${name} proving parameters into the holder engine…`});
  const info=engine.blob(slot,bytes);// the engine repeats length + sha256 before deserializing
  if(info.sha256!==expected.sha256||info.authenticated!==true)throw new ParameterRejected('Engine did not confirm the authenticated parameters');
  loaded[slot]={...info,source,path:expected.path};log({event:'parameters-loaded',name,source,sha256:info.sha256});return loaded[slot];}
 return {loadServedConfig,loadProvingKey,cacheKey,get loaded(){return {...loaded};}};
}
// IndexedDB cache for the worker: one object store, key -> Uint8Array. Entries
// are always re-authenticated on read, so a corrupted or swapped entry is
// discarded instead of used.
export function createIndexedDbCache(dbName='xmr20-holder-parameters'){
 const open=()=>new Promise((res,rej)=>{const r=indexedDB.open(dbName,1);r.onupgradeneeded=()=>r.result.createObjectStore('files');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
 const tx=async(mode,fn)=>{const db=await open();try{return await new Promise((res,rej)=>{const t=db.transaction('files',mode);const req=fn(t.objectStore('files'));t.oncomplete=()=>res(req?.result);t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error||Error('aborted'));});}finally{db.close();}};
 return {
  async get(key){const v=await tx('readonly',s=>s.get(key));return v?new Uint8Array(v):null;},
  async put(key,bytes){await tx('readwrite',s=>s.put(bytes,key));},
  async delete(key){await tx('readwrite',s=>s.delete(key));},
  async keys(){return tx('readonly',s=>s.getAllKeys());},
 };
}
