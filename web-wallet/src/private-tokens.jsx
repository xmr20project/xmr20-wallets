// XMR20 Open/Private tokens on Monero in the website wallet (28 Oct 2026, LOCAL ONLY): the extension's own token rows, drawn in a
// shadow root with the extension's stylesheet. They appear once "Sync XMR wallet" has unlocked this Monero wallet, which opens the
// token engine with the same phrase so XMR and XMR20 sync together.
import React,{useEffect,useRef,useState} from 'react';
import {PRIVATE_WALLET_CSS,currentWebsitePrivateWallet,subscribeWebsitePrivateWallet} from './private-wallet-host.js';

export default function PrivateTokenRows({address}){
 const [state,setState]=useState({wallet:currentWebsitePrivateWallet(),tick:0}),holder=useRef(null),shadow=useRef(null);
 useEffect(()=>subscribeWebsitePrivateWallet(wallet=>setState(s=>({wallet,tick:s.tick+1}))),[]);
 useEffect(()=>{
  if(!holder.current)return;shadow.current??=holder.current.attachShadow({mode:'open'});const root=shadow.current;
  const w=state.wallet?.account()?.xmr===address?state.wallet:null;
  holder.current.dataset.rows='';if(!w){root.innerHTML='';return;}
  // 30 Oct 2026 (owner: "why does "xmr20 tokens" still show on the right? I havent bridged … remove and fix this problem"): when the
  // token service cannot be reached, a wallet that holds no XMR20 on Monero shows nothing here; the "Unavailable right now" row stays
  // only for a wallet that held tokens when it was last read (the module lists no tokens while it is unavailable).
  const detach=w.attach(root),st=w.syncStatus(),key='xmr20-monero-tokens-held:'+address;
  try{if(!st.error&&!st.syncing){if(w.heldTokens().length)localStorage.setItem(key,'1');else localStorage.removeItem(key);}}catch{}
  const hadTokens=(()=>{try{return localStorage.getItem(key)==='1';}catch{return false;}})(),rows=st.error&&!hadTokens?'':w.rowsHTML();holder.current.dataset.rows=rows?'1':'';
  root.innerHTML=`<style>${PRIVATE_WALLET_CSS}</style><section class="token-section" aria-label="XMR20 on Monero" data-network="monero">${rows||(st.syncing?`<div class="empty" role="status"><strong>Reading XMR20 token history…${st.pct==null?'':' '+st.pct+'%'}</strong>The first time on this browser takes a few minutes; it picks up where it left off. Your tokens appear here when it finishes.</div>`:'')}</section>`;
  w.bind();return detach;
 },[state,address]);
 return <div ref={holder} className="xmr20-private-rows"/>;
}
