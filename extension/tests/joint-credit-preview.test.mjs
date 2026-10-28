import test from 'node:test';
import assert from 'node:assert/strict';
import {createJointCreditPreview} from '../../engine/shared/joint-credit-preview.js';
const input=amount=>({operation:'deposit',recipient:'public-fixture',amount});
function setup(prepare){
 let id=0,current=true;const timers=new Map(),seen=[];
 const p=createJointCreditPreview({prepare,isCurrent:()=>current,changed:s=>seen.push(s),setTimer:f=>{timers.set(++id,f);return id;},clearTimer:id=>timers.delete(id)});
 return {p,seen,timers,invalidate:()=>{current=false;},async tick(){const [id,f]=timers.entries().next().value??[];assert.ok(f,'scheduled preview');timers.delete(id);return f();}};
}
test('preview debounces typing and publishes only the latest amount',async()=>{
 const calls=[],f=setup(async v=>{calls.push(v);return {amount:v.amount};});
 f.p.request(input('1'));f.p.request(input('2'));f.p.request(input('3'));
 assert.equal(f.timers.size,1);assert.equal(calls.length,0);assert.equal(f.p.matches(input('3')),false);
 await f.tick();assert.deepEqual(calls,[input('3')]);assert.equal(f.p.matches(input('3')),true);assert.equal(f.p.matches(input('2')),false);
});
test('slow obsolete reply cannot authorize old input and requests never overlap',async()=>{
 const calls=[];let release;const f=setup(async v=>{calls.push(v);if(calls.length===1)await new Promise(r=>release=r);return v;});
 f.p.request(input('1'));const pending=f.tick();assert.equal(f.p.running,true);
 f.p.request(input('2'));f.p.request(input('3'));assert.equal(f.timers.size,0);release();await pending;
 assert.equal(f.p.state.status,'loading');assert.equal(f.p.matches(input('1')),false);assert.equal(f.timers.size,1);
 await f.tick();assert.deepEqual(calls,[input('1'),input('3')]);assert.equal(f.p.matches(input('3')),true);
});
test('invalidating, closing or changing accounts discards in-flight replies',async()=>{
 for(const kind of ['empty','close','account']){
  let release;const f=setup(v=>new Promise(r=>release=()=>r(v)));
  f.p.request(input('1'));const pending=f.tick();
  if(kind==='empty')f.p.request(null);else if(kind==='close')f.p.close();else f.invalidate();
  const count=f.seen.length;release();await pending;
  assert.equal(f.p.matches(input('1')),false);assert.equal(f.timers.size,0);
  if(kind!=='empty')assert.equal(f.seen.length,count);
 }
});
test('failed preview waits for explicit retry or changed input',async()=>{
 let calls=0;const f=setup(async()=>{if(++calls===1)throw Error('Synthetic unavailable');return {valid:true};});
 f.p.request(input('1'));await f.tick();assert.equal(f.p.state.status,'error');assert.equal(f.p.matches(input('1')),false);
 f.p.request(input('1'));assert.equal(f.timers.size,0);f.p.retry();await f.tick();assert.equal(calls,2);assert.equal(f.p.matches(input('1')),true);
});
test('foreground work pauses scheduled preparation and resumes without discarding a ready quote',async()=>{
 const f=setup(async v=>v);f.p.request(input('1'));f.p.pause();assert.equal(f.timers.size,0);
 f.p.request(input('1'));assert.equal(f.timers.size,1);await f.tick();
 f.p.pause();f.p.request(input('1'));assert.equal(f.timers.size,0);assert.equal(f.p.matches(input('1')),true);
});
test('only a current allowlisted index-sync error is classified for read-only recovery',async()=>{
 let reject;const f=setup(()=>new Promise((resolve,no)=>reject=no));
 f.p.request(input('1'));const old=f.tick();f.p.request(input('2'));reject(Object.assign(Error('Old sync response'),{code:'index-sync'}));await old;
 assert.equal(f.p.state.status,'loading');assert.equal(f.p.state.errorCode,undefined);
 const current=f.tick();reject(Object.assign(Error('Current sync response'),{code:'index-sync'}));await current;
 assert.equal(f.p.state.errorCode,'index-sync');assert.equal(f.p.matches(input('2')),false);
});
