import test from 'node:test';import assert from 'node:assert/strict';import {createSiteBroker} from '../src/site-broker.js';
function fixture({jointBridge=false}={}){
 const data={},windows=new Map();let now=Date.now(),number=0,session={id:'unlock-1',activeId:'account-a'},signs=0;
 const account={id:'account-a',name:'Account',sol:'11111111111111111111111111111111',solSecret:'SECRET',xmr:'public-monero',xmrSeed:'DISPOSABLE TEST ONLY'};
 const accounts=[account];
 const chrome={storage:{session:{get:async k=>({[k]:structuredClone(data[k])}),set:async v=>Object.assign(data,structuredClone(v))}},runtime:{id:'extension',getURL:file=>'chrome-extension://extension/'+file,getManifest:()=>({version:'0.1.9'})},windows:{get:async id=>{if(!windows.has(id))throw Error();return windows.get(id);},create:async()=>{const w={id:++number,tabs:[{id:number+100}]};windows.set(w.id,w);return w;}},tabs:{get:async()=>({url:'https://xmr20.org/'})}};
 const broker=createSiteBroker({chrome,jointBridge,readSession:async()=>session,unlock:async password=>{if(password!=='correct')throw Error('Incorrect password');session={id:'unlock-2'};},readVault:async()=>({accounts}),sign:async()=>{signs++;return 'signature';},now:()=>now,uuid:()=>String(++number)});
 const sender={url:'https://xmr20.org/',origin:'https://xmr20.org',frameId:0,tab:{id:1},documentId:'d1'};
 const external=(action,props={},source=sender)=>broker.external({channel:'xmr20-site',action,...props},source);
 const internal=(requestId,action,props={},tabId)=>broker.internal({requestId,action,...props},{id:'extension',url:chrome.runtime.getURL(['openBridge','openXmr721','openMordinals'].includes(data['xmr20-site-connection'].requests[requestId]?.action)?'popup.html':'approval.html')+'?request='+requestId,tab:{id:tabId??data['xmr20-site-connection'].requests[requestId].approvalTabId}});
 const message=()=>`Sign in to XMR20\nWebsite: https://xmr20.org\nWallet: ${account.sol}\nNonce: 00000000-0000-0000-0000-000000000000\nIssued: ${new Date(now).toISOString()}\nExpires: ${new Date(now+300000).toISOString()}\nThis signature proves wallet ownership. It does not authorize a transaction.`;
 return {external,internal,broker,sender,account,accounts,select:id=>session.activeId=id,message,windows,lock:()=>session=null,advance:ms=>now+=ms,signs:()=>signs};
}
test('connect discloses nothing before approval and binds approval/results to tab and document',async()=>{const f=fixture(),r=await f.external('connect');assert.equal(await f.external('status'),null);assert.deepEqual(await f.external('result',r),{done:false});await assert.rejects(f.internal(r.requestId,'approve',{accountId:'account-a'},999));await f.internal(r.requestId,'approve',{accountId:'account-a'});await assert.rejects(f.external('result',r,{url:'https://xmr20.org/',origin:'https://xmr20.org',frameId:0,tab:{id:2},documentId:'d1'}));const result=await f.external('result',r);assert.equal(result.value.account.solana,f.account.sol);assert.ok(!JSON.stringify(result).includes('SECRET'));await assert.rejects(f.external('result',r));});
test('reject, close, timeout and lock all prevent website approval',async()=>{for(const mode of ['reject','close','expire','lock']){const f=fixture(),r=await f.external('connect');if(mode==='reject')await f.internal(r.requestId,'reject');if(mode==='close')f.windows.clear();if(mode==='expire')f.advance(300001);if(mode==='lock'){await f.internal(r.requestId,'approve',{accountId:'account-a'});f.lock();}await assert.rejects(f.external('result',r));assert.equal(f.signs(),0);}});
test('sign-in needs a grant plus a second approval and is revoked by disconnect or lock',async()=>{const f=fixture();await assert.rejects(f.external('signIn',{message:f.message()}));const c=await f.external('connect');await f.internal(c.requestId,'approve',{accountId:'account-a'});await f.external('result',c);const r=await f.external('signIn',{message:f.message()});assert.equal(f.signs(),0);await f.internal(r.requestId,'approve',{accountId:'account-a'});assert.equal(f.signs(),1);assert.equal((await f.external('result',r)).value.signature,'signature');await f.external('disconnect');assert.equal(await f.external('status'),null);await assert.rejects(f.external('signIn',{message:f.message()}));});
test('unsupported signing cannot open an approval and connections never touch idle time',async()=>{const f=fixture();await assert.rejects(f.external('signTransaction',{transaction:'anything'}));assert.equal(f.windows.size,0);assert.equal(f.signs(),0);const r=await f.external('connect');await assert.rejects(f.external('connect'));f.windows.clear();const next=await f.external('connect');assert.notEqual(r.requestId,next.requestId);});
test('local market cannot sign or open bridge operations, even with bridge support enabled',async()=>{
 const f=fixture({jointBridge:true}),origin='http://127.0.0.1:8897',source={url:origin+'/market/',origin,frameId:0,tab:{id:1},documentId:'market'};
 assert.equal((await f.external('ping',{},source)).name,'XMR20 Wallet');
 assert.equal(await f.external('status',{},source),null);
 for(const action of ['signIn','signTransaction','openBridge','publish','approve'])await assert.rejects(f.external(action,{},source),/only connect/);
 assert.equal(f.windows.size,0);assert.equal(f.signs(),0);
 assert.ok((await f.external('connect',{},source)).requestId);
});
test('locking during a pending sign-in prevents its approval even after unlocking again',async()=>{const f=fixture(),c=await f.external('connect');await f.internal(c.requestId,'approve',{accountId:'account-a'});await f.external('result',c);const r=await f.external('signIn',{message:f.message()});f.lock();await f.internal(r.requestId,'unlock',{password:'correct'});await assert.rejects(f.internal(r.requestId,'approve',{accountId:'account-a'}));assert.equal(f.signs(),0);});
test('approval view contains only public accounts and rejecting it creates no grant',async()=>{const f=fixture(),r=await f.external('connect');const view=await f.internal(r.requestId,'view');assert.equal(view.accounts[0].solana,f.account.sol);assert.equal(view.origin,'https://xmr20.org');assert.ok(!JSON.stringify(view).includes('SECRET'));await f.internal(r.requestId,'reject');assert.equal(await f.external('status'),null);});

test('connection defaults to the currently selected account, not the first imported account',async()=>{const f=fixture();f.accounts.push({...f.account,id:'account-b',name:'Second',sol:'22222222222222222222222222222222'});f.select('account-b');const r=await f.external('connect');assert.equal((await f.internal(r.requestId,'view')).accountId,'account-b');assert.equal(await f.external('status'),null);assert.equal(f.signs(),0);});
test('sign-in stays on the approved account when the extension selection changes',async()=>{const f=fixture();f.accounts.push({...f.account,id:'account-b',name:'Second'});const r=await f.external('connect');await f.internal(r.requestId,'approve',{accountId:'account-a'});await f.external('result',r);f.select('account-b');const login=await f.external('signIn',{message:f.message()});assert.equal((await f.internal(login.requestId,'view')).accountId,'account-a');await assert.rejects(f.internal(login.requestId,'approve',{accountId:'account-b'}));assert.equal(f.signs(),0);});
test('an ineligible active account requires explicit selection instead of silently using another wallet',async()=>{const f=fixture();f.accounts.push({...f.account,id:'watch',watch:true,solSecret:undefined});f.select('watch');const r=await f.external('connect'),view=await f.internal(r.requestId,'view');assert.equal(view.accountId,null);assert.equal(view.accounts.length,1);await assert.rejects(f.internal(r.requestId,'approve',{accountId:''}));assert.equal(await f.external('status'),null);});

const bridge={mint:'2qizXDtpK92YziSqmt6Kry3Zc6CNuZxjbQodqcEsZXMR',amountRaw:'1000000',direction:'sol-to-xmr'};
test('website bridge opens only after a scoped connection and never signs or exports keys',async()=>{const f=fixture({jointBridge:true});await assert.rejects(f.external('openBridge',{bridge}));const r=await f.external('connect');await f.internal(r.requestId,'approve',{accountId:'account-a'});await f.external('result',r);const b=await f.external('openBridge',{bridge});const v=await f.internal(b.requestId,'view');assert.deepEqual(v.bridge,bridge);assert.equal(v.account.id,'account-a');assert.ok(!JSON.stringify(v).includes('SECRET'));await assert.rejects(f.internal(b.requestId,'opened',{accountId:'other'}));await f.internal(b.requestId,'opened',{accountId:'account-a'});const result=await f.external('result',b);assert.equal(result.value.opened,true);assert.equal(f.signs(),0);});
test('unsupported mint/fields, stale grant, lock and another document cannot open the bridge',async()=>{for(const mode of ['mint','fields','lock','document']){const f=fixture({jointBridge:true}),r=await f.external('connect');await f.internal(r.requestId,'approve',{accountId:'account-a'});await f.external('result',r);if(mode==='lock')f.lock();await assert.rejects(f.external('openBridge',{bridge:mode==='mint'?{...bridge,mint:'other'}:mode==='fields'?{...bridge,secret:'forbidden'}:bridge},mode==='document'?{url:'https://xmr20.org/',origin:'https://xmr20.org',frameId:0,tab:{id:1},documentId:'other'}:undefined));assert.equal(f.signs(),0);}});
test('ordinary extension builds cannot launch mainnet bridge requests',async()=>{const f=fixture();await assert.rejects(f.external('openBridge',{bridge}));assert.equal(f.windows.size,0);});

test('vault unlock requires separate approval and rechecks linked address before signing',async()=>{
 const f=fixture();f.account.xmr='4AMg1kDaXkWckE3uyd1YqoBKvn4z8ATxmWQVdtjF6aGU4sT278XoyhUV1Ve88ZMCXNXQJpjW2553NWERfMZcNsBtCkMLiNM';
 const c=await f.external('connect');await f.internal(c.requestId,'approve',{accountId:f.account.id});await f.external('result',c);
 const message=`XMR20: unlock my saved Monero wallet\n\nThis approval unlocks Monero signing keys stored on this device. Only approve on https://xmr20.org. Never share this signature.\n\nWallet: ${f.account.sol}\nMonero address: ${f.account.xmr}\nNetwork: mainnet\nBackup ID: ${btoa('a'.repeat(32))}\nVersion: 1`;
 const r=await f.external('signIn',{message});assert.equal(f.signs(),0);const v=await f.internal(r.requestId,'view');assert.equal(v.signingKind,'vaultUnlock');assert.equal(v.unlock.address,f.account.xmr);
 const original=f.account.xmr;f.account.xmr='changed';await assert.rejects(f.internal(r.requestId,'approve',{accountId:f.account.id}),/Monero account changed/);assert.equal(f.signs(),0);f.account.xmr=original;
 await f.internal(r.requestId,'approve',{accountId:f.account.id});assert.equal(f.signs(),1);assert.equal((await f.external('result',r)).done,true);
});

// 0.1.145: what an older document of a tab left ends when a new document of that tab speaks.
test('a new document of the same tab ends the older document\'s connection and open requests',async()=>{
 const f=fixture(),c=await f.external('connect');await f.internal(c.requestId,'approve',{accountId:'account-a'});await f.external('result',c);
 assert.equal((await f.external('status')).account.id,'account-a');
 const pending=await f.external('connect'),next={...f.sender,documentId:'d2'};
 assert.equal(await f.external('status',{},next),null);await assert.rejects(f.external('result',pending,next),/expired/);
 await assert.rejects(f.external('result',pending),/expired/);assert.equal(await f.external('status'),null);
});
// 0.1.145: the XMR721 views on xmr20.org/market/ change only the part after #; that keeps the connection.
test('a navigation that keeps origin, path and query keeps the connection; a reload, another page or a closed tab ends it',async()=>{
 for(const [url,kept] of [['https://xmr20.org/market/#/nft/7',true],['https://xmr20.org/market/',true],[null,false],['https://xmr20.org/market/?view=1',false],['https://xmr20.org/launch/',false],['close',false]]){
  const f=fixture(),source={...f.sender,url:'https://xmr20.org/market/#/xmr721'},c=await f.external('connect',{},source);
  await f.internal(c.requestId,'approve',{accountId:'account-a'});await f.external('result',c,source);
  await f.broker.revokeTab(1,url==='close'?{}:{navigation:true,url});
  assert.equal(Boolean(await f.external('status',{},source)),kept,String(url));
 }
});
test('xmr20.org may open the Mordinals screens or one XMR721 record approval for its connected, selected account',async()=>{
 const f=fixture(),record='ab'.repeat(40),code='a'.repeat(64);
 const local={url:'http://127.0.0.1:8893/',origin:'http://127.0.0.1:8893',frameId:0,tab:{id:3},documentId:'local'};
 await assert.rejects(f.external('openMordinals',{},local),/Use the extension/);
 await assert.rejects(f.external('openMordinals'),/Sign in with XMR20 Wallet/);await assert.rejects(f.external('openXmr721',{record}),/Sign in with XMR20 Wallet/);assert.equal(f.windows.size,0);
 const c=await f.external('connect');await f.internal(c.requestId,'approve',{accountId:'account-a'});await f.external('result',c);
 for(const bad of [undefined,'','abc','AB'.repeat(4),'zz','ab'.repeat(1001)])await assert.rejects(f.external('openXmr721',{record:bad}),/Malformed XMR721 record/);
 f.accounts.push({...f.account,id:'account-b',name:'Second'});f.select('account-b');await assert.rejects(f.external('openMordinals'),/Select Account in XMR20 Wallet/);f.select('account-a');
 const r=await f.external('openXmr721',{record}),view=await f.internal(r.requestId,'view');
 assert.deepEqual(view,{origin:'https://xmr20.org',xmr721:'openXmr721',account:{id:'account-a',name:'Account',solana:null,monero:'public-monero',canSign:false,canSignMonero:true},record});
 assert.ok(!/SECRET|DISPOSABLE/.test(JSON.stringify(view)));
 assert.deepEqual(await f.external('result',r),{done:false});f.advance(600000);assert.deepEqual(await f.external('result',r),{done:false});
 await assert.rejects(f.internal(r.requestId,'done',{accountId:'account-b',result:{id:code,state:'pending'}}),/Unsupported approval result/);
 await assert.rejects(f.internal(r.requestId,'done',{accountId:'account-a',result:{id:'not-a-code',state:'pending'}}),/Unsupported approval result/);
 await f.internal(r.requestId,'done',{accountId:'account-a',result:{id:code,state:'pending',signature:'not passed on'}});
 assert.deepEqual(await f.external('result',r),{done:true,value:{id:code,state:'pending'}});
 const m=await f.external('openMordinals');assert.equal((await f.internal(m.requestId,'view')).xmr721,'openMordinals');
 await f.internal(m.requestId,'done',{accountId:'account-a'});assert.deepEqual(await f.external('result',m),{done:true,value:{opened:true}});
 assert.equal(f.signs(),0);
});
