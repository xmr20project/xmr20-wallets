import React,{Suspense,lazy,useEffect,useMemo,useRef,useState} from 'react';
import {Copy,Check,ExternalLink,Pencil,Wallet,LayoutGrid,History,X} from 'lucide-react';
import {useWallet} from './wallet-session.jsx';
import {sitePath} from './site-path.js';
import {loadWalletHoldings,cachedWalletHoldings} from './wallet-holdings.js';
import {loadSolanaWalletHoldings} from './solana-chain-holdings.js';
import {loadXmrTxs,refreshXmrTxStatus,xmrTxLabel,xmrTxTitle,openXmrTxs} from './xmr-tx-store.js';
import {currentWebsitePrivateWallet,subscribeWebsitePrivateWallet,websiteAccountId} from './private-wallet-host.js';
import {loadSitePrices,loadTokenPrices} from './site-prices.js';
import {loadTokenImages} from './wallet-token-images.js';
import {swapOrderStore} from './website-native-swap.js';
import {ACCENTS,NAME_MAX,BIO_MAX,loadProfile,saveProfile,defaultAccent,initials,loadBridgeDeposits} from './profile-store.js';
import './wallet.css';
import './wallet-premium.css';
import './profile-page.css';
const WalletLibrary=lazy(()=>import('./wallet-library.jsx'));
const TokenHoldings=lazy(()=>import('./wallet-library.jsx').then(m=>({default:m.TokenHoldings})));

// XMR20 profile page (29 Oct 2026, owner: "a new page, where people can see their whole wallet and portfolio … when you click on
// your connected wallet top right of screen, it will show "my profile" where users can create a profile, and then here they can
// access their wallet, their solana and monero holdings and use the wallet in this larger display"). /profile/ mounts this into
// #xmr20-profile-root from the site's wallet bundle (wallet-entry.jsx), so it shares the header's wallet connection.
//   Portfolio: what the connected Solana wallet and its Monero wallet hold, with USD estimates (display only).
//   Wallet:    the real wallet panels side by side, larger: every send, bridge and token screen works as in the wallet window.
//   Activity:  sends, exchanges and wXMR requests this browser has recorded.
const usdFmt=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2});
const usd=v=>v==null||!Number.isFinite(v)?'—':usdFmt.format(v);
const num=(v,max=4)=>new Intl.NumberFormat('en-GB',{minimumFractionDigits:0,maximumFractionDigits:max}).format(v);
const short=a=>a?a.slice(0,6)+'…'+a.slice(-6):'';
const atomic=(raw,decimals)=>{try{return Number(BigInt(raw))/10**decimals;}catch{return 0;}};
const when=t=>t?new Date(t).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';

function useHoldings(address,network){
 const [data,setData]=useState(()=>address?cachedWalletHoldings(address,{network}):null);
 useEffect(()=>{if(!address){setData(null);return;}const abort=new AbortController();setData(cachedWalletHoldings(address,{network}));
  // Solana: chain balances with the index (solana-chain-holdings.js), including wXMR (wxmrRaw).
  const load=()=>(network==='solana'?loadSolanaWalletHoldings(address):loadWalletHoldings(address,{signal:abort.signal,network})).then(d=>{if(!abort.signal.aborted)setData(d);}).catch(()=>{});
  void load();const t=setInterval(()=>{if(!document.hidden)void load();},60000);return()=>{abort.abort();clearInterval(t);};},[address,network]);
 return data;
}
function CopyChip({label,value,link}){
 const [done,setDone]=useState(false);
 return <span className="xp-chip"><span className="xp-chip-label">{label}</span><span className="xp-chip-value" title={value}>{short(value)}</span>
  <button type="button" aria-label={'Copy '+label+' address'} onClick={()=>{void navigator.clipboard?.writeText(value).then(()=>{setDone(true);setTimeout(()=>setDone(false),1400);});}}>{done?<Check aria-hidden="true"/>:<Copy aria-hidden="true"/>}</button>
  {link&&<a href={link} target="_blank" rel="noopener noreferrer" aria-label={'View '+label+' address'}><ExternalLink aria-hidden="true"/></a>}</span>;
}
function Avatar({profile,owner,size='big'}){const accent=profile?.accent||defaultAccent(owner);return <span className={'xp-avatar xp-'+size+' xp-accent-'+accent} aria-hidden="true">{initials(profile?.name,owner)}</span>;}

function EditProfile({owner,profile,onSaved,onClose}){
 const [name,setName]=useState(profile?.name||''),[bio,setBio]=useState(profile?.bio||''),[accent,setAccent]=useState(profile?.accent||defaultAccent(owner)),[error,setError]=useState('');
 useEffect(()=>{const esc=e=>{if(e.key==='Escape')onClose();};addEventListener('keydown',esc);return()=>removeEventListener('keydown',esc);},[]);
 return <div className="xp-modal" role="dialog" aria-modal="true" aria-labelledby="xp-edit-title" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
  <form className="xp-modal-card" onSubmit={e=>{e.preventDefault();try{onSaved(saveProfile(owner,{name,bio,accent}));}catch(err){setError(err.message);}}}>
   <div className="xp-modal-head"><h2 id="xp-edit-title">{profile?'Edit profile':'Create your profile'}</h2><button type="button" aria-label="Close" onClick={onClose}><X aria-hidden="true"/></button></div>
   <div className="xp-edit-preview"><Avatar profile={{name,accent}} owner={owner}/><div><strong>{name.trim()||short(owner)}</strong><small>{bio.trim()||'No bio yet'}</small></div></div>
   <label>Display name<input value={name} maxLength={NAME_MAX} autoComplete="off" placeholder={short(owner)} onChange={e=>setName(e.target.value)}/></label>
   <label>Bio<textarea rows="3" value={bio} maxLength={BIO_MAX} placeholder="A line about you" onChange={e=>setBio(e.target.value)}/><small>{bio.length}/{BIO_MAX}</small></label>
   <fieldset className="xp-accents"><legend>Colour</legend>{ACCENTS.map(a=><button type="button" key={a} aria-label={a} aria-pressed={accent===a} className={'xp-swatch xp-accent-'+a} onClick={()=>setAccent(a)}/>)}</fieldset>
   <p className="xp-note">Saved in this browser for this wallet. Nothing is published.</p>
   {error&&<p className="xp-error" role="alert">{error}</p>}
   <div className="xp-modal-actions"><button type="button" className="xp-btn xp-ghost" onClick={onClose}>Cancel</button><button type="submit" className="xp-btn xp-primary">Save profile</button></div>
  </form></div>;
}

function ConnectFirst({w}){
 // The header restores a saved connection right after the first render (busy while it runs): decide only after that has had its
 // chance, and open the Connect window once if no wallet is connected or reconnecting.
 const asked=useRef(false),[settled,setSettled]=useState(false);
 useEffect(()=>{const t=setTimeout(()=>setSettled(true),400);return()=>clearTimeout(t);},[]);
 useEffect(()=>{if(settled&&!w.owner&&!w.busy&&!asked.current){asked.current=true;w.setOpen(true);}},[settled,w.owner,w.busy]);
 return <section className="xp-shell" aria-label="Profile"/>;
}
function HoldingRow({icon,name,sub,amount,value,stale}){
 return <div className={'xp-row'+(stale?' stale':'')}><span className="xp-row-icon">{icon}</span><span className="xp-row-main"><strong>{name}</strong><small>{sub}</small></span><span className="xp-row-amt"><strong>{amount}</strong><small>{value}</small></span></div>;
}
// 30 Oct 2026 (owner: "why have the token images suddenly dissapeared?"): the index rows carry no image (and chain-read rows never
// do), so token art comes from the site's image list by mint, as on the Wallet tab; the row's own image is the fallback.
const tokenIcon=(r,fallback,images)=>{const src=images?.get(r.mint)||r.image;return src?<img src={src} alt=""/>:<span className="xp-row-initial">{(r.ticker||fallback||'?').slice(0,1)}</span>;};

export default function ProfilePage(){
 const w=useWallet(),owner=w.owner,moneroAddress=w.pair?.address||'';
 const [profile,setProfile]=useState(()=>owner?loadProfile(owner):null),[editing,setEditing]=useState(false),[tab,setTab]=useState(()=>['portfolio','wallet','activity'].includes(location.hash.slice(1))?location.hash.slice(1):'portfolio');
 useEffect(()=>{setProfile(owner?loadProfile(owner):null);},[owner]);
 useEffect(()=>{history.replaceState(null,'','#'+tab);},[tab]);
 // SOL and XMR prices (display only) once a wallet is connected; a refused request just leaves the values at —.
 const [images,setImages]=useState(()=>new Map());useEffect(()=>{let live=true;void loadTokenImages().then(m=>{if(live)setImages(m);});return()=>{live=false;};},[]);
 const [quotes,setQuotes]=useState({});useEffect(()=>{if(!owner)return;let live=true;const load=()=>loadSitePrices().then(q=>{if(live)setQuotes(q||{});}).catch(()=>{});void load();const t=setInterval(load,60000);return()=>{live=false;clearInterval(t);};},[owner]);
 const solRows=useHoldings(owner,'solana'),monRows=useHoldings(moneroAddress,'monero'),bridgeActivity=useBridgeActivity(owner,moneroAddress);
 // XMR: the balance the Monero wallet reports when it syncs (native-balance.jsx sends it on this page's wallet panels).
 const [xmr,setXmr]=useState(null);
 useEffect(()=>{setXmr(null);const on=e=>{if(e.detail?.address===moneroAddress)setXmr(e.detail);};addEventListener('xmr20-xmr-balance',on);return()=>removeEventListener('xmr20-xmr-balance',on);},[moneroAddress]);
 // XMR20 on Monero (Open + Private) from the token wallet, once the Monero wallet has synced it.
 const [tokens,setTokens]=useState([]);
 useEffect(()=>{const read=()=>{const pw=currentWebsitePrivateWallet();setTokens(pw&&pw.account()?.xmr===moneroAddress?pw.heldTokens():[]);};read();return subscribeWebsitePrivateWallet(read);},[moneroAddress]);
 // Token prices: the holdings rows' own, else Raydium LaunchLab (site-prices.js) for every token shown, Monero ones included.
 const priceMints=[...new Set([...(solRows?.rows||[]),...(monRows?.rows||[]),...tokens].map(r=>r.mint).filter(Boolean))].sort().join(',');
 const [launchPrices,setLaunchPrices]=useState({});
 useEffect(()=>{if(!priceMints)return;let live=true;const load=()=>loadTokenPrices(priceMints.split(',')).then(p=>{if(live)setLaunchPrices(p);}).catch(()=>{});void load();const t=setInterval(load,60000);return()=>{live=false;clearInterval(t);};},[priceMints]);
 const priceOf=useMemo(()=>{const m=new Map(Object.entries(launchPrices));for(const r of [...(solRows?.rows||[]),...(monRows?.rows||[])])if(r.priceUsd&&!r.stale)m.set(r.mint,r.priceUsd);return m;},[solRows,monRows,launchPrices]);
 const solUsd=quotes.sol?.priceUsd,xmrUsd=quotes.xmr?.priceUsd;
 const sol=w.solBalance==null?null:atomic(w.solBalance,9);
 const solana=[{key:'sol',icon:<img src={sitePath('/brand/solana.svg')} alt=""/>,name:'SOL',sub:'Solana',amount:sol==null?'—':num(sol)+' SOL',usd:sol!=null&&solUsd?sol*solUsd:null},
  ...(/^[1-9]\d*$/.test(solRows?.wxmrRaw||'')?[(a=>({key:'wxmr',icon:<img src={sitePath('/brand/monero-user.png')} alt=""/>,name:'wXMR',sub:'Wrapped Monero · wxmr.io',amount:num(a,6)+' wXMR',usd:xmrUsd?a*xmrUsd:null}))(atomic(solRows.wxmrRaw,12))]:[]),
  ...(solRows?.rows||[]).map(r=>{const a=atomic(r.amountRaw,6);return {key:r.id,icon:tokenIcon(r,null,images),name:'$'+r.ticker,sub:r.name,amount:num(a,2)+' '+r.ticker,usd:priceOf.get(r.mint)?a*priceOf.get(r.mint):null,stale:r.stale};})];
 const xmrAmount=xmr?atomic(xmr.balanceRaw,12):null;
 const monero=[{key:'xmr',icon:<img src={sitePath('/brand/monero-user.png')} alt=""/>,name:'XMR',sub:xmr?'Monero · '+num(atomic(xmr.unlockedRaw,12),6)+' unlocked':'Monero · open the Wallet tab and sync',amount:xmrAmount==null?'—':num(xmrAmount,6)+' XMR',usd:xmrAmount!=null&&xmrUsd?xmrAmount*xmrUsd:null},
  ...tokens.map(t=>{const a=atomic(t.total,6),p=priceOf.get(t.mint);return {key:'pf:'+t.mint,icon:tokenIcon({mint:t.mint,ticker:t.symbol},null,images),name:'$'+t.symbol,sub:'Open '+num(atomic(t.open,6),2)+' · Private '+num(atomic(t.private,6),2),amount:num(a,2)+' '+t.symbol,usd:p?a*p:null};}),
  ...(monRows?.rows||[]).map(r=>{const a=atomic(r.amountRaw,6);return {key:r.id,icon:tokenIcon(r,null,images),name:'$'+r.ticker,sub:'Previously bridged',amount:num(a,2)+' '+r.ticker,usd:priceOf.get(r.mint)?a*priceOf.get(r.mint):null,stale:r.stale};})];
 const sum=rows=>rows.reduce((n,r)=>n+(r.usd||0),0),solTotal=sum(solana),monTotal=sum(monero),total=solTotal+monTotal;
 const unknown=[...solana,...monero].some(r=>r.usd==null&&r.amount!=='—');
 // 29 Oct 2026 (owner: "remove the "your xmr20 profile" welcome screen … dont show that screen"): without a connected wallet the
 // page shows nothing of its own and the wallet's Connect window opens once the saved connection has been checked.
 if(!owner)return <ConnectFirst w={w}/>;
 const name=profile?.name||short(owner);
 // Own Monero transactions still confirming: ask the node every minute and redraw (30 Oct 2026).
 const [txTick,setTxTick]=useState(0);
 useEffect(()=>{if(!moneroAddress)return;let live=true;const load=()=>refreshXmrTxStatus(moneroAddress).then(()=>{if(live)setTxTick(t=>t+1);}).catch(()=>{});void load();const t=setInterval(()=>{if(!document.hidden&&openXmrTxs(moneroAddress).length)void load();},60000);return()=>{live=false;clearInterval(t);};},[moneroAddress]);
 const activity=[...readActivity(owner,moneroAddress),...bridgeActivity,...pendingDeposits(owner,bridgeActivity)].sort((a,b)=>(b.at||0)-(a.at||0)).slice(0,60);void txTick;
 return <section className="xp-shell">
  <div className="xp-hero">
   <div className="xp-hero-card xp-identity">
    <Avatar profile={profile} owner={owner}/>
    <div className="xp-identity-text"><p className="xp-kicker">XMR20 / PROFILE</p><h1>{name}<span className="xp-dot">.</span></h1>
     <p className="xp-bio">{profile?.bio||(profile?'':'Create a profile to add a name and a short bio.')}</p>
     <div className="xp-chips"><CopyChip label="Solana" value={owner} link={'https://solscan.io/account/'+owner}/>{moneroAddress&&<CopyChip label="Monero" value={moneroAddress}/>}</div>
     <div className="xp-actions"><button type="button" className="xp-btn xp-primary" onClick={()=>setEditing(true)}><Pencil aria-hidden="true"/>{profile?'Edit profile':'Create profile'}</button><button type="button" className="xp-btn xp-ghost" onClick={()=>setTab('wallet')}><Wallet aria-hidden="true"/>Open wallet</button></div>
    </div>
   </div>
   <div className="xp-hero-card xp-worth">
    <p className="xp-kicker">PORTFOLIO VALUE</p><strong className="xp-total">{usd(total)}</strong>
    <div className="xp-split" role="img" aria-label={`Solana ${usd(solTotal)}, Monero ${usd(monTotal)}`}><span className="xp-split-sol" style={{flexGrow:solTotal||0.0001}}/><span className="xp-split-xmr" style={{flexGrow:monTotal||0.0001}}/></div>
    <dl className="xp-worth-rows"><div><dt><i className="xp-key-sol"/>Solana</dt><dd>{usd(solTotal)}</dd></div><div><dt><i className="xp-key-xmr"/>Monero</dt><dd>{usd(monTotal)}</dd></div></dl>
    <p className="xp-note">{unknown?'Some holdings have no price yet and are not counted. ':''}Estimates for display only{xmr?'':'; XMR shows after the Monero wallet syncs'}.</p>
   </div>
  </div>
  <nav className="xp-tabs" role="tablist" aria-label="Profile sections">
   {[['portfolio','Portfolio',LayoutGrid],['wallet','Wallet',Wallet],['activity','Activity',History]].map(([id,label,Icon])=><button key={id} type="button" role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}><Icon aria-hidden="true"/>{label}</button>)}
  </nav>
  {tab==='portfolio'&&<div className="xp-grid">
   <section className="xp-card" aria-label="Solana holdings"><div className="xp-card-head"><span><img src={sitePath('/brand/solana.svg')} alt=""/>Solana</span><strong>{usd(solTotal)}</strong></div>
    {solana.map(r=><HoldingRow key={r.key} icon={r.icon} name={r.name} sub={r.sub} amount={r.amount} value={usd(r.usd)} stale={r.stale}/>)}
    {!solRows&&<p className="xp-muted">Loading tokens…</p>}</section>
   <section className="xp-card" aria-label="Monero holdings"><div className="xp-card-head"><span><img src={sitePath('/brand/monero-user.png')} alt=""/>Monero</span><strong>{usd(monTotal)}</strong></div>
    {moneroAddress?monero.map(r=><HoldingRow key={r.key} icon={r.icon} name={r.name} sub={r.sub} amount={r.amount} value={usd(r.usd)} stale={r.stale}/>)
     :<div className="xp-muted"><p>No Monero wallet is linked to this Solana wallet yet.</p><button type="button" className="xp-btn xp-ghost" onClick={()=>setTab('wallet')}>Set up in Wallet</button></div>}
    {moneroAddress&&!xmr&&<button type="button" className="xp-btn xp-ghost xp-inline" onClick={()=>setTab('wallet')}>Sync your Monero wallet</button>}</section>
  </div>}
  {tab==='wallet'&&<div className="xp-grid xp-wallets">
   <dialog open className="wallet-dialog xp-embed" aria-label="Solana wallet"><div className="xp-embed-head"><img src={sitePath('/brand/solana.svg')} alt=""/>Solana</div><div className="wallet-dialog-body"><div className="wallet-panel-scroll">
    <div className="wallet-native-asset"><span className="wallet-native-icon"><img src={sitePath('/brand/solana.svg')} alt=""/></span><div><strong>SOL</strong><small>{w.balanceStale?'Solana · last known':'Solana'}</small></div><strong>{sol==null?'—':num(sol)}</strong><button type="button" aria-label="Refresh SOL balance" disabled={w.balanceLoading} onClick={w.refreshBalance}>↻</button></div>
    <Suspense fallback={<p role="status">Loading tokens…</p>}><TokenHoldings key={owner} address={owner} network="solana" actions owner={owner} provider={w.provider} pair={w.pair}/></Suspense></div></div></dialog>
   <dialog open className="wallet-dialog xp-embed" aria-label="Monero wallet"><div className="xp-embed-head"><img src={sitePath('/brand/monero-user.png')} alt=""/>Monero</div><div className="wallet-dialog-body"><div className="wallet-panel-scroll">
    {w.provider?.kind==='xmr20'?<p className="small">Wallet setup and signing stay in XMR20 Wallet.</p>:w.pair?<Suspense fallback={<p role="status">Loading Monero wallet…</p>}><WalletLibrary key={owner} owner={owner} pair={w.pair} provider={w.provider}/></Suspense>
     :<div className="xp-muted"><p>Create or import the Monero wallet for this Solana wallet in the wallet window.</p><button type="button" className="xp-btn xp-primary" onClick={()=>{w.setOpen(true);dispatchEvent(new Event('xmr20-wallet-setup'));}}>Set up Monero wallet</button></div>}
   </div></div></dialog>
  </div>}
  {tab==='activity'&&<section className="xp-card xp-activity" aria-label="Activity">
   <div className="xp-card-head"><span><History aria-hidden="true"/>Activity</span></div>
   {activity.length?activity.map(a=><div className="xp-row" key={a.key}><span className={'xp-row-icon xp-act xp-act-'+a.kind}>{a.mark}</span><span className="xp-row-main"><strong>{a.title}</strong><small>{when(a.at)}{a.status?' · '+a.status:''}</small></span><span className="xp-row-amt"><strong>{a.amount}</strong>{a.link&&<a href={a.link} target="_blank" rel="noopener noreferrer">View ↗</a>}</span></div>)
    :<p className="xp-muted">Nothing yet. Bridge transfers, and sends, exchanges and wXMR requests made in this browser, show here.</p>}
  </section>}
  {editing&&<EditProfile owner={owner} profile={profile} onSaved={p=>{setProfile(p);setEditing(false);}} onClose={()=>setEditing(false)}/>}
 </section>;
}
// What this browser recorded: XMR sends (website-xmr-send.jsx), SOL<->XMR exchanges (website-native-swap.js) and wXMR requests
// (website-wxmr-bridge.jsx). Newest first.
// 30 Oct 2026 (owner, a tester: "I started a LUKE bridge transfer … Where can I track the activity?"): bridge transfers in both
// directions, read from the private bridge's own state (the same request the token wallet makes): its public list of credits
// (Solana -> Monero) and redemptions (Monero -> Solana) carry the recipient's token owner key, and the state for this wallet's
// account (id from its Solana and Monero addresses, as the token wallet registers it) returns that key and the payout status of
// each return. Earlier transfers show too, from any browser. Times are estimated from the Monero block (about 2 minutes each).
const BRIDGE_API=(location.origin==='https://xmr20.org'?'https://api.xmr20.org':location.origin)+'/api/private-bridge/action/state';
function useBridgeActivity(owner,moneroAddress){
 const [rows,setRows]=useState([]);
 useEffect(()=>{setRows([]);if(!owner||!moneroAddress)return;let live=true;
  const id=('ext-'+websiteAccountId(owner,moneroAddress)).replace(/[^A-Za-z0-9_-]/g,'').slice(0,64);
  const load=async()=>{try{
   const r=await fetch(BRIDGE_API,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id}),credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(20000)});
   const st=await r.json();if(!live||!r.ok||!st?.registered||!/^[0-9a-f]{64}$/.test(st.ownerKey||''))return;setRows(bridgeRows(st));}catch{}};
  void load();const t=setInterval(()=>{if(!document.hidden)void load();},45000);return()=>{live=false;clearInterval(t);};},[owner,moneroAddress]);
 return rows;
}
export function bridgeRows(st,now=Date.now()){
 const key=st.ownerKey,tip=Number(st.tip)||0,need=Number(st.confirmations)||10,assets=new Map((st.assets||[]).map(a=>[a.asset,a]));
 const payouts=new Map();for(const a of st.assets||[])for(const p of a.payouts||[])if(p?.txid)payouts.set(p.txid,p);
 const amountOf=(raw,a)=>num(atomic(raw,Number.isInteger(a?.decimals)?a.decimals:6),4)+' '+(a?.symbol||'tokens');
 const at=h=>now-Math.max(0,tip-h)*120000,conf=h=>Math.max(0,tip-h+1),out=[];
 for(const c of st.pool?.credits||[]){if(c?.owner!==key||!/^[0-9a-f]{64}$/.test(c.txid||''))continue;const a=assets.get(c.asset),n=conf(c.height);
  out.push({key:'bc'+c.txid,match:{txid:c.txid,symbol:a?.symbol,raw:String(c.amount)},kind:'bridge',mark:'↓',title:(c.kind===2?'Moved to the new format · ':'Bridged from Solana · ')+(a?.symbol||'tokens'),at:at(c.height),
   status:n>=need?'Completed':`Confirming ${n}/${need}`,amount:'+'+amountOf(c.amount,a),link:'https://xmrchain.net/tx/'+c.txid});}
 for(const d of st.pool?.redemptions||[]){if(d?.owner!==key||!/^[0-9a-f]{64}$/.test(d.txid||''))continue;const a=assets.get(d.asset),n=conf(d.height),p=payouts.get(d.txid);
  const status=p?.status==='paid'?'Paid on Solana':p?.status==='submitting'?'Paying on Solana…':n<need?`Confirming ${n}/${need}`:'Waiting for the bridge payout';
  out.push({key:'br'+d.txid,kind:'bridge',mark:'↑',title:'Bridged to Solana · '+(a?.symbol||'tokens'),at:at(d.height),status,amount:'−'+amountOf(d.amount,a),link:'https://xmrchain.net/tx/'+d.txid});}
 return out;
}
// Deposits sent from this browser whose credit is not on Monero yet: matched to a credit by its transaction, else by token and
// amount after the deposit; unmatched ones show as waiting (for three days).
function pendingDeposits(owner,bridge,now=Date.now()){
 const credits=bridge.filter(r=>r.match),used=new Set(),out=[];
 for(const d of loadBridgeDeposits(owner)){
  const hit=(d.credit&&credits.find(c=>c.match.txid===d.credit))||credits.find(c=>!used.has(c.key)&&c.match.symbol===d.symbol&&c.match.raw===d.amount&&c.at>=d.at-1800000);
  if(hit){used.add(hit.key);continue;}if(now-d.at>3*86400000)continue;
  out.push({key:'bd'+d.at,kind:'bridge',mark:'↓',title:'Bridged from Solana · '+d.symbol,at:d.at,status:now-d.at>3600000?'Still waiting for the bridge credit':'Deposit received · waiting for the bridge credit',
   amount:'+'+num(atomic(d.amount,d.decimals),4)+' '+d.symbol,link:d.credit?'https://xmrchain.net/tx/'+d.credit:null});
 }
 return out;
}
function readActivity(owner,moneroAddress){
 const out=[];const parse=k=>{try{const v=JSON.parse(localStorage.getItem(k)||'[]');return Array.isArray(v)?v:[];}catch{return [];}};
 // Sends and splits from this browser (xmr-tx-store.js): the link is there from the start; the status follows the confirmations.
 if(moneroAddress)for(const r of loadXmrTxs(moneroAddress))out.push(r.kind==='split'?{key:'s'+r.hash,kind:'send',mark:'⋮',title:xmrTxTitle(r),at:r.at,status:xmrTxLabel(r),amount:'fee '+num(atomic(r.feeRaw||'0',12),6)+' XMR',link:'https://xmrchain.net/tx/'+r.hash}
  :{key:'s'+r.hash,kind:'send',mark:'↗',title:'Sent XMR to '+short(r.to),at:r.at,status:xmrTxLabel(r),amount:'−'+num(atomic(r.amountRaw,12),6)+' XMR',link:r.hash?'https://xmrchain.net/tx/'+r.hash:null});
 try{for(const r of swapOrderStore(owner).load())out.push({key:'x'+r.requestId,kind:'swap',mark:'⇄',title:r.direction==='sol-xmr'?'Exchange SOL → XMR':'Exchange XMR → SOL',at:r.created,status:r.status,amount:r.amount+' '+(r.direction==='sol-xmr'?'SOL':'XMR'),link:r.id?'https://changenow.io/exchange/txs/'+encodeURIComponent(r.id):null});}catch{}
 for(const r of parse('xmr20-wxmr-withdrawals:'+owner))out.push({key:'w'+r.pda,kind:'bridge',mark:'⇄',title:'wXMR → XMR',at:r.at,status:r.status,amount:num(atomic(r.amount,12),6)+' wXMR',link:r.signature?'https://solscan.io/tx/'+r.signature:null});
 return out.sort((a,b)=>(b.at||0)-(a.at||0)).slice(0,50);
}
