import test from 'node:test';
import assert from 'node:assert/strict';
import {hasUnfinishedSetup,finishedSetups,markSetupFinished} from '../../engine/shared/native-setup-status.js';

const manifest='ab'.repeat(32);
function memoryStore(){const values={},writes=[];return {values,writes,get:async keys=>Object.fromEntries(keys.filter(k=>k in values).map(k=>[k,values[k]])),set:async value=>{writes.push(value);Object.assign(values,value);}};}
function fixture({rows=[{preparationId:'prep-1'}],carrier={state:'signed',txid:'22'.repeat(32)},reply={status:'confirmed',confirmed:true,tokenAllocated:true}}={}){
 const calls=[];
 const client={unlock:async()=>{calls.push('unlock');},operatorCreditPreparations:async()=>{calls.push('list');return rows;},
  recoverPreparedCarrier:async args=>{calls.push('carrier:'+args.preparationId+':'+args.kind);return typeof carrier==='function'?carrier(args):carrier;}};
 const status=async({txid})=>{calls.push('status:'+txid);if(reply instanceof Error)throw reply;return reply;};
 return {client,status,calls};
}
test('a confirmed, allocated saved credit is finished and remembered without another status read',async()=>{
 const f=fixture(),store=memoryStore();
 assert.equal(await hasUnfinishedSetup({...f,manifest,store}),false);
 assert.deepEqual(f.calls,['unlock','list','carrier:prep-1:issuance','status:'+'22'.repeat(32)]);
 assert.deepEqual([...await finishedSetups({manifest,rows:[{preparationId:'prep-1'}],store})],['prep-1']);
 f.calls.length=0;assert.equal(await hasUnfinishedSetup({...f,manifest,store}),false);
 assert.deepEqual(f.calls,['unlock','list'],'a remembered finish needs no carrier or status read');
});
test('unsigned, unconfirmed, unallocated or unreadable setups keep the shortcut',async()=>{
 for(const options of [{carrier:{state:'not-signed'}},{carrier:{state:'signing-unknown'}},
  {reply:{status:'accepted',confirmed:false}},{reply:{status:'confirming',confirmed:false,confirmations:5}},
  {reply:{status:'rejected',confirmed:false,tokenAllocated:false}},{reply:{status:'confirmed',confirmed:true}},
  {reply:Error('service unavailable')},{carrier:()=>{throw Error('Native market wallet is busy.');}}]){
  const f=fixture(options),store=memoryStore();
  assert.equal(await hasUnfinishedSetup({...f,manifest,store}),true,JSON.stringify(options));
  assert.deepEqual(store.writes,[],'nothing unfinished is remembered as finished');
 }
});
test('no saved setup or only refunded setups hide the shortcut; other unfinished rows still show it',async()=>{
 assert.equal(await hasUnfinishedSetup({...fixture({rows:[]}),manifest,store:memoryStore()}),false);
 const refunded=fixture({rows:[{preparationId:'prep-1',completion:{evidence:{status:'refunded'}}}]});
 assert.equal(await hasUnfinishedSetup({...refunded,manifest,store:memoryStore()}),false);assert.deepEqual(refunded.calls,['unlock','list']);
 const mixed=fixture({rows:[{preparationId:'done'},{preparationId:'open'}],carrier:({preparationId})=>preparationId==='done'?{state:'signed',txid:'33'.repeat(32)}:{state:'not-signed'}});
 assert.equal(await hasUnfinishedSetup({...mixed,manifest,store:memoryStore()}),true);
});
test('the local finish mark is bounded, manifest-scoped and never breaks on storage failure',async()=>{
 const store=memoryStore();
 const real='cd'.repeat(32)+':preparation:'+'ef'.repeat(32);await markSetupFinished({manifest,preparationId:real,store});
 assert.deepEqual([...await finishedSetups({manifest,rows:[{preparationId:real}],store})],[real],'journal-format ids are remembered');store.writes.length=0;
 await markSetupFinished({manifest,preparationId:'../bad key',store});await markSetupFinished({manifest:'not-a-manifest',preparationId:'prep-1',store});assert.deepEqual(store.writes,[]);
 await markSetupFinished({manifest,preparationId:'prep-1',store});
 assert.equal((await finishedSetups({manifest:'cd'.repeat(32),rows:[{preparationId:'prep-1'}],store})).size,0,'another manifest does not inherit the mark');
 const broken={get:async()=>{throw Error('storage unavailable');},set:async()=>{throw Error('storage unavailable');}};
 await markSetupFinished({manifest,preparationId:'prep-1',store:broken});
 assert.equal((await finishedSetups({manifest,rows:[{preparationId:'prep-1'}],store:broken})).size,0);
 assert.equal(await hasUnfinishedSetup({...fixture(),manifest,store:broken}),false,'a confirmed status still decides when storage is unavailable');
 assert.equal(await hasUnfinishedSetup({...fixture(),manifest,store:undefined}),false);
});
