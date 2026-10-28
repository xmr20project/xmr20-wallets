import React,{useEffect,useRef,useState} from 'react';
import {createNativeConversionPage} from '../../engine/shared/native-conversion-page.js';
import {createNativeRedemptionPage} from '../../engine/shared/native-redemption-page.js';
import {createNativeSendPage} from '../../engine/shared/native-send-page.js';
import '../../engine/shared/native-send-page.css';
import './website-native-page.css';
import {fitWalletPanel} from './website-native-panel.js';
import {createNativeMarketWalletClient} from './native-market-client.js';
import {nativeRestoreHeight,saveNativeRestoreHeight} from '../../engine/monero/native-wallet-client.js';
import {NATIVE_MARKET_CONFIGURATION} from '../../engine/shared/website/native-market-config.js';
import {createWebsiteCustodySigner} from './website-custody-signer.js';
import {nativeWalletLockName,nativeWalletHeldElsewhere,OTHER_WINDOW_MESSAGE} from './website-native-lock.js';
import {saveNativeDisplay,nativeDisplay,recordNativeBridge} from './website-native-holdings.js';

const fmt=raw=>new Intl.NumberFormat('en-GB',{minimumFractionDigits:2,maximumFractionDigits:6}).format(Number(raw)/1e6);

// Setup marks are display-only; the bridge's own journal (encrypted, per Monero
// address) keeps the actual records. Same get/set shape as extension storage.
export const websiteSetupStore={
 async get(keys){const out={};for(const key of [].concat(keys)){try{const value=localStorage.getItem(key);if(value!==null)out[key]=JSON.parse(value);}catch{}}return out;},
 async set(values){for(const [key,value] of Object.entries(values))localStorage.setItem(key,JSON.stringify(value));}
};

// The extension's "Bridge to Monero", "Bridge to Solana" and Monero token "Send" pages,
// hosted in the website wallet. The linked Monero wallet comes from this browser's vault (unlocked with a Solana
// message signature); the connected Solana wallet approves custody for bridges to Monero.
// The page accepts only an inline image; read the same-origin catalog PNG into one.
async function tokenImageData(url){
 if(!/^https:\/\/xmr20\.org\/tweet-wallet\/assets\/[a-f0-9]{64}\.png$/.test(url)||new URL(url).origin!==globalThis.location?.origin)return null;
 const response=await fetch(url,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(8000)});
 const blob=await response.blob();if(!response.ok||!/^image\/(png|jpeg|webp)$/.test(blob.type)||blob.size>500000)return null;
 return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});
}
export default function WebsiteNativeBridge({mode='bridge',owner,provider,moneroAddress,token,image,onClose,createClient=createNativeMarketWalletClient,createSigner=createWebsiteCustodySigner,pageOptions={},redeemOptions={},sendOptions={},heldElsewhere=nativeWalletHeldElsewhere}){
 const host=useRef(null),wrap=useRef(null),close=useRef(onClose),[error,setError]=useState(''),[balance,setBalance]=useState(null),[attempt,setAttempt]=useState(0),[height,setHeight]=useState(()=>nativeRestoreHeight(moneroAddress));
 // 'bridge' = to Monero, 'redeem' = to Solana (the page's ⇅ switch flips these on the same unlocked
 // wallet), 'send' = Monero tokens to another Monero address.
 const [direction,setDirection]=useState(['redeem','send'].includes(mode)?mode:'bridge'),[session,setSession]=useState(null);
 close.current=onClose;
 useEffect(()=>fitWalletPanel(wrap.current),[]);
 useEffect(()=>{
  if(!height)return;
  let live=true,base=null;const listeners=new Set();setError('');setSession(null);
  const assertCurrent=()=>{if(!live)throw Error('Bridge closed.');provider?.assertCurrent?.();if(provider?.publicKey?.toBase58?.()!==owner)throw Error('Wallet changed. Reconnect before continuing.');};
  const account={solana:owner,monero:moneroAddress};
  (async()=>{
   try{
    // Another xmr20.org tab or window holding this wallet is reported before any wallet prompt.
    const genesis=NATIVE_MARKET_CONFIGURATION?.chainGenesis;
    if(genesis&&await heldElsewhere(await nativeWalletLockName({genesis,address:moneroAddress})))throw Error(OTHER_WINDOW_MESSAGE);
    if(!live)return;
    base=createClient({context:{owner,network:'mainnet',address:moneroAddress,restoreHeight:height},provider,assertCurrent,
     onProgress:value=>{for(const listener of listeners)listener(value);}});
    // A page closed by the direction switch may still be finishing one wallet operation;
    // the next page starts once it has (the engine runs one operation at a time).
    let running=0;const idle=[];
    const track=fn=>async(...args)=>{running++;try{return await fn(...args);}finally{if(!--running)idle.splice(0).forEach(done=>done());}};
    const settled=()=>running?new Promise(done=>idle.push(done)):Promise.resolve();
    // Like the extension: after a completed private sync, an inventory read saves the
    // Monero tab's display summary. Display only; the engine rescans before any transfer.
    let checkpoint=null;
    const outgoing=(value,to)=>{try{recordNativeBridge(moneroAddress,{preparationId:(to==='solana'?'solana:':'send:')+value.txid,amountRaw:String(value.quantity),txid:value.txid,stage:'sending',to});}catch{}return value;};
    const client=Object.freeze({...Object.fromEntries(Object.entries(base).map(([key,value])=>[key,typeof value==='function'&&!['subscribeProgress','isDisposed','dispose'].includes(key)?track(value):value])),
     subscribeProgress(listener){listeners.add(listener);return()=>listeners.delete(listener);},
     sync:track(async()=>{const result=await base.sync();if(result?.ready)checkpoint=result;return result;}),
     inventory:track(async()=>{const rows=await base.inventory();try{if(checkpoint)saveNativeDisplay({address:moneroAddress,inventory:rows,checkpoint});}catch{}return rows;}),
      // New bridges to Solana and sends show on the Monero tab until their Monero transaction confirms.
     assembleRedemption:track(async args=>outgoing(await base.assembleRedemption(args),'solana')),
     assemblePeerSend:track(async args=>outgoing(await base.assemblePeerSend(args),'address'))});
    const capability=await client.capabilities();assertCurrent();
    if(!capability?.available)throw Error(capability?.reason||'The Monero wallet is unavailable in this browser.');
    if(mode==='balance'){
     // Read-only: unlock, sync and read this wallet's native tokens. Nothing is signed or sent.
     setBalance({text:'Unlocking your Monero wallet…'});
     const off=client.subscribeProgress(value=>{if(live&&typeof value==='string')setBalance({text:value});});
     try{
      await client.unlock();assertCurrent();let result;
      do{result=await client.sync();assertCurrent();if(!result.ready)setBalance({text:'Syncing Monero history · block '+result.height+' of '+result.targetHeight});}while(!result.ready);
      setBalance({text:'Reading your tokens…'});await client.inventory();assertCurrent();
      if(live)setBalance({done:true,display:nativeDisplay(moneroAddress)});
     }finally{off();}
     return;
    }
    if(live)setSession({client,account,assertCurrent,settled,busy:()=>running>0,sign:createSigner({provider,account}),image:image?tokenImageData(image).catch(()=>null):Promise.resolve(null)});
   }catch(e){if(live)setError(e.message||'The bridge could not open.');}
  })();
  const changed=()=>close.current();provider?.on?.('accountChanged',changed);provider?.on?.('disconnect',changed);
  return()=>{live=false;base?.dispose?.();provider?.removeListener?.('accountChanged',changed);provider?.removeListener?.('disconnect',changed);};
 },[mode,owner,provider,moneroAddress,height,attempt]);
 useEffect(()=>{
  if(!session)return;
  let live=true,page=null;
  (async()=>{
   try{
    if(session.busy()&&host.current){const main=document.createElement('main'),note=document.createElement('p');main.id='native-send';note.className='native-send-message';note.setAttribute('role','status');
     note.textContent='Finishing the current Monero wallet step…';main.append(note);host.current.replaceChildren(main);}
    await session.settled();if(!live)return;
    const {client,account,assertCurrent,sign}=session,onSwitch=()=>{if(live)setDirection(d=>d==='redeem'?'bridge':'redeem');};
    const common={client,account,assertCurrent,token,container:host.current,onClose:()=>close.current(),onSwitch};
    // A failed signing attempt reopens with a fresh wallet session, which lists the saved record.
    page=direction==='send'?createNativeSendPage({...common,onReopen:()=>setAttempt(n=>n+1),...sendOptions})
     :direction==='redeem'?createNativeRedemptionPage({...common,onReopen:()=>setAttempt(n=>n+1),...redeemOptions})
     :createNativeConversionPage({...common,signCustody:args=>sign({...args,assertCurrent}),setupStore:websiteSetupStore,resumeFrom:'Open new bridge → Saved entries',
      onBridgeState:state=>recordNativeBridge(moneroAddress,state),...pageOptions});
    page.open();
    void session.image.then(data=>{if(live&&data)page.setTokenImage(data);});
    // The page draws after the wallet check; bring it into view once it exists.
    requestAnimationFrame(()=>{if(live)wrap.current?.scrollIntoView?.({block:'start',behavior:'smooth'});});
   }catch(e){if(live)setError(e.message||'The bridge could not open.');}
  })();
  return()=>{live=false;page?.close();};
 },[session,direction]);
 const symbol=token?.symbol||'XMR20',title=mode==='balance'?'Previously bridged tokens':direction==='send'?'Send $'+symbol:direction==='redeem'?'Bridge to Solana':'Bridge to Monero';
 if(!height)return <div ref={wrap} className="website-native-page native-popup-root native-send-window"><StartHeight address={moneroAddress} onBack={()=>close.current()} onSave={setHeight}/></div>;
 return <div ref={wrap} className="website-native-page native-popup-root native-send-window">
  {error?<main id="native-send"><div className="native-send-head"><h1>{title}</h1><button type="button" onClick={()=>close.current()}>Back</button></div>
   <p className="native-send-error" role="alert">{error}</p>
   <div className="native-send-actions"><button type="button" className="native-secondary" onClick={()=>close.current()}>Cancel</button><button type="button" className="native-primary" onClick={()=>setAttempt(n=>n+1)}>Try again</button></div></main>
  :mode==='balance'?<main id="native-send"><div className="native-send-head"><h1>{title}</h1><button type="button" onClick={()=>close.current()}>Back</button></div>
   {balance?.done?<>{balance.display&&BigInt(balance.display.amountRaw)>0n
     ?<p className="native-send-review-amount">{fmt(balance.display.amountRaw)} {symbol}</p>
     :<p className="native-send-review-amount">No bridged tokens found</p>}
    <p className="native-send-help">Read from your Monero wallet in this browser. Bridges still on their way show separately until they arrive.</p>
    <div className="native-send-actions"><button type="button" className="native-primary" onClick={()=>close.current()}>Done</button></div></>
   :<><p className="native-send-help">Reading your Monero wallet in this browser. Nothing is signed or sent.</p>
    <p className="native-send-message" role="status">{balance?.text||'Starting…'}</p>
    <div className="native-send-actions"><button type="button" className="native-secondary" onClick={()=>close.current()}>Cancel</button></div></>}
  </main>:<div ref={host}/>}
  {mode!=='balance'&&<p className="website-native-note">Don’t use this Monero wallet in the XMR20 extension at the same time.</p>}
 </div>;
}

// Wallets with no saved height start at the XMR20 start (nativeRestoreHeight). This screen is reached only
// when a height of 0 was saved explicitly; the token's launch block is suggested because no bridge record is older.
function StartHeight({address,onBack,onSave}){
 const launch=Number(NATIVE_MARKET_CONFIGURATION?.manifest?.height??0),[value,setValue]=useState(launch?String(launch):''),[error,setError]=useState('');
 const save=()=>{const height=Number(value);if(!/^\d{1,7}$/.test(value)||height<1||height>=8000000){setError('Enter a block height, for example '+launch+'.');return;}
  if(!saveNativeRestoreHeight(address,height)){setError('This browser could not save the height. Check site storage and retry.');return;}onSave(height);};
 return <main id="native-send"><div className="native-send-head"><h1>Monero wallet start</h1><button type="button" onClick={onBack}>Back</button></div>
  <p className="native-send-help">Enter the block height when this Monero wallet was created. The bridge scans your wallet from there; an earlier height takes longer.</p>
  <label className="native-send-label" htmlFor="native-start-height">Start height</label>
  <input id="native-start-height" inputMode="numeric" autoComplete="off" value={value} onChange={e=>{setValue(e.target.value.trim());setError('');}}/>
  <p className="native-send-help">Not sure? Keep {launch||'the suggested height'}, when this token launched. XMR you received before it won’t count toward the small network fee.</p>
  {error&&<p className="native-send-error" role="alert">{error}</p>}
  <div className="native-send-actions"><button type="button" className="native-secondary" onClick={onBack}>Cancel</button><button type="button" className="native-primary" onClick={save}>Continue</button></div>
 </main>;
}
