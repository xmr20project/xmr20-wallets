import test from 'node:test';import assert from 'node:assert/strict';
import {createNativeScanCache,nativeScanKey} from '../../engine/token/native-scan-cache.js';
// Minimal IndexedDB double: enough of the request/transaction surface for the module.
function fakeIndexedDB({failOpen=false}={}){
 const rows=new Map();
 const request=(work)=>{const r={};queueMicrotask(()=>{try{r.result=work();r.onsuccess?.();}catch(e){r.error=e;r.onerror?.();}});return r;};
 const db={objectStoreNames:{contains:()=>true},close(){},transaction(){const tx={};const store={get:k=>request(()=>rows.get(k)),put:(v,k)=>request(()=>{rows.set(k,v);return k;}),delete:k=>request(()=>{rows.delete(k);}),clear:()=>request(()=>{rows.clear();}),getAllKeys:()=>request(()=>[...rows.keys()])};
  tx.objectStore=()=>store;setTimeout(()=>tx.oncomplete?.(),1);return tx;}};
 return {rows,open(){const r={};queueMicrotask(()=>{if(failOpen){r.error=Error('denied');r.onerror?.();}else{r.result=db;r.onsuccess?.();}});return r;}};
}
const account={id:'acct',xmr:'4'+'1'.repeat(94),height:3775856};
test('keys bind the checkpoint to the account, address and restore height',()=>{
 assert.equal(nativeScanKey(account),'acct:'+account.xmr+':3775856');
 assert.equal(nativeScanKey({...account,height:-1}),null);assert.equal(nativeScanKey({...account,xmr:'short'}),null);assert.equal(nativeScanKey(null),null);
 assert.notEqual(nativeScanKey(account),nativeScanKey({...account,height:1}));
});
test('checkpoints round-trip as opaque bytes with height metadata; bad input is ignored',async()=>{
 const idb=fakeIndexedDB(),cache=createNativeScanCache({indexedDB:idb});const key=nativeScanKey(account);
 assert.equal(await cache.load(key),null);
 assert.equal(await cache.save(key,new Uint8Array([1,2,3]),{height:3780000,address:account.xmr}),true);
 const row=await cache.load(key);assert.deepEqual([...row.cache],[1,2,3]);assert.equal(row.height,3780000);assert.ok(row.savedAt>0);
 assert.equal(await cache.save(key,new Uint8Array(0)),false);assert.equal(await cache.save(null,new Uint8Array([1])),false);assert.equal(await cache.save(key,'text'),false);
 assert.deepEqual(await cache.keys(),[key]);
 assert.equal(await cache.clear(key),true);assert.equal(await cache.load(key),null);
 await cache.save(key,new Uint8Array([4]));await cache.save('other',new Uint8Array([5]));assert.equal(await cache.clear(),true);assert.deepEqual(await cache.keys(),[]);
});
test('a missing or failing database degrades to no cache without throwing',async()=>{
 const none=createNativeScanCache({indexedDB:undefined});
 assert.equal(await none.load('k'),null);assert.equal(await none.save('k',new Uint8Array([1])),false);assert.equal(await none.clear(),false);assert.deepEqual(await none.keys(),[]);
 const failing=createNativeScanCache({indexedDB:fakeIndexedDB({failOpen:true})});
 assert.equal(await failing.load('k'),null);assert.equal(await failing.save('k',new Uint8Array([1])),false);
});

test('saved working nodes are allowlisted and old caches without a node remain usable',async()=>{
 const cache=createNativeScanCache({indexedDB:fakeIndexedDB()}),key=nativeScanKey(account);
 await cache.save(key,new Uint8Array([1]),{node:'https://xmr-node.cakewallet.com:18081'});
 assert.equal((await cache.load(key)).node,'https://xmr-node.cakewallet.com:18081');
 await cache.save(key,new Uint8Array([2]),{node:'https://attacker.example'});
 assert.equal((await cache.load(key)).node,null);
 await cache.save(key,new Uint8Array([3]));assert.deepEqual([...(await cache.load(key)).cache],[3]);
});
