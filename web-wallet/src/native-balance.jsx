import React,{useEffect,useRef,useState} from 'react';
import {localMoneroBackup} from './monero-local-backup.js';
import {MONERO_NODES,XMR20_MONERO_START,nativeRestoreHeight,savedNativeRestoreHeight,saveNativeRestoreHeight,createNativeBalanceClient} from '../../engine/monero/native-wallet-client.js';
import {openWebsitePrivateWallet,closeWebsitePrivateWallet,setWebsiteNativeWallet,clearWebsiteNativeWallet} from './private-wallet-host.js';
import {sitePath} from './site-path.js';
import {ArrowUpRight,Split} from 'lucide-react';
import {moneroWalletVault} from './monero-wallet-vault.js';
import {createNativeScanCache} from '../../engine/token/native-scan-cache.js';
import WebsiteXmrSend from './website-xmr-send.jsx';
import WebsiteXmrSplit from './website-xmr-split.jsx';
// Saved XMR scan progress (the library-encrypted wallet cache), per wallet and starting block, as in the extension.
const scanCache=createNativeScanCache();
const scanKey=(owner,address,height)=>'web:'+owner+':'+address+':'+height;
const amount=s=>{const n=BigInt(s);return `${n/1000000000000n}.${String(n%1000000000000n).padStart(12,'0')}`.replace(/\.?0+$/,'')||'0';};
// 26 Oct 2026: incoming XMR not spendable yet (scanner summary v1): still in the transaction pool, or in a block with
// fewer than 10 confirmations. Change from this wallet's own sends is not included.
function receiving(b){
 const i=b?.incoming;if(!i||!(i.count>0))return null;let pending=0n,confirming=0n;
 try{pending=BigInt(i.pendingRaw||'0');confirming=BigInt(i.confirmingRaw||'0');}catch{return null;}
 if(pending+confirming<=0n)return null;const n=Number.isSafeInteger(i.minConfirmations)?Math.max(0,Math.min(i.minConfirmations,9)):0;
 return {amount:'+'+amount(String(pending+confirming))+' XMR',status:pending>0n?'waiting for its first confirmation, usually about 2 minutes':n+' of 10 confirmations · spendable in about '+((10-n)*2)+' min'};
}
// 28 Oct 2026 (owner: bought XMR, "it says i have no xmr to send"): XMR not spendable yet is shown even when the scanner's
// incoming summary is absent: the balance minus the unlocked balance is still confirming (new XMR, or change from a send).
// Local preview only (import.meta.env.DEV; removed from builds): reports coin-check outcomes to the local dev server for
// debugging. Balances and error codes only, never keys, addresses or transaction ids.
export const localDiag=row=>{if(import.meta.env.DEV)void fetch('/__xmr20-diag',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({at:new Date().toISOString(),...row})}).catch(()=>{});};
function confirming(b){
 const r=receiving(b);if(r)return {label:'Receiving',...r};
 // 28 Oct 2026 (owner, after a Send XMR: "it now says my remaining balance … is confirming? i think thats the wrong message"):
 // when the scanner's incoming summary is there and nothing is arriving, the locked XMR is change from this wallet's own
 // transaction (a send, the 3-coin split or an XMR20 carrier); Monero keeps change for 10 blocks too.
 try{const locked=BigInt(b?.balanceRaw??'0')-BigInt(b?.unlockedRaw??'0');if(locked>0n)return b?.incoming?{label:'Change',amount:amount(String(locked))+' XMR',status:'from your own transaction, spendable after 10 confirmations, about 20 minutes'}:{label:'Confirming',amount:amount(String(locked))+' XMR',status:'spendable after 10 confirmations, about 20 minutes'};}catch{}
 return null;
}
export default function NativeBalance({owner,address,provider,workerPath=sitePath('/monero-native/native.worker.js')}){
 const [node,setNode]=useState(MONERO_NODES[0].url),[seed,setSeed]=useState(''),[password,setPassword]=useState(''),[height,setHeight]=useState(()=>String(nativeRestoreHeight(address))),[balance,setBalance]=useState(null),[opened,setOpened]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState(null),[form,setForm]=useState(false);
 const client=useRef(null),revision=useRef(0),context={owner,network:'mainnet',address};
 // 28 Oct 2026 (owner): tapping the Monero row (or its logo) or Send opens Send XMR, Split opens Split XMR; a locked wallet
 // unlocks first, then that page opens.
 const [sending,setSending]=useState(false),[splitting,setSplitting]=useState(false),[afterUnlock,setAfterUnlock]=useState(null),reviewingRef=useRef(false);
 let backedUp=false;try{backedUp=localMoneroBackup().has(context);}catch{}
 const [useBackup,setUseBackup]=useState(backedUp);
 function lock(){closeWebsitePrivateWallet();setSending(false);setSplitting(false);setAfterUnlock(null);revision.current++;client.current?.dispose();client.current=null;setSeed('');setPassword('');setOpened(false);setBusy(false);setBalance(null);setProgress(null);}
 // Leaving the Monero tab keeps the XMR20 token wallet open (Bridge on the Solana tab uses it); the wallet closes after 5 minutes
 // in a hidden tab (28 Oct 2026, owner: no Lock button on the row).
 useEffect(()=>()=>{revision.current++;client.current?.dispose();},[owner,address]);
 useEffect(()=>{let timer;const hide=()=>{clearTimeout(timer);if(document.hidden)timer=setTimeout(lock,300000);};document.addEventListener('visibilitychange',hide);return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',hide);};},[]);
 // While unlocked and visible, check for incoming XMR once a minute (a short catch-up scan).
 const syncRef=useRef(null);
 useEffect(()=>{if(!opened)return;const timer=setInterval(()=>{if(!document.hidden&&!reviewingRef.current)void syncRef.current?.({quiet:true});},60000);return()=>clearInterval(timer);},[opened]);
 async function sync(options){const quiet=options?.quiet===true;if(busy||!client.current)return;const current=revision.current;setBusy(true);if(!quiet){setError('');setBalance(null);setProgress({phase:'syncing'});}try{const b=await client.current.sync(node);if(current===revision.current){setBalance(b);setProgress(null);}}catch(e){if(current===revision.current&&!quiet)setError(e.message);}finally{if(current===revision.current)setBusy(false);}}
 syncRef.current=sync;
 // 28 Oct 2026 (owner): a wallet saved with the connected Solana wallet (created here, or imported with it) unlocks with one
 // wallet approval; the phrase or backup form is only the fallback.
 let vaulted=false;try{vaulted=Boolean(provider?.signMessage)&&moneroWalletVault().has(context);}catch{}
 // remember: after a phrase or backup unlock, save the phrase with the connected Solana wallet (one approval) so later syncs
 // only need that wallet's approval (28 Oct 2026, owner). Skipped when already saved or the wallet cannot sign messages.
 async function openWith(getPhrase,{remember=false}={}){if(busy)return;const current=++revision.current;setBusy(true);setError('');setBalance(null);try{
  if(!/^\d+$/.test(height)||!Number.isSafeInteger(Number(height)))throw Error('Enter a valid restore height.');
  let phrase=await getPhrase();if(current!==revision.current){phrase='';return;}setSeed('');setPassword('');
  let toSave=remember&&!vaulted&&provider?.signMessage?phrase:'';
  // 28 Oct 2026 (owner): XMR and XMR20 on Monero sync together. The token engine opens with the same phrase (local build).
  if(provider?.signTransaction)openWebsitePrivateWallet({owner,address,seed:phrase,height,provider});
  const key=scanKey(owner,address,Number(height)),saved=await scanCache.load(key);
  client.current?.dispose();client.current=createNativeBalanceClient({workerFactory:()=>new Worker(workerPath),onProgress:p=>{if(current===revision.current)setProgress(p);},onCheckpoint:cp=>{if(cp?.cache instanceof Uint8Array&&cp.cache.length)void scanCache.save(key,cp.cache,{height:cp.height});}});
  const opening=client.current.open({seed:phrase,address,restoreHeight:Number(height),node,cache:saved?.cache||null});phrase='';const opened=await opening;
  // The worker has checked the phrase against this address; save it now, before the (possibly long) sync.
  // 28 Oct 2026 (owner: "it should only require seed phrase when importing the wallet"): a declined or failed save is said,
  // not swallowed, so it is clear why the next Sync would ask for the phrase again.
  let saveNote='';
  if(toSave&&current===revision.current){setProgress({phase:'approval'});try{await moneroWalletVault().save(context,toSave,provider);}catch{saveNote='This browser did not save the wallet: the approval in your Solana wallet was declined or did not finish, so the next Sync asks for the phrase again.';}finally{toSave='';}if(current===revision.current)setProgress({phase:'syncing'});}toSave='';
  if(opened?.cacheRejected)void scanCache.clear(key);
  if(current!==revision.current)return;setOpened(true);setForm(false);setProgress({phase:'syncing'});if(saveNote)setError(saveNote);
  // 28 Oct 2026 (owner: "let them choose that as default"): a start block chosen under Change is kept for this wallet on this
  // browser once the phrase has opened it, so later syncs start there too.
  if(Number(height)!==nativeRestoreHeight(address))saveNativeRestoreHeight(address,Number(height));
  let b=await client.current.sync(node);if(current===revision.current){setBalance(b);setProgress(null);}
  // 28 Oct 2026: once per unlock, the worker's local coin check (no transaction lookups at the node) releases XMR20 carrier
  // change that an earlier guard froze and keeps XN1 carriers protected; the balance is then re-read.
  const before={balanceRaw:b?.balanceRaw,unlockedRaw:b?.unlockedRaw};
  try{await client.current.checkCarriers({node,carrierLookup:'local'});b=await client.current.sync(node);if(current===revision.current)setBalance(b);localDiag({phase:'unlock-coin-check',ok:true,before,after:{balanceRaw:b?.balanceRaw,unlockedRaw:b?.unlockedRaw}});}
  catch(e){localDiag({phase:'unlock-coin-check',ok:false,code:e?.code||null,message:String(e?.message||e).slice(0,200),before});}
 }catch(e){if(current===revision.current)setError(e.message);}finally{if(current===revision.current)setBusy(false);}}
 const unlock=()=>openWith(()=>useBackup?localMoneroBackup().load(context,password):Promise.resolve(seed.trim()),{remember:true});
 // The approval request is made from the click itself, before any network wait, so the wallet window opens straight away.
 const unlockWithWallet=()=>openWith(()=>{setProgress({phase:'approval'});return moneroWalletVault().load(context,provider);});
 useEffect(()=>{if(afterUnlock&&opened&&balance){setAfterUnlock(null);(afterUnlock==='split'?setSplitting:setSending)(true);}else if(afterUnlock&&!busy&&!opened&&!form)setAfterUnlock(null);},[afterUnlock,opened,balance,busy,form]);
 function openPage(page){const show=page==='split'?setSplitting:setSending;if(opened&&client.current?.alive){show(true);return;}if(busy)return;setAfterUnlock(page);if(vaulted)void unlockWithWallet();else setForm(true);}
 const openSend=()=>openPage('send');
 // 28 Oct 2026 (owner): one Monero row at the top of the Monero tab, as in the extension: the XMR balance, its status and
 // Sync, which also syncs XMR20 on Monero. The unlock form opens under the row.
 const scanFrom=Number(height)||0,pct=progress?.height&&progress?.target?Math.max(0,Math.min(99,Math.round((progress.height-scanFrom)/Math.max(1,progress.target-scanFrom)*100))):null;
 const status=busy&&progress?.phase==='approval'?'Approve in your Solana wallet…':busy?(pct!==null?`Syncing · ${pct}%`:'Syncing…'):balance?(confirming(balance)?confirming(balance).label+' '+confirming(balance).amount:'Last synced '+new Date(balance.updatedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})):opened?'Balance unavailable':'Sync to see XMR and XMR20';
 useEffect(()=>{const update=e=>{if(e.detail?.address===address&&!busy)setHeight(String(e.detail.height));};window.addEventListener('xmr20-start-block',update);return()=>window.removeEventListener('xmr20-start-block',update);},[address,busy]);
 // Send syncs first (as the extension does before building a transaction), so its balance and confirmations are current.
 const syncNow=async()=>{const c=client.current,current=revision.current;if(!c)throw Error('Monero wallet is locked.');const b=await c.sync(node);if(current===revision.current)setBalance(b);return b;};
 // The token screen's "Enable private transfers" uses this unlocked wallet (see private-wallet-host.js).
 const syncNowRef=useRef(syncNow);syncNowRef.current=syncNow;
 useEffect(()=>{const c=client.current;if(!opened||!c)return;setWebsiteNativeWallet({address,client:c,node,syncNow:()=>syncNowRef.current()});return()=>clearWebsiteNativeWallet(c);},[opened,address,node]);
 if(splitting&&opened&&client.current)return <WebsiteXmrSplit client={client.current} node={node} balance={balance} syncNow={syncNow} onReviewing={v=>{reviewingRef.current=v;}} onSent={()=>void sync({quiet:true})} onClose={()=>{reviewingRef.current=false;setSplitting(false);}}/>;
 if(sending&&opened&&client.current)return <WebsiteXmrSend client={client.current} address={address} node={node} balance={balance} syncNow={syncNow} onReviewing={v=>{reviewingRef.current=v;}} onSent={()=>void sync({quiet:true})} onClose={()=>{reviewingRef.current=false;setSending(false);}}/>;
 return <section className="native-wallet wallet-coin" aria-label="Monero balance">
 <div className="wallet-asset wallet-coin-row wallet-coin-send" role="button" tabIndex={0} aria-label="Send XMR" title="Send XMR" onClick={e=>{if(!e.target.closest('button'))openSend();}} onKeyDown={e=>{if((e.key==='Enter'||e.key===' ')&&e.target===e.currentTarget){e.preventDefault();openSend();}}}><div className="wallet-asset-icon wallet-coin-icon"><img src={sitePath('/brand/monero-user.png')} alt=""/></div>
  <div className="wallet-asset-info"><strong>Monero</strong><small role="status" title={balance&&confirming(balance)?`${confirming(balance).label} ${confirming(balance).amount} · ${confirming(balance).status}`:undefined}>{status}</small></div>
  <div className="wallet-coin-value"><strong>{balance?`${amount(balance.balanceRaw)} XMR`:'— XMR'}</strong>{balance&&<small>{amount(balance.unlockedRaw)} unlocked</small>}</div>
  {!opened&&!form&&!busy&&<button type="button" className="wallet-coin-sync" onClick={()=>vaulted?void unlockWithWallet():setForm(true)}>Sync</button>}
  {opened&&<button type="button" className="wallet-coin-sync" aria-label="Refresh XMR" title="Refresh XMR" disabled={busy} onClick={sync}>↻</button>}
 </div>
 {/* 28 Oct 2026 (owner): Send and Split under the Monero row, in the Solana tab's tile style (hidden while the unlock form is open). */}
 {!form&&<div className="wallet-actions-row wallet-coin-actions"><button type="button" className="wallet-tile wallet-primary" onClick={()=>openPage('send')}><ArrowUpRight aria-hidden="true"/><span>Send</span></button><button type="button" className="wallet-tile wallet-secondary" onClick={()=>openPage('split')}><Split aria-hidden="true"/><span>Split</span></button></div>}
 {/* 28 Oct 2026 (owner): no line under the Monero box; the row's own status shows it, and its full text on hover. */}
 {vaulted&&error&&!form&&!opened&&<button type="button" className="wallet-coin-lock" onClick={()=>{setError('');setForm(true);}}>Use recovery phrase or backup instead</button>}
 {progress&&busy&&!form&&progress.phase!=='approval'&&<p role="status" className="small">{progress.height?`Scanning block ${progress.height.toLocaleString()} of ${progress.target.toLocaleString()}`:'Checking wallet history… The first sync can take time.'}</p>}
 {form&&!opened&&<div className="native-unlock">{backedUp&&<label><input type="checkbox" checked={useBackup} disabled={busy} onChange={e=>{setUseBackup(e.target.checked);setSeed('');setPassword('');}}/> Use this device’s encrypted backup</label>}{useBackup?<label>Backup password<input type="password" autoComplete="off" value={password} disabled={busy} onChange={e=>setPassword(e.target.value)}/></label>:<label>Monero recovery phrase<input type="password" autoComplete="off" spellCheck={false} maxLength={400} value={seed} disabled={busy} onChange={e=>setSeed(e.target.value)}/></label>}
  <details className="wallet-height"><summary><span className="wallet-height-text">Scan starts at block {scanFrom.toLocaleString()}{scanFrom===XMR20_MONERO_START?<span> · the XMR20 start</span>:scanFrom===savedNativeRestoreHeight(address)?<span> · this wallet’s creation block</span>:null}</span> <em>Change</em></summary><label>Restore height<input inputMode="numeric" value={height} disabled={busy} onChange={e=>setHeight(e.target.value)}/></label><p className="small">New wallets save their creation height with a 20-block safety margin. Only change this if you know your original wallet’s restore height; a later block can miss deposits. Use 0 to scan all history.</p><label>Remote node<select disabled={busy} value={node} onChange={e=>{setNode(e.target.value);setBalance(null);}}>{MONERO_NODES.map(n=><option value={n.url} key={n.url}>{n.name}</option>)}</select></label></details>
  {progress&&busy&&<p role="status" className="small">{progress.height?`Scanning block ${progress.height.toLocaleString()} of ${progress.target.toLocaleString()}`:'Checking wallet history… The first sync can take time.'}</p>}
  <p className="small">{provider?.signMessage?'Needed only once on this browser. After it syncs, approve saving it in your Solana wallet: it is kept encrypted here, and later syncs only ask that wallet to approve.':'Neither your phrase nor backup password is stored by this sync session.'}</p>
  <div className="wallet-form-actions">{error&&<p role="alert">{error}</p>}<button type="button" className="wallet-primary" disabled={busy||!(useBackup?password:seed)} onClick={unlock}>{busy?'Unlocking & syncing…':'Unlock and sync'}</button><button type="button" disabled={busy} onClick={()=>{setForm(false);setError('');}}>Cancel</button></div></div>}
{error&&!form&&<p role="alert" className="form-error">{error}</p>}</section>;
}
