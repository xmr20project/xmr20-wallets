// Spare anchors that will never confirm give their coin back (1 Nov 2026, owner's lots stuck at "Anchor payment sent · waiting for
// its first block"): a refused spare releases its input; a sent spare the node no longer knows becomes 'dropped', releases its input
// and the next spare is made; a sent spare the node still has (pool or block) is kept. Market host over a stub token worker.
//   node --test wallet-extension/tests/market-spare-settle.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarketHost,inputKeyImages,emptyMarketState} from '../../engine/shared/market-host.js';

const TOKEN='xmr20t1stub',ASSET='ab'.repeat(32),h=c=>c.repeat(64);
// Mainnet transaction f113aefb… (block 3,796,575), its prefix up to the last input; key images as the node decodes them.
const REAL={"txid": "f113aefbe2c378f2306f6dd3e66c20cf8d7a27a7f855596dc3d406e540a2c7f1", "prefix": "020002020010c8b4b32781b0a321919ce605f8e935e9a82bd6e50ee6b607aa1ca88009a1a004d709902ee51d93329404fb076d02b1427c991e895d331ad74480a249dc12f3a8d2152215ad10b34a88d750ae020010cd89b221f793b71287c49116f29fa803fc9d0ad8ac69f6a578a0ff19fddb15cece01bd599129a9609f35de148c2249246698dddd84b3d7e8a4ad5e746bfde00720e787a85c0ea470d73cacacf8af", "keyImages": ["6d02b1427c991e895d331ad74480a249dc12f3a8d2152215ad10b34a88d750ae", "49246698dddd84b3d7e8a4ad5e746bfde00720e787a85c0ea470d73cacacf8af"]};
const prefix=ki=>'02'+'00'+'01'+'02'+'00'+'01'+'05'+ki;// v2, unlock 0, one to-key input: amount 0, one offset, key image

function harness({spares={},lookup=()=>({known:false}),publish=()=>({ok:true,status:'OK'}),signed=[]}={}){
 const t0=Date.now(),calls=[],logs=[];let doc={version:1,market:{[TOKEN]:{...emptyMarketState(),spares,waiting:{w1:{id:'w1',status:'waiting',kind:'prepare',review:{quantity:'1000',list:null},createdAt:t0-3600e3}}}}};
 const journal={read:async()=>structuredClone(doc),write:async m=>{const next=structuredClone(doc);const r=await m(next);doc=next;return r??next;}};
 let n=0;
 const client={call:async(action,a={})=>{calls.push([action,a]);switch(action){
  case 'sync':return {native:{unlocked:'5000000000',locked:'0',reserved:'0',outputs:[]}};
  case 'marketStatus':return {tip:3796600,lots:[],openBalances:{},lotBalances:{},spares:{ready:[],maturing:[]}};
  case 'carrierLookup':return lookup(a.txid);
  case 'nativeRelease':return {released:a.keyImages.length};
  case 'marketSpare':return {buildId:'b'+(++n),fee:'30000000'};
  case 'marketSign':{const s=signed.shift();assert.ok(s,'unexpected spare');return s;}
  case 'carrierPublishRecover':return publish(a.txid);
  default:throw Error('stub: '+action);}}};
 const fetch=async u=>new Response(JSON.stringify(String(u).endsWith('/api/market')?{nftTrading:'soon'}:{}),{status:200,headers:{'content-type':'application/json'}});
 const host=createMarketHost({client,journal,ids:{ownerKey:h('1'),nativeAddress:'4stub',tokenAddress:TOKEN},manifest:{network:{kind:'mainnet',genesis:h('0')},ledgerDomain:h('d')},
  marketUrl:'https://market.invalid',finality:25,asset:ASSET,accountId:'stub',anchorMode:'spare',fetch,log:(...x)=>logs.push(x.join(' '))});
 return {host,calls,logs,doc:()=>doc.market[TOKEN],t0};
}
const spareCalls=calls=>calls.filter(([a])=>['carrierLookup','nativeRelease','marketSpare','carrierPublishRecover'].includes(a)).map(([a,x])=>a==='nativeRelease'?[a,x.keyImages]:a==='carrierLookup'||a==='carrierPublishRecover'?[a,x.txid]:[a]);

test('input key images: a real mainnet transaction and a one-input prefix',()=>{
 assert.deepEqual(inputKeyImages(REAL.prefix),REAL.keyImages);
 assert.deepEqual(inputKeyImages(prefix(h('7'))),[h('7')]);
 assert.throws(()=>inputKeyImages(REAL.prefix.slice(0,-2)),/Truncated/);
});

test('a refused spare releases its input, so the same coin can pay the next attempt',async()=>{
 const x=harness({publish:()=>({ok:false,status:'Failed'}),signed:[{txid:h('a'),blob:prefix(h('c')),anchorKeyImage:h('e'),fee:'30000000',keyImages:[h('c')]}]});
 await x.host.start();await x.host.tick();
 assert.equal(x.doc().spares[h('a')].status,'refused');
 assert.deepEqual(spareCalls(x.calls),[['marketSpare'],['carrierPublishRecover',h('a')],['nativeRelease',[h('c')]]]);
 assert.match(x.doc().spareError,/not accepted: Failed/);
});

test('refused spares saved before this fix release their inputs once per session (never a sent spare\'s input)',async()=>{
 const old=Date.now()-3*3600e3;
 const x=harness({lookup:()=>({known:true,inPool:true,blockHeight:null}),spares:{
  [h('1')]:{txid:h('1'),blob:prefix(h('2')),anchor:h('3'),status:'refused',createdAt:old},
  [h('4')]:{txid:h('4'),blob:prefix(h('5')),anchor:h('6'),status:'refused',createdAt:old},
  [h('7')]:{txid:h('7'),blob:prefix(h('5')),anchor:h('8'),status:'sent',createdAt:Date.now()-600e3}}});
 await x.host.start();await x.host.tick();await x.host.tick();
 const released=x.calls.filter(([a])=>a==='nativeRelease').map(([,a])=>a.keyImages);
 assert.deepEqual(released,[[h('2')]],'once, and not the input of the sent spare');
 assert.equal(x.calls.some(([a])=>a==='marketSpare'),false,'the sent spare (in the pool) still counts as coming');
});

test('a sent spare the node no longer knows is dropped, its input released and the next spare made',async()=>{
 const x=harness({spares:{[h('9')]:{txid:h('9'),blob:prefix(h('c')),anchor:h('e'),status:'sent',createdAt:Date.now()-20*60e3}},
  signed:[{txid:h('b'),blob:prefix(h('c')),anchorKeyImage:h('f'),fee:'30000000',keyImages:[h('c')]}]});
 await x.host.start();await x.host.tick();
 assert.equal(x.doc().spares[h('9')].status,'dropped');assert.equal(x.doc().spares[h('b')].status,'sent');
 assert.deepEqual(spareCalls(x.calls),[['carrierLookup',h('9')],['nativeRelease',[h('c')]],['marketSpare'],['carrierPublishRecover',h('b')]]);
 const st=await x.host.handle({method:'state'});assert.equal(st.anchors.sending,1);assert.deepEqual(st.anchors.sendingInBlock,[]);
 assert.ok(x.logs.some(l=>/unknown to the node/.test(l)));
});

test('a sent spare in the pool is kept; in a block its height is shown; a young one is not looked up',async()=>{
 const pool=harness({spares:{[h('9')]:{txid:h('9'),blob:prefix(h('c')),anchor:h('e'),status:'sent',createdAt:Date.now()-20*60e3}},lookup:()=>({known:true,inPool:true,blockHeight:null})});
 await pool.host.start();await pool.host.tick();
 assert.equal(pool.doc().spares[h('9')].status,'sent');assert.deepEqual(spareCalls(pool.calls),[['carrierLookup',h('9')]]);
 const mined=harness({spares:{[h('9')]:{txid:h('9'),blob:prefix(h('c')),anchor:h('e'),status:'sent',createdAt:Date.now()-20*60e3}},lookup:()=>({known:true,inPool:false,blockHeight:3796590})});
 await mined.host.start();await mined.host.tick();
 assert.equal(mined.doc().spares[h('9')].blockHeight,3796590);
 assert.deepEqual((await mined.host.handle({method:'state'})).anchors.sendingInBlock,[3796590]);
 const young=harness({spares:{[h('9')]:{txid:h('9'),blob:prefix(h('c')),anchor:h('e'),status:'sent',createdAt:Date.now()-60e3}}});
 await young.host.start();await young.host.tick();
 assert.deepEqual(spareCalls(young.calls),[]);
});
