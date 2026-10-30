import {tokenPortfolio,tokenUsd,currentQuote} from './prices.js';
export const NATIVE_PRICE_URL='https://api.coingecko.com/api/v3/simple/price?ids=solana,monero&vs_currencies=usd&include_last_updated_at=true';
export function parseNativePrices(data,now=Date.now()){
 const out={};for(const [symbol,id] of [['sol','solana'],['xmr','monero']]){
  const p=data?.[id],stamp=p?.last_updated_at*1000;
  if(typeof p?.usd==='number'&&Number.isFinite(p.usd)&&p.usd>0&&p.usd<10000000&&Number.isSafeInteger(stamp)&&stamp<=now+60000&&now-stamp<600000)out[symbol]={priceUsd:p.usd,checkedAt:now,sourceAt:stamp,source:'CoinGecko'};
 }return out;
}
export function createNativePriceClient({fetcher=fetch,now=Date.now,ttl=60000}={}){
 let quotes={},attempt=-Infinity,running;
 return {async load({force=false}={}){if(running)return running;if(now()-attempt<(force?5000:ttl))return quotes;attempt=now();running=(async()=>{try{const r=await fetcher(NATIVE_PRICE_URL,{credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error();quotes=parseNativePrices(await r.json(),now());}catch{quotes={};}return quotes;})();try{return await running;}finally{running=null;}}};
}
export function nativeUsd(raw,decimals,quote,now=Date.now()){
 if(typeof raw!=='string'||!/^\d{1,22}$/.test(raw))return null;
 if(BigInt(raw)===0n)return 0;
 if(!quote||!Number.isFinite(quote.priceUsd)||quote.priceUsd<=0||!Number.isSafeInteger(quote.checkedAt)||quote.checkedAt>now+1000||now-quote.checkedAt>=180000||!Number.isSafeInteger(quote.sourceAt)||quote.sourceAt>now+60000||now-quote.sourceAt>=600000)return null;
 const value=Number(raw)/10**decimals*quote.priceUsd;return Number.isFinite(value)?value:null;
}
export function walletPortfolio(cache,account,now=Date.now()){
 const tokens=tokenPortfolio(cache.rows,cache.prices,cache.complete,now),values=[];
 let partial=tokens.partial;
 if(tokens.value!==null)values.push(tokens.value);
 for(const [symbol,decimals,raw] of [['sol',9,cache.sol],['xmr',12,cache.xmr&&cache.xmr.address===account?.xmr?cache.xmr.balanceRaw:null]]){
  if(!account?.[symbol])continue;
  const value=nativeUsd(raw,decimals,cache.nativePrices?.[symbol],now);if(value===null)partial=true;else values.push(value);
 }
 return {value:values.length?values.reduce((a,b)=>a+b,0):null,partial};
}

// A delayed index must not make a known token holding disappear from the
// displayed estimate. Spending continues to use independently verified data.
export function walletPortfolioEstimate(cache,account,now=Date.now()){
 const current=walletPortfolio(cache,account,now);let extra=0,coverage=0,lastKnown=!!cache.solStale;
 for(const row of cache.rows){const quote=currentQuote(cache.prices,row.mint,now),value=tokenUsd(row,quote);if(value===null)continue;coverage++;if(row.stale||quote.stale){extra+=value;lastKnown=true;}}
 for(const [symbol,decimals,raw] of [['sol',9,cache.sol],['xmr',12,cache.xmr&&cache.xmr.address===account?.xmr?cache.xmr.balanceRaw:null]])if(account?.[symbol]&&nativeUsd(raw,decimals,cache.nativePrices?.[symbol],now)!==null)coverage++;
 return {...current,value:current.value===null&&coverage===0?null:(current.value??0)+extra,lastKnown,coverage};
}
