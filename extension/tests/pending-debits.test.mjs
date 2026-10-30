import test from 'node:test';import assert from 'node:assert/strict';
import {pendingDebits,cancellationConfirmed,balanceRejection} from '../src/pending-debits.js';
const account={sol:'owner',xmr:'sender'},row={id:'launch'};
const draft={id:'request-123',owner:'owner',moneroAddress:'sender',recipient:'recipient',launchId:'launch',amountRaw:'490000000000',state:'reserved'};
const remote=moneroTransfers=>({moneroTransfers,transfers:[]});
test('pending requests are scoped to token, sender and authenticated owner without treating the total as available',()=>{
 const rows=pendingDebits(remote([draft,{...draft,id:'other-token',launchId:'other'},{...draft,id:'other-owner',owner:'other'},{...draft,id:'other-address',moneroAddress:'other'},{...draft,state:'complete'},{...draft,state:'cancelled'}]),account,row);
 assert.equal(rows.length,1);assert.equal(rows[0].amountRaw,'490000000000');assert.equal(rows[0].canCancel,true);
});
test('signed, submitted, halted or bridge requests never offer unsigned-send cancellation',()=>{
 for(const t of [{...draft,state:'pending'},{...draft,state:'halted'},{...draft,signature:'signed'},{...draft,txid:'a'.repeat(64)},{...draft,txid:'malformed'}])assert.equal(pendingDebits(remote([t]),account,row)[0].canCancel,false);
 assert.equal(pendingDebits({moneroTransfers:[],transfers:[{...draft,direction:'xmr-to-sol'}]},account,row)[0].canCancel,false);
 assert.equal(pendingDebits({moneroTransfers:[],transfers:[{...draft,direction:'sol-to-xmr'}]},account,row).length,0);
});
test('only an exact server-confirmed cancellation can clear a local reservation receipt',()=>{
 const pending=pendingDebits(remote([draft]),account,row)[0],cancelled={...draft,state:'cancelled'};
 assert.equal(cancellationConfirmed(cancelled,pending),true);
 for(const key of ['id','owner','launchId','moneroAddress','recipient','amountRaw','state'])assert.throws(()=>cancellationConfirmed({...cancelled,[key]:'different'},pending));
 assert.throws(()=>cancellationConfirmed({...cancelled,txid:'a'.repeat(64)},pending));assert.throws(()=>cancellationConfirmed({...cancelled,signature:'signed'},pending));
});
test('invalid or unavailable pending data never becomes a zero-reservation assertion',()=>{for(const value of [null,{}, {moneroTransfers:[]}])assert.throws(()=>pendingDebits(value,account,row));assert.throws(()=>pendingDebits(remote([{...draft,amountRaw:'-1'}]),account,row));});
test('balance-specific recovery does not relabel unrelated service errors',()=>{assert.equal(balanceRejection({code:'MONERO_INSUFFICIENT_BALANCE'}),true);assert.equal(balanceRejection(Error('Insufficient available Monero balance after pending transfers and burns.')),true);assert.equal(balanceRejection(Error('Token backing could not be verified.')),false);});
