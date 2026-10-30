export async function testSigner(signal){
 if(location.origin!=='http://127.0.0.1:8924')throw Error('Open the separate local test on port 8924.');const worker=new Worker('/v2.worker.js'),pending=new Map();let closed=false;
 function close(){closed=true;worker.terminate();for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Test closed.'));}pending.clear();signal.removeEventListener('abort',close);}
 worker.onmessage=({data})=>{const p=pending.get(data?.id);if(!p)return;clearTimeout(p.timer);pending.delete(data.id);data.error?p.reject(Error(data.error)):p.resolve(data.result);};worker.onerror=close;signal.addEventListener('abort',close,{once:true});
 function call(action,fields={}){return new Promise((resolve,reject)=>{if(closed||signal.aborted)return reject(Error('Test closed.'));const id=crypto.randomUUID(),timer=setTimeout(()=>{close();reject(Error('Test signer timed out. Start a new test.'));},40000);pending.set(id,{resolve,reject,timer});worker.postMessage({id,action,...fields});});}
 try{const {address}=await call('create');return {address,bind:context=>call('bind',{context}),sign:review=>call('sign',{review}),close};}catch(e){close();throw e;}
}
