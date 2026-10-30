import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {createJointReturnFlow} from '../../engine/shared/joint-return-flow.js';
import {transferableManifest} from '../../engine/shared/bridge-sdk/core-transferable/mainnet-config.mjs';
import {addresses,receiptAddress} from '../../engine/shared/bridge-sdk/core-transferable/sdk.mjs';
import {digest} from '../../engine/shared/bridge-sdk/core-transferable/records.mjs';
import {XMR20_MINT} from '../../engine/shared/joint-bridge-assets.js';

function fixture(){
 const native='synthetic-native-owner',config={abi:3,network:'mainnet-beta',program:transferableManifest(XMR20_MINT).program,mint:XMR20_MINT,verifier:Keypair.generate().publicKey.toBase58(),owner:Keypair.generate().publicKey.toBase58(),binding:digest(native)};
 const nonce='ac'.repeat(32),amount='985000',fee='14775',state={proofs:{},operations:{}},calls={publish:0,review:0,approve:0,check:0};
 let confirmed=false,clock=0,locked=false,mutate=()=>{},beforeApproval=async()=>{},lostReply=false,checkResult={confirmed:false};
 const envelope={record:{p:'xmr20-joint',v:3,net:'mainnet',op:'burn',owner:native,mint:config.mint,program:config.program,nonce,amount,to:config.owner,from:addresses(config).position.toBase58()},signature:'synthetic-signature'};
 const review=()=>({config:structuredClone(config),proposal:{operation:'release',nonce,amount,expectedFee:fee},envelope:structuredClone(envelope)});
 const options={config,moneroOwner:native,amount,fee,nonce,load:()=>structuredClone(state),now:()=>clock,assertCurrent:()=>assert.ok(!locked,'Wallet locked'),client:{
  async publishMove(){calls.publish++;state.proofs[nonce]={envelope:structuredClone(envelope)};},
  async reviewMove(){calls.review++;const r=review();mutate(r);return r;},
  async check(){calls.check++;return checkResult;}
 },snapshot:async()=>({complete:true,pending:confirmed?[{operation:'burn',receipt:receiptAddress(config,nonce).toBase58()}]:[]}),approve:async r=>{await beforeApproval();flow.assertActive();calls.approve++;state.operations.return={config:r.config,proposal:r.proposal,envelope:r.envelope,phase:'submission-unknown'};if(lostReply)throw Error('Lost relay response');}};
 let flow=createJointReturnFlow(options);
 return {get flow(){return flow;},state,calls,nonce,envelope,options,review,set confirmed(v){confirmed=v;},set locked(v){locked=v;},set time(v){clock=v;},set mutate(v){mutate=v;},set beforeApproval(v){beforeApproval=v;},set lostReply(v){lostReply=v;},set checkResult(v){checkResult=v;},resume(){flow.close();flow=createJointReturnFlow(options);return flow;}};
}

test('one consent publishes once, waits for native confirmation, approves once and only checks the saved Solana result',async()=>{
 const f=fixture();assert.equal(f.calls.publish,0);await f.flow.start();await f.flow.advance();await f.flow.advance();assert.equal(f.calls.approve,0);assert.equal(f.calls.review,0);
 f.confirmed=true;await f.flow.advance();assert.equal(f.flow.state.phase,'submitted');await f.flow.advance();assert.equal(f.calls.approve,1);assert.equal(f.calls.publish,1);
 f.checkResult={confirmed:true};await f.flow.advance();assert.equal(f.flow.state.phase,'complete');assert.equal(f.calls.approve,1);
});
for(const field of ['amount','fee','destination','mint','nonce','envelope'])test(`changed ${field} pauses the return before Solana signing`,async()=>{
 const f=fixture();await f.flow.start();f.confirmed=true;f.mutate=r=>{if(field==='amount')r.proposal.amount='985001';if(field==='fee')r.proposal.expectedFee='14776';if(field==='destination')r.config.owner=Keypair.generate().publicKey.toBase58();if(field==='mint')r.config.mint=Keypair.generate().publicKey.toBase58();if(field==='nonce')r.proposal.nonce='ab'.repeat(32);if(field==='envelope')r.envelope.record.to=Keypair.generate().publicKey.toBase58();};
 await assert.rejects(()=>f.flow.advance(),/changed/);assert.equal(f.calls.approve,0);assert.equal(f.flow.state.phase,'paused');
});
test('closing, locking, pausing or expiry prevents delayed signing after preparation',async()=>{
 for(const action of ['close','lock','pause','expire']){
  const f=fixture();await f.flow.start();f.confirmed=true;
  f.beforeApproval=async()=>{if(action==='close')f.flow.close();if(action==='lock')f.locked=true;if(action==='pause')f.flow.pause();if(action==='expire')f.time=3600001;};
  await assert.rejects(()=>f.flow.advance());assert.equal(f.calls.approve,0);
 }
});
test('lost submission reply is kept and resumed by checking, never re-signing',async()=>{
 const f=fixture();await f.flow.start();f.confirmed=true;f.lostReply=true;await assert.rejects(()=>f.flow.advance(),/Lost relay/);assert.equal(f.calls.approve,1);
 f.resume();await f.flow.start();await f.flow.advance();assert.equal(f.calls.approve,1);assert.equal(f.calls.publish,1);assert.equal(f.calls.check,1);
});
test('expiry never creates an automatic replacement; a new explicit resume can approve the same record',async()=>{
 const f=fixture();await f.flow.start();f.confirmed=true;await f.flow.advance();f.checkResult={retryApprovalRequired:true};await assert.rejects(()=>f.flow.advance(),/expired/);assert.equal(f.calls.approve,1);
 f.state.operations.return.phase='approval-expired';f.resume();await f.flow.start();await f.flow.advance();assert.equal(f.calls.approve,2);assert.equal(f.calls.publish,1);
});
test('overlapping checks cannot create duplicate signatures',async()=>{
 const f=fixture();await f.flow.start();f.confirmed=true;let finish;f.beforeApproval=()=>new Promise(r=>finish=r);const first=f.flow.advance();for(let i=0;i<10&&!finish;i++)await new Promise(r=>setImmediate(r));
 await assert.rejects(()=>f.flow.advance(),/already processing/);finish();await first;assert.equal(f.calls.approve,1);
});
test('a changed saved native record cannot be continued',async()=>{
 const f=fixture();await f.flow.start();f.confirmed=true;f.state.proofs[f.nonce].envelope.record.amount='999999';await assert.rejects(()=>f.flow.advance(),/Saved return differs/);assert.equal(f.calls.approve,0);
});
