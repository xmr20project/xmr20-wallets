// Native worker: preparePayments (extension 0.1.142, for Mordinals bought from this wallet). One Monero transaction paying up to three
// exact amounts (the seller, the protocol fee and the market fee of a Mordinal purchase), behind the same guards as prepare: a synced
// snapshot, the XMR20 coin guard and protected inputs that are never spent. It never relays; the existing relay action sends only
// the reviewed transaction. Applied after patch-native-split-coins.mjs to the extension's vendor/native.worker.js; fails unless each
// anchor appears exactly once. runtime/native.worker.js already contains the result.
import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import assert from 'node:assert/strict';
const PAYMENTS=`  }else if(data.action==='preparePayments'){
   // One transaction paying up to three exact amounts (a Mordinal purchase: seller, protocol fee, market fee).
   // chainHeight is the newest block the Monero node had when the transaction was built.
   const A=/^(?:[48][1-9A-HJ-NP-Za-km-z]{94}|4[1-9A-HJ-NP-Za-km-z]{105})$/,list=data.destinations;
   if(!wallet||!Array.isArray(list)||list.length<1||list.length>3||list.some(d=>!d||typeof d.address!=='string'||!A.test(d.address)||typeof d.amountRaw!=='string'||!/^[1-9][0-9]{0,19}$/.test(d.amountRaw)))throw Error('Invalid transfer');
   const own=await wallet.getPrimaryAddress();if(list.some(d=>d.address===own))throw Error('Same address');
   const state=await snapshot(data.node);
   pending=null;
   const protectedImages=await guardCarriers(data.node,data.carrierLookup);
   const tx=await wallet.createTx({accountIndex:0,destinations:list.map(d=>({address:d.address,amount:BigInt(d.amountRaw)})),relay:false});
   checkInputs(tx,protectedImages);
   const line=(address,amount)=>address+':'+String(amount),destinations=tx.getOutgoingTransfer().getDestinations();
   if(destinations.length!==list.length||destinations.map(d=>line(d.getAddress(),d.getAmount())).sort().join()!==list.map(d=>line(d.address,d.amountRaw)).sort().join()||tx.getIsRelayed())throw Error('Transfer mismatch');
   const feeRaw=String(tx.getFee()),hash=tx.getHash(),key=tx.getKey(),amountRaw=String(list.reduce((sum,d)=>sum+BigInt(d.amountRaw),0n));
   if(!/^[0-9]+$/.test(feeRaw)||!/^[a-f0-9]{64}$/.test(hash)||typeof key!=='string'||!/^(?:[a-f0-9]{64}){1,17}$/.test(key))throw Error('Invalid transaction');
   const id=crypto.randomUUID();pending={id,tx,to:list[0].address,amountRaw,node:data.node,protectedImages,expires:Date.now()+120000};
   result={id,destinations:list.map(d=>({address:d.address,amountRaw:d.amountRaw})),amountRaw,feeRaw,hash,keys:key.match(/.{64}/g),expires:pending.expires,chainHeight:state.target-1};
`;
export const PAYMENT_EDITS=[
 ["  }else if(data.action==='prepare'){\n",PAYMENTS+"  }else if(data.action==='prepare'){\n"],
 ["if(['prepare','prepareMax','checkCarriers','sync','close'].includes(data.action))pending=null;","if(['prepare','prepareMax','preparePayments','checkCarriers','sync','close'].includes(data.action))pending=null;"],
 ["if(data.action==='prepare'||data.action==='prepareMax'||data.action==='prepareSplit'){","if(data.action==='prepare'||data.action==='prepareMax'||data.action==='prepareSplit'||data.action==='preparePayments'){"]];
export async function patchNativePayments(dir){
 const file=join(dir,'native.worker.js');let s=await readFile(file,'utf8');
 if(s.includes("data.action==='preparePayments'"))return 'already';
 for(const [old,neu] of PAYMENT_EDITS){assert.equal(s.split(old).length,2,'native.worker.js: anchor not found exactly once');s=s.replace(old,()=>neu);}
 await writeFile(file,s);return 'patched';
}
