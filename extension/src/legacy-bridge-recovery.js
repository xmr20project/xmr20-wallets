import {bridgeOpen,bridgeStatus,validateBridgeReceipt} from './bridge-policy.js';

// A saved return remains discoverable after its Monero burn consumes the balance.
// These are display/recovery hints; opening one re-reads its authoritative receipt.
export function legacyBridgeRecoveries(receipts,account){
 if(!account?.id||!account.sol||!account.xmr)return [];
 const seen=new Set();
 return (receipts||[]).filter(receipt=>{
  if(receipt?.kind!=='bridge'||receipt.accountId!==account.id||!receipt.row||receipt.row.bridge==='joint-v3'||receipt.intent!==receipt.transfer?.id||seen.has(receipt.intent))return false;
  try{validateBridgeReceipt(receipt.transfer,account,receipt.row);}
  catch{return false;}
  if(!bridgeOpen(receipt.transfer)&&receipt.transfer.state!=='halted')return false;
  seen.add(receipt.intent);return true;
 });
}

export function legacyRecoveryHTML(receipts,account,{esc,amount}){
 const pending=legacyBridgeRecoveries(receipts,account);
 if(!pending.length)return '';
 return `<section class="pending-section" aria-label="Saved bridge returns"><h3>Unfinished bridges</h3>${pending.map((receipt,index)=>{
  const transfer=receipt.transfer,[title,detail]=bridgeStatus(transfer),symbol=receipt.row.ticker||receipt.symbol||'Token';
  return `<article class="receipt"><strong>${esc(amount(transfer.netReceivedRaw))} ${esc(symbol)} to ${transfer.direction==='xmr-to-sol'?'Solana':'Monero'}</strong><p>Last saved: ${esc(title)}</p><p class="subtle">${esc(detail)}</p><button class="primary wide" id="resume-legacy-${index}">Check and continue bridge</button></article>`;
 }).join('')}</section>`;
}
