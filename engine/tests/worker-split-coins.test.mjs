// Native worker prepareSplit with `coins` (patch-native-split-coins.mjs, Split on the Monero row, 28 Oct 2026): coins-1 equal
// payments to the wallet's own address + change, 2..16 coins (Monero's 16-output limit), at least 0.0002 XMR per coin; 3 coins
// when `coins` is omitted ("Enable private transfers" unchanged); never relays. Stand-in wallet and node; nothing touches the network.
//   node --test engine/tests/worker-split-coins.test.mjs
import test from 'node:test';import {framePayload} from '../shared/native-market/xn1/carrier.mjs';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
const dir=new URL('../monero/runtime/',import.meta.url).pathname;
const OWN='4'+'1'.repeat(94),NODE='https://xmr-node.cakewallet.com:18081';
function worker({unlocked,frozen=[],extra=null}){
 const posts=[],calls={createTx:[],relay:0};const pub=extra||[1,...new Array(32).fill(5)];
 const coin={ki:'1'.repeat(64),tx:'a'.repeat(64)};const frozenSet=new Set(frozen);
 const wallet={async getPrimaryAddress(){return OWN;},async getHeight(){return 100;},async getBalance(){return unlocked;},async getUnlockedBalance(){return unlocked;},
  async getOutputs(){return [{getKeyImage:()=>({getHex:()=>coin.ki}),getTx:()=>({getHash:()=>coin.tx,getExtra:()=>pub})}];},
  async isOutputFrozen(k){return frozenSet.has(k);},async freezeOutput(k){frozenSet.add(k);},async thawOutput(k){frozenSet.delete(k);},
  async createTx(cfg){calls.createTx.push(cfg);const dests=cfg.destinations.map(d=>({getAddress:()=>d.address,getAmount:()=>BigInt(d.amount)}));
   return {getOutgoingTransfer:()=>({getDestinations:()=>dests}),getFee:()=>40000000n,getHash:()=>'b'.repeat(64),getIsRelayed:()=>false,getInputs:()=>[{getKeyImage:()=>({getHex:()=>coin.ki})}]};},
  async relayTx(){calls.relay++;return 'b'.repeat(64);}};
 const self={postMessage:m=>posts.push(m),addEventListener(){},importScripts(){},XMLHttpRequest:class{},
  fetch:async url=>({ok:true,json:async()=>({status:'OK',mainnet:true,nettype:'mainnet',height:100,synchronized:true})})};
 const ctx=vm.createContext({self,console:{log(){},info(){},warn(){},error(){},debug(){}},XMLHttpRequest:class{},setTimeout,clearTimeout,setInterval,clearInterval,URL,TextEncoder,TextDecoder,crypto:globalThis.crypto,AbortSignal,Response,Uint8Array,ArrayBuffer,Map,Set,Promise,Error,JSON,Math,Date,Number,BigInt,String,Object,Array});
 vm.runInContext(readFileSync(dir+'native-carrier-guard.js','utf8'),ctx);vm.runInContext(readFileSync(dir+'native.worker.js','utf8'),ctx);
 ctx.__w=wallet;ctx.__g={async freeze(){return [];}};vm.runInContext('wallet=__w;spendGuard=__g;',ctx);
 return {send:async data=>{await ctx.self.onmessage({data:{id:'t'+Math.random(),...data}});return posts.at(-1);},calls};
}
const U=23664660000n;
test('omitted coins: 3 coins exactly as before',async()=>{
 const w=worker({unlocked:U});const r=await w.send({action:'prepareSplit',node:NODE,carrierLookup:'local'});
 assert.equal(r.result.coins,3);assert.equal(r.result.partRaw,String(U/3n));assert.equal(r.result.amountRaw,String(U/3n*2n));
 assert.equal(w.calls.createTx[0].destinations.length,2);assert.equal(w.calls.relay,0);
});
for(const coins of [2,5,10,16])test(`${coins} coins: ${coins-1} equal payments to the own address, not relayed`,async()=>{
 const w=worker({unlocked:U});const r=await w.send({action:'prepareSplit',node:NODE,carrierLookup:'local',coins});
 assert.ok(r.result,JSON.stringify(r));const part=U/BigInt(coins);
 assert.equal(r.result.coins,coins);assert.equal(r.result.partRaw,String(part));assert.equal(r.result.amountRaw,String(part*BigInt(coins-1)));
 const cfg=w.calls.createTx[0];assert.equal(cfg.relay,false);assert.equal(cfg.destinations.length,coins-1);
 assert.ok(cfg.destinations.every(d=>d.address===OWN&&BigInt(d.amount)===part));assert.equal(w.calls.relay,0);
});
for(const coins of [1,17,20,2.5,'4',null])test(`coins ${JSON.stringify(coins)} is refused before anything is built`,async()=>{
 const w=worker({unlocked:U});const r=await w.send({action:'prepareSplit',node:NODE,carrierLookup:'local',coins});
 assert.ok(!r.result);assert.match(r.error,/between 2 and 16 coins/);assert.equal(w.calls.createTx.length,0);
});
test('the minimum grows with the number of coins: 0.0002 XMR each',async()=>{
 const ten=worker({unlocked:1999999999n});const r=await ten.send({action:'prepareSplit',node:NODE,carrierLookup:'local',coins:10});
 assert.equal(r.code,'split-too-small');assert.match(r.error,/at least 0\.002 unlocked XMR to make 10 coins/);assert.equal(ten.calls.createTx.length,0);
 const ok=worker({unlocked:2000000000n});assert.equal((await ok.send({action:'prepareSplit',node:NODE,carrierLookup:'local',coins:10})).result.coins,10);
 const three=worker({unlocked:500000000n});assert.match((await three.send({action:'prepareSplit',node:NODE,carrierLookup:'local'})).error,/at least 0\.0006 unlocked XMR to make 3 coins/);
 const sixteen=worker({unlocked:3000000000n});assert.match((await sixteen.send({action:'prepareSplit',node:NODE,carrierLookup:'local',coins:16})).error,/at least 0\.0032 unlocked XMR to make 16 coins/);
});
test('a protected coin stays out with any number of coins',async()=>{
 const xn1=[1,...new Array(32).fill(5),...framePayload(Uint8Array.from([0x58,0x4e,0x31,2,1,0,0,...new Uint8Array(32)]))];
 const w=worker({unlocked:U,extra:xn1});const r=await w.send({action:'prepareSplit',node:NODE,carrierLookup:'local',coins:8});
 assert.ok(!r.result,'must not produce a review');assert.ok(r.error,JSON.stringify(r));assert.equal(w.calls.relay,0);
});
