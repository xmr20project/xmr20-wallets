import {discoveredAssets} from './joint-bridge-assets.js';

const positive=value=>typeof value==='string'&&/^[0-9]+$/.test(value)&&BigInt(value)>0n;
export const isBridgeHolding=row=>positive(row?.amountRaw)&&(row.network==='solana'||row.network==='monero'&&row.bridge==='joint-v3');

// Preserve unresolved public approvals even when their debit has made the
// portfolio balance zero. Completed returns alone do not create a holding.
export function hasBridgeRecovery(receipt){
 if(Object.values(receipt?.fastOperations??{}).some(j=>j.phase!=='finalized'))return true;
 const jobs=Object.values(receipt?.operations||{});
 if(jobs.some(j=>j?.proposal&&(j.phase!=='finalized'||['register','deposit','donate'].includes(j.proposal.operation)&&j.background?.phase!=='complete')))return true;
 return Object.entries(receipt?.proofs||{}).some(([id,p])=>['transfer','burn'].includes(p?.envelope?.record?.op)&&!jobs.some(j=>j?.phase==='finalized'&&j.proposal?.nonce===id&&j.proposal.operation===(p.envelope.record.op==='burn'?'release':'transfer')));
}

// Catalog rows supply names, never evidence that this wallet owns a token.
// Eligibility here controls discovery only; fresh bridge validation still
// governs every approval, including explicitly opened portfolio rows.
export function walletBridgeAssets(rows=[],{metadata=[],recoveryMints=[],selectedMint}={}){
 const allowed=new Set([...rows.filter(isBridgeHolding).map(r=>r.mint),...recoveryMints,...(selectedMint?[selectedMint]:[])]);
 const labels=new Map(metadata.filter(row=>allowed.has(row.mint)).map(row=>[row.mint,row]));
 const owned=rows.filter(row=>allowed.has(row.mint)).map(row=>{
  const label=labels.get(row.mint),symbol=row.symbol||row.ticker;
  return {...row,...(!symbol||symbol==='Token'?{symbol:label?.symbol||label?.ticker||symbol}:{}),...(!row.name||row.name==='Token'?{name:label?.name||row.name}:{})};
 });
 return discoveredAssets([...owned,...labels.values(),...[...allowed].map(mint=>({mint}))]).filter(a=>a.key!=='previous-xcat'&&allowed.has(a.mint));
}
