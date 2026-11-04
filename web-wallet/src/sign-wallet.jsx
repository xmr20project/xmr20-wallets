// Feather / Cake Wallet in the website wallet (2 Nov 2026; owner: "when people click "connect wallet" we can add feather wallet and
// cake wallet … let people view their token holdings by entering their cake/feather wallet … the moving tokens as a button in the
// connect wallet popup"). These wallets do not connect to websites: you enter the Monero address that holds XMR20 and this panel
// shows what it holds (public ledger state, no signature). Moving tokens: the relay prepares a short message, you sign it in your
// wallet (Feather: Tools → Sign/verify message; Cake: Settings → Other → Sign / Verify), paste the signature (checked here before
// anything is sent), then pay the 0.0001 XMR relay fee by QR code; the relay posts the move after one confirmation. Selling and
// buying happen on /market/ (sign-trade.mjs). Nothing here ever asks for a seed or a key.
import React,{useEffect,useRef,useState} from 'react';
import {Copy,Check} from 'lucide-react';
import {sitePath} from './site-path.js';
import {WALLET_NAMES,savedSignWallet,saveSignWallet,useSignWallet} from './sign-wallet-store.js';
import {decodeAddress,parseSignature,verifySpendSignature} from './sign-message.js';
import {qrMatrix,QR_LICENSE} from './qrcode.mjs';
import './sign-wallet.css';
// Local pages reach the bridge through the site's /api rewrite (as the profile page does); the live site calls api.xmr20.org.
const BRIDGE=document.documentElement.dataset.bridge||(location.origin==='https://xmr20.org'?'https://api.xmr20.org':location.origin)+'/api/private-bridge';
export const GUIDE={
 feather:{sign:'Tools → Sign/verify message',steps:['Open Tools → Sign/verify message.','Paste the message into the Message box.','In Address, enter the address shown after “from” (the one that holds the tokens).','Click Sign and copy the signature (it starts with SigV2).'],pay:'the Send tab (paste the address and the exact amount)',key:'History → double-click the payment → Tx key',sub:'Receive → Create new address'},
 cake:{sign:'Settings → Other → Sign / Verify',steps:['Open Settings → Other → Sign / Verify.','On Sign Message, paste the message.','Choose the address shown after “from”.','Tap Sign, then tap the signature to copy it.'],pay:'Send → scan the QR code',key:'Transactions → tap the payment → Transaction key',sub:'Receive → Addresses → add a subaddress'},
};
async function act(name,body){
 let r;try{r=await fetch(BRIDGE+'/action/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{}),credentials:'omit',cache:'no-store'});}
 catch{throw Error('The XMR20 service is not answering. Nothing was sent; try again in a moment.');}
 const v=await r.json().catch(()=>({}));if(!r.ok)throw Error(v.error||'The service refused this request ('+r.status+').');return v;}
const group=s=>{const [w,f]=String(s).split('.');return w.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(f?'.'+f:'');};
const plain=(atomic,d)=>{const s=BigInt(atomic).toString().padStart(d+1,'0'),f=s.slice(-d).replace(/0+$/,'');return s.slice(0,-d)+(f?'.'+f:'');};
const units=(atomic,d=6)=>group(plain(atomic,d));
const xmr=p=>plain(p,12);
function toAtoms(text,d){const t=String(text).trim().replace(/[,\s_]/g,'');const m=new RegExp(`^(\\d+)(?:\\.(\\d{1,${d}}))?$`).exec(t);if(!m)throw Error(`Enter a number with up to ${d} decimals.`);const v=BigInt(m[1])*10n**BigInt(d)+BigInt((m[2]||'').padEnd(d,'0'));if(v<=0n)throw Error('Enter an amount above 0.');return v;}
const short=a=>a?a.slice(0,8)+'…'+a.slice(-6):'';
const SUFFIX=['','\n','\r\n'];
const RESUME='xmr20-sign-move';
const resume={get(){try{return JSON.parse(sessionStorage.getItem(RESUME)||'null');}catch{return null;}},set(v){try{v?sessionStorage.setItem(RESUME,JSON.stringify(v)):sessionStorage.removeItem(RESUME);}catch{}}};
const held=h=>(h?.tokens||[]).filter(t=>t.mint&&BigInt(t.amount)>0n);

function QR({text,label}){const q=qrMatrix(text,'M'),n=q.size,m=4;let d='';for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(q.dark(x,y))d+=`M${x+m} ${y+m}h1v1h-1z`;
 return <svg viewBox={`0 0 ${n+2*m} ${n+2*m}`} role="img" aria-label={label} shapeRendering="crispEdges" data-license={QR_LICENSE}><rect width="100%" height="100%" fill="#fff"/><path d={d} fill="#000"/></svg>;}
function CopyBtn({value,label='Copy'}){const [done,setDone]=useState(false);
 return <button type="button" className="sw-copy" aria-label={'Copy '+label} onClick={()=>{void navigator.clipboard?.writeText(value).then(()=>{setDone(true);setTimeout(()=>setDone(false),1400);});}}>{done?<Check aria-hidden="true"/>:<Copy aria-hidden="true"/>}{done?'Copied':label}</button>;}
const Logo=({kind})=><img className="sw-logo" src={sitePath(kind==='cake'?'/brand/cake-wallet.png':'/brand/feather.svg')} alt=""/>;

export default function SignWallet({kind:startKind,onBack,wallet}){
 const saved=useSignWallet(),kind=saved?.kind||(WALLET_NAMES[startKind]?startKind:'feather'),name=WALLET_NAMES[kind],g=GUIDE[kind];
 const [view,setView]=useState(()=>saved?(resume.get()?'move':'home'):'connect');
 useEffect(()=>{setView(saved?'home':'connect');},[saved?.address]);
 // The profile page's "Move tokens" button opens the wallet window on the move step.
 useEffect(()=>{const on=()=>{if(savedSignWallet())setView('move');};addEventListener('xmr20-sign-move',on);return()=>removeEventListener('xmr20-sign-move',on);},[]);
 const [holding,setHolding]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=async address=>{setBusy(true);setError('');try{const h=await act('addressHoldings',{address});setHolding(h);return h;}catch(e){setError(e.message);return null;}finally{setBusy(false);}};
 useEffect(()=>{if(saved)void load(saved.address);else setHolding(null);},[saved?.address]);
 if(view==='how')return <HowItWorks kind={kind} onBack={()=>setView(saved?'home':'connect')}/>;
 if(view==='connect'||!saved)return <Connect kind={kind} busy={busy} error={error} onBack={onBack} onHow={()=>setView('how')}
  onConnect={async text=>{const address=text.trim();try{decodeAddress(address,'mainnet');}catch{setError('Enter a Monero mainnet address: 95 characters, starting with 4 or 8.');return;}
   const h=await load(address);if(h){saveSignWallet({kind,address});setView('home');}}}/>;
 if(view==='move')return <Move kind={kind} address={saved.address} holding={holding} onBack={()=>{setView('home');void load(saved.address);}}/>;
 const tokens=held(holding);
 return <div className="sw">
  <div className="sw-id"><Logo kind={kind}/><div><strong>{name}</strong><small className="sw-addr" title={saved.address}>{short(saved.address)}</small></div><CopyBtn value={saved.address} label="address"/></div>
  <div className="wallet-assets-head"><h3>XMR20 at this address</h3><button type="button" aria-label="Refresh" disabled={busy} onClick={()=>void load(saved.address)}>↻</button></div>
  {!holding&&!error&&<p role="status" className="small">Reading the token ledger…</p>}
  {error&&<p role="alert" className="form-error">{error}</p>}
  {holding&&(tokens.length?tokens.map(t=><div className="wallet-asset sw-asset" key={t.asset}><span className="wallet-asset-icon" data-fallback={(t.symbol||'X').slice(0,1)}/><div className="wallet-asset-info"><strong>{t.symbol||'XMR20 token'}</strong><small>Open token · held by this address</small></div><strong className="wallet-asset-usd">{units(t.amount,t.decimals??6)}</strong></div>)
   :<p className="sw-note">No XMR20 at this address yet. Anyone can send XMR20 to it from an XMR20 wallet, or buy a lot on the Monero Market with this address.</p>)}
  {holding&&holding.credit!=='0'&&<p className="sw-note">Fee credit: {xmr(holding.credit)} XMR from an earlier payment. Your next move uses it first.</p>}
  <div className="sw-actions"><button type="button" className="wallet-setup-primary" disabled={!tokens.length} onClick={()=>setView('move')}>Move tokens</button>
   <a className="wallet-setup-import" href={'/market/#'+kind} onClick={e=>{if(location.pathname.startsWith('/market')){e.preventDefault();wallet?.setOpen(false);location.hash='';location.hash=kind;}}}>Sell or buy on the Monero Market</a></div>
  <p className="sw-tips">Viewing needs no signature. Moving, selling and buying each require one message signed in {name} with this address. A signature proves control of the address; it does not spend from it or expose any key. <button type="button" className="sw-link" onClick={()=>setView('how')}>How it works</button></p>
  <div className="wallet-foot"><button type="button" className="wallet-disconnect" onClick={()=>{saveSignWallet(null);resume.set(null);onBack();}}>Forget this address</button></div>
 </div>;
}

function Connect({kind,busy,error,onBack,onHow,onConnect}){
 const name=WALLET_NAMES[kind],g=GUIDE[kind],[text,setText]=useState('');
 return <form className="sw" onSubmit={e=>{e.preventDefault();void onConnect(text);}}>
  <div className="sw-id"><Logo kind={kind}/><div><strong>{name}</strong><small>Any Monero wallet that can sign a message</small></div></div>
  <p>{name} does not connect to websites, and nothing here asks for your seed or keys. Enter the address where you hold XMR20 to see it here; moving, selling and buying then each need one message signed in {name}.</p>
  <label className="sw-label">Your Monero address (main address or subaddress)<input value={text} onChange={e=>setText(e.target.value)} maxLength={106} autoComplete="off" spellCheck={false} placeholder="4… or 8…" autoFocus/></label>
  {error&&<p role="alert" className="form-error">{error}</p>}
  <div className="sw-actions"><button type="submit" className="wallet-setup-primary" disabled={busy||!text.trim()}>{busy?'Reading the ledger…':'View holdings'}</button><button type="button" className="wallet-setup-import" onClick={onBack}>Back</button></div>
  <div className="sw-tips-box"><p><b>Use a subaddress just for XMR20.</b> Make one in {name} ({g.sub}) and receive your tokens there. It keeps the tokens apart from your XMR, and the address you sign with is simply the one that holds them.</p>
   <p><b>About message signing.</b> A signed message proves control of the address without spending from it or exposing any key. Each message states exactly what it authorises and expires at a set block; it cannot be used for anything else.</p>
   <button type="button" className="sw-link" onClick={onHow}>How it all works</button></div>
 </form>;
}

function HowItWorks({kind,onBack}){
 const name=WALLET_NAMES[kind],g=GUIDE[kind];
 return <div className="sw">
  <h3>Use {name} with XMR20</h3>
  <p>{name} does not connect to websites. You use it by signing messages in it and paying from it. Nobody holds your tokens or your XMR, and nothing here asks for a seed or a key.</p>
  <ol className="sw-steps">
   <li><b>Hold.</b> XMR20 can sit at any Monero address. Make a subaddress just for tokens ({g.sub}); you can keep your XMR in another address, even another wallet.</li>
   <li><b>Move.</b> Press <span className="sw-ui">Move tokens</span>, sign the message in {g.sign}, and pay the 0.0001 XMR network fee by QR code. The move is posted after one confirmation.</li>
   <li><b>Sell.</b> On the Monero Market, list an amount at a price by signing the listing message, and pay the listing fee by QR code.</li>
   <li><b>Buy.</b> Reserve a lot by signing, pay the exact amount to the seller from {g.pay}, then paste the payment’s transaction ID and key ({g.key}).</li>
  </ol>
  <p className="sw-note"><b>Message signatures.</b> A signature proves control of the address; it does not spend from it or expose any key. Each message states exactly what it authorises (which tokens, to whom, until which block), and every XMR20 wallet verifies it before the move counts.</p>
  <p className="sw-note">Experimental: every XMR20 wallet verifies each signature and payment itself.</p>
  <div className="sw-actions"><button type="button" className="wallet-setup-import" onClick={onBack}>Back</button></div>
 </div>;
}

// Move tokens from the watched address: form → sign → pay (QR) → done. A move in progress survives a reload of this tab.
function Move({kind,address,holding,onBack}){
 const name=WALLET_NAMES[kind],g=GUIDE[kind],tokens=held(holding);
 const [step,setStep]=useState(()=>resume.get()?'pay':'form'),[mint,setMint]=useState(tokens[0]?.mint||''),[to,setTo]=useState(''),[amount,setAmount]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [prepared,setPrepared]=useState(null),[sig,setSig]=useState(''),[move,setMove]=useState(null),poll=useRef(null);
 useEffect(()=>{if(!mint&&tokens[0])setMint(tokens[0].mint);},[tokens.length]);
 const token=tokens.find(t=>t.mint===mint),dec=token?.decimals??6;
 const credit=holding&&BigInt(holding.credit||'0')>=BigInt(holding.price||'100000000');
 useEffect(()=>{const r=resume.get();if(r?.id&&r.from===address)act('moveStatus',{id:r.id}).then(m=>{setMove(m);setStep('pay');}).catch(()=>{resume.set(null);setStep('form');});else if(r)resume.set(null);},[address]);
 useEffect(()=>{if(step!=='pay'||!move?.id||['done','expired','failed'].includes(move.status))return;poll.current=setInterval(()=>act('moveStatus',{id:move.id}).then(setMove).catch(()=>{}),5000);return()=>clearInterval(poll.current);},[step,move?.id,move?.status]);
 useEffect(()=>{if(move&&['done','expired','failed'].includes(move.status))resume.set(null);},[move?.status]);
 let check=null;if(prepared&&sig.trim()){try{parseSignature(sig.trim());const ok=SUFFIX.some(x=>verifySpendSignature(prepared.text+x,address,sig.trim(),'mainnet'));check={ok,text:ok?`Signed by the spend key of ${short(address)}. Checked in this browser.`:'This signature is not for this exact message from this address. Sign the message above with the address shown after “from”.'};}catch(e){check={ok:false,text:e.message};}}
 async function prepare(e){e.preventDefault();setError('');
  try{decodeAddress(to.trim(),'mainnet');}catch{setError('Enter the Monero address to send to (95 characters).');return;}
  let atoms;try{if(!token)throw Error('Choose a token.');atoms=toAtoms(amount,dec);if(atoms>BigInt(token.amount))throw Error('This address does not hold that much.');}catch(err){setError(err.message);return;}
  setBusy(true);try{setPrepared(await act('movePrepare',{from:address,to:to.trim(),amount:atoms.toString(),mint}));setSig('');setStep('sign');}catch(err){setError(err.message);}finally{setBusy(false);}}
 async function submit(){setError('');setBusy(true);try{const m=await act('moveSubmit',{body:prepared.body,signature:sig.trim()});resume.set({id:m.id,from:address});setMove(m);setStep('pay');}catch(err){setError(err.message);}finally{setBusy(false);}}
 if(step==='form')return <form className="sw" onSubmit={prepare}>
  <h3>Move tokens</h3><p className="sw-note">From <span className="sw-mono">{short(address)}</span> to any Monero address. An XMR20 wallet’s address works too: the tokens land in its normal balance.</p>
  <label className="sw-label">Token<select value={mint} onChange={e=>{setMint(e.target.value);setAmount('');}}>{tokens.map(t=><option key={t.mint} value={t.mint}>{t.symbol||'XMR20 token'} · {units(t.amount,t.decimals??6)}</option>)}</select></label>
  <label className="sw-label">To (Monero address)<input value={to} onChange={e=>setTo(e.target.value)} maxLength={106} autoComplete="off" spellCheck={false} placeholder="4… or 8…"/></label>
  <label className="sw-label">Amount<span className="sw-row"><input value={amount} onChange={e=>setAmount(e.target.value)} inputMode="decimal" autoComplete="off" placeholder="0"/><button type="button" className="sw-max" onClick={()=>setAmount(token?plain(token.amount,dec):'')}>Max</button></span></label>
  <p className="sw-note">{credit?'Network fee: paid from your fee credit.':`Network fee: ${xmr(holding?.price||'100000000')} XMR, paid from your own wallet after you sign. It pays the relay that puts your move on the Monero chain.`}</p>
  {error&&<p role="alert" className="form-error">{error}</p>}
  <div className="sw-actions"><button type="submit" className="wallet-setup-primary" disabled={busy||!token}>{busy?'Preparing…':'Make the message to sign'}</button><button type="button" className="wallet-setup-import" onClick={onBack}>Back</button></div>
 </form>;
 if(step==='sign')return <div className="sw">
  <h3>Sign it in {name}</h3>
  <div className="sw-text"><pre>{prepared.text}</pre><CopyBtn value={prepared.text} label="message"/></div>
  <ol className="sw-steps sw-small">{g.steps.map((s,i)=><li key={i}>{s}</li>)}</ol>
  <label className="sw-label">Paste the signature<textarea rows={3} value={sig} onChange={e=>setSig(e.target.value)} spellCheck={false} placeholder="SigV2…"/></label>
  {check&&<p role="status" className={'sw-check '+(check.ok?'ok':'bad')}>{check.text}</p>}
  {error&&<p role="alert" className="form-error">{error}</p>}
  <div className="sw-actions"><button type="button" className="wallet-setup-primary" disabled={busy||!check?.ok} onClick={()=>void submit()}>{busy?'Sending…':'Continue to payment'}</button><button type="button" className="wallet-setup-import" onClick={()=>setStep('form')}>Back</button></div>
 </div>;
 if(step==='pay'){if(!move)return <p role="status" className="small">Loading your move…</p>;
  const p=move.payment,st=move.status;const line=st==='waiting'?'Waiting for your payment. It shows here once it is in a block (usually a few minutes).':st==='seen'?`Received ${xmr(p?.confirmed||'0')} of ${xmr(move.price)} XMR. Send the rest to the same address.`:st==='built'||st==='posted'?`Paid. Your move is on its way to the Monero chain${move.txid?` (transaction ${move.txid.slice(0,10)}…)`:''}.`:st==='done'?`Done. ${move.amount||'Your tokens'} sent to ${short(move.to)}${move.txid?` in transaction ${move.txid.slice(0,16)}…`:''}.`:st==='expired'?'This move expired before the payment arrived. Any payment to this address counts as credit for your next move.':st==='failed'?`This move could not go through: ${move.error||'the tokens were moved meanwhile'} Your payment is kept as credit for your next move from this address.`:st;
  const cls=st==='done'||st==='built'||st==='posted'?'ok':st==='expired'||st==='failed'?'bad':'';
  return <div className="sw">
   <h3>{st==='done'?'Sent':'Pay the network fee'}</h3>
   {st!=='done'&&<p className="sw-note">Send exactly this from your wallet. Your move is put on the Monero chain once the payment has 1 confirmation (usually a few minutes).</p>}
   {st!=='done'&&<div className="sw-pay"><div className="sw-qr"><QR text={move.uri} label="QR code with the payment address and amount"/></div><div className="sw-pay-rows">
    <div className="sw-pay-row"><span>Amount</span><b>{xmr(move.price)} XMR</b><CopyBtn value={xmr(move.price)}/></div>
    <div className="sw-pay-row"><span>To</span><code>{move.payTo}</code><CopyBtn value={move.payTo}/></div>
    <a className="sw-open" href={move.uri}>Open in my wallet</a><small>Scan with Cake Wallet (Send → scan) or paste into Feather’s Send tab.</small></div></div>}
   <p role="status" className={'sw-check '+cls}>{line}</p>
   <div className="sw-actions"><button type="button" className="wallet-setup-import" onClick={onBack}>{st==='done'?'Back to holdings':'Close (the move keeps running)'}</button></div>
  </div>;}
 return null;
}
