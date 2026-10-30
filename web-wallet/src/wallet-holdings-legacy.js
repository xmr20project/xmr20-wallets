import {validateSnapshot,moneroHolderReceipt} from './holder-snapshot.js';
import {publicLaunches} from './holder-visibility.js';
import {checkMoneroAddress} from '../shared/xmr20/address.js';
const API='https://api.xmr20.org/api/xmr20/tokens';
// Download public snapshots, then match locally. No wallet address or keys are sent.
export async function loadLegacyWalletHoldings(address,{fetcher=fetch,signal}={}){
 const check=checkMoneroAddress(address,'mainnet');if(!check.valid||check.kind!=='standard')throw Error('Invalid Monero address.');
 async function get(url){const r=await fetcher(url,{credentials:'omit',cache:'no-store',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});if(!r.ok)throw Error('Index unavailable');return r.json();}
 const catalog=await get(API);
 if(catalog.schema!=='xmr20-launches-v1'||catalog.moneroNetwork!=='mainnet'||catalog.solanaNetwork!=='mainnet-beta'||!Array.isArray(catalog.tokens)||catalog.tokens.length>10000)throw Error('Index unavailable');
 const listed=new Set(publicLaunches(catalog.tokens).map(t=>t.id));
 const tokens=catalog.tokens.filter(t=>!t.hidden&&!t.halted&&!t.cancelledAt&&t.proofVerified===true&&Number.isSafeInteger(t.confirmations)&&t.confirmations>=10&&t.solanaFinalized===true&&t.state==='Launched'&&/^[a-f0-9]{64}$/.test(t.moneroTxid||'')),results=[],missing=[];let cursor=0;
 if(new Set(tokens.map(t=>t.id)).size!==tokens.length)throw Error('Duplicate token identity in index');
 // Bounded requests; a later catalog needs the server-side wallet projection.
 const batch=tokens.slice(0,250);
 await Promise.all(Array.from({length:Math.min(3,batch.length)},async()=>{while(cursor<batch.length){const token=batch[cursor++];try{
  if(!/^[a-f0-9-]{36}$/.test(token.id)||typeof token.ticker!=='string'||token.ticker.length>10)throw Error();
  const s=validateSnapshot(await get(API+'/'+token.id+'/holders'),token.id);
  if(s.state!=='verified')throw Error();
  const row=s.holders.find(h=>h.network==='monero'&&h.address===address);
  const stale=!!s.stale||!Number.isSafeInteger(s.checkedAt)||Date.now()-s.checkedAt>300000;
  if(stale)missing.push(token.ticker);
  if(row)results.push({id:token.id,listed:listed.has(token.id),deployment:token.moneroTxid,mint:token.mint,ticker:token.ticker,name:token.name,amountRaw:row.amountRaw,checkedAt:s.checkedAt,stale,receipt:moneroHolderReceipt(row)});
 }catch{if(signal?.aborted)throw Error('Wallet changed');missing.push(token.ticker||'Unknown token');}}}));
 if(tokens.length>250)missing.push('Additional tokens beyond the first 250');
 return {rows:results.sort((a,b)=>a.ticker.localeCompare(b.ticker)),complete:missing.length===0,missing,checked:batch.length};
}
export function tokenAmount(raw){const n=BigInt(raw),fraction=String(n%1000000n).padStart(6,'0').replace(/0+$/,'');return (n/1000000n).toLocaleString('en-GB')+(fraction?'.'+fraction:'');}
