import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {createCatalogReader,sharedCatalog,TOKEN_CATALOG_URL} from '../../engine/shared/catalog-cache.js';
import {loadJointCatalog} from '../../engine/shared/joint-bridge-assets.js';
const mint=Keypair.generate().publicKey.toBase58();
function server({status=200,hold=false}={}){
 const calls=[];let release;
 const fetcher=async(url,options)=>{calls.push({url,options});if(hold)await new Promise(r=>{release=r;});options.signal?.throwIfAborted();return new Response(JSON.stringify({schema:'xmr20-launches-v1',solanaNetwork:'mainnet-beta',moneroNetwork:'mainnet',tokens:[{mint,ticker:'THIRD',name:'Another launch'}]}),{status});};
 return {calls,fetcher,release:()=>release?.()};
}
test('one catalog request serves repeated and concurrent readers within the freshness window',async()=>{
 let time=1000;const s=server({hold:true}),reader=createCatalogReader({fetcher:s.fetcher,now:()=>time,ttl:60000});
 const a=reader.load(),b=reader.load();await new Promise(r=>setImmediate(r));assert.equal(s.calls.length,1);s.release();
 const [va,vb]=await Promise.all([a,b]);assert.equal(va.tokens[0].mint,mint);va.tokens.pop();assert.equal(vb.tokens.length,1,'readers receive independent copies');
 time+=30000;assert.equal((await reader.load()).tokens.length,1);assert.equal(s.calls.length,1);
 time+=31000;const late=reader.load();await new Promise(r=>setImmediate(r));assert.equal(s.calls.length,2);s.release();await late;
 const forced=reader.load({force:true});await new Promise(r=>setImmediate(r));assert.equal(s.calls.length,3);s.release();await forced;
 assert.ok(s.calls.every(({url,options})=>url===TOKEN_CATALOG_URL&&options.credentials==='omit'&&options.redirect==='error'&&options.cache==='no-store'));
});
test('failures are never cached and a departing reader does not cancel the request others await',async()=>{
 const failing=server({status:503}),reader=createCatalogReader({fetcher:failing.fetcher});
 await assert.rejects(()=>reader.load(),/unavailable/);await assert.rejects(()=>reader.load(),/unavailable/);assert.equal(failing.calls.length,2);
 const s=server({hold:true}),shared=createCatalogReader({fetcher:s.fetcher}),first=new AbortController(),second=new AbortController();
 const a=shared.load({signal:first.signal}),b=shared.load({signal:second.signal});await new Promise(r=>setImmediate(r));
 first.abort(Error('closed'));await assert.rejects(a,/closed/);assert.equal(s.calls[0].options.signal.aborted,false);
 s.release();assert.equal((await b).tokens.length,1);
 const c=shared.load({signal:second.signal,force:true});await new Promise(r=>setImmediate(r));second.abort(Error('gone'));await assert.rejects(c,/gone/);assert.equal(s.calls[1].options.signal.aborted,true);
});
test('consumers using the same fetch share one reader; different fetchers and URLs stay separate',async()=>{
 const s=server();const rows=await loadJointCatalog({fetcher:s.fetcher});assert.equal(rows.find(r=>r.mint===mint).symbol,'THIRD');
 assert.equal(sharedCatalog(s.fetcher),sharedCatalog(s.fetcher));assert.notEqual(sharedCatalog(s.fetcher),sharedCatalog(server().fetcher));assert.notEqual(sharedCatalog(s.fetcher),sharedCatalog(s.fetcher,'https://xmr20.org/other'));
 await loadJointCatalog({fetcher:s.fetcher});assert.equal(s.calls.length,1,'bridge catalog reads reuse the fresh shared list');
});

test('a caller arriving immediately after the last subscriber aborts starts a fresh request instead of joining the abandoned one',async()=>{
 const s=server({hold:true}),reader=createCatalogReader({fetcher:s.fetcher}),first=new AbortController();
 const a=reader.load({signal:first.signal});await new Promise(r=>setImmediate(r));
 first.abort(Error('closed'));const b=reader.load();
 assert.equal(s.calls.length,2,'second request started synchronously after the abort');assert.equal(s.calls[0].options.signal.aborted,true);assert.equal(s.calls[1].options.signal.aborted,false);
 await assert.rejects(a,/closed/);s.release();assert.equal((await b).tokens.length,1);
});
