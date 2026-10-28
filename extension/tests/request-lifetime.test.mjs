import test from 'node:test';
import assert from 'node:assert/strict';
import {requestLifetime,untilClosed,UNSIGNED_REQUEST_MS} from '../../engine/shared/request-lifetime.js';
test('unsigned work expires after ten minutes and cannot resume after a late wallet reply',async()=>{
 let expire,resolve,notice=0;const lifetime=requestLifetime({setTimer:(fn,ms)=>{assert.equal(ms,UNSIGNED_REQUEST_MS);expire=fn;return 1;},clearTimer(){},onExpire:()=>notice++});
 const wait=untilClosed(new Promise(r=>resolve=r),lifetime.signal);expire();
 await assert.rejects(wait,/expired after 10 minutes/);assert.throws(lifetime.assert,/expired/);resolve('late wallet approval');assert.equal(notice,1);
});
test('submitted receipts have no local expiry and closing never edits their data',()=>{
 const timers=new Map(),receipts={signature:'preserve'};let i=0;
 const lifetime=requestLifetime({setTimer:fn=>{timers.set(++i,fn);return i;},clearTimer:id=>timers.delete(id)});
 lifetime.touch();assert.equal(timers.size,1);lifetime.submitted();assert.equal(timers.size,0);
 lifetime.close();assert.deepEqual(receipts,{signature:'preserve'});assert.equal(timers.size,0);
});
test('checking a submitted transfer cannot restart draft expiry during confirmations',()=>{
 let clock=0,notice=0;const timers=new Map();let next=0;
 const lifetime=requestLifetime({now:()=>clock,setTimer:fn=>{timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id),onExpire:()=>notice++});
 const queuedExpiry=timers.get(1);
 lifetime.submitted();lifetime.touch();
 assert.equal(timers.size,0);
 clock=3*UNSIGNED_REQUEST_MS;
 queuedExpiry();lifetime.assert();lifetime.touch();
 assert.equal(lifetime.signal.aborted,false);assert.equal(notice,0);assert.equal(timers.size,0);
});
test('submission cannot revive an expired or explicitly closed session',async()=>{
 for(const submittedFirst of [false,true]){
  let expire,resolve;const lifetime=requestLifetime({setTimer:fn=>{expire=fn;return 1;},clearTimer(){}});
  const waiting=untilClosed(new Promise(r=>resolve=r),lifetime.signal);
  if(submittedFirst){lifetime.submitted();lifetime.close();}else expire();
  lifetime.submitted();lifetime.touch();
  await assert.rejects(waiting,/expired|cancelled/);assert.throws(lifetime.assert,/expired|cancelled/);
  resolve('late approval');
 }
});
