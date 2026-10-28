// Website records for SOL <-> XMR exchanges. Like the extension, an exchange
// request is saved before its order is created, so an interrupted order can
// be recovered rather than created twice. Records stay on this device only.
const KEY='xmr20-native-swaps-v1:',LIMIT=50;
const valid=r=>r&&typeof r==='object'&&typeof r.requestId==='string'&&/^[a-f0-9-]{36}$/.test(r.requestId)&&['sol-xmr','xmr-sol'].includes(r.direction)&&typeof r.amount==='string'&&/^\d{1,12}(\.\d{1,12})?$/.test(r.amount);
const finished=r=>['finished','refunded','failed','expired'].includes(r.status);

export function swapOrderStore(owner,{storage=globalThis.localStorage}={}){
 if(typeof owner!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner))throw Error('Connect a Solana wallet first.');
 const key=KEY+owner;
 function load(){
  try{const rows=JSON.parse(storage.getItem(key)||'[]');return Array.isArray(rows)?rows.filter(valid):[];}catch{return [];}
 }
 function save(order){
  if(!valid(order))throw Error('Invalid exchange record.');
  let rows=[...load().filter(r=>r.requestId!==order.requestId),order];
  // Only completed exchanges are trimmed; unfinished ones are never dropped.
  while(rows.length>LIMIT){const i=rows.findIndex(finished);if(i<0)break;rows.splice(i,1);}
  storage.setItem(key,JSON.stringify(rows));
 }
 return {load,save};
}

// ChangeNOW SOL amounts are decimal strings with at most nine decimals.
export function solLamports(amount){
 if(typeof amount!=='string'||!/^(0|[1-9]\d{0,9})(\.\d{1,9})?$/.test(amount))throw Error('Invalid SOL amount.');
 const [whole,fraction='']=amount.split('.'),raw=BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'));
 if(raw<1n)throw Error('Invalid SOL amount.');return raw;
}
