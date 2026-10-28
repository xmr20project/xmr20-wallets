const pendingStates=new Set(['source_pending','source_finalized','destination_pending']);
const raw=value=>typeof value==='string'&&/^\d{1,16}$/.test(value)&&BigInt(value)>0n&&BigInt(value)<=1000000000000000n;
const signature=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value);
export function pendingMoneroBridges(transfers,{owner,address,tokens=[],confirmed=[]}){
 if(!owner||!address)return [];
 const byId=new Map(tokens.map(t=>[t.id,t])),seen=new Set(),rows=[];
 for(const t of transfers||[]){
  if(t.owner!==owner||t.moneroAddress!==address||t.direction!=='sol-to-xmr'||!pendingStates.has(t.state)||!signature(t.sourceSignature)||typeof t.id!=='string'||seen.has(t.id))continue;
  const amount=t.creditRaw??t.netReceivedRaw;if(!raw(amount)||!raw(t.amountRaw)||BigInt(amount)>BigInt(t.amountRaw))continue;
  // A finalized credit already visible in the holdings index must not appear twice.
  if(t.destinationTxid&&confirmed.some(r=>r.id===t.launchId&&r.receipt?.url==='https://xmrchain.net/tx/'+t.destinationTxid&&r.receipt.confirmations>=10))continue;
  const token=byId.get(t.launchId);if(token&&token.mint!==t.mint)continue;
  seen.add(t.id);rows.push({id:t.id,launchId:t.launchId,mint:t.mint,ticker:token?.ticker||'Token',name:token?.name||'Incoming bridge',amountRaw:amount,sourceSignature:t.sourceSignature,destinationTxid:typeof t.destinationTxid==='string'&&/^[a-f0-9]{64}$/.test(t.destinationTxid)?t.destinationTxid:null,state:t.state,confirmations:Number.isSafeInteger(t.confirmations)?Math.max(0,Math.min(10,t.confirmations)):0});
 }
 return rows;
}
