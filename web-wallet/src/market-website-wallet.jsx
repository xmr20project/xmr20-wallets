// MONERO MARKET (30 Oct 2026, NOT YET IN THE SITE): the website wallet's side of /market. Copy into website/frontend/src with
// market-website.js, market-website-ui.js and market-website-bridge.js (handoff README), and mount from wallet-entry.jsx on a
// page that has #xmr20-market-root. It feeds the signed-in wallet session to the market bridge; the market page then offers
// "XMR20 wallet on this site". Locking the wallet (its token wallet closes) stops the market wallet too.
import {useEffect,useRef} from 'react';
import {useWallet} from './wallet-session.jsx';
import {currentWebsitePrivateWallet,subscribeWebsitePrivateWallet} from './private-wallet-host.js';
import {nativeRestoreHeight} from '../../engine/monero/native-wallet-client.js';
import {attachMarketWallet} from './market-website-bridge.js';

// Build-time configuration (vite define), like the extension candidate's; without it the market wallet is not offered.
const CONFIG=typeof __XMR20_MONERO_MARKET_NODE__==='string'&&typeof __XMR20_MONERO_MARKET_PARAMS__==='string'&&typeof __XMR20_MONERO_MARKET_API__==='string'&&typeof __XMR20_MONERO_MARKET_ASSET__==='string'
 ?{base:(import.meta.env?.BASE_URL||'/')+'xmr20-market/',node:__XMR20_MONERO_MARKET_NODE__,params:__XMR20_MONERO_MARKET_PARAMS__,api:__XMR20_MONERO_MARKET_API__,asset:__XMR20_MONERO_MARKET_ASSET__}:null;

export default function MarketWebsiteWallet(){
 const {owner,provider,pair,setOpen}=useWallet()||{};const bridge=useRef(null);
 useEffect(()=>{
  if(!CONFIG)return;
  bridge.current=attachMarketWallet({config:CONFIG,openWalletPanel:()=>setOpen?.(true),
   // An unlocked token wallet for the same account already holds the phrase: reuse it (no second approval).
   unlocked:a=>{const w=currentWebsitePrivateWallet()?.account();return w&&w.sol===a.owner&&w.xmr===a.address&&w.xmrSeed?w.xmrSeed:null;}});
  let wasOpen=Boolean(currentWebsitePrivateWallet());
  const off=subscribeWebsitePrivateWallet(w=>{if(wasOpen&&!w)bridge.current?.lock();wasOpen=Boolean(w);});
  return()=>{off();bridge.current?.close();bridge.current=null;};
 },[]);
 useEffect(()=>{
  bridge.current?.setAccount(owner&&provider?.signMessage?{owner,provider,address:pair?.address||null,height:pair?.address?nativeRestoreHeight(pair.address):0,label:'XMR20 wallet'}:null);
 },[owner,provider,pair?.address]);
 return null;
}
