// 30 Oct 2026 (owner: the profile's values went to $0.00 — "make sure we fix all of these things, so they never happen again"): one
// SOL/XMR price read for the whole site. CoinGecko's free API limits requests per visitor, every open tab and panel asked on its own,
// and one refused request cleared the prices. A price any xmr20.org tab read in the last minute is reused (localStorage), and when a
// read fails the last price from the past 30 minutes stays shown.
import {createNativePriceClient} from '../../engine/shared/native-prices.js';
import {createPriceClient} from '../../engine/shared/prices.js';
const KEY='xmr20-native-prices-v1',FRESH=60000,KEEP=1800000,client=createNativePriceClient();
const usable=q=>Number.isFinite(q?.sol?.priceUsd)||Number.isFinite(q?.xmr?.priceUsd);
function saved(){try{const v=JSON.parse(localStorage.getItem(KEY)||'null');return v&&Number.isSafeInteger(v.at)&&v.at<=Date.now()+60000&&usable(v.quotes)?v:null;}catch{return null;}}
export async function loadSitePrices(){
 const last=saved();if(last&&Date.now()-last.at<FRESH)return last.quotes;
 const quotes=await client.load().catch(()=>null);
 if(usable(quotes)){try{localStorage.setItem(KEY,JSON.stringify({at:Date.now(),quotes}));}catch{}return quotes;}
 return last&&Date.now()-last.at<KEEP?last.quotes:{};
}
// XMR20 token prices (owner: "you can use meteora/raydium launchlab for the prices"): the extension's reader (prices.js: Raydium
// LaunchLab, then Raydium's price API once a token has graduated), one per page. The holder index sends no prices. A price read in the
// past 30 minutes stays shown when a later read fails.
const tokenClient=createPriceClient(),lastToken=new Map();
export async function loadTokenPrices(mints){
 const quotes=await tokenClient.load(mints).catch(()=>({})),out={};
 for(const mint of mints){const q=quotes?.[mint];
  if(q&&Number.isFinite(q.priceUsd)&&!q.stale)lastToken.set(mint,{priceUsd:q.priceUsd,at:Date.now()});
  const last=lastToken.get(mint);if(last&&Date.now()-last.at<KEEP)out[mint]=last.priceUsd;}
 return out;
}
