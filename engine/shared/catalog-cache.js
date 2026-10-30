// One public token-catalog read serves every consumer for a short time: home
// Solana balances, Bridge token choices and catalog discovery all read the same
// list. The catalog is discovery metadata only; finalized Solana accounts and
// fresh bridge checks still prove every balance and approval. Concurrent
// readers share one request, which is aborted only when all of them have left.
export const TOKEN_CATALOG_URL='https://xmr20.org/api/xmr20/tokens';
export function createCatalogReader({fetcher=fetch,url=TOKEN_CATALOG_URL,ttl=60000,now=Date.now,maxBytes=4000000}={}){
 let value=null,at=-Infinity,entry=null;
 async function read(signal){
  const r=await fetcher(url,{credentials:'omit',redirect:'error',cache:'no-store',signal});
  if(!r.ok)throw Error('Token list unavailable.');const text=await r.text();if(text.length>maxBytes)throw Error('Token list too large.');
  const parsed=JSON.parse(text);
  if(parsed?.schema!=='xmr20-launches-v1'||!Array.isArray(parsed.tokens)||parsed.tokens.length>10000)throw Error('Token list unavailable.');
  value=parsed;at=now();return parsed;
 }
 return {
  get age(){return value?now()-at:Infinity;},
  load({signal,force=false,maxAge=ttl}={}){
   if(signal?.aborted)return Promise.reject(signal.reason);
   if(!force&&value&&now()-at<=maxAge)return Promise.resolve(structuredClone(value));
   if(!entry){
    const controller=new AbortController(),current={controller,subscribers:0};
    current.promise=read(controller.signal).finally(()=>{if(entry===current)entry=null;});current.promise.catch(()=>{});entry=current;
   }
   const shared=entry;shared.subscribers++;
   return new Promise((resolve,reject)=>{
    let done=false;
    // Detach before aborting so an immediate new caller starts a fresh request
    // instead of joining the abandoned one until its finally runs.
    const leave=()=>{if(done)return;done=true;signal?.removeEventListener('abort',onAbort);if(--shared.subscribers===0&&entry===shared){entry=null;shared.controller.abort(signal?.reason);}};
    const onAbort=()=>{reject(signal.reason);leave();};
    signal?.addEventListener('abort',onAbort,{once:true});
    shared.promise.then(v=>{resolve(structuredClone(v));leave();},e=>{reject(e);leave();});
   });
  }
 };
}
// Readers are keyed by fetch implementation and URL, so the real wallet shares
// one reader while tests with their own fetchers stay isolated.
const readers=new WeakMap();
export function sharedCatalog(fetcher=fetch,url=TOKEN_CATALOG_URL){
 let byUrl=readers.get(fetcher);if(!byUrl){byUrl=new Map();readers.set(fetcher,byUrl);}
 let reader=byUrl.get(url);if(!reader){reader=createCatalogReader({fetcher,url});byUrl.set(url,reader);}
 return reader;
}
