import test from 'node:test';
import assert from 'node:assert/strict';
import {createReviewWait} from '../../engine/shared/joint-review-wait.js';

function setup({animate=false,reduced=false}={}){
  let now=0,current=true,element;
  const timers=new Map(),animations=[];let id=0;
  const node=()=>({textContent:'',...(animate?{animate(frames,options){const a={frames,options,cancelled:false,cancel(){this.cancelled=true;}};animations.push(a);return a;}}:{})});
  element=node();
  const wait=createReviewWait({getElement:()=>element,isCurrent:()=>current,reducedMotion:()=>reduced,now:()=>now,setTimer:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;},clearTimer:id=>timers.delete(id)});
  return {wait,timers,animations,get element(){return element;},repaint(){element=node();},close(){current=false;},advance(ms){const end=now+ms;for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;now=next[1].at;timers.delete(next[0]);next[1].fn();}now=end;}};
}
test('replaces the single message every five seconds and acknowledges an exceeded estimate',()=>{
  const f=setup();f.wait.sync('amount-a');assert.match(f.element.textContent,/Confirming/);
  f.advance(4999);assert.match(f.element.textContent,/Confirming/);f.advance(1);assert.equal(f.element.textContent,'This is usually the longest preparation step.');
  f.advance(5000);assert.match(f.element.textContent,/both networks/);assert.doesNotMatch(f.element.textContent,/longest/);
  f.advance(5000);assert.match(f.element.textContent,/keep this panel open/);assert.doesNotMatch(f.element.textContent,/both networks/);
  f.advance(5000);assert.match(f.element.textContent,/Confirming/);
  f.advance(20000);assert.match(f.element.textContent,/longer than estimated/);f.advance(5000);assert.match(f.element.textContent,/longest preparation step/);assert.equal(f.timers.size,1);
});
test('passive redraw preserves the current message and the five-second schedule',()=>{
  const f=setup();f.wait.sync('amount-a');f.advance(12000);const text=f.element.textContent;
  f.wait.sync('amount-a');assert.equal(f.element.textContent,text);f.repaint();f.wait.sync('amount-a');assert.equal(f.element.textContent,text);
  f.advance(3000);assert.match(f.element.textContent,/keep this panel open/);assert.equal(f.timers.size,1);
});
test('editing amount or recipient resets the message and elapsed time',()=>{
  const f=setup();f.wait.sync('amount-a');f.advance(40000);f.wait.sync('amount-b');assert.match(f.element.textContent,/Confirming/);f.advance(5000);assert.match(f.element.textContent,/longest preparation step/);
});
test('completion, failure and close stop the timer',()=>{
  for(const end of ['finished','closed','stale']){const f=setup();f.wait.sync('amount-a');f.advance(5000);const text=f.element.textContent;
    if(end==='finished')f.wait.sync(null);else if(end==='closed')f.wait.close();else f.close();
    f.advance(40000);assert.equal(f.timers.size,0);assert.equal(f.element.textContent,text);
  }
});
test('fades the previous message out, replaces it, then fades the next message in',()=>{
  const f=setup({animate:true});f.wait.sync('a');assert.equal(f.animations.length,0);
  f.advance(5000);assert.match(f.element.textContent,/Confirming/);const out=f.animations[0];assert.deepEqual(out.frames,[{opacity:1},{opacity:0}]);
  out.onfinish();assert.ok(out.cancelled);assert.match(f.element.textContent,/longest preparation step/);assert.deepEqual(f.animations[1].frames,[{opacity:0},{opacity:1}]);
  f.animations[1].onfinish();f.wait.close();assert.equal(f.timers.size,0);
});
test('reduced motion replaces messages without animation',()=>{
  const f=setup({animate:true,reduced:true});f.wait.sync('a');f.advance(5000);assert.match(f.element.textContent,/longest preparation step/);assert.equal(f.animations.length,0);
});
test('late animation callbacks cannot overwrite closed, repainted or edited reviews',()=>{
  for(const end of ['close','repaint','edit']){const f=setup({animate:true});f.wait.sync('a');f.advance(5000);const old=f.element,out=f.animations[0];
    if(end==='close')f.wait.close();else if(end==='edit')f.wait.sync('b');else{f.repaint();f.wait.sync('a');}
    assert.ok(out.cancelled);out.onfinish();assert.match(old.textContent,/Confirming/);assert.equal(f.animations.length,1);
  }
});
