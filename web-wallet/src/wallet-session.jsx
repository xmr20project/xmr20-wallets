import {createPublicBalanceReader,cachedSolBalance,saveSolBalance} from '../../engine/shared/public-balance.js';
import {createXmr20ExtensionClient} from './xmr20-extension-client.js';
import {connectForThisTab} from './wallet-tab-connection.js';
import React,{createContext,useContext,useEffect,useRef,useState} from 'react';
import bs58 from 'bs58';
import {request,authRequest,setLaunchSession,walletSessionSlot} from './launch-api.js';
const Context=createContext(null),SLOT=walletSessionSlot;
const readSolBalance=createPublicBalanceReader({endpoints:['/api/bridge-solana-read','https://solana-rpc.publicnode.com']});
export const useWallet=()=>useContext(Context);
function LiveWalletProvider({children}){
 const [owner,setOwner]=useState(null),[token,setToken]=useState(null),[provider,setProvider]=useState(null),[pair,setPair]=useState(null),[loaded,setLoaded]=useState(false),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[connectionStep,setConnectionStep]=useState('');const epoch=useRef(0),inflight=useRef(false);
 function disconnect(){if(provider?.kind==='xmr20')void provider.disconnect().catch(()=>{});epoch.current++;balanceRevision.current++;setSolBalance(null);setBalanceError('');try{sessionStorage.removeItem(SLOT);}catch{}setLaunchSession(null);setToken(null);setOwner(null);setProvider(null);setPair(null);setLoaded(false);setOpen(false);setError('');}
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
  const p={kind,assertCurrent:()=>{if(revision!==epoch.current||injected.publicKey?.toBase58()!==address)throw Error('Wallet changed. Sign in again.');},publicKey:injected.publicKey,on:injected.on?.bind(injected),removeListener:injected.removeListener?.bind(injected),signMessage:async message=>{if(revision!==epoch.current||injected.publicKey?.toBase58()!==address)throw Error('Wallet changed. Sign in again.');const result=await injected.signMessage(message,'utf8');if(revision!==epoch.current||injected.publicKey?.toBase58()!==address)throw Error('Wallet changed. Sign in again.');return result;},signTransaction:async tx=>{if(revision!==epoch.current||injected.publicKey?.toBase58()!==address)throw Error('Wallet changed. Sign in again.');return injected.signTransaction(tx);}};
  if(typeof injected.signAllTransactions==='function'){const signAll=injected.signAllTransactions.bind(injected);p.signAllTransactions=async transactions=>{p.assertCurrent();const result=await signAll(transactions);p.assertCurrent();return result;};}
  setProvider(p);try{sessionStorage.setItem(SLOT,JSON.stringify({kind,wallet:address,token:login.token}));}catch{}if(!restore)setOpen(true);if(restoredAccount&&Object.hasOwn(restoredAccount,'pair')){setPair(restoredAccount.pair);setLoaded(true);}else{void reload();}
 }catch(e){if(revision===epoch.current){try{sessionStorage.removeItem(SLOT);}catch{}setLaunchSession(null);setToken(null);setOwner(null);setProvider(null);setError(restore?'':e.message);if(!restore)setOpen(true);}}finally{inflight.current=false;if(revision===epoch.current){setBusy(false);setConnectionStep('');}}}
 useEffect(()=>{let saved;try{saved=JSON.parse(sessionStorage.getItem(SLOT));}catch{}if(saved&&['phantom','solflare'].includes(saved.kind))void connect(saved.kind,saved);return()=>{epoch.current++;};},[]);
 useEffect(()=>{if(!provider?.on)return;provider.on('accountChanged',disconnect);provider.on('disconnect',disconnect);return()=>{provider.removeListener?.('accountChanged',disconnect);provider.removeListener?.('disconnect',disconnect);};},[provider]);
 async function savePair(address){provider?.assertCurrent();const revision=epoch.current;const r=await request('pair',{address});if(revision!==epoch.current)throw Error('Wallet changed.');provider?.assertCurrent();if(r?.pair?.address!==address)throw Error('Wallet linking could not be verified. Please retry.');setPair(r.pair);setLoaded(true);window.dispatchEvent(new Event('xmr20-wallet-paired'));return r.pair;}
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
 const value={owner:'11111111111111111111111111111111',token:null,provider:null,pair:null,loaded:true,open,setOpen,busy:false,error:'',solBalance:'90000000',balanceError:'',refreshBalance:()=>{},reload:async()=>{},checkPair:async()=>null,savePair:async()=>{throw Error('Visual preview only')},disconnect:()=>setOpen(false),connect:()=>setOpen(true)};
 return <Context.Provider value={value}>{children}<div style={{position:'fixed',bottom:8,left:12,zIndex:10,color:'#ff914b',fontSize:12}}>LOCAL DESIGN PREVIEW · Sample balance · Transactions disabled</div></Context.Provider>;
}
export function WalletProvider({children}) {
 const demo=import.meta.env.VITE_XMR20_DESIGN_PREVIEW==='1'&&['localhost','127.0.0.1'].includes(location.hostname)&&(new URLSearchParams(location.search).has('wallet-preview')||new URLSearchParams(location.search).has('setup-preview'));
 return demo?<DemoWalletProvider>{children}</DemoWalletProvider>:<LiveWalletProvider>{children}</LiveWalletProvider>;
}
