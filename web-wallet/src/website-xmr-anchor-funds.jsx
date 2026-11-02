import React,{useEffect,useRef,useState} from 'react';
import '../../engine/shared/native-send-page.css';
import './website-native-page.css';
import {fitWalletPanel} from './website-native-panel.js';
import {saveXmrTx} from './xmr-tx-store.js';

// Monero Market (31 Oct 2026, owner: "a button, which sends the xmr from your wallet to yourself … so its 1 click inside the
// wallet"): a lot's anchor can only be paid with XMR that arrived in an ordinary payment, and XMR left over from bridging or
// private sends is change from XMR20 transactions. This page sends the unlocked XMR to this wallet's own address in one ordinary
// transaction (the split's `prepareSplit`, behind the same XMR20 coin guard), so its coins can pay for anchors 10 blocks later.
// It opens from the market page's "Use my XMR" with the review already built: one click sends it.
const MIN_COIN=200000000n,MAX_COINS=16,MAX_FEE=500000000n;// as the split: 0.0002 XMR per coin; refuse a fee above 0.0005 XMR
const xmr=raw=>{const n=BigInt(raw),f=String(n%1000000000000n).padStart(12,'0').replace(/0+$/,'');return String(n/1000000000000n)+(f?'.'+f:'');};
const short=raw=>{const n=BigInt(raw),f=String(n%1000000000000n).padStart(12,'0').slice(0,6).replace(/0+$/,'');return String(n/1000000000000n)+(f?'.'+f:'');};
const CARRIER_CHECK='Check your coins first to protect any XMR20 tokens. This shares their transaction IDs with your selected Monero node; nothing is sent.';

export default function WebsiteXmrAnchorFunds({address,client,node,balance,syncNow,coins:wanted=3,onReviewing,onSent,onClose}){
 const wrap=useRef(null),alive=useRef(true),started=useRef(false);
 const unlocked=(()=>{try{return BigInt(balance?.unlockedRaw??'0');}catch{return 0n;}})();
 const locked=(()=>{try{const n=BigInt(balance?.balanceRaw??'0')-unlocked;return n>0n?n:0n;}catch{return 0n;}})();
 const most=Number(unlocked/MIN_COIN>BigInt(MAX_COINS)?BigInt(MAX_COINS):unlocked/MIN_COIN);
 const coins=Math.max(2,Math.min(most,Number.isSafeInteger(wanted)?wanted:3)),canSend=most>=2;
 const [step,setStep]=useState('form'),[review,setReview]=useState(null),[result,setResult]=useState(null);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[carrierRetry,setCarrierRetry]=useState(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>fitWalletPanel(wrap.current),[]);
 useEffect(()=>{onReviewing?.(step==='review');return()=>onReviewing?.(false);},[step]);
 async function run(work){
  if(busy)return;setBusy(true);setError('');setCarrierRetry(null);
  try{await work();}
  catch(e){if(!alive.current)return;if(e?.code==='carrier-check-unavailable'){setCarrierRetry(()=>work);setError(CARRIER_CHECK);}else setError(e?.message||'This payment could not continue. Nothing was sent.');setMessage('');}
  finally{if(alive.current)setBusy(false);}
 }
 const prepareReview=()=>run(async()=>{
  setMessage('Syncing your Monero wallet…');if(syncNow)await syncNow();if(!alive.current)return;
  setMessage('Building the payment to yourself…');
  const r=await client.prepareSplit({node,coins,carrierLookup:'local'});if(!alive.current)return;
  if(r.coins!==coins){void client.cancel().catch(()=>{});throw Error('The reviewed payment does not match. Nothing was sent.');}
  if(BigInt(r.feeRaw)>MAX_FEE){void client.cancel().catch(()=>{});throw Error('The Monero fee exceeds 0.0005 XMR. Nothing was sent; try again later.');}
  setReview(r);setStep('review');setMessage('');
 });
 // Opened from the market page: build the review straight away, so the only click left is "Send to myself".
 useEffect(()=>{if(!started.current&&balance&&canSend){started.current=true;void prepareReview();}},[balance,canSend]);
 const checkCoins=()=>{const retry=carrierRetry;void run(async()=>{
  setMessage('Checking which coins are safe to spend…');await client.checkCarriers({node,carrierLookup:'node'});if(!alive.current)return;
  setMessage('Coins checked.');if(retry)await retry();
 });};
 const send=()=>run(async()=>{
  if(!review||Date.now()>=review.expires){setStep('form');setReview(null);throw Error('This review expired. Build it again; nothing was sent.');}
  setMessage('Sending to your own address…');
  const row={kind:'split',hash:review.hash,coins:review.coins,feeRaw:review.feeRaw,at:Date.now(),status:'submitting'};saveXmrTx(address,row);
  try{const sent=await client.relay({reviewId:review.id,node});saveXmrTx(address,{...row,hash:sent?.hash||row.hash,status:'submitted'},row.hash);window.dispatchEvent(new Event('xmr20-xmr-tx'));if(!alive.current)return;setResult({...review,hash:sent?.hash||review.hash});setStep('done');setMessage('');onSent?.();}
  catch(e){saveXmrTx(address,{...row,status:e?.code==='xmr-not-submitted'?'not submitted':'uncertain'});if(e?.code==='xmr-not-submitted'){setStep('form');setReview(null);}else if(alive.current){setResult({...review,uncertain:true});setStep('done');}throw e;}
 });
 const back=()=>{if(step==='review'){void client.cancel().catch(()=>{});setStep('form');setReview(null);setMessage('');setError('');}else onClose();};
 const why='Your XMR is change from XMR20 transactions, which can’t pay for a listing anchor. This sends it to yourself as an ordinary payment; your listing then continues by itself.';
 return <div ref={wrap} className="website-native-page native-popup-root native-send-window"><div><main id="native-send" className="xmr-split">
  <div className="native-send-head"><h1>Prepare XMR for listing</h1><button type="button" disabled={busy&&step==='review'} onClick={back}>Back</button></div>
  <div className="native-send-content"><div className="native-send-scroll"><div className="native-send-fields">
   {step==='form'&&<>
    <p className="native-send-help">{why}</p>
    {!canSend&&<p className="native-send-help" role="status">{'You need at least '+short(String(MIN_COIN*2n))+' unlocked XMR.'}{locked>0n?' '+short(String(locked))+' XMR is still confirming (about 20 minutes).':' Send a little XMR to your Monero address from another wallet or an exchange.'}</p>}
   </>}
   {step==='review'&&review&&<>
    <p className="native-send-review-amount">{short(String(unlocked))} XMR to yourself</p>
    <dl className="native-send-costs"><div><dt>As</dt><dd>{review.coins} coins of about {short(review.partRaw)} XMR</dd></div><div><dt>Network fee</dt><dd>{xmr(review.feeRaw)} XMR</dd></div><div><dt>To</dt><dd>Your own address</dd></div></dl>
    <p className="native-send-help">{why} Usable after 10 confirmations, about 20 minutes. For the most privacy, send XMR from another wallet or an exchange instead.</p>
   </>}
   {step==='done'&&result&&<>
    <p className="native-send-review-amount">{result.uncertain?'Payment status unknown':'Sent to yourself'}</p>
    <dl className="native-send-costs"><div><dt>Network fee</dt><dd>{xmr(result.feeRaw)} XMR</dd></div><div><dt>Ready in</dt><dd>About 20 minutes</dd></div></dl>
    <p className="native-send-help">{result.uncertain?'Check this transaction before trying again.':'After 10 confirmations your wallet pays the anchor and your listing continues by itself. Keep the market page open.'}</p>
    <a className="native-send-explorer" href={'https://xmrchain.net/tx/'+result.hash} target="_blank" rel="noopener noreferrer">View transaction ↗</a>
   </>}
  </div></div>
  <div className="native-send-footer">{busy&&<span className="native-send-elapsed">Working…</span>}
   {message&&<p className="native-send-message" role="status" aria-live="polite">{message}</p>}
   <p className="native-send-error" role="alert" hidden={!error}>{error}</p>
   <div className="native-send-actions">
    {step==='form'&&<><button type="button" className="native-secondary" disabled={busy} onClick={onClose}>Cancel</button>{carrierRetry?<button type="button" className="native-primary" disabled={busy} onClick={checkCoins}>Check coins</button>:<button type="button" className="native-primary" disabled={busy||!canSend} onClick={prepareReview}>{busy?'Preparing…':'Review'}</button>}</>}
    {step==='review'&&<><button type="button" className="native-secondary" disabled={busy} onClick={back}>Cancel</button><button type="button" className="native-primary" disabled={busy} onClick={send}>{busy?'Sending…':'Send to myself'}</button></>}
    {step==='done'&&<button type="button" className="native-primary" onClick={onClose}>Done</button>}
   </div></div></div>
 </main></div></div>;
}
