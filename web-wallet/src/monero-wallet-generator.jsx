import {moneroWalletVault} from './monero-wallet-vault.js';
import {captureNativeRestoreHeight,saveNativeRestoreHeight} from '../../engine/monero/native-wallet-client.js';
import React,{useEffect,useRef,useState} from 'react';
import {createMoneroGenerator} from './monero-wallet-client.js';
import {checkMoneroAddress} from '../shared/xmr20/address.js';
import WalletRecovery from './wallet-recovery.jsx';
import {localMoneroBackup} from './monero-local-backup.js';

export default function MoneroWalletGenerator({owner,provider,onAddress,onClose,onBeforeGenerate,network='stagenet',autoStart=false}){
 const started=useRef(false);
 const [restoreHeight,setRestoreHeight]=useState(0);
 const client=useRef(null),alive=useRef(true),running=useRef(false);
 const savedVault=useRef(null);
 const [saveStage,setSaveStage]=useState('');
 const [step,setStep]=useState('intro'),[address,setAddress]=useState(''),[seed,setSeed]=useState(''),[saveLocal,setSaveLocal]=useState(false),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;client.current?.dispose();};},[]);
 useEffect(()=>{if(!address)return;const warn=e=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[address]);
 async function run(fn){if(running.current)return;running.current=true;setBusy(true);setError('');try{await fn();}catch(e){if(alive.current)setError(['WALLET_SAVE','WALLET_LOOKUP','MONERO_HEIGHT_UNAVAILABLE','MONERO_HEIGHT_STORAGE'].includes(e.code)?e.message:step==='backup'?(e.code==='BACKUP_SAVE'?'Could not save the encrypted backup. Check the password and browser storage, then retry.':e.code==='WALLET_LINK'?'Could not link this wallet. Check your connection and sign-in, then retry. Your recovery phrase is still here.':'Could not finish wallet setup. Your recovery phrase is still here; please retry.'):'Could not create the wallet. Please close this panel and retry.');}finally{running.current=false;if(alive.current)setBusy(false);}}
 async function generate(){
  if(onBeforeGenerate){try{if(!await onBeforeGenerate())return;}catch(e){throw Object.assign(Error('Could not check your linked wallet. '+(e.status===401?'Reconnect your Solana wallet, then retry.':'The wallet service is temporarily unavailable. Please retry; no new wallet was created.')),{code:'WALLET_LOOKUP'});}}
  const birthHeight=network==='mainnet'?await captureNativeRestoreHeight():0;
  if(!alive.current)return;
  setRestoreHeight(birthHeight);
  client.current?.dispose();client.current=createMoneroGenerator();
  const r=await client.current.request('generate',{network});if(!alive.current)return;
  if(r.network!==network||!checkMoneroAddress(r.address,network).valid)throw Error();
  if(!saveNativeRestoreHeight(r.address,birthHeight)){const error=Error('Could not save the wallet creation height on this device. Check browser storage and retry.');error.code='MONERO_HEIGHT_STORAGE';throw error;}
  const revealed=await client.current.request('reveal');if(!alive.current)return;
  setAddress(r.address);setSeed(revealed.seed);setStep('backup');
 }
 useEffect(()=>{if(autoStart&&!started.current){started.current=true;void run(generate);}},[autoStart]);
 async function finish(){
  const context={owner,network,address},contextKey=JSON.stringify(context);
  const progress=stage=>{if(alive.current)setSaveStage(stage);};
  if(provider){try{
   if(savedVault.current?.contextKey!==contextKey||!savedVault.current.check(provider)){
    const check=await moneroWalletVault().save(context,seed,provider,{onProgress:progress});
    if(!check(provider))throw Error('The saved backup changed. Please retry.');
    savedVault.current={contextKey,check};
   }
  }catch(e){throw Object.assign(Error(e.message+' Your wallet has not been linked; keep this panel open and retry.'),{code:'WALLET_SAVE'});}}
  if(!alive.current)return;
  if(saveLocal){progress('backup');try{await localMoneroBackup().save(context,seed,password);}catch{throw Object.assign(Error(),{code:'BACKUP_SAVE'});}}
  if(!alive.current)return;
  if(client.current){
   const r=await client.current.request('finish');if(!alive.current)return;
   if(r.address!==address||r.network!==network)throw Error();
   client.current.dispose();client.current=null;
  }

  progress('linking');
  try{provider?.assertCurrent?.();await onAddress(address,{height:restoreHeight});}catch{throw Object.assign(Error(),{code:'WALLET_LINK'});}
  if(alive.current){setSeed('');setPassword('');}
 }
 if(step==='backup')return <WalletRecovery solanaBackup={!!provider} address={address} seed={seed} height={restoreHeight} saveLocal={saveLocal} password={password} busy={busy} saveStage={saveStage} error={error} onBackup={value=>{setSaveLocal(value);setPassword('');}} onPassword={setPassword} onFinish={()=>run(finish)} onBack={onClose}/>;
 return <section className="wallet-create-state" aria-label="Create a Monero wallet"><div className="wallet-setup-icon" aria-hidden="true">M</div><h3>{busy?'Creating your wallet…':'Create a Monero wallet'}</h3><p>Your recovery phrase is generated on this device.</p>{busy?<div className="wallet-loading-bar" role="status" aria-label="Creating wallet"/>:<button className="wallet-primary" onClick={()=>run(generate)}>Create a Monero wallet</button>}{error&&<p className="form-error" role="alert">{error}</p>}<button className="wallet-text-button" disabled={busy} onClick={onClose}>Back</button></section>;
}
