import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeNativeHoldings,nativeHoldingRow,nativeHoldingsKey,saveNativeHoldings} from '../../engine/shared/native-token-holdings.js';
const address='4'+'1'.repeat(94),configuration={manifestId:'ab'.repeat(32),chainGenesis:'cd'.repeat(32),
 manifest:{cap:1000000000000000n},backing:{mint:'11111111111111111111111111111111'},
 display:{mint:'11111111111111111111111111111111',symbol:'EXTREMIST',name:'Monero Extremist'}};
const checkpoint={ready:true,height:'123',checkpoint:'ef'.repeat(32)};
const output=(vout,quantity,held=false)=>({source:{txid:'12'.repeat(32),vout},quantity,held,keyImage:'PRIVATE DERIVED VALUE MUST NOT LEAVE',outputKey:'NOT REQUIRED'});
test('public display cache holds exact totals without private sources and stays separate from linked claims',async()=>{
 const value=summarizeNativeHoldings({address,configuration,checkpoint,now:1000,inventory:[output(0,'7530668912636'),output(1,'100',true)]});
 assert.equal(value.amountRaw,'7530668912736');assert.equal(value.heldRaw,'100');
 assert(!JSON.stringify(value).includes('PRIVATE'));assert(!JSON.stringify(value).includes('source'));
 const row=nativeHoldingRow(value,address,{configuration,now:1001});assert.equal(row.stale,true);assert.equal(row.balanceSource,'private-native-scan');
 assert.equal(row.solanaOwner,undefined);assert.equal(row.ticker,'EXTREMIST');
 let saved;await saveNativeHoldings({...value,checkedAt:Date.now()},{configuration,storage:{set:async v=>saved=v}});
 assert.equal(Object.keys(saved)[0],nativeHoldingsKey(address,configuration));
});
test('wrong wallet, manifest, future data and malformed inventory never become display holdings',()=>{
 const value=summarizeNativeHoldings({address,configuration,checkpoint,now:1000,inventory:[output(0,'1')]});
 for(const patch of [{address:'8'+'1'.repeat(94)},{manifest:'ff'.repeat(32)},{amountRaw:'-1'},{heldRaw:'2'},{checkedAt:2000},{blockHash:'bad'}])
  assert.equal(nativeHoldingRow({...value,...patch},address,{configuration,now:1001}),null);
 for(const inventory of [[output(0,'1'),output(0,'1')],[output(0,'1e6')],[output(-1,'1')],[output(0,'1000000000000001')]])
  assert.throws(()=>summarizeNativeHoldings({address,configuration,checkpoint,inventory}));
 assert.throws(()=>summarizeNativeHoldings({address,configuration,checkpoint:{...checkpoint,ready:false},inventory:[]}));
});
