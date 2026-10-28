import test from 'node:test';
import assert from 'node:assert/strict';
import {checkTransferAmount,validateTransferQuote} from '../src/transfer-quote.js';
const account={xmr:'sender'},row={id:'launch',deployment:'a'.repeat(64),network:'monero',stale:true,amountRaw:'100000000'};
const quote={launchId:row.id,token:row.deployment,network:'mainnet',from:account.xmr,to:'recipient',amountRaw:'90000000',balanceRaw:'100000000',availableRaw:'100000000',height:4000000};
const validate=q=>validateTransferQuote(q,account,row,'recipient','90000000');
test('delayed or outdated public balance cannot override a verified available balance',()=>{
 assert.equal(validate(quote),quote);
 assert.equal(validateTransferQuote(quote,account,{...row,amountRaw:'1000000'},'recipient','90000000'),quote);
});
test('available balance excludes reserved funds even with sufficient confirmed balance',()=>{
 assert.throws(()=>validate({...quote,availableRaw:'80000000'}),/Insufficient available balance/);
 assert.equal(validate({...quote,availableRaw:'90000000'}).availableRaw,'90000000');
});
test('quote is bound to sender, recipient, token, launch, network and exact amount',()=>{
 for(const key of ['launchId','token','network','from','to','amountRaw'])assert.throws(()=>validate({...quote,[key]:'different'}),/does not match/);
 assert.throws(()=>validate(null),/does not match/);
});
test('malformed or inconsistent balances and missing chain height fail closed',()=>{
 for(const bad of [null,undefined,100,'-1','1e8','01','', '9'.repeat(41)])for(const key of ['balanceRaw','availableRaw'])assert.throws(()=>validate({...quote,[key]:bad}),/Could not verify/);
 assert.throws(()=>validate({...quote,availableRaw:'100000001'}),/Could not verify/);
 for(const height of [undefined,0,-1,'4000000',1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validate({...quote,height}),/Could not verify/);
});
test('per-transfer cap is exact and independent of cached balance',()=>{
 checkTransferAmount('50000000000000');
 assert.throws(()=>checkTransferAmount('50000000000001'),/50,000,000/);
 for(const bad of ['0','-1','1e6','1.0',1])assert.throws(()=>checkTransferAmount(bad),/valid token amount/);
});
