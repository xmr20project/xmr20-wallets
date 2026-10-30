import React,{useEffect,useId,useRef,useState} from 'react';
import './cake-wallet.css';
import {sitePath} from './site-path.js';
const TEST_LAUNCH='5d2b9b2d-234c-4972-b1ae-00550e2c393a';
const date=v=>new Date(v).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'});
const amount=raw=>{const n=BigInt(raw),fraction=String(n%1000000n).padStart(6,'0').replace(/0+$/,'');return (n/1000000n).toLocaleString('en-GB')+(fraction?'.'+fraction:'');};

function Holdings({connection:c}){
  const s=c.snapshot;if(!s||s.address!==c.address)return null;
  const old=Date.now()-s.fetchedAt>180000||s.indexCheckedAt!==null&&Date.now()-s.indexCheckedAt>180000;
  const source=s.method==='individual-holder-records'?'https://api.xmr20.org/api/xmr20/tokens':'https://api.xmr20.org/api/wallet-holdings?network=monero&address='+encodeURIComponent(c.address);
  return <section className="cake-holdings" aria-labelledby="cake-holdings-title"><div className="cake-holdings-head"><h3 id="cake-holdings-title">XMR20 holdings</h3><button type="button" disabled={c.busy} onClick={c.lookup}>Refresh</button></div>
    <p className={'cake-status'+(c.proof?' cake-verified':'')}>{c.proof?'For your verified address':'Public address lookup · ownership unverified'}</p>
    <p className="cake-coverage">{s.available} of {s.checked} token records available · {s.unavailable} unavailable.{!s.complete||old?' Coverage is limited; missing or stale records cannot establish a zero balance.':''}</p>
    {s.limitation&&<p className="cake-coverage">{s.limitation}</p>}
    <div className="cake-token-list">{s.rows.map(row=><div className="cake-token" key={row.id}><div><strong>{row.ticker}</strong><small>{row.name}{row.id===TEST_LAUNCH?' · test token':!row.listed?' · unlisted':''}</small><small>{row.stale||old||Date.now()-row.checkedAt>180000?'Stale record':'Checked'} · {date(row.checkedAt)}</small></div><strong>{amount(row.amountRaw)}</strong></div>)}{!s.rows.length&&<p className="cake-coverage">No positive holdings were reported in the available records.</p>}</div>
    <p className="cake-source">Read from the <a href={source} target="_blank" rel="noopener noreferrer">public XMR20 index</a> · retrieved {date(s.fetchedAt)}.</p>
  </section>;
}

export default function CakeWalletConnect({connection:c,onBack}){
  const [signature,setSignature]=useState(''),[copied,setCopied]=useState('');
  const message=useRef(null),address=useRef(null),signatureInput=useRef(null),status=useRef(null),id=useId();
  useEffect(()=>{address.current?.focus();},[]);
  useEffect(()=>{setSignature('');setCopied('');},[c.challenge?.id,c.address]);
  useEffect(()=>{
    const field=message.current;if(!field)return;
    let width=field.clientWidth;
    const fit=()=>{field.style.height='auto';field.style.height=Math.max(100,field.scrollHeight+2)+'px';};
    fit();
    const resize=new ResizeObserver(()=>{if(field.clientWidth!==width){width=field.clientWidth;fit();}});
    resize.observe(field);return()=>resize.disconnect();
  },[c.challenge?.message]);
  async function copy(){try{await navigator.clipboard.writeText(c.challenge.message);setCopied('Exact message copied.');}catch{setCopied('Copy failed. Select the full message below and copy it.');}}
  async function verify(event){event.preventDefault();const passed=await c.verify(signature);if(passed){setSignature('');status.current?.focus();}}
  async function disconnect(){if(await c.disconnect())onBack();}
  const expired=c.challenge&&Date.now()>=c.challenge.expiresAt,subaddress=c.address.startsWith('8');
  return <div className="cake-connect wallet-panel-scroll">
    <button type="button" className="cake-back" disabled={c.busy} onClick={onBack}>← Wallet options</button>
    <div className="cake-heading"><img src={sitePath('/brand/cake-wallet.png')} alt=""/><div><h3>Cake Wallet</h3><p>Connect an existing Monero wallet</p></div></div>
    <p className="cake-intro">Prove ownership with a message signed in Cake, then view your XMR20 holdings. Your wallet and keys stay in Cake.</p>
    <p ref={status} tabIndex={-1} role="status" className={'cake-status'+(c.proof?' cake-verified':'')}>{c.proof?'Connected · ownership verified':expired?'Ownership unverified · challenge expired':'Ownership unverified'}</p>
    {c.proof&&<p className="cake-coverage">Verified until {date(c.proof.expiresAt)}. This read-only connection does not authorise transfers.</p>}
    <form onSubmit={event=>{event.preventDefault();void c.issue();}}>
      <label htmlFor={id+'-address'}>Primary Monero mainnet address</label>
      <textarea ref={address} id={id+'-address'} rows={3} value={c.address} onChange={event=>c.setAddress(event.target.value)} maxLength={106} spellCheck={false} autoComplete="off" autoCapitalize="off" required disabled={c.busy} aria-describedby={id+'-address-help'}/>
      <p id={id+'-address-help'} className="cake-coverage">Use your primary address in Cake (account 0, address 0). Address lookup alone does not prove ownership.</p>
      {subaddress&&<p className="cake-coverage">This is a subaddress. Public lookup is available, but ownership signing in this test requires your primary address.</p>}
      {!c.proof&&<div className="cake-actions"><button className="cake-primary" type="submit" disabled={c.busy||subaddress}>{c.challenge?'Generate a fresh message':'Generate ownership message'}</button><button type="button" disabled={c.busy||!c.address} onClick={c.lookup}>Look up address only</button></div>}
    </form>
    {c.challenge&&!c.proof&&<section className="cake-message-section"><h4>Sign this message manually in Cake</h4><p className="cake-coverage">Open Other → Sign / Verify, select this same primary address, and paste the complete message. Leave Cake’s signature field empty, press Sign Message, then copy the generated signature.</p>
      <label htmlFor={id+'-message'}>Non-transfer ownership challenge</label><textarea ref={message} id={id+'-message'} value={c.challenge.message} readOnly rows={4} spellCheck={false}/>
      <div className="cake-actions"><button type="button" onClick={copy} disabled={c.busy||expired}>Copy exact message</button></div><p role="status" className="cake-coverage">{copied||'One line; wrapping adds no line breaks.'}</p><p className="cake-coverage">Expires {date(c.challenge.expiresAt)}. {expired?'Generate a fresh message to continue.':''}</p>
      <form onSubmit={verify}><label htmlFor={id+'-signature'}>Cake message signature</label><textarea ref={signatureInput} id={id+'-signature'} value={signature} onChange={event=>setSignature(event.target.value)} rows={3} maxLength={120} spellCheck={false} autoComplete="off" autoCapitalize="off" required disabled={c.busy} placeholder="SigV2…"/><p className="cake-coverage">Paste only the message signature. Never a seed, private key or transaction key.</p><button className="cake-primary" type="submit" disabled={c.busy||expired}>Verify and connect</button></form>
    </section>}
    {c.notice&&<p role="status" className="cake-coverage">{c.notice}</p>}{c.error&&<p role="alert" className="cake-error">{c.error}</p>}
    <Holdings connection={c}/>
    {c.proof&&<div className="cake-actions"><button type="button" disabled={c.busy} onClick={disconnect}>Disconnect Cake Wallet</button></div>}
    <p className="cake-footnote">Ownership and read-only holdings. This connection has no transfer, bridge or transaction controls.</p>
  </div>;
}
