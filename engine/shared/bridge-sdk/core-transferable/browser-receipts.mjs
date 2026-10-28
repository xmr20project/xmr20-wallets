import {canonical,digest} from './records.mjs';
export function publicReceiptStore({config,moneroOwner,storage=localStorage}){
 const scope=digest(canonical(config)),key='xmr20-joint-v3-public:'+scope;
 function checked(v){if(v?.schema!=='joint-owner-v3'||v.scope!==scope||canonical(v.config)!==canonical(config)||v.moneroOwner!==moneroOwner||!v.proofs||!v.operations)throw Error('Public receipt does not match these linked wallets and token.');return v;}
 return Object.freeze({key,load(){const text=storage.getItem(key);if(text===null)return null;if(text.length>1000000)throw Error('Public receipt is oversized. Keep the original backup.');return checked(JSON.parse(text));},save(v){const text=JSON.stringify(checked(v));if(text.length>1000000)throw Error('Public receipt storage is full. Save a backup before continuing.');storage.setItem(key,text);if(storage.getItem(key)!==text)throw Error('Public receipt was not saved.');}});
}
