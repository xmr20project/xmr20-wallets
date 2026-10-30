import {sitePath} from './site-path.js';
// One dedicated worker per generation session. No keys go to a backend, URL,
// telemetry or console. The UI may save a password-encrypted local backup only
// when the user opts in. Disposal kills WASM memory.
export function createMoneroGenerator(){
  if(!globalThis.isSecureContext||!globalThis.crypto?.getRandomValues)throw Error('Wallet generation requires HTTPS or localhost.');
  const worker=new Worker(sitePath('/monero-wallet/generate.worker.js'));
  let pending=null,disposed=false;
  const cancel=message=>{if(pending){clearTimeout(pending.timer);pending.reject(Error(message));pending=null;}};
  worker.onerror=e=>{e.preventDefault();cancel('The Monero wallet library could not load. Close this panel and try again.');worker.terminate();disposed=true;};
  worker.onmessage=({data})=>{
    if(!pending||data?.id!==pending.id)return;
    const task=pending;pending=null;clearTimeout(task.timer);
    if(data.error)task.reject(Error('Wallet generation failed. Close this panel and try again.'));
    else task.resolve(data.result);
  };
  return {
    request(action,args={}){
      if(disposed||pending)return Promise.reject(Error('Wallet generator is unavailable or busy.'));
      return new Promise((resolve,reject)=>{
        const id=crypto.randomUUID();
        const timer=setTimeout(()=>{cancel('Wallet generation timed out. Close this panel and try again.');worker.terminate();disposed=true;},60000);
        pending={id,timer,resolve,reject};worker.postMessage({id,action,...args});
      });
    },
    dispose(){disposed=true;cancel('Wallet generator closed.');worker.terminate();},
  };
}
