// Retry transport failures for public chain reads only. Signing, submission,
// RPC validation errors and successful responses are never replayed here.
const READS=new Set(['getGenesisHash','getAccountInfo','getMultipleAccounts','getEpochInfo','getLatestBlockhash','getTransaction','getSignatureStatuses','getBlockHeight','isBlockhashValid','getBalance','getTokenAccountBalance','getSlot','getMinimumBalanceForRentExemption']);
const RETRY_STATUS=new Set([429,500,502,503,504]);
function isRead(options){
 try{const r=JSON.parse(options?.body);return options?.method==='POST'&&r?.jsonrpc==='2.0'&&['string','number'].includes(typeof r.id)&&Array.isArray(r.params)&&READS.has(r.method)&&Object.keys(r).every(k=>['jsonrpc','id','method','params'].includes(k));}catch{return false;}
}
function pause(ms,signal){
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const stop=()=>{clearTimeout(timer);reject(signal.reason);};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);
  signal.addEventListener('abort',stop,{once:true});
 });
}
export function bridgeReadFetch({fetcher=fetch,signal,onRetry=()=>{},wait=pause,timeoutMs=6000}={}){
 return async(url,options)=>{
  if(!isRead(options))return fetcher(url,options);
  const scope=AbortSignal.any([signal,options.signal].filter(Boolean));
  for(let attempt=0;attempt<3;attempt++){
   scope.throwIfAborted();
   const requestSignal=AbortSignal.any([scope,AbortSignal.timeout(timeoutMs)]);
   try{
    const response=await fetcher(url,{...options,signal:requestSignal});
    scope.throwIfAborted();
    if(!RETRY_STATUS.has(response.status))return response;
    await response.body?.cancel();
   }catch(error){
    scope.throwIfAborted();
    if(!(error instanceof TypeError)&&error?.name!=='TimeoutError')throw error;
   }
   if(attempt===2)throw Object.assign(Error('Solana verification is temporarily unavailable. Your saved transfer is kept. Retry this approval when the connection recovers.'),{code:'bridge-read-unavailable'});
   onRetry();await wait(attempt===0?150:350,scope);
  }
 };
}
