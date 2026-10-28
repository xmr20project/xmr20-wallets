import {checkedIdentityReview} from '../../engine/shared/bridge-sdk/core-universal-link/owner-signing.mjs';
import {moneroWalletVault} from './monero-wallet-vault.js';
import {checkedOwnerReview} from '../../engine/shared/bridge-sdk/core-transferable/owner-signing.mjs';
import {oneShotJointWorker} from './joint-mainnet-signing.js';

export function websiteBridgeProvider(provider,owner,assert){
 const check=()=>{assert();provider.assertCurrent?.();if(provider.publicKey?.toBase58()!==owner)throw Error('Wallet changed. Reconnect the original account.');};
 return {publicKey:{toBase58:()=>owner},assertCurrent:check,async signTransaction(tx){
  check();let signed;
  // Phantom supports sign-only batches. Keep this alternative confined to the
  // bridge, with one exact transaction and no second signing attempt on error.
  if(provider.kind==='phantom'&&typeof provider.signAllTransactions==='function'){
   const result=await provider.signAllTransactions([tx]);check();
   if(!Array.isArray(result)||result.length!==1||!result[0])throw Error('Your wallet returned an invalid transaction approval. Nothing was submitted.');
   signed=result[0];
  }else signed=await provider.signTransaction(tx);
  check();return signed;
 }};
}
export function websiteMoneroSigner({provider,owner,address,assert,worker=oneShotJointWorker,vault=moneroWalletVault()}){
 return async(review,context,signal,{onProgress=()=>{}}={})=>{
  assert();const identity=context?.schema==='wallet-identity-review-v1';
  if(identity)checkedIdentityReview(review,context);else checkedOwnerReview(review,context);
  if(context.config.owner!==owner||context.moneroOwner!==address)throw Error('Monero approval belongs to another linked account.');
  const progress=text=>{assert();if(signal.aborted)throw Error('Bridge closed. Your saved approvals are kept.');onProgress(text);};
  let seed='';try{seed=await vault.load({owner,network:'mainnet',address},provider,{onProgress:phase=>progress(phase==='approval'?'Open your connected wallet to unlock Monero signing…':'Unlocking your saved Monero wallet…')});assert();if(signal.aborted)throw Error('Bridge closed. Your saved approvals are kept.');progress('Signing your Monero record…');return await worker(identity?'sign-wallet-identity-v1':'sign-owner-record-v3',{seed,review,context},{signal,workerFactory:()=>new Worker('/wallet/monero-wallet/joint-transferable.worker.js')});}finally{seed='';}
 };
}
