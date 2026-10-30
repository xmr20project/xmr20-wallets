import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PublicKey} from '@solana/web3.js';
import {createJointHoldings,replaceHoldingSource} from '../../engine/shared/joint-holdings.js';
import {PRIVATE_TEST_POLICY as policy} from '../../engine/shared/bridge-sdk/core-transferable/private-test.mjs';
import {transferableManifest} from '../../engine/shared/bridge-sdk/core-transferable/mainnet-config.mjs';
import {addresses} from '../../engine/shared/bridge-sdk/core-transferable/sdk.mjs';
import {digest,commitment} from '../../engine/shared/bridge-sdk/core-transferable/records.mjs';
import {createHoldingsRefresh} from '../../web-wallet/src/holdings-refresh.js';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 let time=1700000000000,snapshots=0,custodyReads=0;
 const account={sol:policy.owner,xmr:policy.moneroOwner},manifest=transferableManifest(policy.mint),config={...manifest,owner:account.sol,binding:digest(account.xmr)},position=addresses(config).position.toBase58();
 const link={record:{p:'xmr20-joint',v:3,net:'mainnet',op:'link',program:manifest.program,mint:manifest.mint,owner:account.xmr,to:account.sol,nonce:'a1'.repeat(32)},signature:'SigV2'+'1'.repeat(90)};
 const report={schema:'joint-index-v3',complete:true,manifest,privateTestPolicy:policy,positions:[{config,position,moneroOwner:account.xmr,solanaOwner:account.sol,linkTxid:'ab'.repeat(32),balance:'985000',chainBalance:'985000',available:'985000'}],accepted:[{txid:'ab'.repeat(32),envelope:link},{txid:'cd'.repeat(32),envelope:{record:{op:'credit',program:manifest.program,mint:manifest.mint,owner:account.xmr,amount:'985000'}}}]};
 const data=Buffer.alloc(169);data[0]=3;new PublicKey(account.sol).toBuffer().copy(data,1);new PublicKey(manifest.verifier).toBuffer().copy(data,33);new PublicKey(manifest.mint).toBuffer().copy(data,65);Buffer.from(config.binding,'hex').copy(data,97);Buffer.from(commitment(link),'hex').copy(data,129);data.writeBigUInt64LE(985000n,161);
 const storage=new Map(),reader=createJointHoldings({privateTest:true,now:()=>time,storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},adapters:{runtime:()=>({snapshot:async()=>{snapshots++;return structuredClone(report);}}),chain:()=>({verifyProgram:async()=>{},readAccount:async()=>{custodyReads++;return {finalized:true,owner:manifest.program,executable:false,data:Buffer.from(data)};}})}});
 return {account,reader,advance:ms=>time+=ms,get snapshots(){return snapshots;},get custodyReads(){return custodyReads;}};
}

test('actual extension refresh timer uses custody reuse while both Refresh controls still force history',async()=>{
 const f=fixture(),source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8'),timers=[],handlers=new Map(),noop=()=>{};
 // Execute the actual app refresh function and its actual callback registration
 // with public read adapters; no vault/session/browser/financial code is loaded.
 const begin=source.indexOf('async function refresh('),end=source.indexOf('\nfunction inscriptionCard',begin);
 assert.ok(begin>0&&end>begin);
 const bridgeLine=source.split('\n').find(line=>line.startsWith('const bridgeUI=createBridgeUI('));
 const timerLine=source.split('\n').find(line=>line.startsWith('setInterval(')&&line.endsWith(',15000);'));
 const focusLine=source.split('\n').find(line=>line.startsWith('function wakeRefresh('));
 const button=source.match(/on\('refresh',.*?\);/)[0];
 const context=vm.createContext({account:()=>f.account,nativeTokenSends:false,epoch:1,vault:{},busy:false,screen:'home',document:{hidden:false},modal:{open:false},checkIdle:()=>false,cache:{displayScope:f.account.sol+':'+f.account.xmr,rows:[],indexComplete:{},jointPending:[]},jointHoldings:f.reader,replaceHoldingSource,
  refreshPrices:async()=>{},paintBalances:noop,balanceReads:{size:0,run:(_key,read)=>read(new AbortController().signal)},loadPending:async()=>({available:true,complete:true,rows:[]}),readSolBalance:async()=>'0',saveSolBalance:noop,loadSolanaHoldings:async()=>({complete:true,rows:[]}),loadWalletHoldings:async()=>({complete:true,rows:[]}),solanaDisplayRows:(_old,result)=>result.rows,cacheWalletHoldings:noop,
  setInterval:(callback,ms)=>timers.push({callback,ms}),on:(id,fn)=>handlers.set(id,fn),createBridgeUI:options=>({...options,refreshAssets:noop}),tokenImage:noop,same:noop,show:noop,run:noop,record:noop,persist:noop,oneShot:noop,esc:noop,render:noop});
 vm.runInContext(bridgeLine+'\n'+source.slice(begin,end)+'\n'+timerLine+'\n'+focusLine+'\n'+button,context);
 await vm.runInContext('refresh()',context);assert.equal(f.snapshots,1);assert.equal(f.custodyReads,2);
 f.advance(15000);timers[0].callback();await flush();assert.equal(f.snapshots,1,'periodic price refresh must not force a history replay');assert.equal(f.custodyReads,3);
 f.advance(15000);vm.runInContext('wakeRefresh()',context);await flush();assert.equal(f.snapshots,1,'focus refresh keeps the report window');assert.equal(f.custodyReads,4);
 f.advance(5000);handlers.get('refresh')();await flush();assert.equal(f.snapshots,2,'explicit home Refresh forces history');
 f.advance(5000);await vm.runInContext('bridgeUI.refreshHoldings()',context);assert.equal(f.snapshots,3,'explicit Bridge Refresh forces history');
 f.advance(15000);timers[0].callback();await flush();assert.equal(f.snapshots,3);
 f.advance(61000);timers[0].callback();await flush();assert.equal(f.snapshots,4,'expired display report gets fresh history automatically');
 f.reader.clear();
});

test('actual website refresh scheduler reuses custody reports on polls but forces explicit refresh and mutation events',async()=>{
 const f=fixture(),windowTarget=new EventTarget(),documentTarget=new EventTarget(),timers=new Map();documentTarget.hidden=false;let id=0;
 const refresh=createHoldingsRefresh({interval:15000,windowTarget,documentTarget,setTimer:fn=>{timers.set(++id,fn);return id;},clearTimer:key=>timers.delete(key),read:options=>f.reader.load(f.account,[],options),clear:()=>f.reader.clear(),onReading:()=>{},onResult:()=>{},onError:()=>assert.fail('Synthetic public reads should succeed')});
 const tick=async ms=>{f.advance(ms);const [key,fn]=[...timers][0];timers.delete(key);fn();await flush();};
 await flush();assert.equal(f.snapshots,1);
 await tick(15000);assert.equal(f.snapshots,1);assert.equal(f.custodyReads,3);
 f.advance(15000);windowTarget.dispatchEvent(new Event('focus'));await flush();assert.equal(f.snapshots,1);assert.equal(f.custodyReads,4);
 f.advance(5000);await refresh.refresh();assert.equal(f.snapshots,2,'the button remains an explicit fresh-history refresh');
 f.advance(5000);windowTarget.dispatchEvent(new Event('xmr20-holdings-refresh'));await flush();assert.equal(f.snapshots,3,'mutation events invalidate display reuse');
 await tick(15000);assert.equal(f.snapshots,3);
 await tick(61000);assert.equal(f.snapshots,4);
 refresh.dispose();assert.equal(timers.size,0);
});
