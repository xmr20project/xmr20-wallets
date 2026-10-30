import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyReturnRoute} from '../src/legacy-bridge-route.js';
const row={id:'old-token',mint:'test-mint',network:'monero',amountRaw:'2240000000000'};
test('generic empty new-bridge view routes a single received legacy balance straight to return',()=>{
 assert.deepEqual(legacyReturnRoute([row],{emptyNewBridge:true}),{mint:row.mint,direction:'xmr-to-sol'});
 assert.deepEqual(legacyReturnRoute([row,{...row,id:'other',mint:'other-mint'}],{emptyNewBridge:true}),{direction:'xmr-to-sol'});
});
test('existing new-bridge choices/recoveries and explicitly requested assets are never displaced',()=>{
 assert.equal(legacyReturnRoute([row],{emptyNewBridge:false}),null);
 assert.equal(legacyReturnRoute([row],{emptyNewBridge:true,requestedMint:'other-mint'}),null);
 assert.equal(legacyReturnRoute([{...row,bridge:'joint-v3'}],{emptyNewBridge:true}),null);
});
test('zero, native, Solana and malformed balances cannot create legacy withdrawal choices',()=>{
 for(const change of [{amountRaw:'0'},{amountRaw:'NaN'},{amountRaw:'-1'},{network:'solana'},{id:undefined}])assert.equal(legacyReturnRoute([{...row,...change}],{emptyNewBridge:true}),null);
});
