// Hints never change values or authorize a transfer. A swap requires a user click.
export function sendFieldState(recipient,value,{decimals,validAddress}){
 const to=recipient.trim(),amount=value.trim();
 const numeric=v=>new RegExp('^(?:0|[1-9][0-9]{0,12})(?:\\.[0-9]{1,'+decimals+'})?$').test(v)&&/[1-9]/.test(v);
 const addressValid=validAddress(to),amountValid=numeric(amount);
 return {to,amount,addressValid,amountValid,swapped:numeric(to)&&validAddress(amount),amountIsAddress:validAddress(amount)};
}
