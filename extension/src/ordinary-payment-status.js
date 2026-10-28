import {inspectTransactionBytes} from '../../engine/shared/native-market/xn1/transaction-bytes.mjs';
const need=(value,message)=>{if(!value)throw Error(message);};
// A missing transaction is never evidence that an uncertain payment is safe to
// replace. Only its saved bytes may be retried. Authenticate positive results
// against the exact reviewed hash; do not trust a node's tx_hash label alone.
export function ordinaryPaymentStatus({hash,response,target,saved=false}){
 need(/^[a-f0-9]{64}$/.test(hash)&&Number.isSafeInteger(target)&&target>0,'Invalid payment status request');
 need(response?.status==='OK'&&response.untrusted!==true,'Payment status unavailable');
 const rows=response.txs??[],missed=response.missed_tx??[];
 need(Array.isArray(rows)&&Array.isArray(missed)&&rows.length<=1&&missed.length<=1,'Unexpected payment status');
 if(!rows.length){need(missed.length===1&&missed[0]===hash,'Incomplete payment status');return {hash,state:'not-found',saved};}
 const row=rows[0];need(!missed.length&&row.tx_hash===hash&&typeof row.as_hex==='string'&&row.as_hex.length<=1024*1024,'Payment transaction differs');
 need(inspectTransactionBytes(row.as_hex).txid===hash,'Payment bytes differ from the reviewed transaction');
 need(typeof row.in_pool==='boolean','Payment pool status unavailable');
 if(row.in_pool)return {hash,state:'pending',saved,confirmations:0};
 need(Number.isSafeInteger(row.block_height)&&row.block_height>=0&&row.block_height<target,'Payment confirmation unavailable');
 return {hash,state:'confirmed',saved,blockHeight:row.block_height,confirmations:target-row.block_height};
}

const pending=new Set(['Submitting · check receipt','Submission uncertain · check receipt','Submitted · awaiting confirmation','Waiting for inscription']);
export function matchingOrdinaryReceipt(receipts,{accountId,to,amountRaw}){
 const atomic=value=>{if(typeof value!=='string'||!/^\d+(?:\.\d{1,12})?$/.test(value))return null;const [whole,fraction='']=value.split('.');return BigInt(whole)*1000000000000n+BigInt(fraction.padEnd(12,'0'));};
 return receipts.find(row=>row.accountId===accountId&&row.chain==='monero'&&row.symbol==='XMR'&&row.to===to&&pending.has(row.status)&&atomic(row.amount)===BigInt(amountRaw));
}
