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

export default function WebsiteNativeSwap({owner,provider,moneroAddress,onClose}){
 const host=useRef(null),wrap=useRef(null),close=useRef(onClose),[payment,setPayment]=useState(null),[resume,setResume]=useState(null);
 close.current=onClose;
 const store=useMemo(()=>swapOrderStore(owner),[owner]);
 useEffect(()=>{
  if(payment)return;
  let live=true;
  const current=()=>{if(!live)throw Error('Exchange closed.');provider?.assertCurrent?.();if(provider?.publicKey?.toBase58?.()!==owner)throw Error('Wallet changed. Reconnect before continuing.');};
  const page=createNativeSwapPage({container:host.current,account:{solana:owner,monero:moneroAddress||''},assertCurrent:current,onClose:()=>close.current(),
   // The shared page asks https://xmr20.org/api/native-swap; ask this site's own /api/native-swap instead (the same URL on
   // xmr20.org; the local preview forwards it), since a cross-site request is refused by the browser ("Failed to fetch").
   fetcher:(url,init)=>fetch(new URL(url).pathname,init),
   balance:async direction=>{
    if(direction!=='sol-xmr')return null;
    const raw=websiteSolBalance()??String(await solanaRpc().getBalance(new PublicKey(owner)));current();return solShort(raw)+' SOL';
   },
   loadOrders:()=>store.load(),saveOrder:async order=>{current();store.save(order);},
   maximum:async direction=>{
    current();if(direction!=='sol-xmr')throw Error('Enter the XMR amount. Paying XMR from the website is not available yet.');
    const raw=await solanaMaximum(owner,PublicKey.default.toBase58(),{rpc:solanaRpc()});current();return raw;
   },
   onPay:order=>{current();setPayment(order);}});
  page.open(resume);const logos=siteCoinLogos(host.current);
  return()=>{live=false;logos();page.close();};
 },[owner,provider,moneroAddress,payment,resume,store]);
 useEffect(()=>{
  if(!provider?.on)return;const changed=()=>close.current();
  provider.on('accountChanged',changed);provider.on('disconnect',changed);
  return()=>{provider.removeListener?.('accountChanged',changed);provider.removeListener?.('disconnect',changed);};
 },[provider]);
 useEffect(()=>fitWalletPanel(wrap.current),[]);
 const back=requestId=>{setResume(requestId);setPayment(null);};
 return <div ref={wrap} className="website-native-page native-popup-root native-send-window">{payment
  ?<SwapPayment order={payment} owner={owner} provider={provider} store={store} onBack={back}/>
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
