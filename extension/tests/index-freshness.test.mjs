import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak_256} from '@noble/hashes/sha3';
import {validateWalletHoldings,loadWalletHoldings,cacheWalletHoldings,cachedWalletHoldings} from '../../engine/shared/holdings.js';
// Checksum-valid synthetic public address, unrelated to any real account.
const body=Uint8Array.from([18,...Array(64).fill(2)]),bytes=Uint8Array.from([...body,...keccak_256(body).slice(0,4)]),alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let ADDRESS='';for(let i=0;i<bytes.length;i+=8){const block=bytes.slice(i,i+8);let n=0n;for(const v of block)n=(n<<8n)+BigInt(v);let s='';while(n){s=alphabet[Number(n%58n)]+s;n/=58n;}ADDRESS+=s.padStart(block.length===8?11:7,'1');}
const fixture=()=>({schema:'xmr20-wallet-holdings-v1',address:ADDRESS,network:'monero',moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',source:'independent-verified',maxSnapshotAgeMs:600000,complete:true,checked:Date.now()-240000,revision:1,nextCursor:null,rows:[{id:'11111111-1111-1111-1111-111111111111',mint:'So11111111111111111111111111111111111111112',ticker:'TEST',name:'Test token',deployment:'ab'.repeat(32),listed:false,stale:false,amountRaw:'1234567',checkedAt:Date.now()-240000}]});
test('independent index freshness is bounded and ordinary snapshots retain their existing window',()=>{
 const data=fixture();assert.equal(validateWalletHoldings(data,ADDRESS).complete,true);
 delete data.source;delete data.maxSnapshotAgeMs;assert.equal(validateWalletHoldings(data,ADDRESS).complete,false);
 for(const change of [{source:'other',maxSnapshotAgeMs:600000},{source:'independent-verified',maxSnapshotAgeMs:Infinity}])assert.throws(()=>validateWalletHoldings({...fixture(),...change},ADDRESS),/freshness/);
});
test('explicit stale status and expired snapshots can never become fresh',()=>{
 const data=fixture();data.rows[0].stale=true;assert.equal(validateWalletHoldings(data,ADDRESS).complete,false);
 data.rows[0].stale=false;data.rows[0].checkedAt=Date.now()-600001;assert.equal(validateWalletHoldings(data,ADDRESS).complete,false);
});
test('loading and display caching preserve verified source policy and exact amounts',async()=>{
 const data=fixture(),loaded=await loadWalletHoldings(ADDRESS,{fetcher:async()=>({ok:true,json:async()=>data})});assert.equal(loaded.complete,true);assert.equal(loaded.source,'independent-verified');
 const values=new Map(),storage={setItem:(key,value)=>values.set(key,value),getItem:key=>values.get(key)};
 cacheWalletHoldings(ADDRESS,loaded,{storage});const cached=cachedWalletHoldings(ADDRESS,{storage});assert.equal(cached.rows[0].amountRaw,'1234567');assert.equal(cached.source,'independent-verified');assert.equal(cached.complete,false);
});
