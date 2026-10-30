import {createPublicBalanceReader,cachedSolBalance,saveSolBalance} from '../../engine/shared/public-balance.js';
import {createXmr20ExtensionClient} from './xmr20-extension-client.js';
import {connectForThisTab,stillConnected} from './wallet-tab-connection.js';
import React,{createContext,useContext,useEffect,useRef,useState} from 'react';
import bs58 from 'bs58';
import {request,authRequest,setLaunchSession,walletSessionSlot} from './launch-api.js';
import {savedNativeRestoreHeight,saveNativeRestoreHeight} from '../../engine/monero/native-wallet-client.js';
import {moneroWalletVault} from './monero-wallet-vault.js';
const Context=createContext(null),SLOT=walletSessionSlot;
const readSolBalance=createPublicBalanceReader({endpoints:['/api/bridge-solana-read','https://solana-rpc.publicnode.com']});
export const useWallet=()=>useContext(Context);
function LiveWalletProvider({children}){
 const [owner,setOwner]=useState(null),[token,setToken]=useState(null),[provider,setProvider]=useState(null),[pair,setPair]=useState(null),[loaded,setLoaded]=useState(false),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[connectionStep,setConnectionStep]=useState('');const epoch=useRef(0),inflight=useRef(false);
 function disconnect(){try{moneroWalletVault().forgetAll();}catch{}if(provider?.kind==='xmr20')void provider.disconnect().catch(()=>{});epoch.current++;balanceRevision.current++;setSolBalance(null);setBalanceError('');try{sessionStorage.removeItem(SLOT);}catch{}setLaunchSession(null);setToken(null);setOwner(null);setProvider(null);setPair(null);setLoaded(false);setOpen(false);setError('');}
 async function reload(){if(provider?.kind==='xmr20'){try{await provider.checkCurrent();setPair({address:provider.account.monero});setLoaded(true);}catch(e){setError(e.message);setLoaded(false);}return;}const revision=epoch.current;try{const a=await request('account');if(!a||!Object.hasOwn(a,'pair'))throw Error('Saved wallet lookup is incomplete. Retry before creating a wallet.');if(revision===epoch.current){setPair(a.pair);setError('');setLoaded(true);}}catch(e){if(revision===epoch.current){setError(e.message);setLoaded(false);}}}
 async function connect(kind,restore=null){if(inflight.current)return;inflight.current=true;const revision=++epoch.current;setBusy(true);setError('');setConnectionStep('Open your wallet to connect…');try{
  if(kind==='xmr20'){const p=createXmr20ExtensionClient();await p.connect();if(revision!==epoch.current)return;setLaunchSession(null);setToken(null);balanceRevision.current++;setSolBalance(null);setBalanceError('');setOwner(p.account.solana);setProvider(p);setPair(p.account.monero?{address:p.account.monero}:null);setLoaded(true);setOpen(true);return;}
  if(!['phantom','solflare'].includes(kind))throw Error('Choose Phantom or Solflare.');
  const injected=kind==='phantom'?window.phantom?.solana:window.solflare;if(!injected)throw Error(`Install ${kind==='phantom'?'Phantom':'Solflare'} and return here.`);
  const address=await connectForThisTab(injected,restore);if(!address)return;let login,restoredAccount;
  if(restore){if(address!==restore.wallet)throw Error('Wallet changed. Sign in again.');login=restore;restoredAccount=await request('account',{},login.token);}
  else{setConnectionStep('Preparing wallet sign-in…');const c=await authRequest('challenge',{wallet:address});if(revision!==epoch.current)return;setConnectionStep('Approve the sign-in message in your wallet…');const signed=await injected.signMessage(new TextEncoder().encode(c.message),'utf8');if(revision!==epoch.current||injected.publicKey?.toBase58()!==address)throw Error('Wallet changed.');setConnectionStep('Verifying your wallet…');login=await authRequest('signin',{challenge:c.challenge,signature:bs58.encode(signed.signature||signed)});}
  if(revision!==epoch.current)return;
  setLaunchSession(login.token);setToken(login.token);balanceRevision.current++;setSolBalance(null);setBalanceError('');setOwner(address);setPair(null);setLoaded(false);
  const p={kind,address,stillConnected:()=>stillConnected(injected,address),assertCurrent:()=>{if(revision!==epoch.current||injected.publicKey?.toBase58()!==address)throw Error('Wallet changed. Sign in again.');},publicKey:injected.publicKey,on:injected.on?.bind(injected),removeListener:injected.removeListener?.bind(injected),signMessage:async message=>{if(revision!==epoch.current||injected.publicKey?.toBase58()!==address)throw Error('Wallet changed. Sign in again.');const result=await injected.signMessage(message,'utf8');if(revision!==epoch.current||injected.publicKey?.toBase58()!==address)throw Error('Wallet changed. Sign in again.');return result;},signTransaction:async tx=>{if(revision!==epoch.current||injected.publicKey?.toBase58()!==address)throw Error('Wallet changed. Sign in again.');return injected.signTransaction(tx);}};
  if(typeof injected.signAllTransactions==='function'){const signAll=injected.signAllTransactions.bind(injected);p.signAllTransactions=async transactions=>{p.assertCurrent();const result=await signAll(transactions);p.assertCurrent();return result;};}
  setProvider(p);try{sessionStorage.setItem(SLOT,JSON.stringify({kind,wallet:address,token:login.token}));}catch{}if(!restore)setOpen(true);if(restoredAccount&&Object.hasOwn(restoredAccount,'pair')){setPair(restoredAccount.pair);setLoaded(true);}else{void reload();}
 }catch(e){if(revision===epoch.current){try{sessionStorage.removeItem(SLOT);}catch{}setLaunchSession(null);setToken(null);setOwner(null);setProvider(null);setError(restore?'':e.message);if(!restore)setOpen(true);}}finally{inflight.current=false;if(revision===epoch.current){setBusy(false);setConnectionStep('');}}}
 useEffect(()=>{let saved;try{saved=JSON.parse(sessionStorage.getItem(SLOT));}catch{}if(saved&&['phantom','solflare'].includes(saved.kind))void connect(saved.kind,saved);return()=>{epoch.current++;};},[]);
 // 28 Oct 2026 (a user: "when I switch tabs and come back, this option disappears and I can't view the wallet anymore"): an
 // accountChanged that reports the same account, or a disconnect Phantom recovers from without a prompt, keeps this sign-in;
 // another account, a locked wallet or a wallet without that check signs out as before.
 useEffect(()=>{if(!provider?.on)return;let alive=true;
  const check=async next=>{if(provider.address&&next?.toBase58?.()===provider.address)return;await new Promise(r=>setTimeout(r,800));if(!alive)return;
   if(await provider.stillConnected?.().catch(()=>false))return;if(alive)disconnect();};
  provider.on('accountChanged',check);provider.on('disconnect',check);return()=>{alive=false;provider.removeListener?.('accountChanged',check);provider.removeListener?.('disconnect',check);};},[provider]);
 // height (optional): the Monero wallet's creation (start) block, kept with the link (28 Oct 2026).
 async function savePair(address,{height}={}){provider?.assertCurrent();const revision=epoch.current;const r=await request('pair',{address,...(Number.isSafeInteger(height)&&height>=0?{height}:{})});if(revision!==epoch.current)throw Error('Wallet changed.');provider?.assertCurrent();if(r?.pair?.address!==address)throw Error('Wallet linking could not be verified. Please retry.');setPair(r.pair);setLoaded(true);window.dispatchEvent(new Event('xmr20-wallet-paired'));return r.pair;}
 // 28 Oct 2026 (owner: "plan it … basically all wallets will be people creating them through our wallet"): the linked wallet's
 // creation (start) block is kept with the link on the server. A browser without a saved block takes it from there (every sync path
 // then starts at it); a browser that has a block the server lacks sends it once; a block changed later on this browser (Wallet
 // backup, or Change in the sync form) is sent too, so other browsers follow it.
 useEffect(()=>{if(!pair?.address||!token)return;const address=pair.address,local=savedNativeRestoreHeight(address),server=Number.isSafeInteger(pair.height)?pair.height:null;
  if(server!==null&&local!==server)saveNativeRestoreHeight(address,server);
  else if(server===null&&local!==null)void request('pair',{address,height:local}).then(r=>{if(r?.pair?.address===address)setPair(r.pair);}).catch(()=>{});
 },[pair?.address,pair?.height,token]);
 useEffect(()=>{if(!pair?.address||!token)return;const changed=e=>{const {address,height}=e.detail||{};if(address!==pair.address||height===pair.height||!Number.isSafeInteger(height))return;
   void request('pair',{address,height}).then(r=>{if(r?.pair?.address===address)setPair(r.pair);}).catch(()=>{});};
  window.addEventListener('xmr20-start-block',changed);return()=>window.removeEventListener('xmr20-start-block',changed);},[pair?.address,pair?.height,token]);
 async function checkPair(){const revision=epoch.current;const r=await request('account');if(revision!==epoch.current)throw Error('Wallet changed.');if(!r||!Object.hasOwn(r,'pair'))throw Error('Saved wallet lookup is incomplete.');setPair(r.pair);return r.pair;}
 const [solBalance,setSolBalance]=useState(null),[balanceError,setBalanceError]=useState(''),[balanceStale,setBalanceStale]=useState(false),[balanceLoading,setBalanceLoading]=useState(false);
 const balanceRevision=useRef(0);
 async function refreshBalance(){
  if(!owner)return;const current=balanceRevision.current;setBalanceLoading(true);
  try{const raw=await readSolBalance(owner);if(current===balanceRevision.current){saveSolBalance(owner,raw);setSolBalance(raw);setBalanceStale(false);setBalanceError('');}}
  catch{if(current===balanceRevision.current){setBalanceStale(true);setBalanceError('SOL balance could not refresh. Any amount shown is last known.');}}
  finally{if(current===balanceRevision.current)setBalanceLoading(false);}
 }
 useEffect(()=>{
  balanceRevision.current++;const saved=owner?cachedSolBalance(owner):null;setSolBalance(saved?.raw??null);setBalanceStale(!!saved);setBalanceError('');setBalanceLoading(false);if(!owner)return;
  // Also after a bridge or send changes balances (xmr20-holdings-refresh).
  void refreshBalance();const update=()=>{if(!document.hidden)void refreshBalance();};const timer=setInterval(update,30000);window.addEventListener('focus',update);window.addEventListener('xmr20-holdings-refresh',update);
  return()=>{balanceRevision.current++;clearInterval(timer);window.removeEventListener('focus',update);window.removeEventListener('xmr20-holdings-refresh',update);};
 },[owner]);
 return <Context.Provider value={{solBalance,balanceError,balanceStale,balanceLoading,refreshBalance,owner,token,provider,pair,loaded,open,setOpen,busy,error,connectionStep,connect,disconnect,savePair,checkPair,reload}}>{children}</Context.Provider>;
}

function DemoWalletProvider({children}) {
 const [open,setOpen]=useState(true);
 // &wallet-delay=<ms> (30 Oct 2026): the wallet connects after the page has rendered, as on a real visit (release 28's profile
 // crash only happened then).
 const delay=Number(new URLSearchParams(location.search).get('wallet-delay'))||0,[late,setLate]=useState(delay>0);
 useEffect(()=>{if(!late)return;const t=setTimeout(()=>setLate(false),delay);return()=>clearTimeout(t);},[late,delay]);
 // ?wallet-preview=paired (29 Oct 2026): a sample linked Monero address (fresh, unfunded), for the profile page preview.
 // &wallet-owner=<Solana address> (30 Oct 2026): show that public wallet's balances (read-only preview).
 const value={owner:late?null:/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(new URLSearchParams(location.search).get('wallet-owner')||'')?new URLSearchParams(location.search).get('wallet-owner'):'11111111111111111111111111111111',token:null,provider:null,pair:!late&&new URLSearchParams(location.search).get('wallet-preview')==='paired'?{address:/^4[1-9A-HJ-NP-Za-km-z]{94}$/.test(new URLSearchParams(location.search).get('wallet-xmr')||'')?new URLSearchParams(location.search).get('wallet-xmr'):'4AdyMv7EaG59edEMjmaJprAt2DXh5SHKNNbfEZxzzW7f12D4ekMZniwiozY3TAoJGNZ6FzpyqWFfR6E2MjE9rSCG7GDV1Dm',network:'mainnet'}:null,loaded:true,open,setOpen,busy:false,error:'',solBalance:'90000000',balanceError:'',refreshBalance:()=>{},reload:async()=>{},checkPair:async()=>null,savePair:async()=>{throw Error('Visual preview only')},disconnect:()=>setOpen(false),connect:()=>setOpen(true)};
 return <Context.Provider value={value}>{children}<div style={{position:'fixed',bottom:8,left:12,zIndex:10,color:'#ff914b',fontSize:12}}>LOCAL DESIGN PREVIEW · Sample balance · Transactions disabled</div></Context.Provider>;
}
export function WalletProvider({children}) {
 const demo=import.meta.env.VITE_XMR20_DESIGN_PREVIEW==='1'&&['localhost','127.0.0.1'].includes(location.hostname)&&(new URLSearchParams(location.search).has('wallet-preview')||new URLSearchParams(location.search).has('setup-preview'));
 return demo?<DemoWalletProvider>{children}</DemoWalletProvider>:<LiveWalletProvider>{children}</LiveWalletProvider>;
}
