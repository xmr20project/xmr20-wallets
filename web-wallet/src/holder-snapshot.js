const raw=v=>typeof v==='string'&&/^\d{1,16}$/.test(v);
// Withheld transfer fees remain in Solana supply but are not spendable holder balances.
export function validateSnapshot(s,id){
 if(s.schema!=='xmr20-holders-v1'||s.id!==id||!['verified','unissued','syncing'].includes(s.state))throw Error('Invalid snapshot');
 if(s.state==='verified'){
  for(const k of ['capRaw','currentSupplyRaw','solanaRaw','moneroRaw','inTransitRaw','unassignedEscrowRaw','escrowRaw','burnedRaw'])if(!raw(s[k]))throw Error('Invalid supply');
  if(s.capRaw!=='1000000000000000'||BigInt(s.solanaRaw)+BigInt(s.moneroRaw)+BigInt(s.inTransitRaw)+BigInt(s.unassignedEscrowRaw)+BigInt(s.burnedRaw)!==BigInt(s.capRaw)||!Array.isArray(s.holders))throw Error('Supply does not reconcile');
  const withheld=s.withheldTaxRaw===undefined?'0':s.withheldTaxRaw;
  if(!raw(withheld)||BigInt(withheld)>BigInt(s.solanaRaw))throw Error('Invalid withheld fees');
  if(BigInt(s.currentSupplyRaw)+BigInt(s.burnedRaw)!==BigInt(s.capRaw)||BigInt(s.escrowRaw)!==BigInt(s.moneroRaw)+BigInt(s.inTransitRaw)+BigInt(s.unassignedEscrowRaw))throw Error('Supply does not reconcile');
  const seen=new Set();let sol=0n,xmr=0n;for(const r of s.holders){if(!['solana','monero'].includes(r.network)||typeof r.address!=='string'||r.address.length>106||!raw(r.amountRaw)||BigInt(r.amountRaw)<=0n||!Number.isFinite(r.percentage)||r.percentage<0||r.percentage>100||seen.has(r.network+':'+r.address))throw Error('Invalid holder');seen.add(r.network+':'+r.address);if(r.network==='solana')sol+=BigInt(r.amountRaw);else xmr+=BigInt(r.amountRaw);}
  if(sol+BigInt(withheld)!==BigInt(s.solanaRaw)||xmr!==BigInt(s.moneroRaw))throw Error('Incomplete holders');
 }
 return s;
}

// Older snapshots have no provenance. Leave their address as plain text.
export function moneroHolderReceipt(row){
 const p=row.lastIncoming;
 if(row.network!=='monero'||!p||!/^[a-f0-9]{64}$/.test(p.txid)||!['credit','transfer'].includes(p.operation)||!raw(p.amountRaw)||BigInt(p.amountRaw)<=0n||!Number.isSafeInteger(p.height)||p.height<0||!Number.isSafeInteger(p.confirmations)||p.confirmations<10)return null;
 return {url:'https://xmrchain.net/tx/'+p.txid,label:p.operation==='credit'?'Latest bridge credit':'Latest incoming transfer',confirmations:p.confirmations};
}
