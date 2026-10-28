export function moneroSendStatus(transfer,{submitting=false}={}){
 if(!transfer)return null;
 if(submitting)return {label:'Pending',detail:'Submitting your approval and preparing the Monero transaction…',waiting:true};
 if(transfer.state==='pending')return {
  label:'Pending',
  detail:transfer.txid?`Waiting for Monero confirmation · ${transfer.confirmations||0}/10 confirmations.`:'Waiting for the Monero transaction ID. Status updates automatically.',
  waiting:!transfer.txid,
 };
 return {label:transfer.state==='reserved'?'Awaiting approval':transfer.state==='complete'?'Complete':transfer.state==='cancelled'?'Cancelled':transfer.state.replaceAll('_',' '),detail:'',waiting:false};
}

export function sendReceiptAdvanced(previous,next){
 return Boolean(next&&(next.txid&&next.txid!==previous?.txid||['complete','cancelled','halted'].includes(next.state)&&next.state!==previous?.state));
}

export function receiptPollDelay(transfer,{moneroSend=false,submitting=false}={}){
 return moneroSend&&(transfer?.state==='pending'||submitting)&&!transfer?.txid?1500:8000;
}
