import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {loadJointCatalog,rememberJointAsset,savedJointAssets} from '../../engine/shared/joint-bridge-assets.js';

test('the official launch catalog exposes tokens beyond the initial pair without authorizing them',async()=>{
 const mint=Keypair.generate().publicKey.toBase58();let request;
 const rows=await loadJointCatalog({fetcher:async(url,options)=>{request={url,options};return new Response(JSON.stringify({schema:'xmr20-launches-v1',tokens:[{mint,ticker:'THIRD',name:'Another launch'},{mint,ticker:'DUPLICATE'},{mint:'invalid'}]}));}});
 assert.equal(rows.filter(r=>r.mint===mint).length,1);assert.equal(rows.find(r=>r.mint===mint).symbol,'THIRD');assert.equal(request.url,'https://xmr20.org/api/xmr20/tokens');assert.equal(request.options.credentials,'omit');assert.ok(!rows.some(r=>r.mint==='invalid'));
});
test('invalid or failed discovery cannot be mistaken for a complete token catalog',async()=>{
 for(const value of [{schema:'wrong',tokens:[]},{schema:'xmr20-launches-v1',tokens:{} }])await assert.rejects(()=>loadJointCatalog({fetcher:async()=>new Response(JSON.stringify(value))}));
 await assert.rejects(()=>loadJointCatalog({fetcher:async()=>new Response('{}',{status:503})}));
});
test('selected token discovery survives account switching but stores no wallet or spending approval',()=>{
 const disk=new Map(),storage={getItem:k=>disk.get(k),setItem:(k,v)=>disk.set(k,v)},mint=Keypair.generate().publicKey.toBase58();rememberJointAsset({mint,symbol:'THIRD',name:'Another launch',secret:'synthetic-not-stored'},storage);
 assert.equal(savedJointAssets(storage).find(a=>a.mint===mint).symbol,'THIRD');assert.ok(![...disk.values()].join('').includes('synthetic-not-stored'));
});
