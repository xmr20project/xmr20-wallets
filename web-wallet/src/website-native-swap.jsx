import React,{useEffect,useMemo,useRef,useState} from 'react';
import {PublicKey} from '@solana/web3.js';
import {createNativeSwapPage} from '../../engine/shared/native-swap-page.js';
import {solanaMaximum} from '../../engine/shared/solana-max.js';
import '../../engine/shared/native-send-page.css';
import './website-native-page.css';
import {fitWalletPanel} from './website-native-panel.js';
import {solanaRpc,prepareSolTransfer,signAndSubmitSolanaTokenSend,checkSolanaTokenSend} from './wallet-sol-send.js';
import {swapOrderStore,solLamports} from './website-native-swap.js';
import {websiteSolBalance} from './private-wallet-host.js';
import {sitePath} from './site-path.js';

// The extension's SOL <-> XMR page, hosted in the website wallet. Phantom or
// Solflare pays SOL deposits; XMR deposits are paid from a Monero wallet.
const sol=raw=>{const n=BigInt(raw),f=String(n%1000000000n).padStart(9,'0').replace(/0+$/,'');return String(n/1000000000n)+(f?'.'+f:'');};
const solShort=raw=>{const n=BigInt(raw),f=String(n%1000000000n).padStart(9,'0').slice(0,4).replace(/0+$/,'');return String(n/1000000000n)+(f?'.'+f:'');};

// The shared exchange page draws its own small SOL and XMR marks; the website shows the same Solana and Monero logos as
// the rest of its wallet (the SOL row and the Solana/Monero tabs).
const COIN_LOGOS={SOL:'/brand/solana.svg',XMR:'/brand/monero-user.png'};
function siteCoinLogos(root){
 const apply=()=>{for(const art of root.querySelectorAll('.bridge-coin-art:not([data-site-logo])')){
  const src=COIN_LOGOS[art.closest('.bridge-token-chip')?.querySelector('strong')?.textContent.trim()];if(!src)continue;
  const img=document.createElement('img');img.src=sitePath(src);img.alt='';art.dataset.siteLogo='';art.replaceChildren(img);
 }};
 apply();const observer=new MutationObserver(apply);observer.observe(root,{childList:true,subtree:true});return()=>observer.disconnect();
}

// 29 Oct 2026 (owner: "bridge" on the Monero screen = "bridge xmr to solana"): `direction` 'xmr-sol' starts on XMR -> SOL, and
// `xmrWallet` ({client,node,syncNow,balance}, the unlocked Monero wallet) shows its unlocked XMR, sets Max, and pays the
// exchange's XMR deposit from this wallet: one reviewed transaction of exactly the quoted amount (coins carrying XMR20 excluded).
const XMR_FEE_RESERVE=100000000n,MAX_XMR_FEE=100000000n;// 0.0001 XMR, as the exchange page says and Send XMR enforces
const xmrUnits=text=>{if(!/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,12})?$/.test(String(text)))throw Error('Unexpected XMR amount from the exchange.');const [w,f='']=String(text).split('.');return BigInt(w)*1000000000000n+BigInt(f.padEnd(12,'0'));};
const xmrText=raw=>{const n=BigInt(raw),f=String(n%1000000000000n).padStart(12,'0').replace(/0+$/,'');return String(n/1000000000000n)+(f?'.'+f:'');};
const unlockedOf=b=>{try{return BigInt(b?.unlockedRaw??'0');}catch{return 0n;}};
export default function WebsiteNativeSwap({owner,provider,moneroAddress,onClose,direction='sol-xmr',xmrWallet=null,onReviewing}){
 const host=useRef(null),wrap=useRef(null),close=useRef(onClose),[payment,setPayment]=useState(null),[resume,setResume]=useState(null);
 close.current=onClose;
 // The Monero wallet's balance changes with every sync; the page reads the latest through a ref and is not rebuilt.
 const xmr=useRef(xmrWallet);xmr.current=xmrWallet;
 const store=useMemo(()=>swapOrderStore(owner),[owner]);
 useEffect(()=>{
  if(payment)return;
  let live=true;
  const current=()=>{if(!live)throw Error('Exchange closed.');provider?.assertCurrent?.();if(provider?.publicKey?.toBase58?.()!==owner)throw Error('Wallet changed. Reconnect before continuing.');};
  const page=createNativeSwapPage({container:host.current,account:{solana:owner,monero:moneroAddress||''},assertCurrent:current,onClose:()=>close.current(),
   // The shared page asks https://xmr20.org/api/native-swap; ask this site's own /api/native-swap instead (the same URL on
   // xmr20.org; the local preview forwards it), since a cross-site request is refused by the browser ("Failed to fetch").
   fetcher:(url,init)=>fetch(new URL(url).pathname,init),
   direction,
   balance:async direction=>{
    if(direction==='xmr-sol')return xmr.current?xmrText(unlockedOf(xmr.current.balance))+' XMR':null;
    if(direction!=='sol-xmr')return null;
    const raw=websiteSolBalance()??String(await solanaRpc().getBalance(new PublicKey(owner)));current();return solShort(raw)+' SOL';
   },
   loadOrders:()=>store.load(),saveOrder:async order=>{current();store.save(order);},
   maximum:async direction=>{
    current();
    if(direction==='xmr-sol'){if(!xmr.current)throw Error('Enter the XMR amount.');const b=await xmr.current.syncNow();current();const n=unlockedOf(b)-XMR_FEE_RESERVE;if(n<=0n)throw Error('No unlocked XMR is available after the network fee.');return n.toString();}
    if(direction!=='sol-xmr')throw Error('Enter the XMR amount. Paying XMR from the website is not available yet.');
    const raw=await solanaMaximum(owner,PublicKey.default.toBase58(),{rpc:solanaRpc()});current();return raw;
   },
   onPay:order=>{current();setPayment(order);}});
  page.open(resume);const logos=siteCoinLogos(host.current);
  return()=>{live=false;logos();page.close();};
 },[owner,provider,moneroAddress,payment,resume,store,direction]);
 useEffect(()=>{
  if(!provider?.on)return;const changed=()=>close.current();
  provider.on('accountChanged',changed);provider.on('disconnect',changed);
  return()=>{provider.removeListener?.('accountChanged',changed);provider.removeListener?.('disconnect',changed);};
 },[provider]);
 useEffect(()=>fitWalletPanel(wrap.current),[]);
 const back=requestId=>{setResume(requestId);setPayment(null);};
 return <div ref={wrap} className="website-native-page native-popup-root native-send-window">{payment
  ?(payment.direction==='xmr-sol'&&xmrWallet?<XmrPayment order={payment} wallet={xmrWallet} store={store} onReviewing={onReviewing} onBack={back}/>:<SwapPayment order={payment} owner={owner} provider={provider} store={store} onBack={back}/>)
  :<div ref={host}/>}</div>;
}

function SwapPayment({order,owner,provider,store,onBack}){
 const live=useRef(true),[state,setState]=useState({phase:order.direction==='sol-xmr'?'preparing':'manual'}),[copied,setCopied]=useState(false);
 useEffect(()=>()=>{live.current=false;},[]);
 const assert=()=>{if(!live.current)throw Error('Payment closed.');provider?.assertCurrent?.();if(provider?.publicKey?.toBase58?.()!==owner)throw Error('Wallet changed. Reconnect before paying.');};
 const set=value=>{if(live.current)setState(value);};
 const fresh=()=>prepareSolTransfer({owner,to:order.payin,lamports:solLamports(order.amount)});
 async function prepare(){
  set({phase:'preparing'});
  try{set({phase:'review',prepared:await fresh(),preparedAt:Date.now()});}
  catch(e){set({phase:'review',error:e.message});}
 }
 useEffect(()=>{if(order.direction==='sol-xmr')void prepare();},[]);
 // Nothing was signed: the exchange shows its Pay button again.
 const cancel=()=>{try{store.save({...order,paymentOpened:false});}catch{}onBack(order.requestId);};
 async function pay(){
  let prepared=state.prepared;set({...state,phase:'signing',error:''});
  try{
   // A Solana blockhash is short-lived: prepare again just before an older review is signed.
   if(Date.now()-state.preparedAt>45000){prepared=await fresh();assert();}
   const result=await signAndSubmitSolanaTokenSend({prepared,provider,owner,row:{mint:'native-sol'},to:order.payin,amount:order.amount,assertCurrent:assert,
    onSubmitted:({signature})=>{store.save({...order,paymentOpened:true,paymentSignature:signature});set({phase:'submitted',signature});}});
   set({phase:result.confirmed?'confirmed':'submitted',signature:result.signature});
  }catch(e){set(s=>s.signature?{...s,error:e.message}:{phase:'review',prepared,error:e.message});}
 }
 async function recheck(){
  try{const ok=await checkSolanaTokenSend(state.signature,{attempts:3});set(s=>({...s,phase:ok?'confirmed':'submitted',error:ok?'':'Not confirmed yet. Check again shortly.'}));}
  catch(e){set(s=>({...s,error:e.message}));}
 }
 const head=<div className="native-send-head"><h1>Pay deposit</h1><button type="button" onClick={state.signature?()=>onBack(order.requestId):cancel} disabled={state.phase==='signing'}>Back</button></div>;
 const address=<><label>ChangeNOW deposit address</label><div className="native-send-address">{order.payin}</div></>;
 if(state.phase==='manual')return <main id="native-send">{head}
  <p className="native-send-review-amount">{order.amount} XMR</p>{address}
  <p className="native-send-help">Send exactly this amount once from your Monero wallet, for example the XMR20 wallet extension. Paying XMR directly from the website is not available yet.</p>
  <div className="native-send-actions"><button type="button" className="native-primary" onClick={()=>{void navigator.clipboard?.writeText(order.payin).then(()=>setCopied(true));}}>{copied?'Address copied':'Copy address'}</button>
  <button type="button" className="native-secondary" onClick={()=>onBack(order.requestId)}>I have paid — show status</button></div></main>;
 return <main id="native-send">{head}
  <p className="native-send-review-amount">{order.amount} SOL</p>{address}
  {state.prepared&&!state.signature&&<dl className="native-send-costs"><div><dt>Network fee</dt><dd>{sol(state.prepared.fee)} SOL</dd></div><div><dt>Exchange ID</dt><dd>{order.id}</dd></div></dl>}
  {state.phase==='preparing'&&<p className="native-send-message" role="status">Checking your SOL balance and the network fee…</p>}
  {state.phase==='signing'&&<p className="native-send-message" role="status">Approve the payment in your Solana wallet…</p>}
  {state.signature&&<><p className="native-send-message" role="status">{state.phase==='confirmed'?'Payment confirmed on Solana. ChangeNOW will now exchange it.':'Payment sent. Waiting for Solana confirmation…'}</p>
   <a className="native-send-explorer" href={'https://solscan.io/tx/'+state.signature} target="_blank" rel="noopener noreferrer">View payment on Solscan ↗</a></>}
  {state.error&&<p className="native-send-error" role="alert">{state.error}</p>}
  <div className="native-send-actions">{!state.signature
   ?<>{state.prepared&&<button type="button" className="native-primary" onClick={()=>void pay()} disabled={state.phase==='signing'}>Pay {order.amount} SOL</button>}
    {!state.prepared&&state.phase!=='preparing'&&<button type="button" className="native-primary" onClick={()=>void prepare()}>Review again</button>}
    <button type="button" className="native-secondary" onClick={cancel} disabled={state.phase==='signing'}>Cancel</button></>
   :<>{state.phase!=='confirmed'&&<button type="button" className="native-secondary" onClick={()=>void recheck()}>Check confirmation</button>}
    <button type="button" className="native-primary" onClick={()=>onBack(order.requestId)}>Show exchange status</button></>}</div>
 </main>;
}

// 29 Oct 2026: the exchange's XMR deposit paid from this website's unlocked Monero wallet. The worker builds one transaction of
// exactly the quoted amount to the ChangeNOW deposit address without relaying it (prepare), the review shows the network fee,
// and only that reviewed transaction is sent (relay). The order is marked as paid before relaying, so an uncertain send is not
// paid twice.
function XmrPayment({order,wallet,store,onReviewing,onBack}){
 const live=useRef(true),[state,setState]=useState({phase:'preparing'}),[carrierCheck,setCarrierCheck]=useState(false);
 useEffect(()=>()=>{live.current=false;},[]);
 useEffect(()=>{onReviewing?.(state.phase==='review');return()=>onReviewing?.(false);},[state.phase]);
 const set=value=>{if(live.current)setState(value);};
 const amountRaw=(()=>{try{return xmrUnits(order.amount);}catch{return null;}})();
 async function prepare(){
  set({phase:'preparing'});setCarrierCheck(false);
  try{
   if(amountRaw===null||amountRaw<=0n)throw Error('Unexpected XMR amount from the exchange.');
   await wallet.syncNow();
   const r=await wallet.client.prepare({to:order.payin,amountRaw:amountRaw.toString(),node:wallet.node,carrierLookup:'local'});
   if(r.to!==order.payin||BigInt(r.amountRaw)!==amountRaw){void wallet.client.cancel().catch(()=>{});throw Error('The reviewed payment does not match the exchange order. Nothing was sent.');}
   if(BigInt(r.feeRaw)>MAX_XMR_FEE){void wallet.client.cancel().catch(()=>{});throw Error('The Monero fee exceeds 0.0001 XMR. Nothing was sent; try again later.');}
   set({phase:'review',review:r});
  }catch(e){if(e?.code==='carrier-check-unavailable')setCarrierCheck(true);set({phase:'error',error:e?.code==='carrier-check-unavailable'?'Check your coins before paying to protect any XMR20 tokens. This shares their transaction IDs with your selected Monero node; nothing is sent.':e?.code==='xmr-insufficient-unlocked'?'Not enough unlocked XMR for this amount and the network fee.':e.message||'Could not build the payment. Nothing was sent.'});}
 }
 useEffect(()=>{void prepare();},[]);
 const checkCoins=async()=>{set({phase:'preparing'});try{await wallet.client.checkCarriers({node:wallet.node,carrierLookup:'node'});}catch(e){set({phase:'error',error:e.message});return;}void prepare();};
 const cancel=()=>{if(state.phase==='review')void wallet.client.cancel().catch(()=>{});try{store.save({...order,paymentOpened:false});}catch{}onBack(order.requestId);};
 async function pay(){
  const r=state.review;if(!r||Date.now()>=r.expires){set({phase:'error',error:'This review expired. Review again; nothing was sent.'});return;}
  set({phase:'sending',review:r});
  try{store.save({...order,paymentOpened:true});}catch{}
  try{const sent=await wallet.client.relay({reviewId:r.id,node:wallet.node});const hash=sent?.hash||r.hash;try{store.save({...order,paymentOpened:true,paymentTx:hash});}catch{}set({phase:'sent',review:r,hash});void wallet.syncNow().catch(()=>{});}
  catch(e){if(e?.code==='xmr-not-submitted'){try{store.save({...order,paymentOpened:false});}catch{}set({phase:'error',error:e.message});}else set({phase:'uncertain',review:r,error:e.message||'The payment status is unknown.'});}
 }
 const head=<div className="native-send-head"><h1>Pay deposit</h1><button type="button" onClick={['sent','uncertain'].includes(state.phase)?()=>onBack(order.requestId):cancel} disabled={state.phase==='sending'}>Back</button></div>;
 const r=state.review;
 // Same structure as Send XMR: the fields scroll; message, error and the actions stay in view.
 return <div><main id="native-send">{head}
  <div className="native-send-content"><div className="native-send-scroll"><div className="native-send-fields">
   <p className="native-send-review-amount">{order.amount} XMR</p>
   <label>ChangeNOW deposit address</label><div className="native-send-address">{order.payin}</div>
   {r&&state.phase!=='sent'&&<dl className="native-send-costs"><div><dt>Network fee</dt><dd>{xmrText(r.feeRaw)} XMR</dd></div><div><dt>Total</dt><dd>{xmrText(BigInt(r.amountRaw)+BigInt(r.feeRaw))} XMR</dd></div><div><dt>Exchange ID</dt><dd>{order.id}</dd></div></dl>}
   {state.phase==='review'&&<p className="native-send-help">Paid from this wallet. Monero payments cannot be reversed. This review is valid for two minutes.</p>}
   {state.phase==='sent'&&<a className="native-send-explorer" href={'https://xmrchain.net/tx/'+state.hash} target="_blank" rel="noopener noreferrer">View payment ↗</a>}
  </div></div>
  <div className="native-send-footer">
   {state.phase==='preparing'&&<p className="native-send-message" role="status">Checking your unlocked XMR and the network fee…</p>}
   {state.phase==='sending'&&<p className="native-send-message" role="status">Sending to the Monero network…</p>}
   {state.phase==='sent'&&<p className="native-send-message" role="status">Payment sent. ChangeNOW exchanges it after its confirmations and sends SOL to your Solana wallet.</p>}
   <p className="native-send-error" role="alert" hidden={!state.error}>{state.phase==='uncertain'?'Payment status unknown: check the exchange status before paying again. ':''}{state.error}</p>
   <div className="native-send-actions">
    {state.phase==='review'&&<><button type="button" className="native-secondary" onClick={cancel}>Cancel</button><button type="button" className="native-primary" onClick={()=>void pay()}>Pay {order.amount} XMR</button></>}
    {state.phase==='error'&&<><button type="button" className="native-secondary" onClick={cancel}>Cancel</button>{carrierCheck?<button type="button" className="native-primary" onClick={()=>void checkCoins()}>Check coins</button>:<button type="button" className="native-primary" onClick={()=>void prepare()}>Review again</button>}</>}
    {['preparing','sending'].includes(state.phase)&&<button type="button" className="native-secondary" disabled>Working…</button>}
    {['sent','uncertain'].includes(state.phase)&&<button type="button" className="native-primary" onClick={()=>onBack(order.requestId)}>Show exchange status</button>}
   </div></div></div>
 </main></div>;
}
