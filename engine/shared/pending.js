import {checkMoneroAddress} from './address.js';
const ID=/^[a-f0-9-]{36}$/,HASH=/^[a-f0-9]{64}$/,MINT=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const PENDING_URL='https://api.xmr20.org/api/xmr20/pending';
export function validatePending(s,address,now=Date.now()){
 if(s?.schema!=='xmr20-wallet-pending-v1'||s.address!==address||s.network!=='monero'||s.moneroNetwork!=='mainnet'||s.solanaNetwork!=='mainnet-beta'||typeof s.complete!=='boolean'||!Number.isSafeInteger(s.checkedAt)||s.checkedAt<=0||s.checkedAt>now+60000||!Array.isArray(s.rows)||s.rows.length>1000)throw Error('Invalid pending index');
 const seen=new Set(),proofs=new Set();const rows=s.rows.map(r=>{
  if(!ID.test(r.id)||seen.has(r.id)||!ID.test(r.launchId)||!MINT.test(r.mint)||!HASH.test(r.deployment)||!HASH.test(r.txid)||proofs.has(r.txid)||r.address!==address||!['transfer','credit'].includes(r.operation)||!['confirming','validating'].includes(r.state)||typeof r.ticker!=='string'||!/^[A-Z][A-Z0-9]{0,9}$/.test(r.ticker)||typeof r.name!=='string'||!r.name.length||r.name.length>256||typeof r.amountRaw!=='string'||! /^[1-9][0-9]{0,15}$/.test(r.amountRaw)||BigInt(r.amountRaw)>1000000000000000n||!Number.isSafeInteger(r.confirmations)||r.confirmations<0||r.confirmations>10000000||!Number.isSafeInteger(r.checkedAt)||r.checkedAt<=0||r.checkedAt>now+60000)throw Error('Invalid pending transfer');
  seen.add(r.id);proofs.add(r.txid);return {...r,network:'monero',stale:now-r.checkedAt>180000||now-s.checkedAt>180000};
 });return {rows,available:true,complete:s.complete&&!rows.some(r=>r.stale),checkedAt:s.checkedAt};
}
export async function loadPending(address,{fetcher=fetch,signal,endpoint=PENDING_URL}={}){
 const a=checkMoneroAddress(address,'mainnet');if(!a.valid||a.kind!=='standard')throw Error('Invalid Monero address');
 const response=await fetcher(endpoint+'?'+new URLSearchParams({address}),{credentials:'omit',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
 if(response.status===404||response.status===501)return {rows:[],available:false,complete:false};
 if(!response.ok)throw Error('Pending index unavailable');return validatePending(await response.json(),address);
}
export function pendingGroups(pending,confirmed){
 const groups=new Map();for(const r of pending){
  if(confirmed.some(c=>c.network==='monero'&&c.mint===r.mint&&c.deployment===r.deployment&&c.receipt?.url==='https://xmrchain.net/tx/'+r.txid&&c.receipt.confirmations>=10))continue;
  const key=r.deployment+':'+r.mint;if(!groups.has(key))groups.set(key,{id:r.launchId,name:r.name,ticker:r.ticker,mint:r.mint,deployment:r.deployment,network:'monero',amountRaw:'0',stale:false,transfers:[]});const g=groups.get(key);g.amountRaw=String(BigInt(g.amountRaw)+BigInt(r.amountRaw));g.stale=g.stale||r.stale;g.transfers.push(r);
 }return [...groups.values()];
}
