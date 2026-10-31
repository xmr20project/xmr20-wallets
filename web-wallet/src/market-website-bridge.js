// MONERO MARKET candidate (30 Oct 2026): joins the xmr20.org website wallet to the market page. Installs
// globalThis.xmr20MarketWallet (the market page's `website` transport, market/ui/wallet-adapter.mjs) with:
//   connect()       unlock this wallet's Monero phrase (one approval in the connected Solana wallet, as the site's Sync does;
//                   an already unlocked token wallet is reused) and start the market host (market-website.js);
//   call(message)   the bounded market.* v2 methods ({method,id,body}) → {value}|{error}; nothing here can approve;
//   showApprovals() bring the wallet's dialog back (market-website-ui.js), where every approval is decided.
// The account comes from the website wallet session (setAccount); a sign-out or another account closes the market.
import {createWebsiteMarket} from './market-website.js';
import {createMarketDialog} from './market-website-ui.js';
import {moneroWalletVault} from './monero-wallet-vault.js';

// config: see createWebsiteMarket. unlocked(account) → the phrase of an already unlocked token wallet for that account, or null.
export function attachMarketWallet({config,unlocked=()=>null,openWalletPanel=()=>{},vault=moneroWalletVault(),target=globalThis}){
 let account=null,market=null,dialog=null;const listeners=new Set();
 const status=()=>({signedIn:Boolean(account?.owner),address:account?.address||null,...(market?market.status():{phase:'closed',error:null})});
 const notify=()=>{const s=status();for(const l of listeners){try{l(s);}catch{}}};
 function stop(){const m=market,d=dialog;market=null;dialog=null;m?.close();d?.remove();notify();}
 const view=a=>({account:{name:a.label||'Website wallet',monero:a.address}});
 async function connect(){
  const a=account;
  if(!a?.owner||!a?.provider){openWalletPanel();throw Error('Sign in to your XMR20 wallet first (Wallet, top right), then connect again.');}
  if(!a.address)throw Error('Link a Monero wallet to your XMR20 wallet first.');
  if(market&&market.address===a.address&&!['failed','closed'].includes(market.status().phase)){await market.start();return view(a);}
  stop();
  const getSeed=async()=>{const open=unlocked(a);if(open)return open;const context={owner:a.owner,network:'mainnet',address:a.address};
   if(!vault.has(context))throw Error('This browser has no saved key for this Monero wallet. Sync it once in your XMR20 wallet, then connect again.');
   // Release 28: {session:true} reuses the approval a Sync kept for this browser session, so connecting asks Phantom nothing more.
   return vault.load(context,a.provider,{session:true});};
  const m=createWebsiteMarket({config,address:a.address,label:a.label||'Website wallet',getSeed,startHeight:a.height||0,onChange:()=>{if(market===m){dialog?.render();notify();}}});
  market=m;dialog=createMarketDialog({market:m});notify();
  try{await m.start();}catch(e){if(market===m)stop();throw e;}
  if(account?.owner!==a.owner||account?.address!==a.address){stop();throw Error('Your XMR20 wallet changed while the market opened. Connect again.');}
  return view(a);
 }
 async function call(message){
  try{if(!market)throw Error('Connect your XMR20 wallet to the market first.');return {value:await market.handle(message)};}
  catch(e){return {error:String(e?.message||e).slice(0,300)};}
 }
 const api=Object.freeze({version:1,connect,call,status,showApprovals:()=>dialog?.show(),onChange:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}});
 Object.defineProperty(target,'xmr20MarketWallet',{value:api,configurable:true,writable:false});
 target.dispatchEvent?.(new Event('xmr20-market-wallet'));
 const leave=()=>stop();globalThis.addEventListener?.('pagehide',leave);
 return {
  // {owner, provider (signMessage), address, height, label} from the website wallet session; null when signed out.
  setAccount(next){const same=account&&next&&account.owner===next.owner&&account.address===next.address;account=next||null;if(!same&&market)stop();notify();},
  // The website wallet was locked (its token wallet closed): stop answering buyers until connected again.
  lock:stop,
  close(){stop();globalThis.removeEventListener?.('pagehide',leave);if(target.xmr20MarketWallet===api)delete target.xmr20MarketWallet;},
 };
}
