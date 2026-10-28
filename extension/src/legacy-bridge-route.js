// Custody discovery only. Every withdrawal still performs its original proof,
// amount, account-link and transaction checks before an approval is requested.
import {legacyBridgeRecoveries} from './legacy-bridge-recovery.js';
export function legacyReturnRoute(rows,{requestedMint,emptyNewBridge,receipts,account}={}){
 if(requestedMint||!emptyNewBridge)return null;
 const recovery=legacyBridgeRecoveries(receipts,account);
 if(recovery.length)return recovery.length===1?{receiptId:recovery[0].intent}:{recover:true};
 const held=(rows||[]).filter(row=>row?.network==='monero'&&row.bridge!=='joint-v3'&&typeof row.amountRaw==='string'&&/^\d+$/.test(row.amountRaw)&&BigInt(row.amountRaw)>0n&&typeof row.mint==='string'&&typeof row.id==='string');
 if(!held.length)return null;
 return {direction:'xmr-to-sol',...(held.length===1?{mint:held[0].mint}:{})};
}
