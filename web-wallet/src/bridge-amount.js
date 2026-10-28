import {TRANSFER_LIMIT} from '../shared/xmr20/protocol.js';
// Use integer token units throughout: XMR20 tokens have six decimals.
export function bridgeAmountText(raw){
 if(typeof raw!=='string'||!/^\d{1,16}$/.test(raw)||BigInt(raw)>1000000000000000n)throw Error('Invalid token balance. Refresh holdings.');
 const n=BigInt(raw),fraction=(n%1000000n).toString().padStart(6,'0').replace(/0+$/,'');
 return (n/1000000n).toString()+(fraction?'.'+fraction:'');
}
export function bridgeAmountDisplay(raw){
 const [whole,fraction='']=bridgeAmountText(raw).split('.');
 return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+fraction.padEnd(2,'0');
}
export function bridgeTaxLabel(quote){
 const amount=BigInt(quote.amountRaw),tax=BigInt(quote.transferTaxRaw??'0');
 return tax>0n&&tax===(amount*150n+9999n)/10000n?'Transfer tax (1.5%)':'Transfer tax';
}

export function maxBridgeAmount(raw){
 bridgeAmountText(raw);
 return bridgeAmountText((BigInt(raw)>TRANSFER_LIMIT?TRANSFER_LIMIT:BigInt(raw)).toString());
}

// Fill the gross amount only. A fresh review checks pending reservations and
// token fees; subtracting either here could count the same deduction twice.
export function maxSendAmount(raw,network){
 if(network==='monero')return maxBridgeAmount(raw);
 if(network==='solana')return bridgeAmountText(raw);
 throw Error('Choose a supported token network.');
}
