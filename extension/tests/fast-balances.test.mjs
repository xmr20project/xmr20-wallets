import test from 'node:test';import assert from 'node:assert/strict';
import {cachedPortfolio,savePortfolio,portfolioDisplay} from '../src/portfolio-cache.js';
import {readBridgeDisplay,saveBridgeDisplay} from '../../engine/shared/bridge-display.js';
const disk=()=>{const m=new Map();return {getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v)};};
test('portfolio restores synchronously, is account scoped, expires, and gives way to a complete current total',()=>{
 const storage=disk(),now=1800000000000,a={sol:'sol-a',xmr:'xmr-a'};savePortfolio(a,{value:125},3,'2000',{storage,now});
 const cached=cachedPortfolio(a,{storage,now});assert.equal(cached.value,125);
 assert.deepEqual(portfolioDisplay({value:1.82,partial:true},cached,1),{value:125,partial:true,lastKnown:true});
 assert.deepEqual(portfolioDisplay({value:100,partial:false},cached,3),{value:100,partial:false});
 assert.equal(cachedPortfolio({...a,sol:'sol-b'},{storage,now}),null);
 assert.equal(cachedPortfolio(a,{storage,now:now+86400001}),null);
});
test('cached bridge reports cannot cross a token, wallet pair, deployment policy or expiration',()=>{
 const storage=disk(),now=1800000000000,a={sol:'sol',xmr:'xmr'},manifest={program:'program',mint:'mint'},policy={schema:'testing'};
 const report={schema:'joint-index-v3',complete:true,manifest,privateTestPolicy:policy,positions:[{available:'985000'}]};
 saveBridgeDisplay(a,manifest,report,{storage,now});assert.deepEqual(readBridgeDisplay(a,manifest,policy,{storage,now}),report);
 for(const args of [[{...a,xmr:'other'},manifest,policy],[a,{...manifest,mint:'other'},policy],[a,manifest,null]])assert.equal(readBridgeDisplay(...args,{storage,now}),null);
 assert.equal(readBridgeDisplay(a,manifest,policy,{storage,now:now+86400001}),null);
 assert.equal(report.ready,undefined); // A display snapshot never grants readiness.
});
