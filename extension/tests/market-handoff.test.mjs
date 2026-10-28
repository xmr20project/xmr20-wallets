import test from 'node:test';
import assert from 'node:assert/strict';
import {createSiteBroker} from '../src/site-broker.js';
import {marketLaunch,createMarketFetch,MARKET_ORIGIN} from '../src/market-policy.js';
import {createExtensionMarketHost} from '../src/market-wallet-host.js';

function fixture(){
 const saved={},windows=new Map(),popups=new Set(['popup-port']);let n=10,session={id:'unlock',activeId:'a'},url=MARKET_ORIGIN+'/market/';
 const account={id:'a',name:'Public fixture',sol:'11111111111111111111111111111111',xmr:'4'+'1'.repeat(94),solSecret:'PUBLIC TEST FIXTURE',xmrSeed:'PUBLIC TEST FIXTURE'};
 const chrome={storage:{session:{get:async k=>({[k]:structuredClone(saved[k])}),set:async v=>Object.assign(saved,structuredClone(v))}},runtime:{id:'test-extension',getURL:p=>'chrome-extension://test-extension/'+p,getManifest:()=>({version:'fixture'})},windows:{get:async id=>{if(!windows.has(id))throw Error();return windows.get(id);},create:async args=>{const w={id:++n,tabs:[{id:++n}],...args};windows.set(w.id,w);return w;}},tabs:{get:async()=>({url})}};
 const broker=createSiteBroker({chrome,nativePopupAlive:id=>popups.has(id),nativeMarket:true,jointBridge:true,readSession:async()=>session,unlock:async()=>{},readVault:async()=>({accounts:[account]}),sign:async()=>{throw Error('No signing in handoff');},uuid:()=>crypto.randomUUID()});
 const sender={url,origin:MARKET_ORIGIN,frameId:0,tab:{id:1},documentId:'first'};
 const external=(action,args={},s=sender)=>broker.external({channel:'xmr20-site',action,...args},s);
 const connection=()=>saved['xmr20-site-connection'];
 async function connect(action='connect'){const r=await external(action),request=connection().requests[r.requestId];await broker.internal({requestId:r.requestId,action:'approve',accountId:'a'},{id:chrome.runtime.id,url:chrome.runtime.getURL('approval.html')+'?request='+r.requestId,frameId:0,tab:{id:request.approvalTabId}});return (await external('result',r)).value;}
 function internal(action,overrides={}){const [id,m]=Object.entries(connection().markets)[0];return broker.internal({requestId:id,action},{id:chrome.runtime.id,...(m.inline?{url:chrome.runtime.getURL('popup.html'),nativePopupId:m.nativePopupId,...(m.approvalTabId===null?{}:{frameId:0,tab:{id:m.approvalTabId}})}:{url:chrome.runtime.getURL('market.html')+'?request='+id,frameId:0,tab:{id:m.approvalTabId}}),...overrides});}
 const openNative=(overrides={},action='openNativeSend')=>broker.internal({channel:'xmr20-site-approval',action},{id:chrome.runtime.id,url:chrome.runtime.getURL('popup.html'),nativePopupId:'popup-port',frameId:0,...overrides});
 return {broker,external,internal,connect,connection,account,windows,openNative,popups,chrome,lock:()=>session=null,switch:()=>session.activeId='other',navigate:()=>url='https://evil.example/',sender};
}
test('installed popup opens native sends in its own document, with no extra window or Solana wallet',async()=>{
 const f=fixture();delete f.account.sol;delete f.account.solSecret;
 const result=await f.openNative();assert.equal(result.opened,true);assert.equal(result.account.solana,null);
 assert.equal(f.windows.size,0);assert.equal(typeof result.requestId,'string');
 assert.equal((await f.internal('marketView')).market.view,'send');assert.equal((await f.internal('marketKeys')).seed,'PUBLIC TEST FIXTURE');
 assert.equal(Object.keys(f.connection().grants).length,0);
 await assert.rejects(f.external('openNativeSend'));await assert.rejects(f.internal('marketKeys',{tab:{id:999}}));
 await assert.rejects(f.openNative(),/existing/);f.lock();await assert.rejects(f.internal('marketKeys'),/locked/);
});
test('inline access is bound to one live popup port and tab; closing the popup permits a fresh host',async()=>{
 const f=fixture();await f.openNative();
 for(const override of [{nativePopupId:'other'},{nativePopupId:undefined},{url:'chrome-extension://test-extension/market.html'},{tab:{id:20}},{frameId:1}]){
  for(const action of ['marketView','marketKeys','marketSignCustody','marketClose'])await assert.rejects(f.internal(action,override));
 }
 await assert.rejects(f.openNative({nativePopupId:undefined}));
 const old=Object.keys(f.connection().markets)[0];f.popups.delete('popup-port');f.popups.add('reopened');
 const next=await f.openNative({nativePopupId:'reopened',frameId:0,tab:{id:20}});
 assert.notEqual(next.requestId,old);assert.equal(f.windows.size,0);assert.equal(Object.keys(f.connection().markets).length,1);
 assert.equal((await f.internal('marketView')).market.view,'send');
 await f.internal('marketClose');assert.equal(Object.keys(f.connection().markets).length,0);
});
test('website requests cannot evict an active popup; disconnect revokes only its private host',async()=>{
 const f=fixture();await f.connect('connectMonero');await f.openNative();
 await assert.rejects(f.external('openMarket',{market:{view:'list'}}),/existing/);
 await f.broker.revokeNativePopup('unrelated-port');
 await assert.rejects(f.openNative(),/existing/);
 assert.equal(f.windows.size,1); // Connection approval only.
 assert.equal(Object.keys(f.connection().markets).length,1);
 f.popups.delete('popup-port');await f.broker.revokeNativePopup('popup-port');
 assert.equal(Object.keys(f.connection().markets).length,0);
});
test('toolbar popup without tab or frame metadata opens send, bridge and conversion hosts',async()=>{
 for(const [action,view]of [['openNativeSend','send'],['openNativeBridge','redeem'],['openNativeConvert','convert']]){
  const f=fixture();
  // Chrome supplies tab/frameId for tab documents, but omits both for action popups.
  const opened=await f.openNative({frameId:undefined},action);
  assert.equal(opened.opened,true);
  assert.equal((await f.internal('marketView')).market.view,view);
  assert.equal(opened.account.solana,view==='convert'?f.account.sol:null);
  assert.ok(!JSON.stringify(f.connection()).includes('FIXTURE'));
  f.switch();await assert.rejects(f.internal('marketView'),/changed/);
 }
});
test('missing popup frame metadata does not admit foreign pages, ambiguous tab frames or watch-only conversions',async()=>{
 for(const action of ['openNativeSend','openNativeBridge','openNativeConvert']){
  for(const sender of [
   {frameId:undefined,tab:{id:1}},{frameId:-1},{frameId:null},{frameId:1},
   {frameId:undefined,id:'foreign'},{frameId:undefined,url:MARKET_ORIGIN},
   {frameId:undefined,url:'chrome-extension://test-extension/approval.html'},
  ])await assert.rejects(fixture().openNative(sender,action),/Open native sends/);
  await assert.rejects(fixture().external(action));
 }
 const locked=fixture();locked.lock();await assert.rejects(locked.openNative({frameId:undefined}),/Unlock/);
 const watch=fixture();watch.account.watch=true;await assert.rejects(watch.openNative({frameId:undefined},'openNativeConvert'),/Monero wallet/);
 const moneroOnly=fixture();delete moneroOnly.account.solSecret;
 await assert.rejects(moneroOnly.openNative({frameId:undefined},'openNativeConvert'),/one-time conversion/);
});
test('websites, child frames and other packaged pages cannot open the private send host',async()=>{
 for(const change of [{id:'foreign'},{frameId:1},{url:MARKET_ORIGIN},{url:'chrome-extension://test-extension/approval.html'}])await assert.rejects(fixture().openNative(change));
 const f=fixture();f.account.watch=true;await assert.rejects(f.openNative(),/Monero wallet/);
});
test('optional bridge-out opens only from the wallet and still needs no connected Solana account',async()=>{
 const f=fixture();delete f.account.sol;delete f.account.solSecret;
 assert.equal((await f.openNative({},'openNativeBridge')).opened,true);
 assert.equal((await f.internal('marketView')).market.view,'redeem');
 assert.equal((await f.internal('marketView')).account.solana,null);
 await assert.rejects(f.external('openNativeBridge'));
 for(const sender of [{id:'foreign'},{frameId:1},{url:MARKET_ORIGIN}])
  await assert.rejects(fixture().openNative(sender,'openNativeBridge'));
});
test('a Monero-only account connects and opens its private market without Solana keys or address sharing',async()=>{
 for(const linked of [false,true]){
  const f=fixture();if(!linked){delete f.account.sol;delete f.account.solSecret;}
  const connected=await f.connect('connectMonero');
  assert.equal(connected.account.solana,null);assert.equal(connected.account.canSign,false);assert.equal(connected.account.canSignMonero,true);
  assert.equal((await f.external('status')).account.monero,f.account.xmr);
  assert.equal((await f.external('openMarket',{market:{view:'list'}})).opened,true);
  assert.equal((await f.internal('marketView')).account.solana,null);
  assert.equal((await f.internal('marketKeys')).seed,'PUBLIC TEST FIXTURE');
  for(const action of ['signIn','openBridge','signTransaction'])await assert.rejects(f.external(action));
  assert.ok(!JSON.stringify(f.connection()).includes('FIXTURE'));
  assert.ok(Object.values(f.connection().grants).every(g=>g.account.solana===null));
  assert.ok(Object.values(f.connection().markets).every(g=>g.account.solana===null));
 }
});
test('Monero market connection rejects watch-only accounts and other origins',async()=>{
 const f=fixture();f.account.watch=true;await assert.rejects(f.connect('connectMonero'),/Monero/);
 const g=fixture();await assert.rejects(g.external('connectMonero',{}, {...g.sender,url:'https://xmr20.org/',origin:'https://xmr20.org'}),/configured market/);
});
test('market requests only carry exact public listing intent',()=>{
 assert.deepEqual(marketLaunch({view:'list',quantity:'1000000',total:'1000'}),{view:'list',quantity:'1000000',total:'1000'});
 assert.deepEqual(marketLaunch({view:'buy',listingId:'ab'.repeat(32)}),{view:'buy',listingId:'ab'.repeat(32)});
 for(const value of [{view:'list',seed:'x'},{view:'list',quantity:'1',total:'0'},{view:'list',quantity:'18446744073709551616',total:'1'},{view:'buy',listingId:'x'},{view:'list',endpoint:'https://evil.example'}])assert.throws(()=>marketLaunch(value));
});
test('market handoff requires connection and returns only public account; internal keys remain bound to the packaged page',async()=>{
 const f=fixture();await assert.rejects(f.external('openMarket',{market:{view:'list'}}));await f.connect();
 const r=await f.external('openMarket',{market:{view:'list'}});assert.equal(r.opened,true);assert.ok(!JSON.stringify(r).includes('FIXTURE'));
 const view=await f.internal('marketView');assert.equal(view.account.id,'a');assert.ok(!JSON.stringify(view).includes('FIXTURE'));
 assert.equal((await f.internal('marketKeys')).seed,'PUBLIC TEST FIXTURE');
 assert.ok(!JSON.stringify(f.connection()).includes('FIXTURE'));
 for(const action of ['marketKeys','signIn','signTransaction','openBridge','signConstructedSale'])await assert.rejects(f.external(action));
 await assert.rejects(f.internal('marketKeys',{frameId:1}));await assert.rejects(f.internal('marketKeys',{tab:{id:999}}));await assert.rejects(f.internal('marketKeys',{url:'chrome-extension://test-extension/popup.html'}));
 await assert.rejects(f.external('openMarket',{market:{view:'list'}}),/existing/);
});
test('lock, account change, disconnect and navigation revoke a market host',async()=>{
 for(const mode of ['lock','switch','disconnect','navigate','same-origin-navigation']){
  const f=fixture();await f.connect();await f.external('openMarket',{market:{view:'list'}});
  if(mode==='disconnect')await f.external('disconnect');else if(mode==='same-origin-navigation')await f.broker.revokeTab(1);else f[mode]();
  // Revocation removes the grant entirely or makes the exact old request reject.
  if(Object.keys(f.connection().markets||{}).length)await assert.rejects(f.internal('marketKeys'));
  else assert.equal(Object.keys(f.connection().markets||{}).length,0);
 }
});
test('different documents and lookalike origins cannot open market windows',async()=>{
 const f=fixture();await f.connect();
 for(const sender of [{...f.sender,documentId:'other'},{...f.sender,origin:'http://localhost:18941',url:'http://localhost:18941/market/'},{...f.sender,frameId:1}])await assert.rejects(f.external('openMarket',{market:{view:'list'}},sender));
});
test('initial packaged window loading retains its host; closing it or navigating the website revokes it',async()=>{
 const f=fixture();await f.connect();await f.external('openMarket',{market:{view:'list'}});
 const host=Object.values(f.connection().markets)[0];
 await f.broker.revokeTab(host.approvalTabId,{navigation:true});
 assert.equal((await f.internal('marketView')).account.id,'a');
 await f.broker.revokeTab(host.approvalTabId);
 assert.equal(Object.keys(f.connection().markets).length,0);
 await f.external('openMarket',{market:{view:'list'}});
 await f.broker.revokeTab(f.sender.tab.id,{navigation:true});
 assert.equal(Object.keys(f.connection().markets).length,0);
 await assert.rejects(f.external('openMarket',{market:{view:'list'}}));
});
test('fixed market transport rejects arbitrary hosts and non-market APIs',async()=>{
 const calls=[],fetcher=createMarketFetch({fetchImpl:async(...a)=>{calls.push(a);return 'ok';}});
 assert.equal(await fetcher('/api/native-market/status'),'ok');assert.equal(calls[0][0],MARKET_ORIGIN+'/api/native-market/status');assert.equal(calls[0][1].credentials,'omit');assert.equal(calls[0][1].redirect,'error');
 for(const path of ['https://evil.example/api/native-market/status','/api/wallet','/api/native-market/../../wallet','/api/native-market/status#x','http://user:pass@127.0.0.1:18941/api/native-market/status'])assert.throws(()=>fetcher(path));
});
test('private host does not load a seed on connection and terminates on storage revocation',async()=>{
 const listeners=new Set(),actions=[];let disposed=0,options;
 const account={id:'a',name:'Fixture',monero:'4'+'1'.repeat(94),solana:'11111111111111111111111111111111'};
 const runtime={getURL:p=>p,sendMessage:async m=>{actions.push(m.action);return {value:m.action==='marketKeys'?{seed:'PUBLIC FIXTURE',address:account.monero}:{account,sessionId:'s',market:{view:'list'}}};}};
 const host=createExtensionMarketHost({requestId:'00000000-0000-0000-0000-000000000000',runtime,storage:{onChanged:{addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f)}},clientFactory:o=>{options=o;return {dispose(){disposed++;}};}});
 await host.open();assert.equal(options.provider.publicKey,undefined);assert.equal(options.provider.getMoneroAddress(),account.monero);assert.equal(options.context.owner,'monero:mainnet:'+account.monero);assert.equal(actions.includes('marketKeys'),false);assert.equal(await options.vault.load(),'PUBLIC FIXTURE');
 for(const listener of listeners)listener({'xmr20-unlocked-session':{newValue:{id:'s',activeId:'b'}}},'session');
 assert.equal(host.isClosed(),true);assert.equal(disposed,1);await assert.rejects(options.vault.load());assert.equal(listeners.size,0);
 await host.release();await host.release();assert.equal(actions.filter(a=>a==='marketClose').length,1,'Back releases even an already-closed host, only once');
});
test('inline token sync also saves native XMR progress, without a second ordinary scan',async()=>{
 const account={id:'a',monero:'4'+'1'.repeat(94),solana:null};let passes=0,balances=0,finish;
 const runtime={getURL:p=>p,sendMessage:async()=>({value:{account,sessionId:'s',market:{view:'send'}}})};
 const host=createExtensionMarketHost({requestId:'00000000-0000-0000-0000-000000000000',runtime,
  storage:{onChanged:{addListener(){},removeListener(){}}},
  syncBalance:()=>{balances++;return new Promise(r=>finish=r);},
  clientFactory:()=>({sync:async()=>({ready:++passes>=2,height:passes===3?'104':'100'}),dispose(){}})});
 const {client}=await host.open();assert.equal((await client.sync()).ready,false);assert.equal(balances,1);
 let returned=false;const ready=client.sync().then(v=>{returned=true;return v;});await new Promise(r=>setTimeout(r,0));assert.equal(returned,false);
 finish();const refreshed=await ready;assert.equal(refreshed.ready,true);assert.equal(refreshed.height,'104','Refresh token history after a slow ordinary scan');assert.equal(passes,3);assert.equal(balances,1);await host.release();
});
test('funding detection binds the companion balance to the selected address and refreshes on each explicit round',async()=>{
 for(const sameAddress of [true,false]){
  const account={id:'funding-public',monero:'4'+'1'.repeat(94),solana:null};let scans=0;
  const runtime={getURL:p=>p,sendMessage:async()=>({value:{account,sessionId:'s',market:{view:'convert'}}})};
  const host=createExtensionMarketHost({requestId:'00000000-0000-0000-0000-000000000000',runtime,
   storage:{onChanged:{addListener(){},removeListener(){}}},
   syncBalance:async()=>({address:sameAddress?account.monero:'another-public-wallet',balanceRaw:String(++scans),unlockedRaw:'0',height:100}),
   clientFactory:()=>({sync:async()=>({ready:true,height:'90'}),feeFundingStatus:async()=>({address:account.monero,ready:false}),dispose(){}})});
  const {client}=await host.open();await client.sync();const first=await client.feeFundingStatus();
  assert.equal(Boolean(first.nativeBalance),sameAddress);if(sameAddress)assert.equal(first.nativeBalance.balanceRaw,'1');
  await client.sync();const second=await client.feeFundingStatus();assert.equal(scans,2);
  if(sameAddress)assert.equal(second.nativeBalance.balanceRaw,'2');else assert.equal(second.nativeBalance,undefined);
  await host.release();
 }
});
