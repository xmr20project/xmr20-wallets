const HASH=/^[a-f0-9]{64}$/,ID=/^[a-zA-Z0-9-]{8,80}$/;
export const BRIDGE_PROGRAMS={1:'G4Cedy1wgpCnAAn3N7NmczwqFHdUrrnSbBV2UnbvzKNp',2:'9ZySdqL8A326EfQkU2T8AckeYWCVUeeNyFy42oyVqL4R',3:'2wEBASzbdj13KJtmjK7UFhug38oGaWsfvMGhQ3umr265'};
export const bridgeOpen=t=>['reserved','source_pending','source_finalized','destination_pending'].includes(t?.state);
export function bridgeRaw(n){if(typeof n!=='string'||! /^[1-9][0-9]{0,13}$/.test(n)||BigInt(n)>50000000000000n)throw Error('Bridge amount must be positive and no more than 50 million tokens.');return BigInt(n);}
export function bridgeToken(row,launch){
 const program=BRIDGE_PROGRAMS[launch?.bridgeVersion||1];
 if(!launch||launch.id!==row.id||launch.mint!==row.mint||launch.moneroTxid!==row.deployment||!HASH.test(row.deployment)||!program||launch.bridgeProgramId&&launch.bridgeProgramId!==program||launch.moneroNetwork!=='mainnet'||launch.network!=='mainnet-beta'||launch.solanaFinalized!==true||launch.proofVerified!==true||launch.bridgeReady!==true||!Number.isSafeInteger(launch.confirmations)||launch.confirmations<10||launch.hidden||launch.halted||launch.cancelledAt)throw Error('This token is not ready for bridging. Refresh and try again.');
 return {...row,bridgeVersion:launch.bridgeVersion||1,program};
}
export function bridgeAmounts(q,version){const gross=bridgeRaw(q.amountRaw);if(!/^\d{1,14}$/.test(q.transferTaxRaw||'')||!/^\d{1,14}$/.test(q.netReceivedRaw||''))throw Error('Invalid bridge fee.');const fee=BigInt(q.transferTaxRaw),net=BigInt(q.netReceivedRaw),expected=version>=2?(gross*150n+9999n)/10000n:0n;if(fee!==expected||net<=0n||net+fee!==gross)throw Error('Bridge fee or amount changed. Review again.');return {gross,fee,net};}
export function validateBridgeQuote(q,a,row,direction,raw){
 if(!['sol-to-xmr','xmr-to-sol'].includes(direction)||q?.launchId!==row.id||q.mint!==row.mint||q.direction!==direction||q.amountRaw!==raw||q.network!=='mainnet-beta'||q.moneroNetwork!=='mainnet'||q.bridgeEnabled!==true||q.from!==(direction==='sol-to-xmr'?a.sol:a.xmr)||q.to!==(direction==='sol-to-xmr'?a.xmr:a.sol)||!/^\d{1,16}$/.test(q.balanceRaw||'')||BigInt(q.balanceRaw)<bridgeRaw(raw))throw Error('Bridge quote does not match your account, token or amount.');bridgeAmounts(q,row.bridgeVersion);return q;
}
export function validateBridgeReceipt(t,a,row,{id,direction,raw}={}){
 if(!t||!ID.test(t.id)||t.owner!==a.sol||t.moneroAddress!==a.xmr||t.launchId!==row.id||t.mint!==row.mint||!['sol-to-xmr','xmr-to-sol'].includes(t.direction)||!['reserved','source_pending','source_finalized','destination_pending','complete','halted','cancelled'].includes(t.state)||id&&t.id!==id||direction&&t.direction!==direction||raw&&t.amountRaw!==raw)throw Error('Saved bridge does not match this account.');bridgeAmounts(t,row.bridgeVersion);return t;
}
export function bridgeBurnReview(t,a,row){
 validateBridgeReceipt(t,a,row);const prefix='MOUSE-ROAD-XMR20-MAINNET-BRIDGE-V1\n';
 if(t.direction!=='xmr-to-sol'||t.state!=='reserved'||typeof t.signingMessage!=='string'||t.signingMessage.length>2000||!t.signingMessage.startsWith(prefix))throw Error('Bridge is not ready for Monero approval.');
 const r=JSON.parse(t.signingMessage.slice(prefix.length)),canonical='{'+Object.keys(r).sort().map(k=>JSON.stringify(k)+':'+JSON.stringify(r[k])).join(',')+'}';
 if(Object.keys(r).sort().join(',')!=='amount,net,nonce,op,owner,p,to,token,v'||prefix+canonical!==t.signingMessage||r.p!=='xmr20'||r.v!==1||r.net!=='mainnet'||r.op!=='burn'||r.owner!==a.xmr||r.to!==a.sol||r.token!==row.deployment||r.amount!==t.amountRaw||r.nonce!==t.nonce||!/^[a-f0-9]{32}$/.test(r.nonce))throw Error('Monero approval differs from the reviewed bridge.');
 return {network:'mainnet',address:a.xmr,destination:a.sol,token:row.deployment,amountRaw:r.amount,nonce:r.nonce,message:t.signingMessage};
}
export function bridgeStatus(t){
 if(t.state==='complete')return ['Bridge complete','Your tokens have arrived. Refresh balances to see the indexed update.'];
 if(t.state==='halted'||t.state==='cancelled')return ['Bridge needs review','Keep this saved receipt. Do not start another bridge for the same amount.'];
 if(t.state==='reserved')return t.direction==='sol-to-xmr'?['Ready to lock tokens','Approve the Solana deposit to begin.']:['Ready for Monero approval','Approve the signed instruction to move these tokens back to Solana.'];
 if(t.direction==='xmr-to-sol'&&t.state==='source_finalized')return ['Monero confirmed','One Solana approval remains to unlock your tokens. SOL is required for network and account fees.'];
 if(t.direction==='sol-to-xmr'&&t.state==='source_pending')return ['Confirming on Solana','Your deposit is saved. No new approval is needed.'];
 if(t.direction==='xmr-to-sol'&&t.state==='destination_pending')return ['Confirming on Solana','Your unlock approval is submitted. No new approval is needed.'];
 return ['Confirming on Monero',`${Number.isSafeInteger(t.confirmations)?t.confirmations:0}/10 confirmations. You can close the wallet and resume this bridge later.`];
}
