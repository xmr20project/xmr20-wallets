const openStates=new Set(['reserved','source_pending','source_finalized','destination_pending']);
export function bridgeInScope(t,{owner,launchId,mint,network,address}){
 return !!t&&t.owner===owner&&t.launchId===launchId&&t.mint===mint&&t.moneroAddress===address&&t.direction===(network==='monero'?'xmr-to-sol':'sol-to-xmr');
}
export function restoreBridge(transfers,scope,{savedId,resumeId}={}){
 const rows=(transfers||[]).filter(t=>bridgeInScope(t,scope));
 if(resumeId){const exact=rows.find(t=>t.id===resumeId);if(!exact)throw Error('This saved bridge is unavailable for the connected wallet. Reconnect the original Solana wallet.');return exact;}
 const saved=rows.find(t=>t.id===savedId);if(saved)return saved;
 const pending=rows.filter(t=>openStates.has(t.state));
 if(pending.length>1)throw Error('More than one saved bridge exists. Choose Resume bridge on the transfer you want to finish.');
 return pending[0]||null;
}

export function resumableWithdrawals(transfers,{owner,address,tokens=[]}){
 if(!owner||!address)return [];
 const byId=new Map(tokens.map(t=>[t.id,t])),seen=new Set();
 return (transfers||[]).filter(t=>{
  if(!t||t.owner!==owner||t.moneroAddress!==address||t.direction!=='xmr-to-sol'||!openStates.has(t.state)||t.state==='reserved'||typeof t.id!=='string'||seen.has(t.id)||typeof t.amountRaw!=='string'||!/^\d{1,16}$/.test(t.amountRaw)||BigInt(t.amountRaw)<=0n||BigInt(t.amountRaw)>1000000000000000n||!t.launchId||!t.mint)return false;
  const token=byId.get(t.launchId);if(token&&token.mint!==t.mint)return false;
  seen.add(t.id);return true;
 }).map(t=>{const token=byId.get(t.launchId);return {transfer:t,row:{id:t.launchId,mint:t.mint,ticker:token?.ticker||'Token',name:token?.name||'Saved bridge',deployment:token?.moneroTxid,amountRaw:t.amountRaw}};});
}
