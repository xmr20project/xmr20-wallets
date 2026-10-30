import React,{useEffect,useRef,useState} from 'react';
import {Send,Split,ArrowLeftRight,X} from 'lucide-react';
import './website-native-page.css';
import './website-xmr-detail.css';
import {fitWalletPanel} from './website-native-panel.js';
import {sitePath} from './site-path.js';
import {xmrTxLabel,xmrTxTitle} from './xmr-tx-store.js';

// 29 Oct 2026 (owner: "when u click on monero, it shows the different options in the same kind of UI" as the XMR20 token
// screen: "send" "split" and "bridge" … "then under those buttons, would be the receiving monero address"). The Monero row
// opens this screen; each button opens its page and returns here.
const short=raw=>{const n=BigInt(raw),f=String(n%1000000000000n).padStart(12,'0').slice(0,6).replace(/0+$/,'');return String(n/1000000000000n)+(f?'.'+f:'');};
export default function WebsiteXmrDetail({address,balance,pending=[],onSend,onSplit,onBridge,onClose}){
 const wrap=useRef(null),[copied,setCopied]=useState(false);
 useEffect(()=>fitWalletPanel(wrap.current),[]);
 let locked=0n;try{locked=BigInt(balance?.balanceRaw??'0')-BigInt(balance?.unlockedRaw??'0');}catch{}
 const copy=()=>{void navigator.clipboard?.writeText(address).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1600);});};
 return <div ref={wrap} className="website-native-page native-popup-root"><div className="xmr-detail">
  <div className="xmr-detail-head"><h1>Monero</h1><button type="button" aria-label="Close" onClick={onClose}><X aria-hidden="true"/></button></div>
  <div className="xmr-detail-scroll">
   <div className="xmr-detail-hero"><span className="xmr-detail-coin"><img src={sitePath('/brand/monero-user.png')} alt=""/></span>
    <div className="xmr-detail-total">{balance?short(balance.balanceRaw):'—'}<span> XMR</span></div>
    {balance&&<small>{short(balance.unlockedRaw)} unlocked{locked>0n?` · ${short(String(locked))} confirming`:''}</small>}</div>
   <div className={'xmr-detail-actions'+(onBridge?'':' two')}>
    <button type="button" onClick={onSend}><Send aria-hidden="true"/><span>Send</span></button>
    <button type="button" onClick={onSplit}><Split aria-hidden="true"/><span>Split</span></button>
    {onBridge&&<button type="button" onClick={onBridge}><ArrowLeftRight aria-hidden="true"/><span>Bridge</span></button>}
   </div>
   {pending.length>0&&<div className="xmr-detail-card xmr-detail-pending"><div className="xmr-detail-card-head"><span>Pending</span></div>
    {pending.slice().reverse().map(r=><div className="xmr-detail-pending-row" key={r.hash}><span><strong>{xmrTxTitle(r)}</strong><small>{xmrTxLabel(r)}</small></span><a href={'https://xmrchain.net/tx/'+r.hash} target="_blank" rel="noopener noreferrer">View ↗</a></div>)}</div>}
   <div className="xmr-detail-card"><div className="xmr-detail-card-head"><span>Receive XMR</span><button type="button" onClick={copy}>{copied?'Copied':'Copy'}</button></div>
    <div className="xmr-detail-address">{address}</div><small>Your Monero address.</small></div>
  </div>
 </div></div>;
}

// 29 Oct 2026 (owner: "a bridge option like the current one we have with changenow, except add another option for wxmr"): Bridge
// on the Monero screen offers the two ways out of (and into) XMR.
export function WebsiteXmrBridgeChoice({onWxmr,onChangeNow,onClose}){
 const wrap=useRef(null);useEffect(()=>fitWalletPanel(wrap.current),[]);
 return <div ref={wrap} className="website-native-page native-popup-root"><div className="xmr-detail">
  <div className="xmr-detail-head"><h1>Bridge</h1><button type="button" aria-label="Back" onClick={onClose}><X aria-hidden="true"/></button></div>
  <div className="xmr-detail-scroll">
   <button type="button" className="xmr-detail-option" onClick={onWxmr}><span className="xmr-detail-option-icon"><img src={sitePath('/brand/monero-user.png')} alt=""/></span>
    <span className="xmr-detail-option-text"><strong>wXMR on Solana</strong><small>wxmr.io bridge · XMR ⇄ wXMR · 0.1% fee</small></span><ArrowLeftRight aria-hidden="true"/></button>
   {onChangeNow&&<button type="button" className="xmr-detail-option" onClick={onChangeNow}><span className="xmr-detail-option-icon"><img src={sitePath('/brand/solana.svg')} alt=""/></span>
    <span className="xmr-detail-option-text"><strong>SOL</strong><small>ChangeNOW exchange · XMR → SOL</small></span><ArrowLeftRight aria-hidden="true"/></button>}
  </div>
 </div></div>;
}
