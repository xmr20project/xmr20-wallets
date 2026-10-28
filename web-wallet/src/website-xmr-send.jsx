import React,{useEffect,useRef,useState} from 'react';
import '../../engine/shared/native-send-page.css';
import './website-native-page.css';
import {fitWalletPanel} from './website-native-panel.js';
import {checkMoneroAddress} from '../shared/xmr20/address.js';
import {sitePath} from './site-path.js';

// 28 Oct 2026 (owner): send XMR from the website wallet's Monero row, as in the extension. The unlocked wallet's worker is the
// installed extension's native worker: `prepare`/`prepareMax` build one transaction without relaying it (coins carrying XMR20
// are excluded by its guard), and `relay` sends only that reviewed transaction. A record is saved on this device before
// relaying, so an uncertain send can be checked before trying again.
const MAX_FEE=100000000n;// 0.0001 XMR, the extension's limit
const xmr=raw=>{const n=BigInt(raw),f=String(n%1000000000000n).padStart(12,'0').replace(/0+$/,'');return String(n/1000000000000n)+(f?'.'+f:'');};
const short=raw=>{const n=BigInt(raw),f=String(n%1000000000000n).padStart(12,'0').slice(0,6).replace(/0+$/,'');return String(n/1000000000000n)+(f?'.'+f:'');};
function units(text){
 if(!/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,12})?$/.test(text))throw Error('Enter an amount with up to 12 decimal places.');
 const [whole,fraction='']=text.split('.'),raw=BigInt(whole)*1000000000000n+BigInt(fraction.padEnd(12,'0'));
 if(raw<=0n)throw Error('Enter an amount greater than zero.');return raw;
}
const sendsKey=address=>'xmr20-xmr-sends:'+address;
// One record per send: a later update replaces the record saved under the reviewed hash.
function saveSend(address,row,reviewed=row.hash){
 try{const rows=JSON.parse(localStorage.getItem(sendsKey(address))||'[]').filter(r=>r&&r.hash!==row.hash&&r.hash!==reviewed);rows.push(row);localStorage.setItem(sendsKey(address),JSON.stringify(rows.slice(-50)));}catch{}
}
const CARRIER_CHECK='Check your coins before sending to protect any XMR20 tokens. This shares their transaction IDs with your selected Monero node; nothing is sent.';

export default function WebsiteXmrSend({client,address,node,balance,syncNow,onReviewing,onSent,onClose}){
 const wrap=useRef(null),alive=useRef(true),maxReview=useRef(null);
 const [to,setTo]=useState(''),[amountText,setAmountText]=useState(''),[step,setStep]=useState('form'),[review,setReview]=useState(null),[result,setResult]=useState(null);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[carrierRetry,setCarrierRetry]=useState(null),[shownMax,setShownMax]=useState('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>fitWalletPanel(wrap.current),[]);
 // The row's once-a-minute catch-up sync pauses only while a reviewed transaction waits to be sent.
 useEffect(()=>{onReviewing?.(step==='review');return()=>onReviewing?.(false);},[step]);
 // XMR received in the last ~10 blocks (or change from a send) is in the balance but not spendable yet.
 const lockedOf=b=>{try{const n=BigInt(b?.balanceRaw??'0')-BigInt(b?.unlockedRaw??'0');return n>0n?n:0n;}catch{return 0n;}};
 const locked=lockedOf(balance);
 const confirmingError=b=>Error(short(String(lockedOf(b)))+' XMR is still confirming. Monero needs 10 confirmations (about 20 minutes) before newly received XMR can be sent. Try again then.');
 // Sync first so the unlocked balance is current, then build. A shortfall caused by confirming XMR says so.
 async function fresh(){setMessage('Syncing your Monero wallet…');return syncNow?await syncNow():balance;}
 async function build(action,args){const b=await fresh();if(!alive.current)return null;
  setMessage(action==='prepareMax'?'Checking spendable XMR and the network fee…':'Building the transaction for review…');
  try{return await client[action](args);}catch(e){if(e?.code==='xmr-insufficient-unlocked'&&lockedOf(b)>0n)throw confirmingError(b);throw e;}}
 const recipient=to.trim();
 function checkRecipient(){
  const c=checkMoneroAddress(recipient,'mainnet');
  if(!recipient)throw Error('Paste the recipient’s Monero address.');
  if(!c.valid)throw Error('Enter a valid Monero mainnet address.');
  if(recipient===address)throw Error('Choose a different recipient.');
 }
 async function run(work){
  if(busy)return;setBusy(true);setError('');setCarrierRetry(null);
  try{await work();}
  catch(e){if(import.meta.env.DEV)void import('./native-balance.jsx').then(m=>m.localDiag({phase:'send',code:e?.code||null,message:String(e?.message||e).slice(0,200),balanceRaw:balance?.balanceRaw,unlockedRaw:balance?.unlockedRaw}));if(!alive.current)return;if(e?.code==='carrier-check-unavailable'){setCarrierRetry(()=>work);setError(CARRIER_CHECK);}else setError(e?.message||'This send could not continue. Nothing was sent.');setMessage('');}
  finally{if(alive.current)setBusy(false);}
 }
 // Max needs the recipient: the worker builds the exact sweep it would send.
 const max=()=>run(async()=>{
  checkRecipient();setMessage('Checking spendable XMR and the network fee…');
  const r=await build('prepareMax',{to:recipient,node,carrierLookup:'local'});if(!r||!alive.current)return;
  maxReview.current=r;setAmountText(xmr(r.amountRaw));setShownMax(short(r.amountRaw));setMessage('Maximum after the network fee.');
 });
 const prepareReview=()=>run(async()=>{
  checkRecipient();const raw=String(units(amountText.trim()));
  let r=maxReview.current;
  if(!(r&&r.to===recipient&&r.amountRaw===raw&&Date.now()<r.expires)){maxReview.current=null;r=await build('prepare',{to:recipient,amountRaw:raw,node,carrierLookup:'local'});}
  if(!r||!alive.current)return;
  if(BigInt(r.feeRaw)>MAX_FEE){void client.cancel().catch(()=>{});throw Error('The Monero fee exceeds 0.0001 XMR. Nothing was sent; try again later.');}
  setReview(r);setStep('review');setMessage('Check the details, then send. Monero payments cannot be reversed.');
 });
 const checkCoins=()=>{const retry=carrierRetry;void run(async()=>{
  setMessage('Checking which coins are safe to spend…');await client.checkCarriers({node,carrierLookup:'node'});if(!alive.current)return;
  setMessage('Coins checked.');if(retry)await retry();
 });};
 const send=()=>run(async()=>{
  if(!review||Date.now()>=review.expires){setStep('form');setReview(null);maxReview.current=null;throw Error('This review expired. Review the send again; nothing was sent.');}
  const row={hash:review.hash,to:review.to,amountRaw:review.amountRaw,feeRaw:review.feeRaw,at:Date.now(),status:'submitting'};saveSend(address,row);
  setMessage('Sending to the Monero network…');
  try{const sent=await client.relay({reviewId:review.id,node});saveSend(address,{...row,hash:sent?.hash||row.hash,status:'submitted'},row.hash);
   if(!alive.current)return;setResult({...row,hash:sent?.hash||row.hash});setStep('done');setMessage('');onSent?.();}
  catch(e){
   saveSend(address,{...row,status:e?.code==='xmr-not-submitted'?'not submitted':'uncertain'});
   if(e?.code==='xmr-not-submitted'){setStep('form');setReview(null);maxReview.current=null;}
   else if(alive.current){setResult({...row,uncertain:true});setStep('done');}
   throw e;
  }
 });
 const back=()=>{if(step==='review'){void client.cancel().catch(()=>{});setStep('form');setReview(null);setMessage('');setError('');}else onClose();};
 const available=balance?.unlockedRaw!==undefined?'Available: '+short(balance.unlockedRaw)+' XMR'+(locked>0n?' · '+short(String(locked))+' confirming':''):'Available: —';
 return <div ref={wrap} className="website-native-page native-popup-root native-send-window"><div><main id="native-send">
  <div className="native-send-head"><h1>Send XMR</h1><button type="button" disabled={busy&&step==='review'} onClick={back}>Back</button></div>
  <div className="native-send-content"><div className="native-send-scroll"><div className="native-send-fields">
   {step==='form'&&<>
    <div className="bridge-token-panels"><section className="bridge-token-panel" aria-label="You send">
     <div className="bridge-panel-heading"><span>You send</span><span>Monero</span></div>
     <div className="bridge-panel-value"><label className="bridge-sr-only" htmlFor="xmr-send-amount">Amount (XMR)</label>
      <input id="xmr-send-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={amountText} disabled={busy} onChange={e=>{setAmountText(e.target.value);setShownMax('');}}/>
      <div className="bridge-token-chip"><span className="bridge-token-art"><span className="bridge-token-initial bridge-coin-art" data-site-logo="" aria-hidden="true"><img src={sitePath('/brand/monero-user.png')} alt=""/></span></span><strong>XMR</strong></div></div>
     <div className="bridge-panel-foot"><span>{shownMax?'Max after fee: '+shownMax:available}</span><button type="button" className="bridge-max" aria-label="Use maximum available amount" disabled={busy} onClick={max}>Max</button></div>
    </section></div>
    <label className="native-send-label" htmlFor="xmr-send-to">Recipient’s Monero address</label>
    <textarea id="xmr-send-to" rows="2" spellCheck={false} autoComplete="off" placeholder="Paste the recipient’s Monero address" value={to} disabled={busy} onChange={e=>{setTo(e.target.value);maxReview.current=null;setShownMax('');}}/>
    {locked>0n&&!error&&<p className="native-send-help" role="status">{short(String(locked))} XMR is still confirming. It can be sent after 10 confirmations, about 20 minutes after it arrived.</p>}
    <p className="native-send-help">The network fee (about 0.00004 XMR) is paid from this wallet. Coins carrying XMR20 tokens are never spent.</p>
   </>}
   {step==='review'&&review&&<>
    <p className="native-send-review-amount">{xmr(review.amountRaw)} XMR</p>
    <dl className="native-send-costs"><div><dt>Network fee</dt><dd>{xmr(review.feeRaw)} XMR</dd></div><div><dt>Total</dt><dd>{xmr(String(BigInt(review.amountRaw)+BigInt(review.feeRaw)))} XMR</dd></div></dl>
    <label>To</label><div className="native-send-address">{review.to}</div>
    <p className="native-send-help">Paid from this wallet, including the network fee. This review is valid for two minutes.</p>
   </>}
   {step==='done'&&result&&<>
    <p className="native-send-review-amount">{result.uncertain?'Send status unknown':'XMR sent'}</p>
    <dl className="native-send-costs"><div><dt>Amount</dt><dd>{xmr(result.amountRaw)} XMR</dd></div><div><dt>Network fee</dt><dd>{xmr(result.feeRaw)} XMR</dd></div></dl>
    <label>To</label><div className="native-send-address">{result.to}</div>
    <p className="native-send-help">{result.uncertain?'Check this transaction before sending again. Its record is saved on this device.':'It appears in the recipient’s wallet after about 10 confirmations (about 20 minutes).'}</p>
    <a className="native-send-explorer" href={'https://xmrchain.net/tx/'+result.hash} target="_blank" rel="noopener noreferrer">View transaction ↗</a>
   </>}
  </div></div>
  <div className="native-send-footer">{busy&&<span className="native-send-elapsed">Working…</span>}
   {message&&<p className="native-send-message" role="status" aria-live="polite">{message}</p>}
   <p className="native-send-error" role="alert" hidden={!error}>{error}</p>
   <div className="native-send-actions">
    {step==='form'&&<><button type="button" className="native-secondary" disabled={busy} onClick={onClose}>Cancel</button>{carrierRetry?<button type="button" className="native-primary" disabled={busy} onClick={checkCoins}>Check coins</button>:<button type="button" className="native-primary" disabled={busy||!amountText.trim()||!recipient} onClick={prepareReview}>{busy?'Checking…':'Review'}</button>}</>}
    {step==='review'&&<><button type="button" className="native-secondary" disabled={busy} onClick={back}>Back</button><button type="button" className="native-primary" disabled={busy} onClick={send}>{busy?'Sending…':'Send XMR'}</button></>}
    {step==='done'&&<button type="button" className="native-primary" onClick={onClose}>Done</button>}
   </div></div></div>
 </main></div></div>;
}
