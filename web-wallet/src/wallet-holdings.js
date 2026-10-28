import {checkMoneroAddress} from '../shared/xmr20/address.js';
import {loadLegacyWalletHoldings} from './wallet-holdings-legacy.js';
export {tokenAmount} from './wallet-holdings-legacy.js';
export const WALLET_HOLDINGS_URL='/api/wallet-holdings';
export const validTokenImage=image=>image===null||image===undefined||image==='/assets/tokens/covert-v1.png'||typeof image==='string'&&/^https:\/\/api\.xmr20\.org\/mainnet\/i\/[A-Za-z0-9_-]{20,80}$/.test(image);
const key=(a,network='monero')=>'xmr20-public-holdings-v1:'+network+':'+a;
const id=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
function validAddress(address,network){if(network==='solana'){if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))throw Error('Invalid Solana address');return;}const a=checkMoneroAddress(address,'mainnet');if(!a.valid||a.kind!=='standard')throw Error('Invalid Monero address');}
export function walletIndexMaxAge(s){
 if(s.source===undefined&&s.maxSnapshotAgeMs===undefined)return 180000;
 if(s.source==='independent-verified'&&s.maxSnapshotAgeMs===600000)return 600000;
 throw Error('Invalid wallet index freshness');
}
export function validateWalletHoldings(s,address,network='monero'){
 if(s?.schema!=='xmr20-wallet-holdings-v1'||s.address!==address||(s.network||'monero')!==network||s.moneroNetwork!=='mainnet'||s.solanaNetwork!=='mainnet-beta'||!Array.isArray(s.rows)||s.rows.length>10000||typeof s.complete!=='boolean'||!Number.isSafeInteger(s.checked)||s.checked<0)throw Error('Invalid wallet index');
 const maxAge=walletIndexMaxAge(s);
 const seen=new Set();const rows=s.rows.map(r=>{
  if(!id(r.id)||seen.has(r.id)||typeof r.mint!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.mint)||typeof r.ticker!=='string'||r.ticker.length>10||typeof r.name!=='string'||r.name.length>256||!/^[a-f0-9]{64}$/.test(r.deployment)||typeof r.listed!=='boolean'||typeof r.stale!=='boolean'||typeof r.amountRaw!=='string'||!/^\d{1,16}$/.test(r.amountRaw)||BigInt(r.amountRaw)<=0n||BigInt(r.amountRaw)>1000000000000000n||!Number.isSafeInteger(r.checkedAt)||r.checkedAt<=0||r.checkedAt>Date.now()+60000)throw Error('Invalid holder');
  if(!validTokenImage(r.image))throw Error('Invalid token image');
  if(r.priceUsd!==undefined&&r.priceUsd!==null&&(!Number.isFinite(r.priceUsd)||r.priceUsd<=0||r.priceUsd>1000000))throw Error('Invalid market price');
  seen.add(r.id);let receipt=null;
  if(r.receipt){if(network!=='monero'||!/^https:\/\/xmrchain.net\/tx\/[a-f0-9]{64}$/.test(r.receipt.url)||!['Latest bridge credit','Latest incoming transfer'].includes(r.receipt.label)||!Number.isSafeInteger(r.receipt.confirmations)||r.receipt.confirmations<10)throw Error('Invalid receipt');receipt={url:r.receipt.url,label:r.receipt.label,confirmations:r.receipt.confirmations};}
  return {id:r.id,mint:r.mint,ticker:r.ticker,name:r.name,image:r.image||null,priceUsd:r.priceUsd??null,deployment:r.deployment,listed:r.listed,amountRaw:r.amountRaw,checkedAt:r.checkedAt,stale:r.stale||Date.now()-r.checkedAt>maxAge,receipt};
 });
 return {rows,complete:s.complete&&!rows.some(r=>r.stale),checked:s.checked,cached:false,...(s.source?{source:s.source,maxSnapshotAgeMs:maxAge}:{})};
}
function envelope(address,data,network){return {schema:'xmr20-wallet-holdings-v1',address,network,moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',...data};}
export function cachedWalletHoldings(address,{storage=globalThis.localStorage,now=Date.now(),network='monero'}={}){
 try{const s=JSON.parse(storage.getItem(key(address,network)));if(!Number.isSafeInteger(s.savedAt)||s.savedAt>now||now-s.savedAt>86400000)return null;const d=validateWalletHoldings(s,address,network);return {...d,complete:false,cached:true,savedAt:s.savedAt,rows:d.rows.map(r=>({...r,stale:true}))};}catch{return null;}
}
export function cacheWalletHoldings(address,data,{storage=globalThis.localStorage,now=Date.now(),network='monero'}={}){
 try{const clean=validateWalletHoldings(envelope(address,data,network),address,network);storage.setItem(key(address,network),JSON.stringify({...envelope(address,clean,network),savedAt:now}));}catch{}
}
// Queries public token records only. Never reads keys or starts a native wallet scan.
export async function loadWalletHoldings(address,{fetcher=fetch,signal,endpoint=WALLET_HOLDINGS_URL,network='monero'}={}){
 validAddress(address,network);
 for(let attempt=0;attempt<2;attempt++){
  const rows=[];let after='',revision=null,checked=null,complete=true,sourcePolicy={};const cursors=new Set();let changed=false;
  for(let page=0;page<100;page++){
   const q=new URLSearchParams({address,network});if(after){q.set('after',after);q.set('revision',String(revision));}
   const r=await fetcher(endpoint+'?'+q,{credentials:'omit',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
   // Compatibility until the new read endpoint is deployed; never mask outages.
   if(network==='monero'&&page===0&&(r.status===404||r.status===501))return loadLegacyWalletHoldings(address,{fetcher,signal});
   if(r.status===409){changed=true;break;}if(!r.ok)throw Error('Wallet index unavailable');
   const s=await r.json(),data=validateWalletHoldings(s,address,network);
   if(!Number.isSafeInteger(s.revision)||s.revision<0||s.rows.length>100||s.nextCursor!==null&&!id(s.nextCursor))throw Error('Invalid index page');
   const nextPolicy=data.source?{source:data.source,maxSnapshotAgeMs:data.maxSnapshotAgeMs}:{};
   if(revision!==null&&(revision!==s.revision||checked!==s.checked||JSON.stringify(sourcePolicy)!==JSON.stringify(nextPolicy))){changed=true;break;}
   sourcePolicy=nextPolicy;revision=s.revision;checked=s.checked;complete=complete&&data.complete;rows.push(...data.rows);
   if(s.nextCursor===null)return validateWalletHoldings(envelope(address,{...sourcePolicy,rows,complete,checked},network),address,network);
   if(!s.rows.length||s.nextCursor!==s.rows.at(-1).id||s.nextCursor<=after||cursors.has(s.nextCursor))throw Error('Invalid page cursor');
   cursors.add(s.nextCursor);after=s.nextCursor;
  }
  if(!changed)throw Error('Wallet index result too large');
 }
 throw Error('Wallet index changed during refresh; retry shortly');
}
