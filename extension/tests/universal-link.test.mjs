import test from 'node:test';import assert from 'node:assert/strict';import {Keypair} from '@solana/web3.js';
import {createUniversalLinkUI} from '../../engine/shared/universal-link-ui.js';
const native='45cQVke2TNqcDi7dkQY3dRiMgVSF89V4reM1BsBeSXDrdmBdXpbrCCqTQ39zUcvyZgVYk7kGQFjNmRfnmvaACHYz3ZMwG5q';
function fixture(t,{linked=false,pending=false,lookup=async()=>{},activationPending=false,foreign=false,swallow=false,progress=async()=>({phase:'monero-pending',publication:{txid:'ab'.repeat(32),confirmations:3}})}={}){
 const old=new Map(['document','navigator'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));Object.defineProperty(globalThis,'document',{configurable:true,value:{hidden:false}});Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(k,o,f)=>f({})}}});
 const key=Keypair.generate(),account={id:'fixture',sol:key.publicKey.toBase58(),xmr:native},els=new Map(),timers=new Map();let html='',working=false,review=0,approve=0,activations=0,checks=0,back=0,lookups=0,counter=0;
 let identity={proofs:{},operations:pending?{saved:{phase:'finalized',signature:'1'.repeat(88),config:{owner:account.sol}}}:{}},activation={operations:activationPending?{asset:{phase:'submission-unknown',signature:'2'.repeat(88),config:{mint:'fixture-mint'},moneroOwner:native}}:{}};
 const d={account:()=>account,modal:{open:true},same(){},esc:s=>String(s??''),getElement:id=>els.get(id),provider:()=>({publicKey:key.publicKey}),isBusy:()=>working,show(title,body){html=body;els.clear();for(const m of body.matchAll(/\bid="([^"]+)"([^>]*)>/g))els.set(m[1],{disabled:m[2].includes('disabled')});},on:(id,fn)=>{if(els.has(id))els.get(id).onclick=fn;},run:async fn=>{working=true;try{return await fn(1);}catch(e){if(!swallow)throw e;}finally{working=false;}}};
 const adapters={identityReceiptStore:()=>({key:'fixture-key',load:()=>null,save(){}}),activationReceiptStore:()=>({key:'activation-fixture-key',load:()=>null,save(){}}),createIdentitySolanaAdapter:()=>({}),createIdentityHttpClient:()=>({progress}),createIdentityWalletClient:()=>({lookup:async()=>{lookups++;await lookup();return linked?{solanaOwner:foreign?Keypair.generate().publicKey.toBase58():account.sol}:null;},receipt:()=>identity,review:async()=>{review++;return {};},approve:async()=>{approve++;identity.operations.saved={phase:'finalized',signature:'1'.repeat(88),config:{owner:account.sol}};},check:async()=>{checks++;},retry:async()=>{}}),createActivationWalletClient:()=>({receipt:()=>activation,review:async()=>{activations++;return {proposal:{rentLamports:3000000}};},approve:async()=>{activation.operations.asset={phase:'submission-unknown',signature:'2'.repeat(88),config:{mint:'fixture-mint'},moneroOwner:native};},check:async()=>{activation.operations.asset.phase='finalized';return {confirmed:true};}})};
 const ui=createUniversalLinkUI(d,{endpoint:'http://localhost:1234',rpcEndpoint:'http://localhost:1234',onBack:()=>back++,adapters,setTimer:fn=>{timers.set(++counter,fn);return counter;},clearTimer:id=>timers.delete(id)});t.after(()=>{ui.clear();for(const [k,v]of old)if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];});
 return {ui,d,account,els,timers,get html(){return html;},get counts(){return {review,approve,activations,checks,back,lookups};},async click(id){const el=els.get(id);assert.ok(el&&!el.disabled,id);el.onclick();for(let i=0;i<30;i++){await new Promise(r=>setImmediate(r));if(!working)return;}throw Error('action did not settle');}};
}
test('universal setup opens without signing; one explicit link action approves both proofs',async t=>{const f=fixture(t);await f.ui.open();assert.equal(f.counts.review,0);assert.equal(f.counts.approve,0);assert.match(f.html,/public and permanent/);await f.click('identity-review');assert.equal(f.counts.review,1);assert.equal(f.counts.approve,1);assert.match(f.html,/3\/10/);assert.match(f.html,/https:\/\/xmrchain.net\/tx\/abab/);assert.ok(!f.els.has('identity-approve'));});
test('already linked recipient sees the unsigned account cost and approves setup once',async t=>{const f=fixture(t,{linked:true});await f.ui.open({mint:'fixture-mint',symbol:'TOKEN'});assert.equal(f.counts.review,0);assert.equal(f.counts.activations,1);assert.match(f.html,/0.003000 SOL/);assert.match(f.html,/no tokens move/);await f.click('identity-activate-approve');assert.match(f.html,/Token ready/);assert.equal(f.counts.approve,0);for(const fn of f.timers.values())fn();assert.equal(f.counts.back,1);});
test('opening pending identity shows actual count and never creates another review',async t=>{const f=fixture(t,{pending:true});await f.ui.open();assert.match(f.html,/3\/10/);assert.equal(f.counts.review,0);assert.ok(f.timers.size);assert.ok(!f.els.has('identity-review'));f.ui.clear();assert.equal(f.timers.size,0);});
test('finalized Solana approval does not invent Monero confirmations before publication',async t=>{
 let finish;const waiting=new Promise(r=>finish=r),f=fixture(t,{pending:true,progress:()=>waiting});
 const opening=f.ui.open();await new Promise(r=>setImmediate(r));
 assert.match(f.html,/Checking your saved wallet link/);assert.equal((f.html.match(/data-loading="true"/g)||[]).length,1);
 finish({phase:'finalized',publication:null});await opening;
 assert.match(f.html,/Preparing Monero publication/);assert.match(f.html,/Monero confirmations<\/span><strong>Awaiting publication/);
 assert.match(f.html,/Your Solana approval is confirmed/);assert.doesNotMatch(f.html,/0\/10|xmrchain.net/);
 assert.equal(f.counts.approve,0);assert.equal(f.counts.review,0);
});
test('saved link progresses from pool through confirmations without another approval',async t=>{
 let count=0,hold;const f=fixture(t,{pending:true,progress:async()=>{await hold;return {phase:'monero-pending',publication:{txid:'ab'.repeat(32),confirmations:count}};}});
 await f.ui.open();assert.match(f.html,/Waiting for Monero confirmations/);assert.match(f.html,/0\/10/);
 for(const value of [1,9,10]){count=value;await f.click('identity-check-saved');assert.match(f.html,new RegExp(value+'/10'));}
 assert.match(f.html,/Monero confirmations complete/);assert.ok(!f.els.has('identity-review'));assert.equal(f.els.get('identity-back').disabled,false);
 assert.equal(f.counts.approve,0);assert.equal(f.counts.review,0);assert.equal(f.counts.lookups,0);
 let finish;hold=new Promise(r=>finish=r);f.els.get('identity-check-saved').onclick();await new Promise(r=>setImmediate(r));
 assert.equal((f.html.match(/data-loading="true"/g)||[]).length,1);assert.match(f.html,/10\/10/);
 finish();for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
});
test('published transaction with unknown confirmation count stays checking rather than claiming zero',async t=>{
 const f=fixture(t,{pending:true,progress:async()=>({phase:'monero-pending',publication:{txid:'ab'.repeat(32),confirmations:null}})});await f.ui.open();
 assert.match(f.html,/Waiting for Monero confirmations/);assert.match(f.html,/Monero confirmations<\/span><strong>Checking/);
 assert.match(f.html,/https:\/\/xmrchain.net\/tx\/abab/);assert.doesNotMatch(f.html,/0\/10/);assert.equal(f.counts.approve,0);
});
test('opening a saved activation reconciles its exact receipt without asking again',async t=>{const f=fixture(t,{linked:true,activationPending:true});await f.ui.open({mint:'fixture-mint'});assert.match(f.html,/Token ready/);assert.equal(f.counts.activations,0);assert.equal(f.counts.approve,0);});
test('unavailable identity lookup cannot claim linked or enable setup',async t=>{const f=fixture(t,{lookup:async()=>{throw Error('Independent history unavailable');}});await f.ui.open();assert.match(f.html,/Independent history unavailable/);assert.equal(f.els.get('identity-review').disabled,true);assert.equal(f.counts.review,0);});
test('closing during lookup prevents late rendering and polling',async t=>{let finish;const gate=new Promise(r=>finish=r),f=fixture(t,{lookup:()=>gate});const opening=f.ui.open();await new Promise(r=>setImmediate(r));const html=f.html;f.ui.clear();finish();await opening;assert.equal(f.html,html);assert.equal(f.timers.size,0);});

test('a global identity owned by another Solana wallet cannot be shown as this wallet pair linked',async t=>{const f=fixture(t,{linked:true,foreign:true});await f.ui.open();assert.match(f.html,/linked to another Solana wallet/);assert.ok(!f.els.has('identity-activate'));assert.equal(f.els.get('identity-review').disabled,true);});
test('host run wrapper swallowing exceptions still shows errors inside the linking modal',async t=>{let fail=false;const f=fixture(t,{swallow:true,lookup:async()=>{if(fail)throw Error('Fresh checkpoint unavailable');}});await f.ui.open();fail=true;await f.click('identity-check-saved');assert.match(f.html,/Fresh checkpoint unavailable/);assert.equal(f.counts.approve,0);});

test('saved-link routing is wallet-pair and registry scoped and includes Solana-finalized links',async()=>{
 const {hasSavedUniversalLink}=await import('../../engine/shared/universal-link-ui.js');
 const {identityReceiptStore}=await import('../../engine/shared/bridge-sdk/core-universal-link/browser-receipts.mjs');
 const {identityRegistry}=await import('../../engine/shared/bridge-sdk/core-universal-link/mainnet-config.mjs');
 const disk=new Map(),storage={getItem:k=>disk.get(k)??null,setItem:(k,v)=>disk.set(k,v)};
 const a={sol:Keypair.generate().publicKey.toBase58(),xmr:native},store=identityReceiptStore({registry:identityRegistry,owner:a.sol,moneroOwner:a.xmr,storage});
 const receipt={schema:'wallet-identity-owner-v1',scope:store.key.split(':')[1],proofs:{},operations:{saved:{config:{owner:a.sol},phase:'finalized'}}};store.save(receipt);
 assert.equal(hasSavedUniversalLink(a,{storage}),true);
 assert.equal(hasSavedUniversalLink({...a,sol:Keypair.generate().publicKey.toBase58()},{storage}),false);
 assert.equal(hasSavedUniversalLink({...a,xmr:'another-public-address'},{storage}),false);
 receipt.operations.saved.phase='approval-expired';store.save(receipt);assert.equal(hasSavedUniversalLink(a,{storage}),false);
 disk.set(store.key,'malformed');assert.throws(()=>hasSavedUniversalLink(a,{storage}));
});

test('opening recovery respects the same activation lock as automatic send setup',async t=>{
 const f=fixture(t,{linked:true,activationPending:true}),keys=[];
 navigator.locks.request=async(key,options,fn)=>{keys.push(key);return fn(null);};
 await f.ui.open({mint:'fixture-mint'});assert.deepEqual(keys,['activation-fixture-key']);assert.match(f.html,/Another window is preparing/);assert.doesNotMatch(f.html,/Token ready/);assert.equal(f.counts.activations,0);assert.equal(f.counts.approve,0);
});
