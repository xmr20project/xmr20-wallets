import React,{useEffect,useRef,useState} from 'react';
import {moneroWalletVault} from './monero-wallet-vault.js';
import {localMoneroBackup} from './monero-local-backup.js';
export default function MoneroSendApproval({owner,address,provider,busy,onApprove}){
 const password=useRef(),alive=useRef(true),flight=useRef(false);useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(password.current)password.current.value='';};},[]);const[error,setError]=useState(''),[unlocking,setUnlocking]=useState(false);const context={owner,address,network:'mainnet'};
 let saved=false,legacy=false;try{saved=moneroWalletVault().has(context);legacy=localMoneroBackup().has(context);}catch{}
 async function approve(){if(flight.current||busy)return;flight.current=true;setUnlocking(true);setError('');let seed='';try{
  if(saved)seed=await moneroWalletVault().load(context,provider);
  else if(legacy){seed=await localMoneroBackup().load(context,password.current.value);password.current.value='';await moneroWalletVault().save(context,seed,provider);}
  else throw Error('No saved Monero key on this device. Import this wallet once, then approve future sends in your Solana wallet.');
  if(!alive.current)return;provider?.assertCurrent?.();if(provider?.publicKey?.toBase58()!==owner)throw Error('Wallet changed. Reconnect before sending.');await onApprove(seed);
 }catch(e){if(alive.current)setError(e.message||'Could not unlock your Monero wallet.');}finally{seed='';if(password.current)password.current.value='';flight.current=false;if(alive.current)setUnlocking(false);}}
 return <div className="monero-send-approval">{saved?<p>Approve in your connected Solana wallet to unlock and sign this Monero transfer on this device.</p>:legacy?<><p>Unlock your existing backup once to enable approval with your Solana wallet.</p><label>Backup password<input ref={password} type="password" autoComplete="off" disabled={busy||unlocking}/></label></>:<p role="status">This browser has no saved key for this Monero wallet. Import it once using “Import XMR wallet”, or sign with your external Monero wallet below. Future sends won’t ask for your recovery phrase.</p>}{(saved||legacy)&&<button type="button" disabled={busy||unlocking} onClick={approve}>{unlocking?'Waiting for wallet approval…':'Approve in Solana wallet'}</button>}{error&&<p className="form-error" role="alert">{error}</p>}</div>;
}
