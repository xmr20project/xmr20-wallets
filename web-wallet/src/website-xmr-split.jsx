import React,{useEffect,useRef,useState} from 'react';
import '../../engine/shared/native-send-page.css';
import './website-native-page.css';
import './website-xmr-split.css';
import {fitWalletPanel} from './website-native-panel.js';

// 28 Oct 2026 (owner: "the "split" button should be to split the monero balance into smaller amounts, so that they can be used
// for private transfers … from 2 to 20 slots (or however many they are able to) but require a minimum balance"; "to allow people
// to use their monero balance for multiple smaller transactions at once, rather than waiting 10 confirmations").
// One transaction to this wallet's own address: coins-1 equal payments plus the change. The worker's `prepareSplit` builds it
// behind its XMR20 coin guard without relaying it; `relay` sends only that reviewed transaction. Monero allows 16 outputs per
// transaction, so 16 coins is the most one split can make; each coin needs at least 0.0002 XMR (the worker refuses less).
const MIN_COIN=200000000n,MAX_COINS=16,MAX_FEE=500000000n;// 0.0002 XMR per coin; refuse a fee above 0.0005 XMR
const xmr=raw=>{const n=BigInt(raw),f=String(n%1000000000000n).padStart(12,'0').replace(/0+$/,'');return String(n/1000000000000n)+(f?'.'+f:'');};
const short=raw=>{const n=BigInt(raw),f=String(n%1000000000000n).padStart(12,'0').slice(0,6).replace(/0+$/,'');return String(n/1000000000000n)+(f?'.'+f:'');};
const CARRIER_CHECK='Check your coins before splitting to protect any XMR20 tokens. This shares their transaction IDs with your selected Monero node; nothing is sent.';

export default function WebsiteXmrSplit({client,node,balance,syncNow,onReviewing,onSent,onClose}){
 const wrap=useRef(null),alive=useRef(true);
 const unlocked=(()=>{try{return BigInt(balance?.unlockedRaw??'0');}catch{return 0n;}})();
 const locked=(()=>{try{const n=BigInt(balance?.balanceRaw??'0')-unlocked;return n>0n?n:0n;}catch{return 0n;}})();
 const most=Number(unlocked/MIN_COIN>BigInt(MAX_COINS)?BigInt(MAX_COINS):unlocked/MIN_COIN);
 const [coins,setCoins]=useState(()=>Math.max(2,Math.min(most,4))),[step,setStep]=useState('form'),[review,setReview]=useState(null),[result,setResult]=useState(null);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[carrierRetry,setCarrierRetry]=useState(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>fitWalletPanel(wrap.current),[]);
 useEffect(()=>{onReviewing?.(step==='review');return()=>onReviewing?.(false);},[step]);
 // A sync can lower the unlocked balance: keep the choice within what it can make now.
 useEffect(()=>{if(most>=2&&coins>most)setCoins(most);},[most]);
 const canSplit=most>=2,each=canSplit?unlocked/BigInt(coins):0n;
 async function run(work){
  if(busy)return;setBusy(true);setError('');setCarrierRetry(null);
  try{await work();}
  catch(e){if(!alive.current)return;if(e?.code==='carrier-check-unavailable'){setCarrierRetry(()=>work);setError(CARRIER_CHECK);}else setError(e?.message||'This split could not continue. Nothing was sent.');setMessage('');}
  finally{if(alive.current)setBusy(false);}
 }
 // Sync first so the unlocked balance is current, then build the reviewed transaction.
 const prepareReview=()=>run(async()=>{
  setMessage('Syncing your Monero wallet…');if(syncNow)await syncNow();if(!alive.current)return;
  setMessage('Building the transaction for review…');
  const r=await client.prepareSplit({node,coins,carrierLookup:'local'});if(!alive.current)return;
  if(r.coins!==coins){void client.cancel().catch(()=>{});throw Error('The reviewed split does not match your choice. Nothing was sent.');}
  if(BigInt(r.feeRaw)>MAX_FEE){void client.cancel().catch(()=>{});throw Error('The Monero fee exceeds 0.0005 XMR. Nothing was sent; try again later.');}
  setReview(r);setStep('review');setMessage('');
 });
 const checkCoins=()=>{const retry=carrierRetry;void run(async()=>{
  setMessage('Checking which coins are safe to spend…');await client.checkCarriers({node,carrierLookup:'node'});if(!alive.current)return;
  setMessage('Coins checked.');if(retry)await retry();
 });};
 const split=()=>run(async()=>{
  if(!review||Date.now()>=review.expires){setStep('form');setReview(null);throw Error('This review expired. Review the split again; nothing was sent.');}
  setMessage('Sending to your own address…');
  try{const sent=await client.relay({reviewId:review.id,node});if(!alive.current)return;setResult({...review,hash:sent?.hash||review.hash});setStep('done');setMessage('');onSent?.();}
  catch(e){if(e?.code==='xmr-not-submitted'){setStep('form');setReview(null);}else if(alive.current){setResult({...review,uncertain:true});setStep('done');}throw e;}
 });
 const back=()=>{if(step==='review'){void client.cancel().catch(()=>{});setStep('form');setReview(null);setMessage('');setError('');}else onClose();};
 const need='You need at least '+short(String(MIN_COIN*2n))+' unlocked XMR to split (0.0002 XMR per coin).';
 return <div ref={wrap} className="website-native-page native-popup-root native-send-window"><div><main id="native-send" className="xmr-split">
  <div className="native-send-head"><h1>Split XMR</h1><button type="button" disabled={busy&&step==='review'} onClick={back}>Back</button></div>
  <div className="native-send-content"><div className="native-send-scroll"><div className="native-send-fields">
   {step==='form'&&<>
    <div className="bridge-token-panels"><section className="bridge-token-panel" aria-label="Number of coins">
     <div className="bridge-panel-heading"><span>Split into</span><span>Monero</span></div>
     <div className="bridge-panel-value xmr-split-stepper">
      <button type="button" aria-label="Fewer coins" disabled={busy||!canSplit||coins<=2} onClick={()=>setCoins(c=>Math.max(2,c-1))}>−</button>
      <output aria-live="polite">{canSplit?coins:'—'}<small> coins</small></output>
      <button type="button" aria-label="More coins" disabled={busy||!canSplit||coins>=most} onClick={()=>setCoins(c=>Math.min(most,c+1))}>+</button>
     </div>
     {canSplit&&most>2&&<input className="xmr-split-range" type="range" min="2" max={most} step="1" value={coins} disabled={busy} aria-label="Number of coins" onChange={e=>setCoins(Number(e.target.value))}/>}
     <div className="bridge-panel-foot"><span>{canSplit?'About '+short(String(each))+' XMR each':'Available: '+short(String(unlocked))+' XMR'}</span><span>{canSplit?'Up to '+most:''}</span></div>
    </section></div>
    {!canSplit&&<p className="native-send-help" role="status">{need}{locked>0n?' '+short(String(locked))+' XMR is still confirming.':''}</p>}
    <p className="native-send-help">Sends your unlocked XMR to yourself as equal coins. After 10 confirmations (about 20 minutes) each coin can pay for its own transfer, so you can make several at once.</p>
   </>}
   {step==='review'&&review&&<>
    <p className="native-send-review-amount">{review.coins} coins</p>
    <dl className="native-send-costs"><div><dt>Each</dt><dd>about {short(review.partRaw)} XMR</dd></div><div><dt>Network fee</dt><dd>{xmr(review.feeRaw)} XMR</dd></div><div><dt>To</dt><dd>Your own address</dd></div></dl>
    <p className="native-send-help">All coins can be spent after 10 confirmations, about 20 minutes. This review is valid for two minutes.</p>
   </>}
   {step==='done'&&result&&<>
    <p className="native-send-review-amount">{result.uncertain?'Split status unknown':'Split into '+result.coins+' coins'}</p>
    <dl className="native-send-costs"><div><dt>Network fee</dt><dd>{xmr(result.feeRaw)} XMR</dd></div><div><dt>Ready in</dt><dd>About 20 minutes</dd></div></dl>
    <p className="native-send-help">{result.uncertain?'Check this transaction before splitting again.':'The coins can be spent after 10 confirmations.'}</p>
    <a className="native-send-explorer" href={'https://xmrchain.net/tx/'+result.hash} target="_blank" rel="noopener noreferrer">View transaction ↗</a>
   </>}
  </div></div>
  <div className="native-send-footer">{busy&&<span className="native-send-elapsed">Working…</span>}
   {message&&<p className="native-send-message" role="status" aria-live="polite">{message}</p>}
   <p className="native-send-error" role="alert" hidden={!error}>{error}</p>
   <div className="native-send-actions">
    {step==='form'&&<><button type="button" className="native-secondary" disabled={busy} onClick={onClose}>Cancel</button>{carrierRetry?<button type="button" className="native-primary" disabled={busy} onClick={checkCoins}>Check coins</button>:<button type="button" className="native-primary" disabled={busy||!canSplit} onClick={prepareReview}>{busy?'Checking…':'Review'}</button>}</>}
    {step==='review'&&<><button type="button" className="native-secondary" disabled={busy} onClick={back}>Back</button><button type="button" className="native-primary" disabled={busy} onClick={split}>{busy?'Splitting…':'Split into '+review?.coins+' coins'}</button></>}
    {step==='done'&&<button type="button" className="native-primary" onClick={onClose}>Done</button>}
   </div></div></div>
 </main></div></div>;
}
