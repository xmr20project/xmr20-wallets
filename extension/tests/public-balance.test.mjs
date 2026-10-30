import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicBalanceReader,cachedSolBalance,saveSolBalance} from '../../engine/shared/public-balance.js';
import {createRefreshLanes} from '../src/refresh-lanes.js';
const owner='11111111111111111111111111111111',other='22222222222222222222222222222222';
const response=(options,value)=>new Response(JSON.stringify({id:JSON.parse(options.body).id,result:{value}}));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('installed balance reader uses the private Helius wallet proxy without public RPC fallback',async()=>{
 const calls=[],read=createPublicBalanceReader({fetcher:async(url,options)=>{
  calls.push(url);const {action,rpc}=JSON.parse(options.body);assert.equal(action,'walletRpc');assert.equal(rpc.method,'getBalance');assert.equal(rpc.params[1].commitment,'finalized');
  return Response.json({jsonrpc:'2.0',id:rpc.id,result:{value:100000000}});
 }});assert.equal(await read(owner),'100000000');assert.deepEqual(calls,['https://xmr20.org/api/wallet']);
});
test('a stalled primary yields to a fast balance source; concurrent same-wallet reads share it',async()=>{
 const calls=[];let aborted=false;
 const read=createPublicBalanceReader({endpoints:['primary','backup'],hedgeMs:5,timeoutMs:100,fetcher:async(url,options)=>{
  calls.push(url);if(url==='primary'){options.signal.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});}return response(options,1797476);
 }});
 const first=read(owner);assert.equal(first,read(owner));assert.equal(await first,'1797476');assert.deepEqual(calls,['primary','backup']);assert.equal(aborted,true);
});
test('public balance rejects invalid/unsafe responses and stops within its deadline',async()=>{
 for(const value of [-1,Number.MAX_SAFE_INTEGER+1,'42']){
  const read=createPublicBalanceReader({endpoints:['source'],fetcher:async(_,options)=>response(options,value)});await assert.rejects(read(owner),/Invalid SOL balance/);
 }
 const read=createPublicBalanceReader({endpoints:['stuck'],timeoutMs:15,fetcher:()=>new Promise(()=>{})});await assert.rejects(read(owner),/taking longer/);
});
test('different wallet reads remain separate and mismatched RPC replies are rejected',async()=>{
 const read=createPublicBalanceReader({endpoints:['source'],fetcher:async(_,options)=>response(options,JSON.parse(options.body).params[0]===owner?123:456)});
 assert.deepEqual(await Promise.all([read(owner),read(other)]),['123','456']);
 const mismatch=createPublicBalanceReader({endpoints:['source'],fetcher:async()=>new Response(JSON.stringify({id:'other-request',result:{value:123}}))});await assert.rejects(mismatch(owner),/Invalid SOL balance/);
});
test('display balance cache separates wallets, preserves zero and expires',()=>{
 const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},now=1800000000000;
 saveSolBalance(owner,'0',{storage,now});assert.equal(cachedSolBalance(owner,{storage,now}).raw,'0');assert.equal(cachedSolBalance(other,{storage,now}),null);
 assert.equal(cachedSolBalance(owner,{storage,now:now+86400001}),null);assert.equal(cachedSolBalance(owner,{storage,now:now-1}),null);
});
test('a long history read does not stop SOL refreshing again, and duplicate reads coalesce',async()=>{
 const lanes=createRefreshLanes(),history=deferred();let solCalls=0,historyCalls=0;
 const slow=lanes.run('history',()=>{historyCalls++;return history.promise;});
 assert.equal(slow,lanes.run('history',()=>{throw Error('duplicate history');}));
 assert.equal(await lanes.run('SOL',()=>++solCalls),1);assert.equal(await lanes.run('SOL',()=>++solCalls),2);assert.equal(historyCalls,1);
 history.resolve('complete');assert.equal(await slow,'complete');assert.equal(lanes.size,0);
});
test('switching accounts aborts old reads; their completion cannot erase newer reads',async()=>{
 const lanes=createRefreshLanes(),old=deferred(),next=deferred();let signal;
 const first=lanes.run('SOL',s=>{signal=s;return old.promise;});await Promise.resolve();lanes.clear();assert.equal(signal.aborted,true);
 const second=lanes.run('SOL',()=>next.promise);old.resolve('old account');await first;assert.equal(lanes.size,1);
 next.resolve('new account');assert.equal(await second,'new account');assert.equal(lanes.size,0);
});
