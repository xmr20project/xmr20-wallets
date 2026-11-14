// Native worker preparePayments (patch-native-payments.mjs, extension 0.1.142): one transaction paying up to three exact amounts
// (a Mordinal purchase: the seller, the protocol fee and the market fee), behind the carrier guard; reviewed, never relayed (relay
// stays a separate step). Stand-in wallet and node; nothing touches the network.
//   node --test engine/tests/worker-payments.test.mjs
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
const dir=new URL('../monero/runtime/',import.meta.url).pathname;
const OWN='4'+'1'.repeat(94),SELLER='4'+'2'.repeat(94),PROTOCOL='4'+'3'.repeat(94),MARKET='8'+'4'.repeat(94),NODE='https://xmr-node.cakewallet.com:18081';
function worker({unlocked=50000000000n,mismatch=false}={}){
 const posts=[],calls={createTx:[],relay:0};const coin={ki:'1'.repeat(64),tx:'a'.repeat(64)};const frozenSet=new Set();
 const wallet={async getPrimaryAddress(){return OWN;},async getHeight(){return 100;},async getBalance(){return unlocked;},async getUnlockedBalance(){return unlocked;},
  async getOutputs(){return [{getKeyImage:()=>({getHex:()=>coin.ki}),getTx:()=>({getHash:()=>coin.tx,getExtra:()=>[1,...new Array(32).fill(5)]})}];},
  async isOutputFrozen(k){return frozenSet.has(k);},async freezeOutput(k){frozenSet.add(k);},async thawOutput(k){frozenSet.delete(k);},
  async createTx(cfg){calls.createTx.push(cfg);const dests=cfg.destinations.map((d,i)=>({getAddress:()=>d.address,getAmount:()=>BigInt(d.amount)+(mismatch&&i===0?1n:0n)}));
   return {getOutgoingTransfer:()=>({getDestinations:()=>dests}),getFee:()=>40000000n,getHash:()=>'b'.repeat(64),getKey:()=>'c'.repeat(64),getIsRelayed:()=>false,getInputs:()=>[{getKeyImage:()=>({getHex:()=>coin.ki})}]};},
  async relayTx(){calls.relay++;return 'b'.repeat(64);}};
 const self={postMessage:m=>posts.push(m),addEventListener(){},importScripts(){},XMLHttpRequest:class{},
  fetch:async url=>({ok:true,json:async()=>({status:'OK',mainnet:true,nettype:'mainnet',height:100,synchronized:true})})};
 const ctx=vm.createContext({self,console:{log(){},info(){},warn(){},error(){},debug(){}},XMLHttpRequest:class{},setTimeout,clearTimeout,setInterval,clearInterval,URL,TextEncoder,TextDecoder,crypto:globalThis.crypto,AbortSignal,Response,Uint8Array,ArrayBuffer,Map,Set,Promise,Error,JSON,Math,Date,Number,BigInt,String,Object,Array});
 vm.runInContext(readFileSync(dir+'native-carrier-guard.js','utf8'),ctx);vm.runInContext(readFileSync(dir+'native.worker.js','utf8'),ctx);
 ctx.__w=wallet;ctx.__g={async freeze(){return [];}};vm.runInContext('wallet=__w;spendGuard=__g;',ctx);
 return {send:async data=>{await ctx.self.onmessage({data:{id:'t'+Math.random(),...data}});return posts.at(-1);},calls};
}
const PAY=[{address:SELLER,amountRaw:'1000000000000'},{address:PROTOCOL,amountRaw:'5000000000'},{address:MARKET,amountRaw:'2500000000'}];
test('three exact payments in one transaction, reviewed and not relayed',async()=>{
 const w=worker();const r=await w.send({action:'preparePayments',destinations:PAY,node:NODE,carrierLookup:'local'});
 assert.ok(r.result,JSON.stringify(r));
 const plain=v=>JSON.parse(JSON.stringify(v));// the worker's objects come from its own context
 assert.deepEqual(plain(r.result.destinations),PAY);assert.equal(r.result.amountRaw,'1007500000000');assert.equal(r.result.feeRaw,'40000000');
 assert.equal(r.result.hash,'b'.repeat(64));assert.deepEqual(plain(r.result.keys),['c'.repeat(64)]);assert.equal(r.result.chainHeight,99);assert.ok(r.result.id);
 const cfg=w.calls.createTx[0];assert.equal(w.calls.createTx.length,1);assert.equal(cfg.relay,false);
 assert.deepEqual(cfg.destinations.map(d=>[d.address,String(d.amount)]),PAY.map(d=>[d.address,d.amountRaw]));assert.equal(w.calls.relay,0);
});
test('refused before anything is built: no payment, more than three, a bad address or amount, or this wallet\'s own address',async()=>{
 for(const destinations of [[],[...PAY,{address:SELLER,amountRaw:'1'}],[{address:'5'+'2'.repeat(94),amountRaw:'1'}],[{address:SELLER,amountRaw:'0'}],[{address:SELLER,amountRaw:'1.5'}],[{address:OWN,amountRaw:'1'}],null]){
  const w=worker();const r=await w.send({action:'preparePayments',destinations,node:NODE,carrierLookup:'local'});
  assert.ok(!r.result&&r.error,JSON.stringify({destinations,r}));assert.equal(w.calls.createTx.length,0);assert.equal(w.calls.relay,0);}
});
test('a transaction that does not pay exactly what was asked is refused',async()=>{
 const w=worker({mismatch:true});const r=await w.send({action:'preparePayments',destinations:PAY,node:NODE,carrierLookup:'local'});
 assert.ok(!r.result,'must not produce a review');assert.match(r.error,/Nothing was sent/);assert.equal(w.calls.createTx.length,1);assert.equal(w.calls.relay,0);
});
