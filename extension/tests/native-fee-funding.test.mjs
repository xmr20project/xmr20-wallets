import test from 'node:test';import assert from 'node:assert/strict';
import {nativeFeeFunding} from '../../engine/shared/native-market/wallet/native-fee-funding.mjs';
const output=(key,amount='8000000000',height='100',change={})=>({keyImage:key,amount,height,token:false,spent:false,duplicateKey:false,source:{txid:key,vout:'0'},...change});
const check=(outputs,change={})=>nativeFeeFunding({outputs,height:'110',requiredRaw:'101000000',...change});
test('nineteen network confirmations are explained as one remaining verified block; twenty can fund',()=>{
 const before=check([output('a')],{height:'109'});assert.equal(before.summary.reason,'confirming');assert.equal(before.summary.totalRaw,'8000000000');assert.equal(before.summary.blocksRemaining,'1');assert.equal(before.selected.length,0);
 const ready=check([output('a')]);assert.equal(ready.summary.ready,true);assert.equal(ready.selected.length,1);
});
test('funding selectors keep reserved, token, duplicate and spent coins protected',()=>{
 const {selected,summary}=check([output('held'),output('token','9000000000','100',{token:true}),output('spent','9000000000','100',{spent:true}),output('duplicate','9000000000','100',{duplicateKey:true})],{locks:[{keyImage:'held'}]});
 assert.equal(selected.length,0);assert.equal(summary.reason,'reserved');assert.equal(summary.reservedRaw,'8000000000');assert.equal(summary.carrierRaw,'9000000000');assert.equal(summary.availableRaw,'0');
});
test('a large fee coin is selected even after sixteen tiny historical coins',()=>{
 const {selected,summary}=check([...Array.from({length:16},(_,i)=>output('dust'+i,'1')),output('funded')]);
 assert.equal(summary.ready,true);assert.deepEqual(selected.map(o=>o.keyImage),['funded']);
});
test('input bounds and genuinely insufficient funding stay distinct from confirmation waits',()=>{
 const small=check([output('a','1')]);assert.equal(small.summary.reason,'insufficient');
 const split=check(Array.from({length:17},(_,i)=>output(String(i),'6000000')));assert.equal(split.summary.reason,'fragmented');assert.equal(split.selected.length,16);assert.equal(split.summary.ready,false);
});
test('page funding summary never includes transaction identities or selected input descriptors',()=>{
 const {summary}=check([output('PRIVATE-INPUT-IDENTITY')]);assert.ok(!JSON.stringify(summary).includes('PRIVATE-INPUT'));assert.equal(summary.requiredRaw,'101000000');
});
