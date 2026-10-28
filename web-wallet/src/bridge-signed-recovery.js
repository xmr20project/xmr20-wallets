import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {VersionedTransaction} from '@solana/web3.js';

// A local timeout is never proof that a signed transaction can be discarded.
// Only the authenticated receipt for this exact intent and signed attempt is.
export function savedWithdrawalResolution(transfer,savedText,owner){
 try{
  const saved=JSON.parse(savedText||'null');
  if(!saved||saved.operation!=='Withdrawal'||saved.id!==transfer?.id||transfer.owner!==owner||transfer.direction!=='xmr-to-sol')return null;
  const tx=VersionedTransaction.deserialize(Buffer.from(saved.transaction,'base64'));
  if(tx.message.staticAccountKeys[0]?.toBase58()!==owner||!tx.signatures[0]?.some(b=>b!==0))return null;
  const signature=bs58.encode(tx.signatures[0]);
  if(transfer.state==='complete'&&transfer.destinationSignature===signature)return 'complete';
  if(transfer.state!=='source_finalized'||transfer.destinationSignature)return null;
  const attempt=transfer.withdrawalHistory?.find(a=>a.signature===signature&&a.blockhash===tx.message.recentBlockhash&&['expired','failed'].includes(a.reason)&&a.checkedAt);
  return attempt?'expired':null;
 }catch{return null;}
}

export function bridgeReceiptAdvanced(previous,next){
 if(!previous||!next||previous.id!==next.id)return false;
 return previous.state!==next.state||previous.sourceSignature!==next.sourceSignature||previous.destinationSignature!==next.destinationSignature||previous.withdrawalHistory?.length!==next.withdrawalHistory?.length;
}
