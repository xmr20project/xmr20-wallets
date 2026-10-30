// Public display data only. Never used to calculate a transaction or approve it.
const key=a=>'xmr20-portfolio-display-v1:'+a.sol+':'+a.xmr;
const valid=v=>Number.isFinite(v)&&v>=0&&v<1e18;
export function cachedPortfolio(a,{storage=globalThis.localStorage,now=Date.now()}={}){
 try{const v=JSON.parse(storage.getItem(key(a)));if(v?.sol!==a.sol||v?.xmr!==a.xmr||!valid(v.value)||!Number.isSafeInteger(v.coverage)||v.coverage<0||!Number.isSafeInteger(v.savedAt)||v.savedAt>now||now-v.savedAt>86400000)return null;return v;}catch{return null;}
}
export function savePortfolio(a,portfolio,coverage,sol,{storage=globalThis.localStorage,now=Date.now()}={}){
 if(!valid(portfolio.value)||!Number.isSafeInteger(coverage)||coverage<0)return;
 try{storage.setItem(key(a),JSON.stringify({sol:a.sol,xmr:a.xmr,value:portfolio.value,coverage,solRaw:typeof sol==='string'&&/^\d{1,20}$/.test(sol)?sol:null,savedAt:now}));}catch{}
}
export function portfolioDisplay(current,cached,coverage,complete=false){
 return !complete&&cached&&(current.value===null||coverage<cached.coverage)?{...current,value:cached.value,lastKnown:true}:current;
}
