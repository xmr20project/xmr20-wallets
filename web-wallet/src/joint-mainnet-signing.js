import {moneroWalletVault} from './monero-wallet-vault.js';
import {checkedOwnerReview} from '../../engine/shared/bridge-sdk/core-next/owner-signing.mjs';
export function oneShotJointWorker(action,args,{workerFactory=()=>new Worker('/wallet/joint-owner.worker.js'),signal}={}){
 if(!globalThis.isSecureContext)throw Error('Use the dedicated localhost wallet.');const worker=workerFactory(),id=crypto.randomUUID();let timer,done=false;
 return new Promise((resolve,reject)=>{const end=(error,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.terminate();error?reject(Error(error)):resolve(result);},abort=()=>end('Wallet panel closed. Reopen and check its saved receipt.');
 worker.onerror=e=>{e.preventDefault?.();end('Offline Monero approval could not load.');};worker.onmessage=({data})=>{if(data?.id!==id)return;end(data.error,data.result);};timer=setTimeout(()=>end('Monero approval timed out. Retry the saved action.'),60000);if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});worker.postMessage({id,action,...args});});
}
export function createSavedJointSigner({owner,address,provider,store,signal,onProgress=()=>{}}){
 return {address,async sign(review){const context=store.load();checkedOwnerReview(review,context);provider.assertCurrent?.();let seed='';try{seed=await moneroWalletVault().load({owner,network:'mainnet',address},provider,{onProgress});if(signal?.aborted)throw Error('Wallet panel closed.');const result=await oneShotJointWorker('sign-owner-record',{seed,review,context},{signal});return result.signature;}finally{seed='';}}};
}
export const jointSignatureVerifier={async verify(text,address,signature){return (await oneShotJointWorker('verify-owner-record',{text,address,signature})).good===true;}};
