import test from 'node:test';
import assert from 'node:assert/strict';
import {recipientSetupFlow} from '../../engine/shared/joint-recipient-setup.js';
function fixture({saved=false,pending=0,approveError=false,expires=false,checkError=false}={}){
 const abort=new AbortController(),jobs={},calls={reviews:0,approvals:0,checks:0,waits:0};let active=true;
 const job=()=>({config:{mint:'mint'},moneroOwner:'recipient',phase:'submission-unknown'});
 if(saved)jobs.id=job();
 const activation={retry:async()=>{throw Error('Independent finality unavailable');},receipt:()=>({operations:structuredClone(jobs)}),review:async()=>{calls.reviews++;return {operationId:'id',proposal:{rentLamports:2500000}};},approve:async()=>{calls.approvals++;jobs.id=job();if(approveError)throw Error('Lost response');},check:async()=>{calls.checks++;if(checkError)throw Error('Independent finality unavailable');if(expires){jobs.id.phase='approval-expired';return {retryApprovalRequired:true};}if(calls.checks>pending){jobs.id.phase='finalized';return {confirmed:true};}return {confirmed:false};}};
 const options={activation,signal:abort.signal,assertCurrent:()=>{assert.ok(active,'Account changed');},attempts:3,wait:async()=>{calls.waits++;}};
 return {flow:recipientSetupFlow(options),options,activation,jobs,calls,abort,change:()=>active=false,input:{mint:'mint',recipient:'recipient'}};
}
test('review is read-only; one explicit confirmation creates and independently checks the account',async()=>{
 const f=fixture({pending:1}),p=await f.flow.prepare(f.input);assert.equal(p.rentLamports,2500000);assert.equal(f.calls.approvals,0);
 await f.flow.confirm(p);assert.deepEqual(f.calls,{reviews:1,approvals:1,checks:2,waits:1});
 await f.flow.confirm(p);assert.equal(f.calls.approvals,1);
});
test('lost submission response reconciles the saved approval without signing again',async()=>{
 const f=fixture({approveError:true}),p=await f.flow.prepare(f.input);await f.flow.confirm(p);assert.equal(f.calls.approvals,1);assert.equal(f.calls.checks,1);
});
test('reopening uses durable pending setup and does not need a new rent approval',async()=>{
 const f=fixture({saved:true}),p=await f.flow.prepare(f.input);assert.equal(p.rentLamports,null);await f.flow.confirm(p);assert.equal(f.calls.reviews,0);assert.equal(f.calls.approvals,0);
});
test('unknown finality and timeout never replace the saved approval',async()=>{
 for(const opts of [{pending:100},{checkError:true}]){
  const f=fixture(opts),p=await f.flow.prepare(f.input);await assert.rejects(()=>f.flow.confirm(p),/still confirming|finality/);assert.equal(f.jobs.id.phase,'submission-unknown');assert.equal(f.calls.approvals,1);
  await assert.rejects(()=>f.flow.confirm(p));assert.equal(f.calls.approvals,1);assert.equal(f.calls.checks,opts.checkError?2:6);
 }
});
test('expiry invalidates the plan; another explicit review is required before replacement signing',async()=>{
 const f=fixture({expires:true}),p=await f.flow.prepare(f.input);await assert.rejects(()=>f.flow.confirm(p),/expired/);assert.equal(f.flow.needsReview(p),true);
 await assert.rejects(()=>f.flow.confirm(p),/Review/);assert.equal(f.calls.approvals,1);
 const next=await f.flow.prepare(f.input);assert.notEqual(next,p);assert.equal(f.calls.approvals,1);
});
test('close or account switch during confirmation blocks continuation',async()=>{
 for(const close of [true,false]){
  const f=fixture({pending:1});f.options.wait=async()=>{if(close)f.abort.abort();else f.change();};const flow=recipientSetupFlow(f.options),p=await flow.prepare(f.input);
  await assert.rejects(()=>flow.confirm(p),/closed|changed/);assert.equal(f.calls.checks,1);assert.equal(f.calls.approvals,1);assert.equal(f.jobs.id.phase,'submission-unknown');
 }
});
test('double clicks and competing setup windows cannot sign concurrently',async()=>{
 const f=fixture();let unblock;f.activation.approve=async()=>{f.calls.approvals++;await new Promise(r=>unblock=r);f.jobs.id={config:{mint:'mint'},moneroOwner:'recipient',phase:'submission-unknown'};};
 const p=await f.flow.prepare(f.input),first=f.flow.confirm(p);await assert.rejects(()=>f.flow.confirm(p),/already running/);assert.equal(f.calls.approvals,1);unblock();await first;
 const other=fixture();other.options.lock=()=>{throw Error('Other window');};const flow=recipientSetupFlow(other.options);await assert.rejects(()=>flow.prepare(other.input),/Other window/);assert.equal(other.calls.approvals,0);
});
test('altered or foreign plans cannot authorize rent and unrelated receipts are ignored',async()=>{
 const f=fixture();f.jobs.other={config:{mint:'other'},moneroOwner:'recipient',phase:'submission-unknown'};
 const p=await f.flow.prepare(f.input);assert.equal(f.calls.reviews,1);assert.throws(()=>{p.recipient='other';},TypeError);
 await assert.rejects(()=>f.flow.confirm({...p,recipient:'other'}),/Review/);assert.equal(f.calls.approvals,0);
});
