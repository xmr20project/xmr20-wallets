import test from 'node:test';import assert from 'node:assert/strict';
import {createScanLane,createCompanionScan} from '../src/shared-wallet-scan.js';
test('Bridge and XMR callers share the same in-flight ordinary wallet scan',async()=>{
 const lane=createScanLane();let count=0,release;const work=()=>{count++;return new Promise(r=>release=r);};
 const bridge=lane.run('wallet-a',work),send=lane.run('wallet-a',work);await Promise.resolve();assert.equal(count,1);assert.equal(bridge,send);
 release({height:123});assert.deepEqual(await send,{height:123});assert.deepEqual(await bridge,{height:123});
 assert.equal(await lane.run('wallet-a',()=>++count),2);
});
test('failed scans can resume and different wallets never reuse each other’s promise',async()=>{
 const lane=createScanLane();await assert.rejects(lane.run('a',()=>{throw Error('interrupted');}));
 assert.equal(await lane.run('a',()=>123),123);
 const [a,b]=await Promise.all([lane.run('a',()=>1),lane.run('b',()=>2)]);assert.deepEqual([a,b],[1,2]);
});
test('a token sync starts XMR scanning once, waits at completion, and closing silences late progress',async()=>{
 let scans=0,release,progress;const messages=[];
 const companion=createCompanionScan(p=>{scans++;progress=p;return new Promise(r=>release=r);},v=>messages.push(v));
 companion.start();companion.start();await Promise.resolve();assert.equal(scans,1);let done=false;const waiting=companion.finish().then(()=>done=true);await Promise.resolve();assert.equal(done,false);
 progress('balance block 10');assert.deepEqual(messages,['balance block 10']);companion.close();progress('late');assert.equal(messages.length,1);
 release();await waiting;assert.equal(done,true);assert.equal(companion.finished,true);
});
test('an ordinary node interruption keeps the native token path usable and reports saved progress',async()=>{
 const messages=[],companion=createCompanionScan(()=>{throw Error('node dropped');},v=>messages.push(v));companion.start();
 assert.equal(await companion.finish(),false);assert.match(messages[0],/saved progress/);
});

test('a new explicit round refreshes the balance snapshot, without overlapping scans or crossing wallets',async()=>{
 let scans=0;const companion=createCompanionScan(async()=>({address:'public-wallet',balanceRaw:String(++scans)}));
 companion.start();companion.start();assert.equal(await companion.finish(),true);assert.equal(scans,1);assert.equal(companion.snapshot.balanceRaw,'1');
 companion.start();assert.equal(companion.finished,false);await companion.finish();assert.equal(scans,2);assert.equal(companion.snapshot.balanceRaw,'2');
 const other=createCompanionScan(async()=>({address:'another-public-wallet',balanceRaw:'99'}));other.start();await other.finish();assert.equal(companion.snapshot.address,'public-wallet');
 companion.close();companion.start();await companion.finish();assert.equal(scans,2);
});
