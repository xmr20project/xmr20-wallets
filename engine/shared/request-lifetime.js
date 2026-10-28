export const UNSIGNED_REQUEST_MS=10*60*1000;

// Cancels local work only. A signed/submitted receipt is never removed here.
// Racing the signal releases UI/Web Locks even if a wallet prompt never replies.
export function untilClosed(promise,signal){
 if(signal.aborted)return Promise.reject(signal.reason);
 return new Promise((resolve,reject)=>{
  const stop=()=>reject(signal.reason);
  signal.addEventListener('abort',stop,{once:true});
  Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));
 });
}
export function requestLifetime({onExpire=()=>{},setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now}={}){
 const controller=new AbortController();let timer,deadline=Infinity,submitted=false;
 const expire=()=>{if(submitted||controller.signal.aborted)return;api.close('This unsigned request expired after 10 minutes. Start a new request.');onExpire();};
 const api={signal:controller.signal,
  assert(){if(now()>=deadline)expire();if(controller.signal.aborted)throw controller.signal.reason;},
  touch(){if(submitted||controller.signal.aborted)return;deadline=now()+UNSIGNED_REQUEST_MS;clearTimer(timer);timer=setTimer(expire,UNSIGNED_REQUEST_MS);timer?.unref?.();},
  // Once submitted, this session may wait for chain confirmations indefinitely.
  // Later button clicks and already-queued expiry callbacks must not expire it.
  submitted(){submitted=true;deadline=Infinity;clearTimer(timer);timer=null;},
  close(message='Request cancelled. Nothing further will be submitted.'){clearTimer(timer);controller.abort(Error(message));}
 };api.touch();return api;
}
