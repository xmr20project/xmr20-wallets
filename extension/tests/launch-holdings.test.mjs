import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {validateWalletHoldings,cacheWalletHoldings,cachedWalletHoldings} from '../../engine/shared/holdings.js';
// Saved Solana holdings keep a launch of the trading service (a row known by its mint, with no launch record or Monero
// inscription) beside launchpad rows, whose checks are unchanged.
const OWNER=Keypair.generate().publicKey.toBase58(),key=()=>Keypair.generate().publicKey.toBase58();
const pad=()=>({id:'11111111-1111-1111-1111-111111111111',mint:key(),ticker:'PAD',name:'Launchpad token',deployment:'ab'.repeat(32),listed:true,stale:false,amountRaw:'1234567',checkedAt:Date.now()-1000});
const launch=(change={})=>{const mint=key();return {id:mint,mint,ticker:'TEST',name:'Test launch',deployment:null,listed:false,venue:'xmr20-trade',stale:false,amountRaw:'7530668912636',checkedAt:Date.now()-1000,...change};};
const envelope=(rows,network='solana')=>({schema:'xmr20-wallet-holdings-v1',address:OWNER,network,moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',complete:true,checked:Date.now()-1000,rows});
test('a launch row is a valid Solana holding and keeps its venue; a launchpad row is returned as before',()=>{
 const a=pad(),b=launch(),data=validateWalletHoldings(envelope([a,b]),OWNER,'solana');
 assert.equal(data.complete,true);assert.equal(data.rows.length,2);
 assert.deepEqual(Object.keys(data.rows[0]).sort(),['amountRaw','checkedAt','deployment','id','image','listed','mint','name','priceUsd','receipt','stale','ticker']);
 assert.deepEqual({...data.rows[1],checkedAt:0},{id:b.mint,mint:b.mint,ticker:'TEST',name:'Test launch',image:null,priceUsd:null,deployment:null,listed:false,venue:'xmr20-trade',amountRaw:'7530668912636',checkedAt:0,stale:false,receipt:null});
});
test('saved Solana holdings with a launch row are written and read back; without the row kind they were dropped whole',()=>{
 const values=new Map(),storage={setItem:(k,v)=>values.set(k,v),getItem:k=>values.get(k)??null},a=pad(),b=launch();
 cacheWalletHoldings(OWNER,{rows:[a,b],complete:true,checked:Date.now()-1000},{storage,network:'solana'});assert.equal(values.size,1);
 const cached=cachedWalletHoldings(OWNER,{storage,network:'solana'});
 assert.equal(cached.cached,true);assert.equal(cached.complete,false);assert.deepEqual(cached.rows.map(r=>[r.id,r.venue,r.amountRaw,r.stale]),[[a.id,undefined,'1234567',true],[b.mint,'xmr20-trade','7530668912636',true]]);
});
test('the launch row kind is exact and exists on Solana only',()=>{
 assert.throws(()=>validateWalletHoldings(envelope([launch()],'monero'),OWNER,'monero'),/Invalid holder/);
 for(const change of [{id:key()},{id:'11111111-1111-1111-1111-111111111111'},{deployment:undefined},{deployment:''},{deployment:'ab'.repeat(32)},{listed:true},{venue:'raydium-launchlab'},{venue:undefined},{amountRaw:'0'},{ticker:'ELEVENCHARS'}])
  assert.throws(()=>validateWalletHoldings(envelope([launch(change)]),OWNER,'solana'),/Invalid holder/,JSON.stringify(change));
 const b=launch();assert.throws(()=>validateWalletHoldings(envelope([b,{...b}]),OWNER,'solana'),/Invalid holder/,'the same launch row twice');
});
test('a launch row and another row never share a mint',()=>{
 const a=pad(),b=launch({id:a.mint,mint:a.mint});
 for(const rows of [[a,b],[b,a]])assert.throws(()=>validateWalletHoldings(envelope(rows),OWNER,'solana'),/Invalid holder/);
 assert.equal(validateWalletHoldings(envelope([a,launch()]),OWNER,'solana').rows.length,2);
});
test('launchpad rows are checked as before: a launch id needs its Monero deployment',()=>{
 for(const change of [{deployment:null},{deployment:'ab'.repeat(31)},{deployment:null,venue:'xmr20-trade',listed:false},{id:'short'}])
  assert.throws(()=>validateWalletHoldings(envelope([{...pad(),...change}]),OWNER,'solana'),/Invalid holder/,JSON.stringify(change));
});
