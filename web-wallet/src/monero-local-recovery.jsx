import CopyRecoveryPhrase from './copy-recovery-phrase.jsx';
import React,{useEffect,useRef,useState} from 'react';
import {localMoneroBackup} from './monero-local-backup.js';
import {moneroWalletVault} from './monero-wallet-vault.js';
// 28 Oct 2026 (owner): a Monero wallet saved with the connected Solana wallet shows its recovery phrase after one approval in
// that wallet, like other wallets' export; a password backup (older wallets) still asks for its password.
export default function LocalMoneroRecovery({owner,network,address,provider}){
 const [open,setOpen]=useState(false),[password,setPassword]=useState(''),[seed,setSeed]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const alive=useRef(true),revision=useRef(0);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;revision.current++;};},[]);
 function close(){revision.current++;setOpen(false);setSeed('');setPassword('');setError('');setBusy(false);}
 useEffect(()=>{if(!seed)return;if(document.hidden){close();return;}const timer=setTimeout(close,60000);const hide=()=>{if(document.hidden)close();};document.addEventListener('visibilitychange',hide);return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',hide);};},[seed]);
 const context={owner,network,address};
 let saved=false,vaulted=false;try{saved=localMoneroBackup().has(context);}catch{}try{vaulted=Boolean(provider?.signMessage)&&moneroWalletVault().has(context);}catch{}
 if(!saved&&!vaulted)return null;
 async function unlock(){if(busy)return;const current=revision.current;setBusy(true);setError('');try{const value=vaulted?await moneroWalletVault().load(context,provider):await localMoneroBackup().load(context,password);if(alive.current&&revision.current===current){setSeed(value);setPassword('');}}catch(e){if(alive.current&&revision.current===current)setError(e.message);}finally{if(alive.current&&revision.current===current)setBusy(false);}}
 const phrase=seed&&<><ol className="xmr20-seed" aria-label="Recovery phrase">{seed.split(/\s+/).map((word,i)=><li key={i}>{word}</li>)}</ol><CopyRecoveryPhrase seed={seed}/><p className="small">Hides automatically after one minute or when this tab is hidden.</p></>;
 // The approval request is made from the click itself, so the wallet window opens straight away.
 if(vaulted)return <div className="monero-local-recovery">{!open?<button className="bevel" onClick={()=>{setOpen(true);void unlock();}}>Show recovery phrase</button>:<><p className="small">{seed?'Anyone with these 25 words can spend this wallet’s XMR and XMR20. Never share them or type them into a website.':busy?'Approve in your Solana wallet to show this Monero wallet’s recovery phrase…':'Approve in your Solana wallet to show this Monero wallet’s 25-word recovery phrase.'}</p>{phrase}{!seed&&!busy&&<button className="bevel" onClick={unlock}>Show recovery phrase</button>}{error&&<p role="alert" className="form-error">{error}</p>} <button className="bevel" onClick={close}>Hide</button></>}</div>;
 return <div className="monero-local-recovery">{!open?<button className="bevel" onClick={()=>setOpen(true)}>retrieve recovery phrase on this device</button>:<><p className="small">This encrypted backup is stored only in this browser. XMR20 cannot reset its password or recover it after browser data is cleared.</p>{seed?<><ol className="xmr20-seed" aria-label="Recovery phrase">{seed.split(/\s+/).map((word,i)=><li key={i}>{word}</li>)}</ol><CopyRecoveryPhrase seed={seed}/><p className="small">Hides automatically after one minute or when this tab is hidden.</p></>:<><label>Local backup password<input type="password" autoComplete="off" maxLength={256} value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="bevel" disabled={busy||!password} onClick={unlock}>{busy?'unlocking on your device…':'show recovery phrase'}</button></>}{error&&<p role="alert" className="form-error">{error}</p>} <button className="bevel" onClick={close}>hide and close</button></>}</div>;
}
