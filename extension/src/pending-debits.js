const raw=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,39})$/.test(value);
const id=value=>typeof value==='string'&&/^[-a-zA-Z0-9]{8,80}$/.test(value);
export function pendingDebits(remote,account,row){
 if(!remote||!Array.isArray(remote.moneroTransfers)||!Array.isArray(remote.transfers))throw Error('Pending requests could not be verified. Please retry.');
 const result=[];
 for(const [kind,rows]of [['send',remote.moneroTransfers],['bridge',remote.transfers]])for(const t of rows){
  if(t.owner!==account.sol||t.moneroAddress!==account.xmr||t.launchId!==row.id||['complete','cancelled'].includes(t.state)||kind==='bridge'&&t.direction!=='xmr-to-sol')continue;
  if(!id(t.id)||!raw(t.amountRaw)||BigInt(t.amountRaw)<=0n||typeof t.state!=='string')throw Error('Pending request details are incomplete. Please retry.');
  result.push({id:t.id,kind,owner:t.owner,launchId:t.launchId,from:t.moneroAddress,to:typeof t.recipient==='string'?t.recipient:null,amountRaw:t.amountRaw,state:t.state,txid:typeof t.txid==='string'&&/^[a-f0-9]{64}$/.test(t.txid)?t.txid:null,canCancel:kind==='send'&&t.state==='reserved'&&!t.signature&&!t.txid});
 }
 return result;
}
export function cancellationConfirmed(result,pending){
 if(!pending.canCancel||!result||result.id!==pending.id||result.owner!==pending.owner||result.launchId!==pending.launchId||result.moneroAddress!==pending.from||result.recipient!==pending.to||result.amountRaw!==pending.amountRaw||result.state!=='cancelled'||result.txid||result.signature)throw Error('Cancellation could not be confirmed. Refresh pending requests before retrying.');
 return true;
}
export function balanceRejection(error){return error?.code==='MONERO_INSUFFICIENT_BALANCE'||/^(Insufficient available (?:Monero )?balance|This amount exceeds your available Monero token balance)/.test(error?.message||'');}
