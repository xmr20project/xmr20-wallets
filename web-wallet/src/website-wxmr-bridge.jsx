import React,{useEffect,useRef,useState} from 'react';
import '../../engine/shared/native-send-page.css';
import './website-native-page.css';
import './website-wxmr-bridge.css';
import {fitWalletPanel} from './website-native-panel.js';
import {checkMoneroAddress} from '../shared/xmr20/address.js';
import {sitePath} from './site-path.js';
import {solanaRpc,signAndSubmitSolanaTokenSend} from './wallet-sol-send.js';
import {WXMR,checkProgram,readBridge,feeOf,buildCreateDeposit,buildWithdrawal,buildCancelWithdrawal,buildClaimPending,readWithdrawalAt} from './wxmr-bridge.js';

// 29 Oct 2026 (owner: "add another option for wxmr, that can bridge wxmr to native xmr? and vice versa"). The wxmr.io bridge,
// run by the wXMR team, from this website wallet (wxmr-bridge.js has the program details):
//   XMR -> wXMR: the Solana wallet gets its reusable Monero deposit address once (one approval); this Monero wallet then pays one
//     reviewed transaction of the chosen amount to it; wXMR arrives in the Solana wallet after 10 confirmations, less the fee.
//   wXMR -> XMR: one approval in the Solana wallet hands the wXMR (fee included) to the bridge for this wallet's Monero address
//     (or another); the bridge sends the XMR. A request still waiting after 5 minutes can be cancelled (the bridge keeps its fee).
const ONE=1000000000000n,MAX_FEE=100000000n,FEE_RESERVE=100000000n;// 0.0001 XMR: Send XMR's fee limit and Max's reserve
const xmr=raw=>{const n=BigInt(raw),f=String(n%ONE).padStart(12,'0').replace(/0+$/,'');return String(n/ONE)+(f?'.'+f:'');};
const short=raw=>{const n=BigInt(raw),f=String(n%ONE).padStart(12,'0').slice(0,6).replace(/0+$/,'');return String(n/ONE)+(f?'.'+f:'');};
function units(text){
 if(!/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,12})?$/.test(text))throw Error('Enter an amount with up to 12 decimal places.');
 const [w,f='']=text.split('.'),raw=BigInt(w)*ONE+BigInt(f.padEnd(12,'0'));if(raw<=0n)throw Error('Enter an amount greater than zero.');return raw;
}
const parsed=text=>{try{return units(text.trim());}catch{return null;}};
const storeKey=owner=>'xmr20-wxmr-withdrawals:'+owner;
const loadOuts=owner=>{try{const v=JSON.parse(localStorage.getItem(storeKey(owner))||'[]');return Array.isArray(v)?v:[];}catch{return [];}};
const saveOuts=(owner,rows)=>{try{localStorage.setItem(storeKey(owner),JSON.stringify(rows.slice(-20)));}catch{}};

// 30 Oct 2026 (owner: "the bridge button for wxmr should be the wxmr.io bridge feature we built"): a wXMR row on the Solana
// side opens this at wXMR -> XMR without a Monero wallet (client), so it offers only that direction.
export default function WebsiteWxmrBridge({owner,provider,address,client,node,balance,syncNow,onReviewing,onSent,onClose,initialDir='in'}){
 const wrap=useRef(null),alive=useRef(true),connection=useRef(solanaRpc());
 const [dir,setDir]=useState(client?initialDir:'out'),[info,setInfo]=useState(null),[loadError,setLoadError]=useState('');
 const [amountText,setAmountText]=useState(''),[to,setTo]=useState(address),[step,setStep]=useState('form'),[review,setReview]=useState(null),[done,setDone]=useState(null);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[outs,setOuts]=useState(()=>loadOuts(owner)),[now,setNow]=useState(Date.now()),[carrierCheck,setCarrierCheck]=useState(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>fitWalletPanel(wrap.current),[]);
 useEffect(()=>{onReviewing?.(step==='review'&&dir==='in');return()=>onReviewing?.(false);},[step,dir]);
 const current=()=>{if(!alive.current)throw Error('Bridge closed.');provider?.assertCurrent?.();if(provider?.publicKey?.toBase58?.()!==owner)throw Error('Wallet changed. Reconnect before continuing.');};
 async function load(){try{const b=await readBridge(connection.current,owner);if(alive.current){setInfo(b);setLoadError('');}return b;}catch(e){if(alive.current)setLoadError(e.message||'The wXMR bridge is not available right now.');return null;}}
 // Every 10 s: the deposit address once the bridge assigns it, balances, and the status of earlier requests.
 useEffect(()=>{void load();const t=setInterval(()=>{if(!document.hidden){void load();setNow(Date.now());void refreshOuts();}},10000);return()=>clearInterval(t);},[]);
 async function refreshOuts(){const rows=loadOuts(owner);if(!rows.length)return;let changed=false;
  for(const r of rows){if(['done','cancelled'].includes(r.status))continue;const w=await readWithdrawalAt(connection.current,r.pda).catch(()=>undefined);if(w===undefined)continue;
   const status=w?w.status:'done';if(status!==r.status){r.status=status;changed=true;}}
  if(changed)saveOuts(owner,rows);if(alive.current)setOuts(rows);}
 useEffect(()=>{void refreshOuts();},[]);
 async function run(work){if(busy)return;setBusy(true);setError('');try{await work();}catch(e){if(alive.current){setError(e?.message||'This step could not finish. Nothing was sent.');setMessage('');}}finally{if(alive.current)setBusy(false);}}
 const sign=async(prepared,label,submitted=()=>{})=>{setMessage('Approve in your Solana wallet…');return signAndSubmitSolanaTokenSend({prepared,provider,owner,row:{mint:WXMR.program.toBase58()},to:label,amount:String(prepared.blockhash),assertCurrent:current,onSubmitted:x=>{submitted(x);if(alive.current)setMessage('Submitted. Waiting for Solana to confirm…');}});};
 const fee=info?.feeBps??10,raw=parsed(amountText),unlocked=(()=>{try{return BigInt(balance?.unlockedRaw??'0');}catch{return 0n;}})();
 const deposit=info?.deposit,ready=deposit&&deposit.status==='active'&&/^[48]/.test(deposit.address);
 const switchDir=d=>{if(busy)return;setDir(d);setAmountText('');setStep('form');setReview(null);setDone(null);setError('');setMessage('');};
 // ---- XMR -> wXMR
 const createAddress=()=>run(async()=>{current();await checkProgram(connection.current);const prepared=await buildCreateDeposit(connection.current,owner);
  await sign(prepared,'wxmr-deposit-account');setMessage('Waiting for the wXMR bridge to give your deposit address…');
  for(let i=0;i<30&&alive.current;i++){const b=await load();if(b?.deposit?.status==='active'&&b.deposit.address){setMessage('');return;}await new Promise(r=>setTimeout(r,4000));}
  setMessage('The bridge has not given your address yet. It appears here when ready; you can close this page meanwhile.');});
 const maxIn=()=>{if(unlocked>FEE_RESERVE)setAmountText(xmr(unlocked-FEE_RESERVE));else setError('No unlocked XMR is available after the network fee.');};
 const reviewIn=()=>run(async()=>{
  if(raw===null)throw Error('Enter an amount.');if(raw<WXMR.minDeposit)throw Error('The wXMR bridge takes at least '+xmr(WXMR.minDeposit)+' XMR per deposit.');
  setMessage('Syncing your Monero wallet…');if(syncNow)await syncNow();if(!alive.current)return;setMessage('Building the transaction for review…');
  let r;try{r=await client.prepare({to:deposit.address,amountRaw:raw.toString(),node,carrierLookup:'local'});}
  catch(e){if(e?.code==='carrier-check-unavailable'){setCarrierCheck(true);throw Error('Check your coins before paying to protect any XMR20 tokens. This shares their transaction IDs with your selected Monero node; nothing is sent.');}if(e?.code==='xmr-insufficient-unlocked')throw Error('Not enough unlocked XMR for this amount and the network fee.');throw e;}
  if(r.to!==deposit.address||BigInt(r.amountRaw)!==raw){void client.cancel().catch(()=>{});throw Error('The reviewed payment does not match. Nothing was sent.');}
  if(BigInt(r.feeRaw)>MAX_FEE){void client.cancel().catch(()=>{});throw Error('The Monero fee exceeds 0.0001 XMR. Nothing was sent; try again later.');}
  setReview(r);setStep('review');setMessage('');});
 const checkCoins=()=>run(async()=>{setMessage('Checking which coins are safe to spend…');await client.checkCarriers({node,carrierLookup:'node'});setCarrierCheck(false);setMessage('Coins checked. Review again.');});
 const sendIn=()=>run(async()=>{const r=review;if(!r||Date.now()>=r.expires){setStep('form');setReview(null);throw Error('This review expired. Review again; nothing was sent.');}
  setMessage('Sending to the Monero network…');const sent=await client.relay({reviewId:r.id,node});
  if(!alive.current)return;setDone({dir:'in',amount:r.amountRaw,fee:r.feeRaw,hash:sent?.hash||r.hash});setStep('done');setMessage('');onSent?.();});
 const claim=()=>run(async()=>{current();await checkProgram(connection.current);await sign(await buildClaimPending(connection.current,owner,{authority:info.config.authority}),'wxmr-claim');await load();setMessage('Claimed.');});
 // ---- wXMR -> XMR
 const dest=to.trim(),destCheck=checkMoneroAddress(dest,'mainnet');
 const reviewOut=()=>run(async()=>{
  if(raw===null)throw Error('Enter an amount.');if(raw<WXMR.minWithdrawal)throw Error('The wXMR bridge sends at least '+xmr(WXMR.minWithdrawal)+' XMR.');
  if(raw>(info?.balance??0n))throw Error('This Solana wallet holds '+short(String(info?.balance??0n))+' wXMR.');
  if(!destCheck.valid)throw Error('Enter a valid Monero mainnet address.');
  setReview({amount:raw,fee:feeOf(raw,fee),to:dest});setStep('review');});
 const sendOut=()=>run(async()=>{current();await checkProgram(connection.current);const b=await load();if(!b)throw Error('The wXMR bridge is not available right now. Nothing was sent.');
  if(review.amount>b.balance)throw Error('This Solana wallet holds '+short(String(b.balance))+' wXMR. Nothing was sent.');
  const prepared=await buildWithdrawal(connection.current,owner,{amount:review.amount,xmrAddress:review.to,lastNonce:b.lastNonce});
  // Kept on this device once the wallet has signed (before it is sent), so its status can be followed and cancelled later.
  const row={pda:prepared.withdrawal.toBase58(),nonce:String(prepared.nonce),amount:String(review.amount),fee:String(review.fee),to:review.to,at:Date.now(),status:'pending'};
  const res=await sign(prepared,'wxmr-withdrawal',({signature})=>{const rows=[...loadOuts(owner),{...row,signature}];saveOuts(owner,rows);if(alive.current)setOuts(rows);});
  if(!alive.current)return;setDone({dir:'out',amount:String(review.amount),fee:String(review.fee),to:review.to,signature:res.signature});setStep('done');setMessage('');void load();});
 const cancelOut=row=>run(async()=>{current();await checkProgram(connection.current);const w=await readWithdrawalAt(connection.current,row.pda);
  if(!w||w.status!=='pending')throw Error('The bridge is already sending this one; it can no longer be cancelled.');
  await sign(await buildCancelWithdrawal(connection.current,owner,{withdrawal:row.pda,authority:info.config.authority}),'wxmr-cancel');
  const rows=loadOuts(owner).map(r=>r.pda===row.pda?{...r,status:'cancelled'}:r);saveOuts(owner,rows);setOuts(rows);void load();setMessage('Cancelled. The wXMR (less the bridge fee) is back in your Solana wallet.');});
 const back=()=>{if(step==='review'){if(dir==='in')void client.cancel().catch(()=>{});setStep('form');setReview(null);setMessage('');setError('');}else onClose();};
 const coin=label=><div className="bridge-token-chip"><span className="bridge-token-art"><span className="bridge-token-initial bridge-coin-art" data-site-logo="" aria-hidden="true"><img src={sitePath('/brand/monero-user.png')} alt=""/></span></span><strong>{label}</strong></div>;
 const receive=raw&&raw>0n?short(String(raw-feeOf(raw,fee))):'0';
 const statusWord={pending:'Waiting for the bridge',sending:'Bridge is sending XMR',done:'Done',cancelled:'Cancelled'};
 const recent=outs.slice(-3).reverse();
 return <div ref={wrap} className="website-native-page native-popup-root native-send-window"><div><main id="native-send" className="wxmr-bridge">
  <div className="native-send-head"><h1>wXMR bridge</h1><button type="button" disabled={busy&&step==='review'} onClick={back}>Back</button></div>
  <div className="native-send-content"><div className="native-send-scroll"><div className="native-send-fields">
   {step==='form'&&<>
    {client&&<div className="wxmr-tabs" role="tablist"><button type="button" role="tab" aria-selected={dir==='in'} disabled={busy} onClick={()=>switchDir('in')}>XMR → wXMR</button><button type="button" role="tab" aria-selected={dir==='out'} disabled={busy} onClick={()=>switchDir('out')}>wXMR → XMR</button></div>}
    {loadError&&<p className="native-send-help" role="status">{loadError}</p>}
    {dir==='in'&&!info&&!loadError&&<p className="native-send-help" role="status">Checking the wXMR bridge…</p>}
    {dir==='in'&&info&&!deposit&&<div className="wxmr-card"><strong>Your wXMR deposit address</strong><p>Created once with one approval in your Solana wallet, then yours for every deposit. Solana's small account cost is shown in your wallet.</p></div>}
    {dir==='in'&&deposit&&!ready&&<div className="wxmr-card"><strong>Waiting for your deposit address</strong><p>The wXMR bridge gives it to your Solana wallet, usually within a minute.</p></div>}
    {(dir==='out'||ready)&&<div className="bridge-token-panels">
     <section className="bridge-token-panel" aria-label="You send">
      <div className="bridge-panel-heading"><span>You send</span><span>{dir==='in'?'Monero':'Solana'}</span></div>
      <div className="bridge-panel-value"><label className="bridge-sr-only" htmlFor="wxmr-amount">Amount</label>
       <input id="wxmr-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={amountText} disabled={busy} onChange={e=>{setAmountText(e.target.value);setError('');}}/>{coin(dir==='in'?'XMR':'wXMR')}</div>
      <div className="bridge-panel-foot"><span>Available: {dir==='in'?short(String(unlocked))+' XMR':info?short(String(info.balance))+' wXMR':'—'}</span><button type="button" className="bridge-max" disabled={busy||(dir==='out'&&!info)} onClick={dir==='in'?maxIn:()=>setAmountText(xmr(info.balance))}>Max</button></div>
     </section>
     <section className="bridge-token-panel" aria-label="You receive">
      <div className="bridge-panel-heading"><span>You receive</span><span>{dir==='in'?'Solana':'Monero'}</span></div>
      <div className="bridge-panel-value"><output className="wxmr-receive">{receive}</output>{coin(dir==='in'?'wXMR':'XMR')}</div>
      <div className="bridge-panel-foot"><span>Bridge fee {fee/100}% · minimum 0.1 XMR</span></div>
     </section></div>}
    {dir==='out'&&<details className="native-send-disclosure" open={!address||undefined}><summary>Receive at</summary><textarea rows="2" spellCheck={false} autoComplete="off" value={to} disabled={busy} onChange={e=>setTo(e.target.value)}/><p className="native-send-help">{!dest?'Enter the Monero address that receives the XMR.':dest===address?'This wallet’s Monero address.':!destCheck.valid?'Not a valid Monero mainnet address.':'Another Monero address.'}</p></details>}
    {dir==='in'&&ready&&<details className="native-send-disclosure"><summary>Deposit address</summary><div className="native-send-address">{deposit.address}</div><p className="native-send-help">Yours for every deposit. Each payment is minted after 10 Monero confirmations; transfers under 0.1 XMR are not minted.</p></details>}
    {dir==='in'&&info?.pendingMint>0n&&<div className="wxmr-card"><strong>{short(String(info.pendingMint))} wXMR waiting to be claimed</strong><p>It was minted before your Solana wallet had a wXMR account.</p></div>}
    {dir==='out'&&recent.length>0&&<div className="wxmr-list"><span>Recent</span>{recent.map(r=><div key={r.pda} className="wxmr-row"><span><strong>{short(r.amount)} wXMR → XMR</strong><small>{statusWord[r.status]||r.status}</small></span>
     {r.status==='pending'&&now-r.at>=WXMR.cancelAfterSeconds*1000&&<button type="button" className="native-secondary" disabled={busy} onClick={()=>cancelOut(r)}>Cancel</button>}</div>)}</div>}
    <p className="native-send-help">The wxmr.io bridge is run by the wXMR team. It holds the XMR behind wXMR; this wallet only sends your requests to it.</p>
   </>}
   {step==='review'&&review&&dir==='in'&&<>
    <p className="native-send-review-amount">{xmr(review.amountRaw)} XMR → wXMR</p>
    <dl className="native-send-costs"><div><dt>Network fee</dt><dd>{xmr(review.feeRaw)} XMR</dd></div><div><dt>Bridge fee</dt><dd>{short(String(feeOf(BigInt(review.amountRaw),fee)))} wXMR</dd></div><div><dt>You receive</dt><dd>about {short(String(BigInt(review.amountRaw)-feeOf(BigInt(review.amountRaw),fee)))} wXMR</dd></div><div><dt>Arrives</dt><dd>After 10 confirmations, about 20 min</dd></div></dl>
    <label>To your wXMR deposit address</label><div className="native-send-address">{review.to}</div>
    <p className="native-send-help">Paid from this wallet. Monero payments cannot be reversed. This review is valid for two minutes.</p>
   </>}
   {step==='review'&&review&&dir==='out'&&<>
    <p className="native-send-review-amount">{xmr(review.amount)} wXMR → XMR</p>
    <dl className="native-send-costs"><div><dt>Bridge fee</dt><dd>{short(String(review.fee))} wXMR</dd></div><div><dt>You receive</dt><dd>{short(String(review.amount-review.fee))} XMR</dd></div><div><dt>Solana fee</dt><dd>Shown in your wallet</dd></div></dl>
    <label>To</label><div className="native-send-address">{review.to}</div>
    <p className="native-send-help">You approve this in your Solana wallet. The bridge then sends the XMR; you can cancel if it has not started after 5 minutes.</p>
   </>}
   {step==='done'&&done&&<>
    <p className="native-send-review-amount">{done.dir==='in'?'XMR sent to the bridge':'Request sent to the bridge'}</p>
    <dl className="native-send-costs">{done.dir==='in'?<><div><dt>Amount</dt><dd>{xmr(done.amount)} XMR</dd></div><div><dt>wXMR arrives</dt><dd>After 10 confirmations</dd></div></>:<><div><dt>Amount</dt><dd>{xmr(done.amount)} wXMR</dd></div><div><dt>You receive</dt><dd>{short(String(BigInt(done.amount)-BigInt(done.fee)))} XMR</dd></div></>}</dl>
    <p className="native-send-help">{done.dir==='in'?'wXMR appears in your Solana wallet about 20 minutes after this payment.':'The XMR shows as Receiving on the Monero row once the bridge sends it.'}</p>
    {done.hash&&<a className="native-send-explorer" href={'https://xmrchain.net/tx/'+done.hash} target="_blank" rel="noopener noreferrer">View payment ↗</a>}
    {done.signature&&<a className="native-send-explorer" href={'https://solscan.io/tx/'+done.signature} target="_blank" rel="noopener noreferrer">View request on Solscan ↗</a>}
   </>}
  </div></div>
  <div className="native-send-footer">{busy&&<span className="native-send-elapsed">Working…</span>}
   {message&&<p className="native-send-message" role="status" aria-live="polite">{message}</p>}
   <p className="native-send-error" role="alert" hidden={!error}>{error}</p>
   <div className="native-send-actions">
    {step==='form'&&<><button type="button" className="native-secondary" disabled={busy} onClick={onClose}>Cancel</button>
     {dir==='in'&&info&&!deposit?<button type="button" className="native-primary" disabled={busy} onClick={createAddress}>Create deposit address</button>
      :dir==='in'&&info?.pendingMint>0n?<button type="button" className="native-primary" disabled={busy} onClick={claim}>Claim wXMR</button>
      :dir==='in'&&carrierCheck?<button type="button" className="native-primary" disabled={busy} onClick={checkCoins}>Check coins</button>
      :<button type="button" className="native-primary" disabled={busy||!info||(dir==='in'&&!ready)||!amountText.trim()} onClick={dir==='in'?reviewIn:reviewOut}>{busy?'Checking…':'Review'}</button>}</>}
    {step==='review'&&<><button type="button" className="native-secondary" disabled={busy} onClick={back}>Back</button><button type="button" className="native-primary" disabled={busy} onClick={dir==='in'?sendIn:sendOut}>{busy?'Working…':dir==='in'?'Send '+xmr(review.amountRaw)+' XMR':'Approve in wallet'}</button></>}
    {step==='done'&&<button type="button" className="native-primary" onClick={onClose}>Done</button>}
   </div></div></div>
 </main></div></div>;
}
