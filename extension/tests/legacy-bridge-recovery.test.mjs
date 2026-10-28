import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyBridgeRecoveries,legacyRecoveryHTML} from '../src/legacy-bridge-recovery.js';
import {legacyReturnRoute} from '../src/legacy-bridge-route.js';
const account={id:'test-account',sol:'test-sol-owner',xmr:'test-monero-owner'};
const receipt=()=>({kind:'bridge',accountId:account.id,intent:'test-return-id',row:{id:'test-launch',mint:'test-mint',ticker:'TEST',bridgeVersion:3},transfer:{id:'test-return-id',owner:account.sol,moneroAddress:account.xmr,launchId:'test-launch',mint:'test-mint',direction:'xmr-to-sol',state:'source_finalized',amountRaw:'2240000000000',transferTaxRaw:'33600000000',netReceivedRaw:'2206400000000'}});
test('burned-out balance still resumes the exact saved return, without creating a new intent',()=>{
 const row=receipt();assert.equal(legacyBridgeRecoveries([row],account).length,1);
 assert.deepEqual(legacyReturnRoute([],{emptyNewBridge:true,receipts:[row],account}),{receiptId:row.intent});
 assert.equal(legacyReturnRoute([],{emptyNewBridge:false,receipts:[row],account}),null);
 assert.equal(legacyReturnRoute([],{emptyNewBridge:true,requestedMint:'other',receipts:[row],account}),null);
});
test('other accounts, changed owners, fees, IDs and new-bridge custody cannot enter legacy recovery',()=>{
 for(const change of [r=>r.accountId='other',r=>r.transfer.owner='other',r=>r.transfer.moneroAddress='other',r=>r.transfer.netReceivedRaw='2240000000000',r=>r.intent='other',r=>r.row.bridge='joint-v3']){
  const r=receipt();change(r);assert.deepEqual(legacyBridgeRecoveries([r],account),[]);
 }
});
test('completed and cancelled receipts leave recovery, duplicates cannot create duplicate actions',()=>{
 const r=receipt();assert.equal(legacyBridgeRecoveries([r,r],account).length,1);
 for(const state of ['complete','cancelled'])assert.equal(legacyBridgeRecoveries([{...r,transfer:{...r.transfer,state}}],account).length,0);
 const next=receipt();next.intent=next.transfer.id='second-return-id';assert.deepEqual(legacyReturnRoute([],{emptyNewBridge:true,receipts:[r,next],account}),{recover:true});
});
test('home recovery uses the exact net amount once and says a final Solana approval remains',()=>{
 const html=legacyRecoveryHTML([receipt()],account,{esc:String,amount:raw=>String(BigInt(raw)/1000000n)});
 assert.match(html,/2206400 TEST to Solana/);assert.match(html,/One Solana approval remains/);assert.match(html,/Check and continue bridge/);assert.doesNotMatch(html,/2240000 TEST to Solana/);
 assert.equal(legacyRecoveryHTML([],account,{esc:String,amount:String}),'');
});
