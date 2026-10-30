// Background return watcher: public-history checks, badge + notification once, removal, expiry, sender checks. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
const store=new Map(),alarms=new Map(),badges=[],notes=[],listeners={message:[],alarm:[],click:[]};
globalThis.chrome={runtime:{id:'ext',getURL:p=>'chrome-extension://ext/'+p,onMessage:{addListener:f=>listeners.message.push(f)}},
 storage:{local:{get:async k=>store.has(k)?{[k]:structuredClone(store.get(k))}:{},set:async o=>{for(const [k,v] of Object.entries(o))store.set(k,structuredClone(v));},remove:async k=>{store.delete(k);}}},
 alarms:{create:async(n,o)=>{alarms.set(n,o);},clear:async n=>{alarms.delete(n);},onAlarm:{addListener:f=>listeners.alarm.push(f)}},
 action:{setBadgeText:async o=>{badges.push(o.text);},setBadgeBackgroundColor:async()=>{}},
 notifications:{create:(id,o)=>{notes.push({id,...o});},clear(){},onClicked:{addListener:f=>listeners.click.push(f)}},tabs:{create:async()=>{}}};
const {handleReturnWatch,checkReturnWatches,returnIsReady}=await import('../src/return-watch.js');
const N='ab'.repeat(32),W={action:'watch',mint:'Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR',nonce:N,receipt:'DwsyWzcJuy5Hx92aMZJeHJLjvurVir2kNVhnbfcoHAjM',amount:'15,269,488.357106',symbol:'XMR20'};
const reply=report=>async(url,o)=>{assert.equal(url,'https://api.xmr20.org/api/joint-transferable/'+W.mint+'/snapshot');assert.equal(o.method,'POST');assert.equal(o.credentials,'omit');return {ok:true,json:async()=>report};};
test('watch -> not ready -> ready notifies once with a badge; done removes and clears the alarm',async()=>{
 store.clear();alarms.clear();badges.length=0;notes.length=0;
 assert.deepEqual(await handleReturnWatch(W),{watching:1});assert.ok(alarms.has('xmr20-return-watch'));
 await checkReturnWatches({fetcher:reply({complete:true,pending:[{operation:'burn',receipt:'other'}],accepted:[]})});assert.equal(notes.length,0);assert.deepEqual(badges,[]);
 await checkReturnWatches({fetcher:reply({complete:true,pending:[{operation:'burn',receipt:W.receipt}],accepted:[]})});
 assert.equal(notes.length,1);assert.equal(notes[0].id,'xmr20-return-'+N);assert.match(notes[0].message,/15,269,488\.357106 XMR20/);assert.match(notes[0].message,/Resume return/);assert.deepEqual(badges,['1']);
 await checkReturnWatches({fetcher:reply({complete:true,pending:[{operation:'burn',receipt:W.receipt}],accepted:[]})});assert.equal(notes.length,1,'notified only once');
 assert.deepEqual(await handleReturnWatch({action:'done',nonce:N}),{watching:0});assert.ok(!store.has('xmr20-return-watch'));assert.ok(!alarms.has('xmr20-return-watch'));
});
test('an accepted burn with the exact nonce also counts as ready; an incomplete report never does',()=>{
 assert.equal(returnIsReady({complete:true,accepted:[{envelope:{record:{op:'burn',nonce:N}}}]},W,N),true);
 assert.equal(returnIsReady({complete:false,pending:[{operation:'burn',receipt:W.receipt}]},W,N),false);
 assert.equal(returnIsReady({complete:true,accepted:[{envelope:{record:{op:'transfer',nonce:N}}}]},W,N),false);
});
test('failed reads are retried later; watches older than 3 days are dropped; invalid watches are refused',async()=>{
 store.clear();alarms.clear();notes.length=0;await handleReturnWatch(W);
 await checkReturnWatches({fetcher:async()=>{throw Error('offline');}});assert.equal(notes.length,0);assert.ok(store.has('xmr20-return-watch'));
 await checkReturnWatches({fetcher:async()=>({ok:false})});assert.equal(notes.length,0);
 await checkReturnWatches({fetcher:reply({complete:true,pending:[],accepted:[]}),now:()=>Date.now()+3*86400000+1});assert.ok(!store.has('xmr20-return-watch'),'expired watch removed');
 for(const bad of [{...W,nonce:'xyz'},{...W,receipt:'bad receipt!'},{...W,amount:'<script>'},{...W,symbol:'X'.repeat(17)}])await assert.rejects(handleReturnWatch(bad),/Invalid return watch/);
});
test('only the wallet popup may register a watch',async()=>{
 const [listener]=listeners.message;let replied=null;
 assert.equal(listener({channel:'xmr20-return-watch',...W},{id:'other',url:'chrome-extension://ext/popup.html'},v=>{replied=v;}),undefined);
 assert.equal(listener({channel:'xmr20-return-watch',...W},{id:'ext',url:'https://evil.example/'},v=>{replied=v;}),undefined);assert.equal(replied,null);
 assert.equal(listener({channel:'xmr20-return-watch',...W},{id:'ext',url:'chrome-extension://ext/popup.html'},v=>{replied=v;}),true);
});
