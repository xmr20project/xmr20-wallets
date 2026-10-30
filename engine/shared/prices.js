// Display-only reference prices. Never used for signing, available balances or fees.
export const LAUNCHLAB_URL='https://launch-mint-v1.raydium.io/get/by/mints';
export const RAYDIUM_PRICE_URL='https://api-v3.raydium.io/mint/price';
export const XMR20_PLATFORM='AvnRU5mzuQujakZeMLTPRiGYdqFw3LF5QUCXmk27ZCTo';
// Public XMR20 tweet-launch platform; display pricing only, never spending authority.
export const XMR20_TWEET_PLATFORM='46otjKsDngkHBjScqHmVBkroPtbieJajPj8AC31cHzbW';
const XMR20_PRICE_PLATFORMS=new Set([XMR20_PLATFORM,XMR20_TWEET_PLATFORM]);
export const WXMR_MINT='WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp';
const MINT=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
export function launchPrice(row,mint,spot,checkedAt){
 if(!row||row.mint!==mint||!MINT.test(mint)||!MINT.test(row.poolId)||!XMR20_PRICE_PLATFORMS.has(row.platformInfo?.pubKey)||row.mintB?.address!==WXMR_MINT||row.mintB?.chainId!==101||row.decimals!==6)return null;
 let priceUsd,source;
 if(row.migrateAmmId){
  if(!MINT.test(row.migrateAmmId)||!spot||spot.success!==true||!Object.hasOwn(spot.data||{},mint))return null;
  const value=spot.data[mint];if(!['number','string'].includes(typeof value)||typeof value==='string'&&(!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/i.test(value)||value.length>64))return null;
  priceUsd=Number(value);source='Raydium';
 }else{
  if(!Number.isFinite(row.finishingRate)||row.finishingRate<0||row.finishingRate>=100||!positive(row.marketCap)||!positive(row.supply)||row.supply>1000000000)return null;
  priceUsd=row.marketCap/row.supply;source='LaunchLab';
 }
 if(!positive(priceUsd)||priceUsd>1000000)return null;
 return {mint,priceUsd,source,checkedAt,stale:false};
}
export function createPriceClient({fetcher=fetch,now=Date.now,ttl=60000,maxAge=180000,onMetadata=()=>{}}={}){
 const cache=new Map();let running=null;
 async function json(url){const response=await fetcher(url,{credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error('Prices unavailable');const data=await response.json();if(data?.success!==true)throw Error('Prices unavailable');return data;}
 async function update(mints){
  for(let i=0;i<mints.length;i+=50){const group=mints.slice(i,i+50),attempt=now();
   // Mark failed attempts too, so the 15-second balance refresh cannot hammer pricing APIs.
   for(const mint of group)cache.set(mint,{...cache.get(mint),attempt,failed:true});
   try{
    const launches=await json(LAUNCHLAB_URL+'?ids='+group.join(','));
    if(!Array.isArray(launches.data?.rows)||launches.data.rows.length>group.length)throw Error('Invalid LaunchLab response');
    const rows=new Map();for(const row of launches.data.rows){if(!row||!group.includes(row.mint)||rows.has(row.mint))throw Error('Invalid LaunchLab identity');rows.set(row.mint,row);}
    try{onMetadata([...rows.values()]);}catch{/* Optional artwork cannot invalidate prices. */}
    const graduated=group.filter(m=>rows.get(m)?.migrateAmmId);let spot=null;
    if(graduated.length)try{spot=await json(RAYDIUM_PRICE_URL+'?mints='+graduated.join(','));}catch{}
    for(const mint of group){const row=rows.get(mint);if(row?.migrateAmmId&&!spot)continue;cache.set(mint,{attempt,quote:launchPrice(row,mint,spot,now()),failed:false});}
   }catch{/* Previously fetched quotes remain labelled stale, then expire. */}
  }
  // Bound public metadata retained in memory across account changes.
  if(cache.size>1000)for(const key of cache.keys()){if(cache.size<=1000)break;if(!mints.includes(key))cache.delete(key);}
 }
 return {async load(input,{force=false}={}){const mints=[...new Set(input.filter(m=>typeof m==='string'&&MINT.test(m)))].slice(0,1000);if(running){await running;force=false;}
  const due=mints.filter(m=>!cache.has(m)||now()-cache.get(m).attempt>=(force?5000:ttl));
  if(due.length){running=update(due);try{await running;}finally{running=null;}}
  const result={};for(const mint of mints){const entry=cache.get(mint),quote=entry?.quote;result[mint]=quote&&now()-quote.checkedAt<=maxAge?{...quote,stale:entry.failed||now()-quote.checkedAt>=maxAge}:null;}return result;
 }};
}
export function tokenUsd(row,quote){
 if(!quote||quote.mint!==row.mint||!positive(quote.priceUsd)||typeof row.amountRaw!=='string'||!/^\d{1,16}$/.test(row.amountRaw))return null;
 const raw=Number(row.amountRaw);if(!Number.isSafeInteger(raw)||raw<0||raw>1000000000000000)return null;
 const value=raw/1000000*quote.priceUsd;return Number.isFinite(value)?value:null;
}
export function currentQuote(prices,mint,now=Date.now()){const q=prices?.[mint];return q&&Number.isSafeInteger(q.checkedAt)&&q.checkedAt<=now+1000&&now-q.checkedAt<180000?q:null;}
export function tokenPortfolio(rows,prices={},complete=false,now=Date.now()){
 let total=0,priced=0;for(const row of rows){const quote=currentQuote(prices,row.mint,now),value=tokenUsd(row,quote);if(value===null||quote.stale||row.stale)continue;total+=value;priced++;}
 return {value:priced?total:complete&&rows.length===0?0:null,priced,count:rows.length,partial:!complete||priced!==rows.length};
}
export function usd(value,{unit=false}={}){if(value===null||!Number.isFinite(value)||value<0)return '—';if(value>0&&value<0.01&&!unit)return '<$0.01';return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:unit?2:2,maximumFractionDigits:unit?10:2}).format(value);}
