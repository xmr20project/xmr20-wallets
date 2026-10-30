import test from 'node:test';import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {createJointMainnetUI} from '../../engine/shared/joint-mainnet-ui.js';
import {jointProgress} from '../../engine/shared/joint-progress.js';
import {XCAT_MINT,XMR20_MINT,jointAsset,discoveredAssets,jointTokenLabel} from '../../engine/shared/joint-bridge-assets.js';
function setup(t,fetcher){
 const previous=new Map();for(const key of ['document','localStorage','fetch'])previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
 const elements=new Map(),listeners=new Map(),doc={hidden:false,activeElement:null,getElementById:id=>elements.get(id),addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:(n,f)=>{if(listeners.get(n)===f)listeners.delete(n);}},disk=new Map();
 Object.assign(globalThis,{document:doc,localStorage:{getItem:k=>disk.get(k)??null,setItem:(k,v)=>disk.set(k,v),removeItem:k=>disk.delete(k)},fetch:(url,o)=>url.endsWith('/catalog')?Promise.resolve(new Response('{}',{status:503})):fetcher(url,o)});
 const account={id:'disposable',name:'Disposable wallet',sol:Keypair.generate().publicKey.toBase58(),solSecret:'test-only-unavailable',xmr:'45cQVke2TNqcDi7dkQY3dRiMgVSF89V4reM1BsBeSXDrdmBdXpbrCCqTQ39zUcvyZgVYk7kGQFjNmRfnmvaACHYz3ZMwG5q',xmrSeed:'test-only-unavailable'};
 let busy=false,body='',renders=0;const modal={open:true},d={account:()=>account,same:()=>{},modal,esc:v=>String(v),settings(){},isBusy:()=>busy,on:(id,fn)=>{if(elements.has(id))elements.get(id).onclick=fn;},show(title,value){body=value;renders++;elements.clear();for(const m of value.matchAll(/<([a-z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){const el={id:m[3],tagName:m[1].toUpperCase(),disabled:/\bdisabled\b/.test(m[2]),dataset:{},focus(){doc.activeElement=this;}};elements.set(el.id,el);}},async run(fn){if(busy)return;busy=true;try{await fn(1);}catch(e){if(elements.get('error'))elements.get('error').textContent=e.message;}finally{busy=false;}},oneShot(){throw Error('Test cannot sign.');}};
 const ui=createJointMainnetUI(d);t.after(()=>{ui.clear();for(const [k,v] of previous)if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];});return {ui,doc,elements,listeners,get body(){return body;},get renders(){return renders;},get busy(){return busy;}};
}
test('form appears before slow readiness finishes; approvals stay disabled, then enable',async t=>{
 let resolve,signal;const response=new Promise(r=>resolve=r),f=setup(t,async(url,o)=>{assert.ok(url.endsWith('/api/joint-protocol/'+XCAT_MINT+'/readiness'));signal=o.signal;return response;});
 const opening=f.ui.open({mint:XCAT_MINT});await new Promise(r=>setImmediate(r));
 assert.ok(f.elements.has('joint-amount'));assert.equal(f.elements.get('joint-amount').disabled,false);assert.equal(f.elements.get('joint-review').disabled,true);assert.match(f.body,/Verifying Solana and Monero records/);assert.equal(f.busy,false);assert.equal(f.listeners.size,1);
 resolve(new Response(JSON.stringify({ready:true,manifest:jointAsset(XCAT_MINT).manifest,requirements:[]})));await opening;
 assert.equal(f.elements.get('joint-review').disabled,false);assert.doesNotMatch(f.body,/id="joint-elapsed"/);assert.equal(f.listeners.size,0);assert.equal(signal.aborted,false);
});
test('closing during readiness aborts the request and prevents late repaint',async t=>{
 let resolve,signal;const p=new Promise(r=>resolve=r),f=setup(t,async(_,o)=>{signal=o.signal;return p;});const opening=f.ui.open({mint:XCAT_MINT});await new Promise(r=>setImmediate(r));const renders=f.renders;f.ui.clear();f.doc.hidden=true;resolve(new Response(JSON.stringify({ready:true,manifest:jointAsset(XCAT_MINT).manifest})));await opening;assert.equal(signal.aborted,true);assert.equal(f.renders,renders);assert.equal(f.listeners.size,0);
});
test('failed readiness stops feedback, keeps signing disabled, and permits retry',async t=>{
 const f=setup(t,async()=>{throw Error('synthetic outage');});await f.ui.open({mint:XCAT_MINT});assert.equal(f.elements.get('joint-review').disabled,true);assert.equal(f.elements.get('joint-ready').disabled,false);assert.doesNotMatch(f.body,/id="joint-elapsed"/);assert.equal(f.listeners.size,0);
});
test('XMR20 defaults to the shared route and never borrows previous XCAT readiness',async t=>{
 const f=setup(t,async url=>{assert.ok(url.endsWith('/api/joint-protocol/'+XMR20_MINT+'/readiness'));return new Response(JSON.stringify({ready:false,manifest:jointAsset().manifest,requirements:[{description:'The shared bridge is not active yet.'}]}));});await f.ui.open();assert.match(f.body,/Amount \(XMR20\)/);assert.match(f.body,/not active yet/);assert.equal(f.elements.get('joint-review').disabled,true);assert.equal(f.elements.get('joint-token').disabled,false);assert.equal(jointAsset().mint,XMR20_MINT);
});
test('an additional discovered mint is selectable and uses the same pinned program',async t=>{
 const mint=Keypair.generate().publicKey.toBase58(),asset=jointAsset(mint,[{mint,ticker:'NEW',name:'New token'}]);assert.equal(asset.manifest.program,jointAsset().manifest.program);assert.equal(discoveredAssets([{mint,ticker:'NEW'}]).length,4);
 const f=setup(t,async url=>{assert.ok(url.endsWith('/api/joint-protocol/'+mint+'/readiness'));return new Response(JSON.stringify({ready:false,manifest:asset.manifest,requirements:[]}));});await f.ui.open({mint,rows:[{mint,ticker:'NEW',name:'New token'}]});assert.match(f.body,/Amount \(NEW\)/);assert.equal(f.elements.get('joint-review').disabled,true);
});
test('previous XCAT positions keep their original program and route',async t=>{const old=jointAsset('previous-xcat');assert.notEqual(old.manifest.program,jointAsset(XCAT_MINT).manifest.program);const f=setup(t,async url=>{assert.ok(url.endsWith('/api/joint-mainnet/readiness'));return new Response(JSON.stringify({ready:true,manifest:old.manifest,requirements:[]}));});await f.ui.open({mint:'previous-xcat'});assert.match(f.body,/previous joint bridge/);assert.equal(f.elements.get('joint-review').disabled,false);});
test('duplicate token symbols remain distinguishable by their actual mint',()=>{const rows=[1,2].map(()=>({mint:Keypair.generate().publicKey.toBase58(),ticker:'SAME'})),assets=discoveredAssets(rows),same=assets.filter(a=>a.symbol==='SAME'),labels=same.map(a=>jointTokenLabel(a,assets));assert.notEqual(labels[0],labels[1]);for(let i=0;i<2;i++)assert.ok(labels[i].includes(same[i].mint.slice(0,4)));});
test('elapsed feedback follows real time, pauses hidden animation and cleans up',()=>{
 const elapsed={},row={dataset:{}},listeners=new Set();let now=0,tick,clears=0,current=true;const document={hidden:false,getElementById:id=>id==='joint-elapsed'?elapsed:row,addEventListener:(_,f)=>listeners.add(f),removeEventListener:(_,f)=>listeners.delete(f)};
 const p=jointProgress({document,now:()=>now,setTimer:f=>(tick=f,1),clearTimer:()=>clears++,isCurrent:()=>current});p.start('Checking');now=12000;tick();assert.equal(elapsed.textContent,'12s');document.hidden=true;now=14000;tick();assert.equal(elapsed.textContent,'12s');assert.equal(row.dataset.paused,'true');current=false;tick();assert.equal(listeners.size,0);assert.equal(clears,1);assert.equal(p.render(String),'');
});
