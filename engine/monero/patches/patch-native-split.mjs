// Native worker: "Enable private transfers" (owner, 28 Oct 2026: "a button to click to enable private transfers, then the xmr
// splits into 2 slots or something"). A private XMR20 transfer is 2 Monero transactions, each paying its carrier fee from a
// different spendable XMR output, and Monero locks change for 10 blocks. prepareSplit reviews ONE transaction to this wallet's
// own primary address with 2 equal payments plus change — 3 separate coins — behind the same guards as prepare (synced
// snapshot, XMR20 carrier guard, protected inputs never spent); it never relays. The existing relay action sends only that
// reviewed transaction through the shared spend guard. Applied after patch-native-guard.mjs to the website copy and to the
// extension's vendor/native.worker.js; fails unless each anchor appears exactly once.
import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import assert from 'node:assert/strict';
export const SPLIT_MIN_PART='200000000';// 0.0002 XMR per coin
export async function patchNativeSplit(dir){
 const file=join(dir,'native.worker.js');let s=await readFile(file,'utf8');
 if(s.includes("data.action==='prepareSplit'"))return 'already';// extension 0.1.116+ ships these bytes
 const edit=(old,neu)=>{assert.equal(s.split(old).length,2,'native.worker.js: anchor not found exactly once');s=s.replace(old,neu);};
 edit("  }else if(data.action==='prepare'){\n",
`  }else if(data.action==='prepareSplit'){
   // Website wallet / extension 0.1.116, 28 Oct 2026: one transaction to this wallet's own address leaving 3 coins.
   if(!wallet)throw Error('Unlock first');
   const own=await wallet.getPrimaryAddress();
   await snapshot(data.node);
   pending=null;
   const protectedImages=await guardCarriers(data.node,data.carrierLookup);
   const unlocked=BigInt(await wallet.getUnlockedBalance()),part=unlocked/3n;
   if(part<${SPLIT_MIN_PART}n){const error=Error('You need at least 0.0006 unlocked XMR to make 3 coins. Receive more XMR, or wait until incoming XMR unlocks (10 confirmations).');error.code='split-too-small';throw error;}
   const tx=await wallet.createTx({accountIndex:0,destinations:[{address:own,amount:part},{address:own,amount:part}],relay:false});
   checkInputs(tx,protectedImages);
   const destinations=tx.getOutgoingTransfer().getDestinations();
   if(destinations.length!==2||destinations.some(d=>d.getAddress()!==own||BigInt(d.getAmount())!==part)||tx.getIsRelayed())throw Error('Transfer mismatch');
   const feeRaw=String(tx.getFee()),hash=tx.getHash(),amountRaw=String(part*2n);
   if(!/^[0-9]+$/.test(feeRaw)||! /^[a-f0-9]{64}$/.test(hash))throw Error('Invalid transaction');
   const id=crypto.randomUUID();pending={id,tx,to:own,amountRaw,node:data.node,protectedImages,expires:Date.now()+120000};
   result={id,to:own,amountRaw,partRaw:String(part),coins:3,unlockedRaw:String(unlocked),feeRaw,hash,expires:pending.expires};
  }else if(data.action==='prepare'){
`);
 edit("  if(error?.code==='carrier-check-unavailable'||error?.code==='carrier-check-capacity'){",
      "  if(error?.code==='split-too-small'){post({id:data.id,error:error.message,code:error.code})\nreturn\n}\n  if(error?.code==='carrier-check-unavailable'||error?.code==='carrier-check-capacity'){");
 edit("  if(data.action==='prepare'||data.action==='prepareMax'){","  if(data.action==='prepare'||data.action==='prepareMax'||data.action==='prepareSplit'){");
 await writeFile(file,s);
}
