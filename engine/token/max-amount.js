// Amount inputs use exact atomic integers, never rounded portfolio values.
export const TOKEN_TRANSFER_LIMIT='50000000000000';
export function atomic(value){
 if(typeof value==='bigint'&&value>=0n)return value;
 if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return BigInt(value);
 if(typeof value==='string'&&/^(0|[1-9][0-9]{0,39})$/.test(value))return BigInt(value);
 throw Error('Available balance could not be verified. Refresh and try again.');
}
export function maximumRaw(balance,{reserved='0',fee='0',limit}={}){
 let n=atomic(balance)-atomic(reserved)-atomic(fee);if(n<0n)n=0n;
 if(limit!==undefined&&n>atomic(limit))n=atomic(limit);
 return n.toString();
}
export function inputAmount(raw,decimals=6){
 if(!Number.isInteger(decimals)||decimals<0||decimals>18)throw Error('Invalid token decimals.');
 const n=atomic(raw),base=10n**BigInt(decimals),fraction=(n%base).toString().padStart(decimals,'0').replace(/0+$/,'');
 return (n/base).toString()+(fraction?'.'+fraction:'');
}
export function maxControl(id,label,disabled=''){
 return `<div class="amount-label"><label for="${id}">${label}</label><button type="button" class="amount-max" id="${id}-max" aria-label="Use maximum available amount" ${disabled}>Max</button></div>`;
}
// An async balance lookup must not overwrite a newer edit or a different form.
export async function fillMaximum(input,load,{isCurrent=()=>input.isConnected,decimals=6,onFill=()=>{}}={}){
 let edited=false;const changed=()=>{edited=true;};input.addEventListener('input',changed);
 try{const raw=await load();if(!isCurrent()||edited)return false;
  if(atomic(raw)===0n)throw Error('No spendable balance is available after pending transfers and fees.');
  input.value=inputAmount(raw,decimals);onFill(input.value);return true;
 }finally{input.removeEventListener('input',changed);}
}
