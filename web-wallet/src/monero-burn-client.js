export function createMoneroBurnSigner(){
  if(!globalThis.isSecureContext||!globalThis.crypto?.getRandomValues)throw Error('Monero approval requires HTTPS or localhost.');
  const worker=new Worker('/wallet/monero-wallet/sign.worker.js');
  let pending,disposed=false;
  const stop=()=>{disposed=true;worker.terminate();};
  const reject=message=>{if(pending){clearTimeout(pending.timer);pending.reject(Error(message));pending=null;}stop();};
  worker.onerror=event=>{event.preventDefault();reject('The Monero signing library could not load. Please try again.');};
  worker.onmessage=({data})=>{
    if(!pending||data?.id!==pending.id)return;
    const task=pending;pending=null;clearTimeout(task.timer);stop();
    if(data.error)task.reject(Error(data.error==='wrong_wallet'?'This recovery phrase belongs to a different Monero address. Use the backup for the address shown above.':'Could not approve with this recovery phrase. Check all 25 words, or use the external wallet option.'));
    else task.resolve(data.result.signature);
  };
  return {
    sign(seed,review){
      if(disposed||pending)return Promise.reject(Error('Signing is already running or closed.'));
      return new Promise((resolve,rejectTask)=>{
        const id=crypto.randomUUID();
        const timer=setTimeout(()=>reject('Monero approval timed out. Please try again.'),60000);
        pending={id,timer,resolve,reject:rejectTask};worker.postMessage({id,action:'signBurn',seed,review});
      });
    },
    dispose(){reject('Monero approval closed.');},
  };
}
