import test from 'node:test';import assert from 'node:assert/strict';
import {maximumRaw,inputAmount,fillMaximum,TOKEN_TRANSFER_LIMIT} from '../../engine/token/max-amount.js';
import {solanaMaximum} from '../../engine/shared/solana-max.js';
import {Keypair} from '@solana/web3.js';
test('Max preserves atomic precision, excludes fees and reservations, and never subtracts transfer tax twice',()=>{
 assert.equal(inputAmount('9000000000'),'9000');assert.equal(inputAmount('985001'),'0.985001');
 assert.equal(inputAmount('900719925474099312345678',12),'900719925474.099312345678');
 assert.equal(maximumRaw('9000000000',{reserved:'1000000000'}),'8000000000');
 assert.equal(maximumRaw('1000000',{fee:'5000'}),'995000');
 assert.equal(maximumRaw('10',{reserved:'20'}),'0');
 assert.equal(maximumRaw('50000000000001',{limit:TOKEN_TRANSFER_LIMIT}),TOKEN_TRANSFER_LIMIT);
 assert.equal(maximumRaw('1000000'),'1000000'); // Fee is applied once by the existing transfer.
 for(const v of [undefined,null,-1,1.5,Number.MAX_SAFE_INTEGER+1,'1e9','-1','1,000'])assert.throws(()=>maximumRaw(v));
});
function field(){const listeners=new Set();return {value:'2',isConnected:true,addEventListener:(_,f)=>listeners.add(f),removeEventListener:(_,f)=>listeners.delete(f),edit(value){this.value=value;for(const f of listeners)f();},listeners};}
test('slow Max results cannot overwrite edits, another account, or a closed modal',async()=>{
 for(const change of [f=>f.edit('7'),f=>{f.isConnected=false;}]){const f=field();let resolve;const pending=fillMaximum(f,()=>new Promise(r=>resolve=r));change(f);resolve('9000000');assert.equal(await pending,false);assert.notEqual(f.value,'9');assert.equal(f.listeners.size,0);}
 const f=field();await fillMaximum(f,async()=>'1234567');assert.equal(f.value,'1.234567');
 await assert.rejects(()=>fillMaximum(f,async()=>'0'),/No spendable/);assert.equal(f.value,'1.234567');
});
test('SOL Max uses the fee for the actual sender and recipient without signing or broadcasting',async()=>{
 const owner=Keypair.generate().publicKey.toBase58(),to=Keypair.generate().publicKey.toBase58();let messages=0;
 const rpc={getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1}),getBalance:async()=>1000000,getFeeForMessage:async message=>{messages++;assert.equal(message.accountKeys[0].toBase58(),owner);assert.ok(message.accountKeys.some(k=>k.toBase58()===to));return {value:5000};}};
 assert.equal(await solanaMaximum(owner,to,{rpc}),'995000');assert.equal(messages,1);
 rpc.getFeeForMessage=async()=>({value:null});await assert.rejects(()=>solanaMaximum(owner,to,{rpc}),/fee unavailable/);
});
