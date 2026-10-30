// Website/extension native worker prepareSplit (patch-native-split.mjs): one transaction to the wallet's own address with 2 equal
// payments + change (3 coins), behind the carrier guard; refuses below 0.0006 XMR; never relays (relay stays a separate step).
// Stand-in wallet and node; nothing touches the network.
//   node --test engine/tests/worker-split.test.mjs
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
test('3 coins: 2 equal payments to the own address, reviewed and not relayed',async()=>{
 const w=worker({unlocked:23664660000n});const r=await w.send({action:'prepareSplit',node:NODE,carrierLookup:'local'});
 assert.ok(r.result,JSON.stringify(r));assert.equal(r.result.coins,3);assert.equal(r.result.to,OWN);assert.equal(r.result.partRaw,String(23664660000n/3n));
 assert.equal(r.result.amountRaw,String(23664660000n/3n*2n));assert.equal(r.result.feeRaw,'40000000');
 const cfg=w.calls.createTx[0];assert.equal(cfg.relay,false);assert.equal(cfg.destinations.length,2);assert.ok(cfg.destinations.every(d=>d.address===OWN&&BigInt(d.amount)===23664660000n/3n));
 assert.equal(w.calls.relay,0);
});
test('below 0.0006 unlocked XMR it refuses with a clear message and builds nothing',async()=>{
 const w=worker({unlocked:500000000n});const r=await w.send({action:'prepareSplit',node:NODE,carrierLookup:'local'});
 assert.equal(r.code,'split-too-small');assert.match(r.error,/at least 0\.0006 unlocked XMR/);assert.equal(w.calls.createTx.length,0);
});
test('a protected coin stays out: the input check refuses the transaction',async()=>{
 const xn1=[1,...new Array(32).fill(5),...framePayload(Uint8Array.from([0x58,0x4e,0x31,2,1,0,0,...new Uint8Array(32)]))];
 const w=worker({unlocked:23664660000n,extra:xn1});const r=await w.send({action:'prepareSplit',node:NODE,carrierLookup:'local'});
 assert.ok(!r.result,'must not produce a review');assert.ok(r.error,JSON.stringify(r));assert.equal(w.calls.relay,0);
});
