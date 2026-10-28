import test from 'node:test';import assert from 'node:assert/strict';
import {createWorkerClient} from '../../engine/token/worker-client.js';
function fakeWorker(){
 const posted=[];let terminated=0;
 const w={posted,get terminated(){return terminated;},postMessage(m){posted.push(m);},terminate(){terminated++;},onmessage:null,onerror:null,
  reply(id,body){w.onmessage({data:{id,...body}});}};
 return w;
}
const tick=()=>new Promise(r=>setTimeout(r,0));
test('a deadline terminates the worker, fails every outstanding call and reports the client dead',async()=>{
 const w=fakeWorker();let dead=0;const c=createWorkerClient('native.worker.js',{spawn:()=>w,onDead:()=>dead++});
 const slow=c.call('sync',{},5),other=c.call('prepare',{},1000);
 await assert.rejects(slow,/timed out/);await assert.rejects(other,/timed out/);
 assert.equal(w.terminated,1);assert.equal(dead,1);assert.equal(c.alive,false);
 await assert.rejects(c.call('sync'),/closed/);
});
test('progress renews an idle deadline so a scan is bounded by stalls, not total time',async()=>{
 const w=fakeWorker();const seen=[];const c=createWorkerClient('native.worker.js',{spawn:()=>w,onProgress:p=>seen.push(p)});
 const call=c.call('sync',{node:'x'},25,{idle:true});const id=w.posted[0].id;
 for(let i=0;i<5;i++){await new Promise(r=>setTimeout(r,15));w.reply(id,{progress:{height:i}});}
 w.reply(id,{result:{ok:true}});
 assert.deepEqual(await call,{ok:true});assert.equal(seen.length,5);assert.equal(c.alive,true);
});
test('a fixed deadline is not renewed by progress',async()=>{
 const w=fakeWorker();const c=createWorkerClient('native.worker.js',{spawn:()=>w});
 const call=c.call('sync',{},20);const id=w.posted[0].id;
 await new Promise(r=>setTimeout(r,12));w.reply(id,{progress:{height:1}});
 await assert.rejects(call,/timed out/);
});
test('checkpoints are routed separately, error metadata is preserved and close fails pending work',async()=>{
 const w=fakeWorker();const checkpoints=[];const c=createWorkerClient('native.worker.js',{spawn:()=>w,onCheckpoint:cp=>checkpoints.push(cp)});
 const call=c.call('sync');const id=w.posted[0].id;
 w.reply(undefined,{checkpoint:{height:5}});w.onmessage({data:{checkpoint:{height:6}}});
 assert.deepEqual(checkpoints.map(c=>c.height),[5,6]);
 w.reply(id,{error:'Monero sync could not finish',code:'x',sync:{attempts:3},count:2});
 const error=await call.catch(e=>e);assert.equal(error.code,'x');assert.equal(error.sync.attempts,3);assert.equal(error.count,2);
 const pending=c.call('prepare');c.close();await assert.rejects(pending,/locked/);assert.equal(c.alive,false);
 c.notify('stop');assert.equal(w.posted.length,2);
});
test('worker load failures fail outstanding calls once and transfer lists reach postMessage',async()=>{
 const w=fakeWorker();let dead=0;const c=createWorkerClient('native.worker.js',{spawn:()=>w,onDead:()=>dead++});
 const buffer=new ArrayBuffer(4);const call=c.call('open',{cache:new Uint8Array(buffer)},1000,{transfer:[buffer]});
 w.onerror();await assert.rejects(call,/could not load/);assert.equal(dead,1);assert.equal(w.terminated,1);
 await tick();
});

test('late messages from a terminated worker cannot save cache or report progress',()=>{
 const w=fakeWorker(),checkpoints=[];const c=createWorkerClient('native.worker.js',{spawn:()=>w,onCheckpoint:cp=>checkpoints.push(cp)});
 c.close();w.reply(undefined,{checkpoint:{height:10}});assert.equal(checkpoints.length,0);
});
