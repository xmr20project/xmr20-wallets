import React,{useEffect,useId,useRef,useState} from 'react';
import {prepareSolanaTokenSend,signAndSubmitSolanaTokenSend,checkSolanaTokenSend} from './wallet-sol-send.js';
import {WXMR} from './wxmr-bridge.js';

// 30 Oct 2026 (owner: wXMR held in the connected wallet shows "send, bridge" on hover). Send wXMR to another Solana wallet,
// the same review and signing checks as the XMR20 token Send (wallet-sol-send.js), with wXMR's 12 decimals.
const ONE=1000000000000n;
const text=raw=>{const n=BigInt(raw),f=String(n%ONE).padStart(12,'0').replace(/0+$/,'');return String(n/ONE)+(f?'.'+f:'');};
const shown=raw=>{const n=BigInt(raw),f=String(n%ONE).padStart(12,'0').slice(0,6).replace(/0+$/,'');return String(n/ONE)+(f?'.'+f:'');};
const row={mint:WXMR.mint.toBase58(),decimals:12,ticker:'wXMR'};
export default function WebsiteWxmrSend({owner,provider,balanceRaw,onSent,onClose}){
 const [amount,setAmount]=useState(''),[to,setTo]=useState(''),[prepared,setPrepared]=useState(null),[receipt,setReceipt]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),amountId=useId();useEffect(()=>()=>{alive.current=false;},[]);
 const edit=()=>{setPrepared(null);setError('');};
 async function run(work){if(busy)return;setBusy(true);setError('');try{await work();}catch(e){if(alive.current)setError(e?.message||'This step could not finish. Nothing was sent.');}finally{if(alive.current)setBusy(false);}}
 const review=()=>run(async()=>{const recipient=to.trim();if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recipient))throw Error('Enter a Solana wallet address.');
  const p=await prepareSolanaTokenSend({row,owner,to:recipient,amount:amount.trim()});if(alive.current)setPrepared({...p,to:recipient,amount:amount.trim()});});
 const send=()=>run(async()=>{const p=prepared;
  const r=await signAndSubmitSolanaTokenSend({prepared:p,provider,owner,row,to:p.to,amount:p.amount,assertCurrent:()=>{if(!alive.current)throw Error('Send closed.');},onSubmitted:x=>{if(alive.current)setReceipt(x);}});
  if(!alive.current)return;setReceipt(r);setPrepared(null);onSent?.();});
 return <div className="wallet-action-sheet" role="region" aria-label="Send wXMR">
  <div className="wallet-action-head"><strong>Send wXMR</strong><button type="button" aria-label="Close action" onClick={onClose}>×</button></div>
  {!receipt&&<><p>{shown(balanceRaw)} wXMR available</p>
   <div style={{margin:'12px 0'}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}><label htmlFor={amountId} style={{margin:0}}>Amount</label><button type="button" aria-label="Use maximum send amount" disabled={busy||BigInt(balanceRaw)<=0n} onClick={()=>{edit();setAmount(text(balanceRaw));}} style={{minHeight:44,padding:'4px 12px',margin:0}}>Max</button></div>
    <input id={amountId} inputMode="decimal" value={amount} onChange={e=>{edit();setAmount(e.target.value);}} placeholder="0" autoComplete="off" disabled={busy}/></div>
   <p className="wallet-action-note">SOL network fees are paid separately.</p>
   <label>Recipient Solana address<input value={to} onChange={e=>{edit();setTo(e.target.value);}} autoComplete="off" spellCheck={false} disabled={busy}/></label>
   {!prepared&&<button type="button" disabled={busy||!amount.trim()||!to.trim()} onClick={review}>Review send</button>}
   {prepared&&<div className="wallet-action-review"><p>Send {shown(rawOf(prepared.amount))} wXMR to {prepared.to.slice(0,8)}…{prepared.to.slice(-6)}.</p><p>Solana network and account costs also apply.</p><button type="button" disabled={busy} onClick={send}>Approve in Solana wallet</button><button type="button" disabled={busy} onClick={edit}>Edit</button></div>}</>}
  {receipt&&<p role="status">{receipt.confirmed?'Transfer confirmed':'Transfer submitted · confirmation pending'} · <a href={`https://solscan.io/tx/${receipt.signature}`} target="_blank" rel="noopener noreferrer">view receipt ↗</a>{!receipt.confirmed&&<button type="button" disabled={busy} onClick={()=>run(async()=>{const confirmed=await checkSolanaTokenSend(receipt.signature);if(alive.current)setReceipt({...receipt,confirmed});if(confirmed&&receipt.savedKey)sessionStorage.removeItem(receipt.savedKey);})}>Check confirmation</button>}</p>}
  {busy&&<p role="status" className="wallet-action-progress"><span className="wallet-action-spinner" aria-hidden="true"/>{prepared?'Waiting for your Solana wallet…':'Checking your request…'}</p>}{error&&<p role="alert" className="form-error">{error}</p>}
 </div>;
}
function rawOf(amount){const [w,f='']=amount.split('.');return (BigInt(w)*ONE+BigInt(f.padEnd(12,'0'))).toString();}
