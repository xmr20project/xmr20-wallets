import React,{useEffect,useRef,useState} from 'react';
import {request as defaultRequest} from './launch-api.js';
import WalletAssetAction from './wallet-asset-action.jsx';
import {resumableWithdrawals} from './bridge-restoration.js';
import {loadTokenCatalog} from './wallet-token-images.js';
import {pendingMoneroBridges} from './wallet-pending-bridges.js';
const fmt=raw=>new Intl.NumberFormat('en-GB',{minimumFractionDigits:2,maximumFractionDigits:6}).format(Number(raw)/1e6);
export default function PendingBridgeTokens({owner,address,confirmed=[],images=new Map(),pair,provider,request=defaultRequest,loadCatalog=loadTokenCatalog}){
 const [snapshot,setSnapshot]=useState(null),[delayed,setDelayed]=useState(false),[resuming,setResuming]=useState(null),[refreshVersion,setRefreshVersion]=useState(0);const prior=useRef(new Set());
 useEffect(()=>{let disposed=false,timer,inflight=false;setSnapshot(null);setDelayed(false);prior.current=new Set();
  async function refresh(){if(disposed||inflight||!owner)return;inflight=true;try{
   const [account,tokens]=await Promise.all([request('account'),loadCatalog().catch(()=>[])]);
   if(disposed)return;
   const completed=(account.transfers||[]).some(t=>prior.current.has(t.id)&&t.state==='complete');
   prior.current=new Set((account.transfers||[]).filter(t=>t.owner===owner&&t.moneroAddress===address&&['sol-to-xmr','xmr-to-sol'].includes(t.direction)&&t.state!=='complete').map(t=>t.id));
   setSnapshot({transfers:account.transfers||[],tokens});setDelayed(false);
   if(completed)window.dispatchEvent(new Event('xmr20-holdings-refresh'));
  }catch{if(!disposed)setDelayed(true)}finally{inflight=false}}
  void refresh();timer=setInterval(()=>{if(!document.hidden)void refresh()},8000);window.addEventListener('xmr20-bridge-updated',refresh);window.addEventListener('focus',refresh);
  return()=>{disposed=true;clearInterval(timer);window.removeEventListener('xmr20-bridge-updated',refresh);window.removeEventListener('focus',refresh)};
 },[owner,address,refreshVersion]);
 if(!snapshot)return <p role={delayed?"alert":"status"} className="wallet-index-note">{delayed?<>Saved bridges could not load. <button type="button" onClick={()=>setRefreshVersion(n=>n+1)}>Retry saved bridges</button></>:"Checking saved bridges…"}</p>;
 const rows=pendingMoneroBridges(snapshot?.transfers,{owner,address,tokens:snapshot?.tokens,confirmed});
 const outgoing=resumableWithdrawals(snapshot?.transfers,{owner,address,tokens:snapshot?.tokens});
 return rows.length||outgoing.length?<div className="wallet-pending-bridges" aria-label="Saved bridges">{outgoing.map(({transfer:t,row})=><div className="wallet-asset-wrap" key={t.id}><article className="wallet-asset wallet-pending-asset"><div className="wallet-asset-icon" aria-hidden="true">{images.get(row.mint)?<img src={images.get(row.mint)} alt=""/>:row.ticker.slice(0,1)}</div><div className="wallet-asset-info"><strong>${row.ticker}</strong><small>{fmt(t.amountRaw)} {row.ticker} · bridge to Solana</small><small>{t.state==='source_finalized'?'Monero confirmed · finish on Solana':t.state==='destination_pending'?'Approval sent · confirming on Solana':'Waiting for Monero confirmation'}</small></div><div className="wallet-asset-actions"><button type="button" onClick={()=>setResuming(t.id)}>Resume bridge</button></div></article>{resuming===t.id&&<WalletAssetAction key={t.id} row={row} kind="bridge" network="monero" address={address} owner={owner} pair={pair} provider={provider} resumeId={t.id} request={request} onClose={()=>setResuming(null)}/>}</div>)}{rows.map(r=><article className="wallet-asset wallet-pending-asset" key={r.id}>
  <div className="wallet-asset-icon" aria-hidden="true">{images.get(r.mint)?<img src={images.get(r.mint)} alt="" onError={e=>{e.currentTarget.hidden=true;e.currentTarget.parentNode.dataset.fallback=r.ticker.slice(0,1)}}/>:r.ticker.slice(0,1)}</div>
  <div className="wallet-asset-info"><strong>${r.ticker}</strong><small>{fmt(r.amountRaw)} {r.ticker} arriving</small><small>{delayed?'Status delayed · last checked':r.state==='source_pending'?'Confirming Solana transaction':r.state==='destination_pending'?`Waiting for Monero · ${r.confirmations}/10 confirmations`:'Preparing Monero credit'}</small><div style={{display:'flex',flexWrap:'wrap',gap:'8px 20px'}}>{r.destinationTxid&&<a className="wallet-pending-proof" href={'https://xmrchain.net/tx/'+r.destinationTxid} target="_blank" rel="noopener noreferrer">View Monero transaction ↗</a>}<a className="wallet-pending-proof" href={'https://solscan.io/tx/'+r.sourceSignature} target="_blank" rel="noopener noreferrer">View Solana transaction ↗</a></div></div>
  <span className="wallet-pending-label" role="status">Pending</span>
 </article>)}</div>:null;
}
