import React,{useEffect,useState} from 'react';
import {ArrowLeftRight} from 'lucide-react';
import {nativeDisplay,pendingNativeBridges,recordNativeBridge,NATIVE_HOLDINGS_EVENT} from './website-native-holdings.js';
import {createNativeSendClient} from '../../engine/shared/native-market/wallet/native-send-client.mjs';
import {nativeTokenMetadata} from '../../engine/shared/native-token-holdings.js';

const fmt=raw=>new Intl.NumberFormat('en-GB',{minimumFractionDigits:2,maximumFractionDigits:6}).format(Number(raw)/1e6);
const ago=ms=>ms<90000?'just now':ms<5400000?Math.round(ms/60000)+' min ago':ms<172800000?Math.round(ms/3600000)+' h ago':Math.round(ms/86400000)+' days ago';
const STATUS={solana:'Confirming on Solana',building:'Building the Monero transaction',sending:'Sending to Monero',
 confirmed:'Arrived on Monero · check balance to include it',rejected:'Needs attention · open Open new bridge → Saved entries'};
const OUT={solana:{sending:'Publishing on Monero',confirmed:'Monero confirmed · Solana payout follows',rejected:'Needs attention · open Bridge → Saved bridges'},
 address:{sending:'Publishing on Monero',confirmed:'Confirmed on Monero · check balance to update',rejected:'Needs attention · open Send → Saved sends'}};
function status(e,now){
 if(e.to&&e.stage!=='confirming')return OUT[e.to][e.stage];
 if(e.stage==='confirming')return 'Monero confirmations · '+Math.min(e.confirmations??0,e.required??10)+'/'+(e.required??10);
 if(['solana','building'].includes(e.stage)&&now-e.updatedAt>600000)return 'Paused · resume from Open new bridge → Saved entries';
 return STATUS[e.stage];
}

// The website wallet's Monero tab: one "Monero balance" check for every wallet, token rows
// only for what this wallet's last private scan in this browser found, and bridges still
// on their way in either direction.
export default function NativeMoneroTokens({address,image,onCheck,onSend,onBridge,statusClient}){
 const meta=nativeTokenMetadata(),[,setVersion]=useState(0),now=Date.now();
 useEffect(()=>{const changed=()=>setVersion(n=>n+1);addEventListener(NATIVE_HOLDINGS_EVENT,changed);addEventListener('storage',changed);
  return()=>{removeEventListener(NATIVE_HOLDINGS_EVENT,changed);removeEventListener('storage',changed);};},[]);
 // Keep in-flight Monero confirmations moving even after the bridge window is closed.
 useEffect(()=>{let live=true,busy=false;const api={credit:statusClient??createNativeSendClient({operation:'credit'}),burn:statusClient??createNativeSendClient({operation:'burn'}),send:statusClient??createNativeSendClient({operation:'send'})};
  async function poll(){if(busy||document.hidden)return;busy=true;try{
   for(const e of pendingNativeBridges(address).filter(e=>e.txid&&['sending','confirming'].includes(e.stage))){
    const value=await api[e.to==='solana'?'burn':e.to==='address'?'send':'credit'].status({txid:e.txid});if(!live)return;
    const accepted=['accepted','mempool','confirming','confirmed'].includes(value?.status);
    recordNativeBridge(address,{preparationId:e.preparationId,amountRaw:e.amountRaw,txid:e.txid,stage:value?.confirmed?'confirmed':value?.status==='rejected'?'rejected':accepted?'confirming':e.stage,
     ...(accepted&&Number.isSafeInteger(value.confirmations)?{confirmations:value.confirmations,required:value.requiredConfirmations}:{})});
   }}catch{}finally{busy=false;}}
  void poll();const timer=setInterval(()=>void poll(),30000);return()=>{live=false;clearInterval(timer);};},[address,statusClient]);
 if(!meta)return null;
 const display=nativeDisplay(address),pending=pendingNativeBridges(address),held=!!display&&BigInt(display.amountRaw)>0n;
 const icon=(src,letter)=><div className="wallet-asset-icon" aria-hidden="true">{src?<img src={src} alt="" onError={e=>{e.currentTarget.hidden=true;e.currentTarget.parentNode.dataset.fallback=letter;}}/>:letter}</div>;
 const token=icon(image,meta.ticker.slice(0,1)),when=display&&ago(Math.max(0,now-display.checkedAt));
 // The saved balance was read before a bridge to Solana or a send started, so it still includes it.
 const leaving=held&&pending.find(e=>e.to&&e.startedAt>display.checkedAt);
 return <div className="wallet-native-holdings" aria-label="Monero balance">
  {pending.map(e=><div className="wallet-asset-wrap" key={e.preparationId}><article className="wallet-asset wallet-pending-asset">{token}
   <div className="wallet-asset-info"><strong>${meta.ticker}</strong><small>{fmt(e.amountRaw)} {meta.ticker} {e.to==='solana'?(e.stage==='confirmed'?'sent to Solana':'leaving for Solana'):e.to==='address'?(e.stage==='confirmed'?'sent':'sending'):e.stage==='confirmed'?'arrived':'arriving'}</small><small>{status(e,now)}</small></div>
   <span className="wallet-pending-label" role="status">{e.stage==='confirmed'?(e.to?'Sent':'Arrived'):e.stage==='rejected'?'Check':'Pending'}</span>
  </article></div>)}
  {/* Token rows only for what this wallet's last check actually found. */}
  {held&&<div className="wallet-asset-wrap"><article className="wallet-asset">{token}
   <div className="wallet-asset-info"><strong>${meta.ticker}</strong><small>{fmt(display.amountRaw)} {meta.ticker}</small><small>{leaving?(leaving.to==='solana'?'Checked before your bridge to Solana':'Checked before your send'):'On Monero'}</small></div>
   {(onSend||onBridge)&&<div className="wallet-asset-actions">{onSend&&<button type="button" onClick={onSend}>Send</button>}{onBridge&&<button type="button" onClick={onBridge}>Bridge</button>}</div>}
  </article></div>}
  {/* No token artwork on the check itself; a token row with its artwork appears above only when one is found. */}
  <div className="wallet-asset-wrap"><article className="wallet-asset"><div className="wallet-asset-icon wallet-check-icon" aria-hidden="true"><ArrowLeftRight/></div>
   <div className="wallet-asset-info"><strong>Previously bridged tokens</strong><small>{!display?'Not checked in this browser yet':held?'Checked '+when:'None found · checked '+when}</small></div>
   <button type="button" className="wallet-secondary wallet-native-check" onClick={onCheck}>{display?'Refresh':'Check'}</button>
  </article></div>
 </div>;
}
