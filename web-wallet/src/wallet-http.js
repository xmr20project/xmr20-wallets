const READS=new Set(['account','catalog','launchBalance']);
export function createWalletHttp({fetchImpl=(...args)=>fetch(...args),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
 const pending=new Map();
 async function send(endpoint,body,timeoutMs,read){
  for(let attempt=0;;attempt++){
   let response,result;
   try{
    response=await fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
    try{result=await response.json();}catch{throw Error('Wallet service returned an incomplete response. Please retry.');}
    if(!response.ok){const error=Error(result.error||'Wallet service temporarily unavailable. Please retry.');error.status=response.status;throw error;}
    return result;
   }catch(error){
    const transient=!response||[429,502,503,504].includes(response.status);
    if(read&&attempt===0&&transient){await sleep(350);continue;}
    if(error.name==='TimeoutError'||error.name==='AbortError'||error instanceof TypeError)throw Error('Connection timed out. Please retry. Your saved wallet and receipts are unchanged.');
    throw error;
   }
  }
 }
 return (endpoint,body,timeoutMs)=>{
  const read=READS.has(body.action),key=JSON.stringify([endpoint,body]);
  if(read&&pending.has(key))return pending.get(key);
  const task=send(endpoint,body,timeoutMs,read);
  if(read){pending.set(key,task);task.finally(()=>{if(pending.get(key)===task)pending.delete(key);}).catch(()=>{});}
  return task;
 };
}
