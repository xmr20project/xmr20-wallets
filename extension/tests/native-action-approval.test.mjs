import test from 'node:test';
import assert from 'node:assert/strict';
import {checkNativeFee,checkNativeSend,checkNativeRedemption,checkConversionPreparation} from '../../engine/shared/native-action-approval.js';
test('single-action approval rejects changed recipient, amount or network fee',()=>{
 const terms={amount:'7530668912636',recipient:'public-recipient'},review={quantity:terms.amount,recipientAddress:terms.recipient,recipient:terms.recipient,fee:'30000000'};
 checkNativeSend(review,terms);checkNativeRedemption(review,terms);
 for(const fn of [checkNativeSend,checkNativeRedemption]){
  assert.throws(()=>fn({...review,quantity:'1'},terms),/changed/);
  assert.throws(()=>fn({...review,fee:'100000001'},terms),/fee changed/);
  assert.throws(()=>fn({...review,recipient:'other',recipientAddress:'other'},terms),/changed/);
 }
 for(const fee of [null,'-1','NaN','1.2'])assert.throws(()=>checkNativeFee({fee}),/fee changed/);
 checkNativeFee({fee:'100000000'});
});
test('one conversion approval binds the exact source, holder, amount and token fee',()=>{
 const approved={kind:'migrate-output',owner:'public-holder',amount:'7530668912636',fee:'0'},prepared={plan:{request:approved,record:{amount:approved.amount}},quote:{nativeFee:'30000000'}};
 checkConversionPreparation(prepared,approved);
 for(const key of Object.keys(approved))assert.throws(()=>checkConversionPreparation({...prepared,plan:{...prepared.plan,request:{...approved,[key]:'changed'}}},approved),/changed/);
 assert.throws(()=>checkConversionPreparation({...prepared,plan:{...prepared.plan,record:{amount:'1'}}},approved),/changed/);
 assert.throws(()=>checkConversionPreparation({...prepared,quote:{nativeFee:'100000001'}},approved),/fee changed/);
});
