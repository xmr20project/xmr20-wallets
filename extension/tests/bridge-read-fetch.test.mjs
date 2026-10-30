import test from 'node:test';
import assert from 'node:assert/strict';
import {Connection,PublicKey} from '@solana/web3.js';
import {bridgeReadFetch} from '../../engine/shared/bridge-read-fetch.js';
const request=(method='getAccountInfo')=>({method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:['11111111111111111111111111111111',{encoding:'base64',commitment:'finalized'}]})});
test('SDK account verification recovers from HTTP 500 using the exact same read',async()=>{
 const seen=[],notices=[];let attempts=0;
 const transport=bridgeReadFetch({wait:async()=>{},onRetry:()=>notices.push('retry'),fetcher:async(url,options)=>{
  seen.push({url,body:options.body});const rpc=JSON.parse(options.body);
  if(!attempts++)return new Response('{"error":{"message":"Internal Server Error"}}',{status:500});
  return Response.json({jsonrpc:'2.0',id:rpc.id,result:{context:{slot:123},value:{data:['','base64'],executable:true,lamports:1,owner:'11111111111111111111111111111111',rentEpoch:0}}});
 }});
 const c=new Connection('https://xmr20.org/api/bridge-solana-read',{commitment:'finalized',disableRetryOnRateLimit:true,fetch:transport});
 const account=await c.getAccountInfo(new PublicKey('11111111111111111111111111111111'),'finalized');
 assert.equal(account.executable,true);assert.equal(seen.length,2);assert.deepEqual(seen[0],seen[1]);assert.equal(notices.length,1);
});
test('persistent transport outages stop after three attempts with a safe actionable message',async()=>{
 const delays=[];let calls=0;const f=bridgeReadFetch({fetcher:async()=>{calls++;return new Response('PRIVATE_UPSTREAM_DETAIL',{status:503});},wait:async ms=>delays.push(ms)});
 await assert.rejects(f('https://example.invalid',request()),e=>e.code==='bridge-read-unavailable'&&!e.message.includes('PRIVATE')&&/saved transfer is kept/.test(e.message));
 assert.equal(calls,3);assert.deepEqual(delays,[150,350]);
});
test('transactions, batches and unknown RPC methods are never retried',async()=>{
 for(const options of [request('sendTransaction'),request('requestAirdrop'),request('signMessage'),{...request(),body:'[]'}]){
  let calls=0;const f=bridgeReadFetch({fetcher:async()=>{calls++;return new Response('failure',{status:500});}});
  assert.equal((await f('https://example.invalid',options)).status,500);assert.equal(calls,1);
 }
});
test('RPC errors, wrong account data, and permission failures stay visible without retry',async()=>{
 for(const response of [new Response('denied',{status:403}),Response.json({jsonrpc:'2.0',id:1,error:{code:-32602,message:'invalid params'}}),Response.json({jsonrpc:'2.0',id:1,result:{value:null}})]){
  let calls=0;const f=bridgeReadFetch({fetcher:async()=>{calls++;return response;}});
  assert.equal(await f('https://example.invalid',request()),response);assert.equal(calls,1);
 }
});
test('closing during retry backoff prevents further network requests',async()=>{
 const controller=new AbortController();let calls=0;
 const f=bridgeReadFetch({signal:controller.signal,fetcher:async()=>{calls++;throw new TypeError('Failed to fetch');},onRetry:()=>controller.abort(Error('Bridge closed'))});
 await assert.rejects(f('https://example.invalid',request()),/Bridge closed/);assert.equal(calls,1);
});
test('a hanging read is bounded and a later attempt can recover',async()=>{
 let calls=0;const f=bridgeReadFetch({timeoutMs:5,wait:async()=>{},fetcher:async(_url,{signal})=>{
  if(calls++)return new Response('ok');
  return new Promise((resolve,reject)=>{const keepAlive=setTimeout(()=>resolve(new Response('too late')),100);signal.addEventListener('abort',()=>{clearTimeout(keepAlive);reject(signal.reason);},{once:true});});
 }});
 assert.equal(await (await f('https://example.invalid',request())).text(),'ok');assert.equal(calls,2);
});
