// 28 Oct 2026: the carrier builder keeps the Monero output distribution and reads only the last blocks again (a private send
// timed out reading the whole 23 MB list for each carrier). A stand-in daemon serves a growing chain; a stand-in engine records the
// distribution it is given, which must equal what the previous code built from one whole-chain read.
import test from 'node:test';import assert from 'node:assert/strict';
import {createCarrierBuilder} from '../token/holder-carrier.js';

const RINGCT=5;
function chain(height,{fork=null}={}){// cumulative outputs per height; fork: {at, extra} adds outputs from `at` on (another branch)
 const counts=[];let total=0;for(let h=0;h<height;h++){if(h>=RINGCT)total+=1+(h%3)+(fork&&h>=fork.at?fork.extra:0);counts.push(total);}return counts;}
function daemon(state){
 const reads=[];
 const fetch=async(url,init)=>{const body=JSON.parse(init.body);const reply=v=>({ok:true,json:async()=>v});
  if(url.endsWith('/get_transaction_pool'))return reply({spent_key_images:[]});
  const counts=state.counts,height=counts.length;
  if(body.method==='get_info')return reply({result:{height}});
  if(body.method==='get_fee_estimate')return reply({result:{fee:20000,quantization_mask:10000}});
  if(body.method==='get_output_distribution'){const {from_height:from,to_height:to}=body.params;reads.push([from,to]);const start=Math.max(from,RINGCT);
   return reply({result:{distributions:[{start_height:start,base:start>0?counts[start-1]:0,distribution:counts.slice(start,to+1)}]}});}
  throw Error('unexpected '+url+' '+body.method);};
 return {fetch,reads};}
// What the code before 28 Oct built: one whole-chain read, mapped onto heights 0..=tip.
const previous=(counts,tip)=>{const out=new Array(tip+1).fill(0);for(let h=0;h<=tip;h++){const i=h-RINGCT;out[h]=i<0?0:counts[RINGCT+Math.min(i,counts.length-1-RINGCT)];}return out;};
function builder(d,store){const seen=[];const engine={call:req=>{if(req.op==='carrierQuote'){seen.push(req.distribution);return {ready:true,quoteId:'q'};}throw Error('op '+req.op);}};
 return {seen,carrier:createCarrierBuilder({engine,rpc:'http://node',fetch:d.fetch,distributionStore:store})};}

test('the whole list is read once; later quotes read only the last blocks and give the engine the same numbers',async()=>{
 const state={counts:chain(200)},d=daemon(state),{seen,carrier}=builder(d);
 await carrier.quote({kind:'private',wireLen:100});assert.deepEqual(d.reads,[[0,199]]);assert.deepEqual(seen[0],previous(state.counts,199));
 await carrier.quote({kind:'private',wireLen:100});assert.deepEqual(d.reads,[[0,199]],'same tip: nothing read again');
 state.counts=chain(207);await carrier.quote({kind:'private',wireLen:100});
 assert.deepEqual(d.reads.at(-1),[179,206],'only the last blocks, from 20 below the kept tip');assert.deepEqual(seen.at(-1),previous(state.counts,206));
});

test('a reorganisation deeper than the kept tip reads the whole list again',async()=>{
 const state={counts:chain(200)},d=daemon(state),{seen,carrier}=builder(d);
 await carrier.quote({kind:'shield',wireLen:100});
 state.counts=chain(210,{fork:{at:190,extra:5}});await carrier.quote({kind:'shield',wireLen:100});
 assert.deepEqual(d.reads,[[0,199],[179,209],[0,209]]);assert.deepEqual(seen.at(-1),previous(state.counts,209));
});

test('a warm-up and a quote at the same time share one read; the kept list survives a new builder through the store',async()=>{
 const state={counts:chain(300)},d=daemon(state);let saved=null;const store={load:async()=>saved,save:async k=>{saved={start:k.start,tip:k.tip,values:Uint32Array.from(k.values)};}};
 const {seen,carrier}=builder(d,store);
 await Promise.all([carrier.warm(),carrier.quote({kind:'private',wireLen:100})]);assert.deepEqual(d.reads,[[0,299]]);assert.deepEqual(seen[0],previous(state.counts,299));
 await new Promise(r=>setTimeout(r,10));assert.equal(saved?.tip,299);
 state.counts=chain(305);const again=builder(d,store);await again.carrier.quote({kind:'private',wireLen:100});
 assert.deepEqual(d.reads.at(-1),[279,304],'a new session reads only the new blocks');assert.deepEqual(again.seen[0],previous(state.counts,304));
});
