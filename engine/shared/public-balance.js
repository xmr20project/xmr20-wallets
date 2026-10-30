// Public display reads only. Transaction preparation always checks its own balance.
const SLOT='xmr20-sol-display-v1:';
const validRaw=value=>typeof value==='string'&&/^\d{1,20}$/.test(value);
export function cachedSolBalance(owner,{storage=globalThis.localStorage,now=Date.now()}={}){
 try{const value=JSON.parse(storage.getItem(SLOT+owner));return value.owner===owner&&validRaw(value.raw)&&Number.isSafeInteger(value.checkedAt)&&value.checkedAt<=now&&now-value.checkedAt<=86400000?value:null;}catch{return null;}
}
export function saveSolBalance(owner,raw,{storage=globalThis.localStorage,now=Date.now()}={}){
 if(!validRaw(raw))return;try{storage.setItem(SLOT+owner,JSON.stringify({owner,raw,checkedAt:now}));}catch{}
}
const HELIUS_WALLET='https://xmr20.org/api/wallet';
export function createPublicBalanceReader({fetcher=globalThis.fetch,endpoints=[HELIUS_WALLET],timeoutMs=4500,hedgeMs=350}={}){
 const pending=new Map();
 return function read(owner){
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner))return Promise.reject(Error('Invalid Solana address'));
  if(pending.has(owner))return pending.get(owner);
  const task=new Promise((resolve,reject)=>{
   const controller=new AbortController();let done=false,started=0,failed=0,hedge;
   const finish=(error,value)=>{if(done)return;done=true;clearTimeout(deadline);clearTimeout(hedge);controller.abort();error?reject(error):resolve(value);};
   const deadline=setTimeout(()=>finish(Error('SOL balance is taking longer than expected.')),timeoutMs);
   async function attempt(){
    if(done||started>=endpoints.length)return;const endpoint=endpoints[started++],id=crypto.randomUUID();
    try{
     const rpc={jsonrpc:'2.0',id,method:'getBalance',params:[owner,{commitment:'finalized'}]};
     const response=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(endpoint===HELIUS_WALLET?{action:'walletRpc',rpc}:rpc),credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
     if(!response.ok)throw Error('Balance service unavailable');const result=await response.json();
     if(result.id!==id||result.error||!Number.isSafeInteger(result.result?.value)||result.result.value<0)throw Error('Invalid SOL balance');
     finish(null,String(result.result.value));
    }catch(error){if(done)return;failed++;if(started<endpoints.length)void attempt();else if(failed===endpoints.length)finish(error);}
   }
   if(!endpoints.length){finish(Error('No balance service configured'));return;}
   void attempt();hedge=setTimeout(()=>void attempt(),hedgeMs);
  }).finally(()=>{if(pending.get(owner)===task)pending.delete(owner);});
  pending.set(owner,task);return task;
 };
}
