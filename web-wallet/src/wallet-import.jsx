import {moneroWalletVault} from './monero-wallet-vault.js';
import React,{useEffect,useRef,useState} from 'react';
import {createMoneroGenerator} from './monero-wallet-client.js';
import {localMoneroBackup} from './monero-local-backup.js';
import {checkMoneroAddress} from '../shared/xmr20/address.js';
import {saveNativeRestoreHeight,nativeRestoreHeight,XMR20_MONERO_START} from '../../engine/monero/native-wallet-client.js';
export default function WalletImport({owner,provider,onImport,onClose}){
 const [mode,setMode]=useState('import'),[seed,setSeed]=useState(''),[address,setAddress]=useState(''),[height,setHeight]=useState(''),[backup,setBackup]=useState(false),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const client=useRef(null),alive=useRef(true),flight=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;client.current?.dispose();};},[]);
 async function submit(){if(flight.current)return;flight.current=true;setBusy(true);setError('');try{
  if(height!==''&&(!/^\d+$/.test(height)||!Number.isSafeInteger(Number(height))))throw Error('Enter a valid restore height, or 0.');
  let value=address.trim();
  if(mode==='import'){
   client.current=createMoneroGenerator();
   const result=await client.current.request('import',{network:'mainnet',seed:seed.trim(),...(value?{expectedAddress:value}:{})});
   if(!alive.current)return;value=result.address;
   if(!result.restored||result.network!=='mainnet')throw Error('Could not restore this wallet.');
   if(provider)await moneroWalletVault().save({owner,network:'mainnet',address:value},seed.trim().toLowerCase().replace(/\s+/g,' '),provider);
   if(backup)await localMoneroBackup().save({owner,network:'mainnet',address:value},seed.trim().toLowerCase().replace(/\s+/g,' '),password);
  }
  const valid=checkMoneroAddress(value,'mainnet');if(!valid.valid||valid.kind!=='standard')throw Error('Use a primary Monero mainnet address.');
  if(!alive.current)return;
  if(mode==='import'&&height!=='')saveNativeRestoreHeight(value,Number(height));
  await onImport({address:value,kind:mode==='import'?'imported':'watch'});
  if(alive.current){setSeed('');setPassword('');onClose();}
 }catch{if(alive.current)setError('Could not import this wallet. Check the 25-word Monero phrase, expected address and backup password, or use a valid primary address to view holdings. Your existing wallet is unchanged.');}finally{client.current?.dispose();client.current=null;flight.current=false;if(alive.current)setBusy(false);}}
 return <section className="wallet-import" aria-label="Import Monero wallet"><h3>Import XMR wallet</h3><label>Import method<select disabled={busy} value={mode} onChange={e=>{setMode(e.target.value);setSeed('');setPassword('');setError('');}}><option value="import">Restore with 25-word Monero phrase</option><option value="watch">View holdings with a public address</option></select></label>
 {mode==='import'&&<><p className="small">Checked on this device in an offline worker, never sent to the index or a node. Your Solana wallet saves an encrypted copy here, so later sends need its approval instead of these words.</p><label>25-word Monero recovery phrase<input type="password" autoComplete="off" spellCheck={false} maxLength={400} disabled={busy} value={seed} onChange={e=>setSeed(e.target.value)}/></label></>}
 <label>{mode==='import'?'Expected primary address (optional)':'Monero primary address'}<input autoComplete="off" spellCheck={false} maxLength={106} disabled={busy} value={address} onChange={e=>setAddress(e.target.value.trim())}/></label>
 {mode==='import'?<>{/* 28 Oct 2026 (owner): show the block the scan starts from: this wallet's saved creation height on this device, otherwise the XMR20 start. */}
 <details className="wallet-height"><summary><span className="wallet-height-text">Scan starts at block {(height!==''&&/^\d+$/.test(height)?Number(height):nativeRestoreHeight(address.trim())).toLocaleString()}{height===''&&<span> · {nativeRestoreHeight(address.trim())===XMR20_MONERO_START?'the XMR20 start':'saved on this device'}</span>}</span> <em>Change</em></summary><label>Restore height<input inputMode="numeric" placeholder={String(nativeRestoreHeight(address.trim()))} disabled={busy} value={height} onChange={e=>setHeight(e.target.value)}/></label><p className="small">Wallets created here remember their creation block. Otherwise the scan starts at the XMR20 start (28 September 2026). Enter an earlier block, or 0 for the full history, only if this wallet received XMR before then.</p></details><label><input type="checkbox" disabled={busy} checked={backup} onChange={e=>{setBackup(e.target.checked);setPassword('');}}/> Save an encrypted backup on this device (optional)</label>{backup&&<label>Backup password (at least 12 characters)<input type="password" autoComplete="new-password" minLength={12} maxLength={256} disabled={busy} value={password} onChange={e=>setPassword(e.target.value)}/></label>}<p className="small">25-word Monero phrases only. For other formats, view holdings by address and sign in your original wallet.</p></>:<p className="small">Address-only viewing shows public XMR20 holdings. It does not prove ownership, allow spending or reveal native XMR balances.</p>}
 {/* The action, Cancel and any error stay visible at the bottom of the panel while the form scrolls. */}
 <div className="wallet-form-actions">{error&&<p role="alert">{error}</p>}<button className="wallet-primary" disabled={busy||(mode==='import'?seed.trim().split(/\s+/).length!==25||backup&&password.length<12:!address)} onClick={submit}>{busy?'Checking on your device…':mode==='import'?'Import wallet':'View holdings'}</button><button disabled={busy} onClick={onClose}>Cancel</button></div></section>;
}
