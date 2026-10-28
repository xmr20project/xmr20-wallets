// Request/response over a dedicated worker with per-call deadlines.
// A deadline or load failure terminates the worker. The client then reports
// itself dead and fails every outstanding call, so an owner can never reuse a
// terminated worker for its next request.
export function createWorkerClient(file,{spawn=name=>new Worker('vendor/'+name),onProgress=()=>{},onCheckpoint=()=>{},onDead=()=>{}}={}){
 const worker=spawn(file),pending=new Map();let dead=false;
 function fail(message){for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error(message));}pending.clear();}
 function kill(message){if(dead)return;dead=true;try{worker.terminate();}catch{}fail(message);onDead();}
 worker.onmessage=({data})=>{
  if(dead||!data)return;
  if(data.checkpoint){onCheckpoint(data.checkpoint);return;}
  const p=pending.get(data.id);if(!p)return;
  if(data.progress){if(p.idle){clearTimeout(p.timer);p.timer=setTimeout(p.expire,p.timeout);}onProgress(data.progress,p.action);return;}
  clearTimeout(p.timer);pending.delete(data.id);
  if(data.error){const error=Error(data.error);if(typeof data.code==='string')error.code=data.code;if(typeof data.count==='number')error.count=data.count;if(data.sync&&typeof data.sync==='object')error.sync=data.sync;p.reject(error);}
  else p.resolve(data.result);
 };
 worker.onerror=()=>kill('Wallet library could not load.');
 return {
  get alive(){return !dead;},
  // idle:true treats the deadline as an inactivity limit that each progress
  // message renews, so long scans are bounded by stalls rather than total time.
  call(action,args={},timeout=90000,{transfer=[],idle=false}={}){
   return new Promise((resolve,reject)=>{
    if(dead){reject(Error('Wallet worker closed. Reopen and try again.'));return;}
    const id=crypto.randomUUID();
    const expire=()=>{pending.delete(id);const message=idle?'Monero scan stopped responding. Reopen and sync again; saved progress is kept.':'Wallet operation timed out. Reopen and try again.';kill(message);reject(Error(message));};
    const entry={resolve,reject,action,idle,timeout,expire,timer:setTimeout(expire,timeout)};
    pending.set(id,entry);
    try{worker.postMessage({id,action,...args},transfer);}catch(error){clearTimeout(entry.timer);pending.delete(id);reject(error);}
   });
  },
  // Fire-and-forget control message, e.g. asking a running scan to pause.
  notify(action,args={}){if(dead)return;try{worker.postMessage({id:crypto.randomUUID(),action,...args});}catch{}},
  close(){kill('Wallet locked.');}
 };
}
