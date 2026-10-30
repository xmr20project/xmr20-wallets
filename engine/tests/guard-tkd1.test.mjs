// Website-patched carrier guard: real-format XMR20-TKD1 carriers are ordinary; XN1 and anything not framed exactly stay protected.
//   node --test engine/tests/guard-tkd1.test.mjs
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
import {framePayload} from '../shared/native-market/xn1/carrier.mjs';
const load=f=>{const self={};vm.runInNewContext(readFileSync(f,'utf8'),{self,Uint8Array,Error,Number,BigInt,Map,Set,Object,Array,JSON,String});return self.XMR20CarrierGuard;};
const g=load(new URL('../monero/runtime/',import.meta.url).pathname+'native-carrier-guard.js');
const pub=()=>[1,...Array.from({length:32},(_,i)=>(i*7+3)&255)];
const varint=n=>n<128?[n]:[(n&127)|128,n>>7];
// Frame exactly like transport.rs frame(): tx pubkey, then 254-byte record chunks, each a 0x02 nonce of 0x7F + chunk.
function frame(record,{chunk=254,paymentId=false,extraTag=null,twoPubkeys=false}={}){
 const out=[...pub()];if(twoPubkeys)out.push(...pub());if(paymentId)out.push(2,9,1,1,2,3,4,5,6,7,8);
 for(let i=0;i<record.length;i+=chunk){const c=record.slice(i,i+chunk);out.push(2,...varint(c.length+1),127,...c);}
 if(extraTag)out.push(...extraTag);return Uint8Array.from(out);
}
const record=(magic,len)=>[...magic].map(c=>c.charCodeAt(0)).concat(0xfe,...Array.from({length:len-4},(_,i)=>(i*31+0x58)&255));
const kind=extra=>[...g.classifyOwnedOutputs([{keyImage:'b'.repeat(64),txHash:'c'.repeat(64),vout:0,extra}]).details.values()][0];
const prot=extra=>g.classifyOwnedOutputs([{keyImage:'b'.repeat(64),txHash:'c'.repeat(64),vout:0,extra}]).protected.length;
test('TKD1 records of every kind and size are ordinary',()=>{
 for(const m of ['XP1','XC1','XR1','XS1','XU1','XMA','XMB'])for(const len of [4,100,254,255,508,700,1011]){
  const e=frame(record(m,len));if(e.length>1060)continue;assert.equal(kind(e),'xmr20-tkd1-record',m+' '+len);assert.equal(prot(e),0);}
 assert.equal(kind(frame(record('XP1',600),{paymentId:true})),'xmr20-tkd1-record');
});
test('ordinary transactions stay ordinary; XN1 carriers stay protected',()=>{
 assert.equal(kind(Uint8Array.from(pub())),'ordinary');
 const xn1=Uint8Array.from([...pub(),...framePayload(Uint8Array.from([0x58,0x4e,0x31,2,1,0,0,...new Uint8Array(32)]))]);
 assert.notEqual(kind(xn1),'xmr20-tkd1-record');assert.equal(prot(xn1),1);
});
test('anything not framed exactly as a TKD1 carrier stays protected',()=>{
 const bad={
  unknownMagic:frame(record('XQ1',300)),
  shortMiddleChunk:frame(record('XP1',400),{chunk:200}),
  unknownTag:frame(record('XP1',300),{extraTag:[0xde,1,2]}),
  additionalPubkeys:frame(record('XP1',300),{extraTag:[4,1,...new Array(32).fill(9)]}),
  twoTxPubkeys:frame(record('XP1',300),{twoPubkeys:true}),
  tooLong:frame(record('XP1',1020)),
  xn1MarkerInside:frame([0x58,0x4e,0x31,...record('XP1',300).slice(3)]),
 };
 for(const [name,e] of Object.entries(bad)){assert.notEqual(kind(e),'xmr20-tkd1-record',name);assert.equal(prot(e),1,name);}
});
