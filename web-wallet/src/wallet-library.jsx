import {websiteBridgeRows,mergeWalletHoldings,bridgeActionRow} from './bridge-portfolio.js';
import PendingBridgeTokens from './wallet-pending-bridges.jsx';
import NativeMoneroTokens from './website-native-holdings.jsx';
import {loadTokenImages} from './wallet-token-images.js';
import React,{lazy,Suspense,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import WalletImport from './wallet-import.jsx';
import NativeBalance from './native-balance.jsx';
import PrivateTokenRows from './private-tokens.jsx';
import {ArrowLeftRight,Repeat,X} from 'lucide-react';
import {ensureWebsitePrivateWallet,websiteSolBalance} from './private-wallet-host.js';
import LocalMoneroRecovery,{MoneroStartBlock} from './monero-local-recovery.jsx';
import {walletLibrary} from './wallet-import-store.js';
import {loadWalletHoldings,tokenAmount,cachedWalletHoldings,cacheWalletHoldings} from './wallet-holdings.js';
import {loadSolanaWalletHoldings} from './solana-chain-holdings.js';
import {loadSitePrices} from './site-prices.js';
import {sitePath} from './site-path.js';
import {checkMoneroAddress} from '../shared/xmr20/address.js';
import WalletAssetAction from './wallet-asset-action.jsx';
import {NATIVE_MARKET_CONFIGURATION} from '../../engine/shared/website/native-market-config.js';
import {savedNativeRestoreHeight} from '../../engine/monero/native-wallet-client.js';
import {nativeDisplay,pendingNativeBridges} from './website-native-holdings.js';

const TransferableHoldings=lazy(()=>import('./transferable-holdings.jsx'));
const WebsiteNativeSwap=lazy(()=>import('./website-native-swap.jsx'));
const WebsiteNativeBridge=lazy(()=>import('./website-native-bridge.jsx'));
const WebsiteWxmrBridge=lazy(()=>import('./website-wxmr-bridge.jsx'));
const WebsiteWxmrSend=lazy(()=>import('./website-wxmr-send.jsx'));
const formatAmount=raw=>new Intl.NumberFormat('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(raw)/1e6);
// 30 Oct 2026 (owner: "this wxmr must be detected when in a wallet"): wXMR (wxmr.io, 12 decimals) is listed on the Solana side
// with Send and Bridge (to XMR through the wxmr.io bridge); its value uses the XMR price.
const WXMR_MINT='WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp';
const formatWxmr=raw=>{const n=BigInt(raw),f=String(n%1000000000000n).padStart(12,'0').slice(0,6).replace(/0+$/,'');return String(n/1000000000000n)+(f?'.'+f:'');};
const formatUsd=row=>row.stale||row.priceUsd===null||row.priceUsd===undefined?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(row.amountRaw)/1e6*row.priceUsd);

export default function WalletLibrary({owner,pair,localPair,provider,onLink,onSelectedAddress}){
 const [wallets,setWallets]=useState([]),[selected,setSelected]=useState(pair?.address||''),[importing,setImporting]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0);
 useEffect(()=>{try{setWallets(walletLibrary(owner).read());}catch{setError('Saved wallets could not be loaded.');}},[owner]);
 const options=[...(pair?[{address:pair.address,kind:'linked'}]:[]),...(localPair&&localPair.address!==pair?.address?[{address:localPair.address,kind:'preview'}]:[]),...wallets].filter((r,i,all)=>all.findIndex(a=>a.address===r.address)===i);
 const current=options.find(r=>r.address===selected)||options[0];
 useEffect(()=>{onSelectedAddress?.(current?.address||'');},[current?.address,onSelectedAddress]);
 async function imported(row){setWallets(walletLibrary(owner).add(row));setSelected(row.address);setReload(n=>n+1);}
 return <section className="wallet-library" aria-label="Monero wallets">
  {localPair&&localPair.address!==pair?.address&&<p className="notice">Your saved launch wallet is restored. The other address remains available on this device.</p>}
  {/* 28 Oct 2026 (owner): no picker for a single Monero wallet; the header shows its address. Kept only to switch between several. */}
  {options.length>1&&<label className="wallet-selector">Monero wallet<select value={current?.address||''} onChange={e=>setSelected(e.target.value)}>{options.map(r=><option key={r.address} value={r.address}>{r.kind==='linked'?'Linked wallet':r.kind==='imported'?'Imported wallet':r.kind==='preview'?'Earlier wallet':'Address only'} · {r.address.slice(0,8)}…{r.address.slice(-6)}</option>)}</select></label>}
  {current&&<>
   {current.kind!=='watch'&&<NativeBalance key={current.address} owner={owner} address={current.address} provider={provider} workerPath={sitePath('/monero-native/native.worker.js')}/>}<TokenHoldings key={current.address+':'+reload} address={current.address} network="monero" actions owner={owner} pair={pair} provider={provider} rowsAbove={current.kind!=='watch'?<PrivateTokenRows address={current.address}/>:null} onLink={!pair&&current.kind==='imported'?onLink:undefined}/>
   {current.kind!=='watch'&&<><details className="wallet-advanced"><summary>Wallet backup</summary><MoneroStartBlock address={current.address} linkedHeight={pair?.address===current.address?pair?.height:undefined}/><LocalMoneroRecovery key={'backup:'+current.address} owner={owner} network="mainnet" address={current.address} provider={provider}/></details></>}
   {!pair&&current.kind==='imported'&&onLink&&<button onClick={async()=>{try{await onLink(current.address);}catch(e){setError(e.message);}}}>Link wallet for launches and bridging</button>}</>}
  {!importing?<button className="wallet-subtle-button wallet-row-button" onClick={()=>setImporting(true)}>Import XMR wallet</button>:<WalletImport provider={provider} key={owner} owner={owner} onImport={imported} onClose={()=>setImporting(false)}/>}{error&&<p role="alert">{error}</p>}
 </section>;
}

// rowsAbove (30 Oct 2026, owner: the "Tokens" title "should be above the XMR20 tokens"): the Monero tab's XMR20 rows render under this
// section's Tokens heading, like the Solana tab's tokens, instead of between the Monero row and the heading.
export function TokenHoldings({address,network='monero',actions=false,owner,provider,pair,onLink,rowsAbove=null}){
 const scope=owner+':'+network+':'+address;
 const [reading,setReading]=useState(()=>({scope,data:cachedWalletHoldings(address,{network})})),[error,setError]=useState(''),[refreshing,setRefreshing]=useState(true),[action,setAction]=useState(null);
 const data=reading.scope===scope?reading.data:null,setData=value=>setReading({scope,data:value});
 // Native (operator-verified) Monero tokens live in the private engine, not the public holdings index.
 // 30 Oct 2026 (owner: "Yes, hide it"): the "Previously bridged tokens" check replays that bridge from its activation block, even for
 // a new wallet. A wallet whose saved creation block is after the activation is not offered it, unless this browser already holds a
 // check result or a transfer of that bridge for it.
 const nativeStart=NATIVE_MARKET_CONFIGURATION?.manifest?.height,born=savedNativeRestoreHeight(address);
 const nativeAfter=nativeStart!=null&&born!=null&&BigInt(born)>BigInt(nativeStart)&&!nativeDisplay(address)&&!pendingNativeBridges(address).length;
 const nativeMonero=network==='monero'&&actions&&owner&&pair?.address&&address===pair.address&&!!NATIVE_MARKET_CONFIGURATION?.display&&!nativeAfter;
 const actionRow=['swap','native-bridge','native-redeem','native-send','native-balance','private-bridge-choose','wxmr-send','wxmr-bridge'].includes(action?.kind)?null:bridgeActionRow(action,data?.rows||[],scope);
 // The native (operator) bridge replaces the retired transferable bridge for its token on Solana.
 const nativeMint=NATIVE_MARKET_CONFIGURATION?.backing?.mint,nativeBridge=network==='solana'&&provider?.kind!=='xmr20'&&!!nativeMint&&!!pair?.address;
 const openBridge=row=>setAction(nativeBridge&&(!row||row.mint===nativeMint)?{scope,id:'native-bridge',kind:'native-bridge'}:row?{scope,id:row.id,row,kind:'bridge'}:{scope,id:'new-bridge',kind:'bridge'});
 // 28 Oct 2026 (owner): Solana tokens bridge to Monero through the new private bridge (no wallet link), signed in the connected
 // wallet. It needs a little SOL; without it this says so before anything opens. Monero-side rows keep their Bridge to Solana.
 const privateBridgeOn=network==='solana'&&actions&&!!owner&&provider?.kind!=='xmr20';
 const [bridgeNote,setBridgeNote]=useState(null),bridgeRun=useRef(0);
 useEffect(()=>()=>{bridgeRun.current++;},[]);
 const solText=l=>(Number(l)/1e9).toLocaleString('en-GB',{maximumFractionDigits:6});
 async function openPrivateBridge(row){
  const run=++bridgeRun.current,live=()=>run===bridgeRun.current;setAction(null);setBridgeNote(null);
  const lamports=websiteSolBalance();
  if(lamports!==null&&BigInt(lamports)<110000n){setBridgeNote({scope,sol:lamports});return;}
  if(!pair?.address){setBridgeNote({scope,error:'Set up your Monero wallet on the Monero tab first. Bridged tokens arrive there.'});return;}
  try{
   setBridgeNote({scope,busy:'Approve in your Solana wallet to open your Monero wallet…'});
   const w=await ensureWebsitePrivateWallet({owner,address:pair.address,provider});
   for(;;){if(!live())return;const st=w.syncStatus();if(st.error)throw Error(st.restarting?st.error:'Monero tokens are unavailable right now: '+st.error);if(!st.syncing)break;
    setBridgeNote({scope,busy:'Reading XMR20 token history'+(st.pct==null?'':' · '+st.pct+'%')+'. The first time on this browser takes a few minutes; it picks up where it left off. The bridge opens when it finishes…'});await new Promise(r=>setTimeout(r,1000));}
   if(!live())return;setBridgeNote(null);
   await w.openBridge(row.mint,'deposit',null,{symbol:row.ticker,name:row.name,solanaBalance:row.amountRaw});
  }catch(e){if(live())setBridgeNote({scope,error:e.message||'The bridge could not open.'});}
 }
 const [solana,setSolana]=useState(()=>({owner,rows:cachedWalletHoldings(owner,{network:'solana'})?.rows||[]})),[joint,setJoint]=useState(null);
 const [images,setImages]=useState(new Map());
 const [wxmr,setWxmr]=useState(null),[xmrUsd,setXmrUsd]=useState(null);
 const wxmrRaw=network==='solana'&&wxmr?.owner===address&&/^\d+$/.test(wxmr.raw||'')&&BigInt(wxmr.raw)>0n?wxmr.raw:null;
 useEffect(()=>{if(!wxmrRaw)return;let live=true;const load=()=>loadSitePrices().then(q=>{if(live&&q?.xmr?.priceUsd)setXmrUsd(q.xmr.priceUsd);}).catch(()=>{});void load();const t=setInterval(load,60000);return()=>{live=false;clearInterval(t);};},[!!wxmrRaw]);
 useEffect(()=>{let active=true;loadTokenImages().then(value=>{if(active)setImages(value);});return()=>{active=false;};},[]);
 const latest=useRef(data),refreshRef=useRef(()=>{});
 const bridgeRows=useMemo(()=>websiteBridgeRows({owner,address,network,linkedAddress:pair?.address,currentRows:data?.rows,solana,joint}),[owner,address,network,pair?.address,data,solana,joint]);
 const catalogRows=useMemo(()=>[...(data?.rows||[]),...(solana.owner===owner?solana.rows:[])],[data,solana,owner]);
 const refreshHoldings=useCallback(()=>{window.dispatchEvent(new Event('xmr20-holdings-refresh'));return refreshRef.current();},[]);
 useEffect(()=>{
  const abort=new AbortController();let pending=null,oppositePending=null,opposite=cachedWalletHoldings(owner,{network:'solana'});
  latest.current=cachedWalletHoldings(address,{network});setData(latest.current);setAction(null);setError('');
  setSolana({owner,rows:opposite?.rows||[]});
  // Solana: the chain read and the index together (solana-chain-holdings.js); force skips its 20-second sharing.
  const refreshCurrent=(force=false)=>{
   if(abort.signal.aborted||pending)return pending;setError('');setRefreshing(true);
   pending=(network==='solana'?loadSolanaWalletHoldings(address,{force}):loadWalletHoldings(address,{signal:abort.signal,network})).then(result=>{
    if(abort.signal.aborted)return;
    if(network==='solana')setWxmr(previous=>result.wxmrRaw==null&&previous?.owner===address?previous:{owner:address,raw:result.wxmrRaw??null});
    const next=mergeWalletHoldings(result,latest.current);
    latest.current=next;cacheWalletHoldings(address,next,{network});setData(next);
   }).catch(()=>{if(!abort.signal.aborted){if(latest.current){const stale={...latest.current,complete:false,rows:latest.current.rows.map(r=>({...r,stale:true}))};latest.current=stale;setData(stale);}setError('Holdings could not refresh. Saved balances are kept.');}}).finally(()=>{pending=null;if(!abort.signal.aborted)setRefreshing(false);});
   return pending;
  };
  // The opposite tab's Solana balance is independent of the Monero index.
  // Keep its cache account-scoped and let either source finish first.
  const refreshOpposite=(force=false)=>{
   if(abort.signal.aborted||network==='solana'||!actions||!owner)return;
   if(oppositePending)return oppositePending;
   oppositePending=loadSolanaWalletHoldings(owner,{force}).then(result=>{
    if(abort.signal.aborted)return;opposite=mergeWalletHoldings(result,opposite);
    cacheWalletHoldings(owner,opposite,{network:'solana'});setSolana({owner,rows:opposite.rows});
   }).catch(()=>{if(!abort.signal.aborted)setSolana(previous=>previous.owner===owner?{owner,rows:previous.rows.map(row=>({...row,stale:true}))}:previous);}).finally(()=>{oppositePending=null;});
   return oppositePending;
  };
  const refresh=(force=false)=>Promise.allSettled([refreshCurrent(force),refreshOpposite(force)]);
  refreshRef.current=()=>refresh(true);void refresh();
  const update=()=>{if(!document.hidden)void refresh();},changed=()=>{if(!document.hidden)void refresh(true);};const timer=setInterval(update,30000);window.addEventListener('focus',update);window.addEventListener('xmr20-holdings-refresh',changed);
  return()=>{abort.abort();clearInterval(timer);window.removeEventListener('focus',update);window.removeEventListener('xmr20-holdings-refresh',changed);};
 },[address,network,owner,actions]);
 return <section className="wallet-assets" aria-label={`${network==='monero'?'Monero':'Solana'} token holdings`}>
  <div className="wallet-assets-head"><h3>Tokens</h3><button type="button" disabled={refreshing} aria-label="Refresh token holdings" onClick={()=>void refreshHoldings()}>↻</button></div>
  {rowsAbove}
  {/* 28 Oct 2026 (owner): Bridge/Swap tiles on the Solana tab only; Monero assets bridge from their own row (on hover). */}
  {actions&&owner&&network==='solana'&&<div className="wallet-actions-row"><button className="wallet-tile wallet-primary" onClick={()=>privateBridgeOn?(setBridgeNote(null),setAction({scope,id:'private-bridge-choose',kind:'private-bridge-choose'})):openBridge()}><ArrowLeftRight aria-hidden="true"/><span>Bridge</span></button>
   {network==='solana'&&provider?.kind!=='xmr20'&&<button className="wallet-tile wallet-secondary" onClick={()=>setAction({scope,id:'native-swap',kind:'swap'})}><Repeat aria-hidden="true"/><span>Swap SOL ↔ XMR</span></button>}</div>}
  {action?.kind==='private-bridge-choose'&&action.scope===scope&&<section className="wallet-action-sheet wallet-bridge-choose" aria-label="Bridge to Monero"><div className="wallet-action-head"><h3>Bridge to Monero</h3><button type="button" aria-label="Close" onClick={()=>setAction(null)}><X aria-hidden="true"/></button></div>
   <p className="small">Choose a token. It arrives on Monero as open tokens in about 20 minutes. To bridge back, open it on the Monero tab.</p>
   {(data?.rows||[]).length?data.rows.map(r=><button type="button" key={r.id} className="wallet-choose-row" onClick={()=>void openPrivateBridge(r)}><span className="wallet-asset-icon" aria-hidden="true">{(images.get(r.mint)||r.image)?<img src={images.get(r.mint)||r.image} alt=""/>:r.ticker.slice(0,1)}</span><span className="wallet-asset-info"><strong>${r.ticker}</strong><small>{formatAmount(r.amountRaw)} {r.ticker}</small></span><ArrowLeftRight aria-hidden="true"/></button>):<p className="wallet-empty">No Solana tokens to bridge yet.</p>}</section>}
  {bridgeNote?.scope===scope&&<section className="wallet-action-sheet wallet-bridge-note" aria-live="polite">{bridgeNote.sol!==undefined?<><div className="wallet-action-head"><h3>Add SOL to bridge</h3><button type="button" aria-label="Close" onClick={()=>setBridgeNote(null)}><X aria-hidden="true"/></button></div>
    <p>This wallet has {solText(bridgeNote.sol)} SOL. Bridging to Monero needs a little SOL: about 0.00011 SOL for the bridge fee and the Solana network fee, plus a one-time 0.0034 SOL the first time a token is bridged.</p>
    <p className="small">Send SOL to this wallet, then press Bridge again.</p><button type="button" className="wallet-copy-address" onClick={()=>void navigator.clipboard.writeText(owner)}>Copy {owner.slice(0,5)}…{owner.slice(-5)}</button></>
   :bridgeNote.busy?<p className="joint-busy" data-loading="true" role="status">{bridgeNote.busy}</p>:<><p role="alert" className="form-error">{bridgeNote.error}</p><button type="button" onClick={()=>setBridgeNote(null)}>Close</button></>}</section>}
  {action?.kind==='native-bridge'&&action.scope===scope&&<Suspense fallback={<p role="status">Loading bridge…</p>}><WebsiteNativeBridge owner={owner} provider={provider} moneroAddress={pair.address} token={{symbol:NATIVE_MARKET_CONFIGURATION.display?.symbol||'EXTREMIST'}} image={images.get(NATIVE_MARKET_CONFIGURATION.display?.mint)} onClose={()=>setAction(null)}/></Suspense>}
  {action?.kind==='native-redeem'&&action.scope===scope&&<Suspense fallback={<p role="status">Loading bridge…</p>}><WebsiteNativeBridge mode="redeem" owner={owner} provider={provider} moneroAddress={pair.address} token={{symbol:NATIVE_MARKET_CONFIGURATION.display?.symbol||'EXTREMIST'}} image={images.get(NATIVE_MARKET_CONFIGURATION.display?.mint)} onClose={()=>setAction(null)}/></Suspense>}
  {action?.kind==='native-send'&&action.scope===scope&&<Suspense fallback={<p role="status">Loading Monero wallet…</p>}><WebsiteNativeBridge mode="send" owner={owner} provider={provider} moneroAddress={pair.address} token={{symbol:NATIVE_MARKET_CONFIGURATION.display?.symbol||'EXTREMIST'}} image={images.get(NATIVE_MARKET_CONFIGURATION.display?.mint)} onClose={()=>setAction(null)}/></Suspense>}
  {action?.kind==='native-balance'&&action.scope===scope&&<Suspense fallback={<p role="status">Loading Monero wallet…</p>}><WebsiteNativeBridge mode="balance" owner={owner} provider={provider} moneroAddress={pair.address} token={{symbol:NATIVE_MARKET_CONFIGURATION.display?.symbol||'EXTREMIST'}} onClose={()=>setAction(null)}/></Suspense>}
  {action?.kind==='swap'&&action.scope===scope&&<Suspense fallback={<p role="status">Loading exchange…</p>}><WebsiteNativeSwap owner={owner} provider={provider} moneroAddress={pair?.address} onClose={()=>setAction(null)}/></Suspense>}
  {action?.kind==='wxmr-send'&&action.scope===scope&&wxmrRaw&&<Suspense fallback={<p role="status">Loading…</p>}><WebsiteWxmrSend owner={owner} provider={provider} balanceRaw={wxmrRaw} onSent={()=>void refreshHoldings()} onClose={()=>setAction(null)}/></Suspense>}
  {action?.kind==='wxmr-bridge'&&action.scope===scope&&<Suspense fallback={<p role="status">Loading the wXMR bridge…</p>}><WebsiteWxmrBridge owner={owner} provider={provider} address={pair?.address||''} initialDir="out" onSent={()=>void refreshHoldings()} onClose={()=>setAction(null)}/></Suspense>}
  {actionRow&&<WalletAssetAction key={action.id+':'+action.kind} row={actionRow} kind={action.kind} bridgeProtocol={action.id==='new-bridge'?'transferable':undefined} network={network} address={address} owner={owner} pair={pair} provider={provider} bridgeRows={bridgeRows} refreshHoldings={refreshHoldings} onLink={onLink} onClose={()=>setAction(null)}/>}
  {nativeMonero&&<NativeMoneroTokens address={pair.address} image={images.get(NATIVE_MARKET_CONFIGURATION.display?.mint)} onCheck={()=>setAction({scope,id:'native-balance',kind:'native-balance'})}
   onSend={provider?.kind!=='xmr20'?()=>setAction({scope,id:'native-send',kind:'native-send'}):undefined}
   onBridge={provider?.kind!=='xmr20'?()=>setAction({scope,id:'native-redeem',kind:'native-redeem'}):undefined}/>}
  {actions&&owner&&pair?.address&&<Suspense fallback={network==='monero'?<p>Loading bridge balances…</p>:null}><TransferableHoldings owner={owner} address={pair.address} pair={pair} provider={provider} rows={catalogRows} visible={network==='monero'&&address===pair.address} onRows={setJoint} bridgeRows={bridgeRows} refreshHoldings={refreshHoldings}/></Suspense>}
  {network==='monero'&&actions&&owner&&<PendingBridgeTokens owner={owner} address={address} confirmed={data?.rows||[]} images={images} pair={pair} provider={provider}/>}
  {refreshing&&!data&&<p role="status">Loading tokens…</p>}{error&&<p role="alert" className="form-error">{error}</p>}
  {wxmrRaw&&<div className="wallet-asset-wrap"><article className="wallet-asset"><div className="wallet-asset-icon" aria-hidden="true"><img src={sitePath('/brand/monero-user.png')} alt=""/></div><div className="wallet-asset-info"><a href={'https://solscan.io/token/'+WXMR_MINT} target="_blank" rel="noopener noreferrer" title="Wrapped Monero (wxmr.io)">wXMR</a><small>{formatWxmr(wxmrRaw)} wXMR</small></div><strong className="wallet-asset-usd" title={xmrUsd?'Estimated USD value from the XMR price':'Price unavailable'}>{xmrUsd?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(wxmrRaw)/1e12*xmrUsd):'—'}</strong>{actions&&owner===address&&provider?.kind!=='xmr20'&&<div className="wallet-asset-actions"><button onClick={()=>setAction({scope,id:'wxmr-send',kind:'wxmr-send'})}>Send</button><button onClick={()=>setAction({scope,id:'wxmr-bridge',kind:'wxmr-bridge'})}>Bridge</button></div>}</article></div>}
  {data&&<>{data.rows.map(r=><div className="wallet-asset-wrap" key={r.id}><article className="wallet-asset"><div className="wallet-asset-icon" aria-hidden="true">{(images.get(r.mint)||r.image)?<img key={images.get(r.mint)||r.image} src={images.get(r.mint)||r.image} alt="" loading="lazy" onError={e=>{e.currentTarget.hidden=true;e.currentTarget.parentNode.dataset.fallback=r.ticker.slice(0,1);}}/>:r.ticker.slice(0,1)}</div><div className="wallet-asset-info"><a href={r.listed?'https://xmr20.org/#inscription/'+r.id:'https://xmrchain.net/tx/'+r.deployment} target="_blank" rel="noopener noreferrer" title={r.name}>${r.ticker}</a><small>{formatAmount(r.amountRaw)} {r.ticker}{r.stale?' · last checked':''}</small></div><strong className="wallet-asset-usd" title={r.priceUsd?'Estimated USD value from recent market price':'Price unavailable'}>{formatUsd(r)}</strong>{actions&&<div className="wallet-asset-actions"><button onClick={()=>setAction({scope,id:r.id,row:r,kind:'send'})}>Send</button><button onClick={()=>privateBridgeOn?void openPrivateBridge(r):openBridge(r)}>Bridge</button></div>}</article></div>)}{data.complete&&!data.rows.length&&!nativeMonero&&!wxmrRaw&&<p className="wallet-empty">No confirmed tokens on {network==='monero'?'Monero':'Solana'} yet.</p>}{!data.complete&&!refreshing&&<p className="wallet-index-note">Index update delayed · balances last checked</p>}</>}
 </section>;
}
