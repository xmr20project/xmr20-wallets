import test from 'node:test';import assert from 'node:assert/strict';import {Keypair} from '@solana/web3.js';import bs58 from 'bs58';
import {createJointTransferableUI} from '../../engine/shared/joint-transferable-ui.js';import {jointAccountProvider} from '../../engine/shared/joint-account.js';
import {jointWaiting} from '../../engine/shared/joint-waiting.js';
import {transferableManifest} from '../../engine/shared/bridge-sdk/core-transferable/mainnet-config.mjs';
import {addresses,receiptAddress,approveExternal,transaction,creditCommitment} from '../../engine/shared/bridge-sdk/core-transferable/sdk.mjs';
import {digest} from '../../engine/shared/bridge-sdk/core-transferable/records.mjs';
import {publicReceiptStore} from '../../engine/shared/bridge-sdk/core-transferable/browser-receipts.mjs';
import {createRuntimeHttpClient} from '../../engine/shared/bridge-sdk/core-transferable/runtime-api.mjs';
import {PRIVATE_TEST_POLICY,WALLET_TEST_POLICY} from '../../engine/shared/bridge-sdk/core-transferable/private-test.mjs';
import {XMR20_MINT,XCAT_MINT} from '../../engine/shared/joint-bridge-assets.js';
const native='45cQVke2TNqcDi7dkQY3dRiMgVSF89V4reM1BsBeSXDrdmBdXpbrCCqTQ39zUcvyZgVYk7kGQFjNmRfnmvaACHYz3ZMwG5q';
function setup(t,{ready,registered=false,verify=async()=>{},snapshotComplete=true,movesConfirmed=false,privateTest=false,authorizedAccount=true,configureClient,configureRuntime,holdings=[{network:'solana',mint:XMR20_MINT,amountRaw:'1000000'}],uiOptions={}}={}){
 const old=new Map();for(const k of ['document','localStorage','navigator'])old.set(k,Object.getOwnPropertyDescriptor(globalThis,k));const elements=new Map(),doc={hidden:false,activeElement:null,getElementById:id=>elements.get(id),addEventListener(){},removeEventListener(){}},disk=new Map();Object.defineProperty(globalThis,'document',{configurable:true,value:doc});Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>disk.get(k)??null,setItem:(k,v)=>disk.set(k,v)}});Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(k,o,f)=>f({})}}});
 const a={id:'disposable',name:'Disposable wallet',sol:privateTest&&authorizedAccount?PRIVATE_TEST_POLICY.owner:Keypair.generate().publicKey.toBase58(),solSecret:'fixture-unavailable',xmr:native,xmrSeed:'fixture-unavailable'},manifest=transferableManifest(XMR20_MINT);let html='',busy=false,renders=0,signs=0,approvals=0,legacy=0,previous=0;
 const previewTimers=new Map();let timerId=0;const previewOptions={setTimer:fn=>{previewTimers.set(++timerId,fn);return timerId;},clearTimer:id=>previewTimers.delete(id)};
 const errors=[],position=addresses({...manifest,owner:a.sol,binding:digest(native)}).position.toBase58(),d={account:()=>a,modal:{open:true},same(){},esc:v=>String(v),rows:()=>holdings,settings(){},isBusy:()=>busy,on:(id,f)=>{if(elements.has(id))elements.get(id).onclick=f;},show(title,body){html=body;renders++;elements.clear();for(const m of body.matchAll(/<([a-z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){const el={id:m[3],dataset:{},innerHTML:'',insertAdjacentHTML(_,html){this.innerHTML+=html;},tagName:m[1].toUpperCase(),disabled:/\bdisabled\b/.test(m[2]),selectionStart:0,selectionEnd:0,focus(){doc.activeElement=this;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}};elements.set(el.id,el);}},async run(f){if(busy)return;busy=true;try{await f(1);}catch(e){errors.push(e);if(!configureClient)throw e;}finally{busy=false;}},oneShot(){signs++;throw Error('No signing in UI fixture.');}};
 const adapters={publicReceiptStore,createSolanaAdapter:()=>({verifyProgram:verify,fee:async amount=>(BigInt(amount)*15n/1000n).toString()}),createRuntimeHttpClient:options=>configureRuntime?configureRuntime(options):({readiness:async()=>ready?ready():{schema:'joint-readiness-v3',ready:true,manifest,...(privateTest?{privateTestPolicy:PRIVATE_TEST_POLICY}:{})}}),createWalletClient:options=>Object.assign({snapshot:async()=>({...((ready?await ready():null)??{ready:true,manifest,...(privateTest?{privateTestPolicy:PRIVATE_TEST_POLICY}:{})}),schema:'joint-index-v3',complete:snapshotComplete,pending:movesConfirmed?Object.entries(options.store.load()?.proofs||{}).filter(([,p])=>['transfer','burn'].includes(p.envelope.record.op)).map(([id,p])=>({operation:p.envelope.record.op,receipt:receiptAddress(recoveryState(options).config,id).toBase58()})):[],positions:registered?[{position,available:'98500000'}]:[]}),reviewRegistration:async nonce=>{approvals++;return {proposal:{operation:'register',nonce},envelope:{record:{owner:native}}};},reviewCredit:async input=>({proposal:{operation:input.recipient===native?'deposit':'donate',amount:input.amount,expectedFee:(BigInt(input.amount)*15n/1000n).toString(),nonce:input.nonce},envelope:{record:{owner:input.recipient}}}),receipt(){throw Error('No receipt.');}},configureClient?.(options))};
 const ui=createJointTransferableUI(d,{previewOptions,...uiOptions,adapters,privateTest,legacy:()=>legacy++,previous:()=>previous++});t.after(()=>{ui.clear();for(const [k,v] of old)if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];});return {ui,elements,d,a,errors,async preview(){const [id,fn]=previewTimers.entries().next().value??[];assert.ok(fn,'preview scheduled');previewTimers.delete(id);await fn();},get html(){return html;},get renders(){return renders;},get signs(){return signs;},get approvals(){return approvals;},get legacy(){return legacy;},get previous(){return previous;}};
}
test('replacement waits for verified history before offering first-time registration',async t=>{let resolve;const p=new Promise(r=>resolve=r),f=setup(t,{ready:()=>p});const opening=f.ui.open();await new Promise(r=>setImmediate(r));assert.ok(!f.elements.has('j3-register'));assert.match(f.html,/Checking your wallets/);assert.match(f.html,/XMR20/);assert.equal(f.signs,0);resolve({schema:'joint-readiness-v3',ready:true,manifest:transferableManifest(XMR20_MINT)});await opening;assert.equal(f.elements.get('j3-register').disabled,false);assert.equal(f.approvals,0);});
test('unavailable service or unverified immutable code keeps real approvals disabled',async t=>{const f=setup(t,{verify:async()=>{throw Error('Synthetic missing deployment');}});await f.ui.open();assert.ok(!f.elements.has('j3-register'));assert.equal(f.elements.get('j3-ready').disabled,false);assert.match(f.html,/Bridge connection unavailable/);assert.equal(f.approvals,0);});
test('closing prevents a late readiness result from painting or enabling approvals',async t=>{let resolve;const p=new Promise(r=>resolve=r),f=setup(t,{ready:()=>p});const opening=f.ui.open();await new Promise(r=>setImmediate(r));const count=f.renders;f.ui.clear();resolve({schema:'joint-readiness-v3',ready:true,manifest:transferableManifest(XMR20_MINT)});await opening;assert.equal(f.renders,count);});
test('registered holder sees exact balance, direct airdrop/transfer/return choices and both old withdrawal paths',async t=>{const f=setup(t,{registered:true});await f.ui.open();assert.match(f.html,/Available: 98\.5/);for(const label of ['Airdrop to a registered','Send to another','Bridge back to my'])assert.ok(f.html.includes(label));assert.equal(f.elements.get('j3-bridge').disabled,true);await f.preview();assert.equal(f.elements.get('j3-bridge').disabled,false);f.elements.get('j3-previous').onclick();assert.equal(f.previous,1);await f.ui.open();f.elements.get('j3-legacy').onclick();assert.equal(f.legacy,1);assert.equal(f.signs,0);});
test('incomplete native history cannot enable the holder form',async t=>{const f=setup(t,{registered:true,snapshotComplete:false});await f.ui.open();assert.ok(!f.elements.has('j3-register'));assert.equal(f.signs,0);});
test('selected extension account signs exact ABI 3 credit; mismatched message or key cannot sign',async()=>{const key=Keypair.generate(),a={sol:key.publicKey.toBase58(),solSecret:bs58.encode(key.secretKey)},manifest=transferableManifest(XMR20_MINT),config={abi:3,network:manifest.network,program:manifest.program,mint:manifest.mint,verifier:manifest.verifier,owner:a.sol,binding:digest(native)},proposal={operation:'deposit',network:config.network,actor:a.sol,amount:'1000000',expectedFee:'15000',nonce:'ba'.repeat(32),blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:500};proposal.commitment=creditCommitment(config,proposal);const p=jointAccountProvider({account:()=>a,assert(){}}),signed=await approveExternal(config,proposal,transaction(config,proposal).serialize(),p);assert.ok(signed.signatures[0].some(v=>v));await assert.rejects(()=>approveExternal(config,{...proposal,amount:'2000000'},transaction(config,proposal).serialize(),p));a.solSecret=bs58.encode(Keypair.generate().secretKey);await assert.rejects(()=>approveExternal(config,proposal,transaction(config,proposal).serialize(),p),/does not match/);});
test('public receipts are isolated by program, mint, linked owner; failed storage cannot continue',()=>{const disk=new Map(),storage={getItem:k=>disk.get(k)??null,setItem:(k,v)=>disk.set(k,v)},config={abi:3,...transferableManifest(XMR20_MINT),owner:Keypair.generate().publicKey.toBase58(),binding:digest(native)},store=publicReceiptStore({config,moneroOwner:native,storage}),v={schema:'joint-owner-v3',scope:digest((awaitCanonical(config))),config,moneroOwner:native,proofs:{},operations:{}};store.save(v);assert.deepEqual(store.load(),v);assert.throws(()=>publicReceiptStore({config:{...config,mint:XCAT_MINT},moneroOwner:native,storage}).save(v),/does not match/);storage.setItem=()=>{};assert.throws(()=>store.save({...v,proofs:{changed:true}}),/not saved/);});
function awaitCanonical(v){return JSON.stringify(Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])));}
test('private candidate names its mutable status, restricts to XMR20 and hides peer/airdrop actions',async t=>{
 const f=setup(t,{privateTest:true,registered:true});await f.ui.open({rows:[{mint:XCAT_MINT}]});
 assert.match(f.html,/Private 1 XMR20 test/);assert.match(f.html,/can still change this program/);
 assert.match(f.html,/allowance stays at 1 XMR20 after a return/);
 assert.equal(f.elements.get('j3-bridge').disabled,true);await f.preview();assert.equal(f.elements.get('j3-bridge').disabled,false);
 assert.ok(!f.html.includes('Airdrop to a registered')&&!f.html.includes('Send to another'));
 assert.ok(!f.html.includes(XCAT_MINT));assert.equal(f.signs,0);
});
test('private candidate rejects another selected wallet before any native signing or registration review',async t=>{
 const f=setup(t,{privateTest:true,authorizedAccount:false});await assert.rejects(()=>f.ui.open(),/authorized linked wallets/);assert.equal(f.signs,0);assert.equal(f.approvals,0);
});
test('private candidate refuses a missing or substituted policy attestation and never weakens ordinary readiness',async t=>{
 const f=setup(t,{privateTest:true,ready:async()=>({schema:'joint-readiness-v3',ready:true,manifest:transferableManifest(XMR20_MINT)})});await f.ui.open();assert.ok(!f.elements.has('j3-register'));assert.equal(f.signs,0);
});

async function clicked(f,id){const button=f.elements.get(id);assert.ok(button&&!button.disabled,id+' must be available');button.onclick();for(let i=0;i<30;i++){await new Promise(r=>setImmediate(r));if(!f.d.isBusy())return;}assert.fail('UI action did not finish');}
function recoveryState(o){const m=o.manifest,config={abi:3,network:m.network,program:m.program,mint:m.mint,verifier:m.verifier,owner:o.provider.publicKey.toBase58(),binding:digest(native)};return {schema:'joint-owner-v3',scope:digest(awaitCanonical(config)),config,moneroOwner:native,proofs:{},operations:{}};}
async function transferReview(f){await f.ui.open({direction:'xmr-to-xmr'});f.elements.get('j3-amount').oninput({target:{value:'1'}});f.elements.get('j3-recipient').oninput({target:{value:native}});await clicked(f,'j3-review');}
test('native approval displays live progress and receiver-link failure beside its button',async t=>{
 let fail,attempts=0;
 const f=setup(t,{registered:true,configureClient:o=>({async publishMove(){attempts++;o.onProgress('Checking confirmed balance and recipient…');await new Promise((_,reject)=>fail=reject);}})});
 await transferReview(f);const approve=f.elements.get('j3-publish');approve.onclick();approve.onclick();await new Promise(r=>setImmediate(r));
 assert.equal(attempts,1);assert.equal(f.elements.get('j3-publish').disabled,true);assert.equal(f.elements.get('j3-cancel').disabled,false);
 assert.match(f.html,/Approving Monero record…/);assert.equal(f.elements.get('joint-stage').textContent,'Checking confirmed balance and recipient…');
 assert.ok(f.html.indexOf('id="j3-review-title"')<f.html.indexOf('id="progress"'));assert.ok(f.html.indexOf('id="progress"')<f.html.indexOf('id="j3-publish"'));
 assert.equal([...f.html.matchAll(/id="progress"/g)].length,1);
 fail(Error('Registered recipient required.'));for(let i=0;i<30&&f.d.isBusy();i++)await new Promise(r=>setImmediate(r));
 assert.match(f.html,/Check the recipient’s wallet link and token account/);
 assert.ok(f.html.indexOf('id="j3-native-feedback"')<f.html.indexOf('role="alert"'));assert.ok(f.html.indexOf('role="alert"')<f.html.indexOf('id="j3-publish"'));
 assert.equal(f.elements.get('j3-cancel').disabled,false);assert.ok(!f.elements.has('j3-resume-move-0'));assert.equal(f.signs,0);
});
test('native publication reuses the client fresh snapshot while retaining every UI verification gate',async t=>{
 for(const failure of ['none','schema','manifest','policy','complete','program'])await t.test(failure,async t=>{
  let histories=0,checks=0,published=0,approving=false;const manifest=transferableManifest(XMR20_MINT);
  const f=setup(t,{registered:true,verify:async()=>{checks++;if(approving&&failure==='program')throw Error('Synthetic deployment mismatch');},configureClient:o=>({
   async snapshot(){histories++;return {schema:'joint-index-v3',manifest,complete:true,positions:[{position:addresses(recoveryState(o).config).position.toBase58(),available:'100000000'}]};},
   async publishMove(review,{validateSnapshot}){const report={schema:'joint-index-v3',manifest,complete:true,positions:[]};if(failure==='schema')report.schema='wrong';if(failure==='manifest')report.manifest={...manifest,mint:XCAT_MINT};if(failure==='policy')report.privateTestPolicy={unexpected:true};if(failure==='complete')report.complete=false;await validateSnapshot(report);published++;}
  })});
  await transferReview(f);approving=true;const before=checks;await clicked(f,'j3-publish');
  assert.equal(histories,1,'UI must not fetch another full history before publishMove');assert.equal(checks,before+1);assert.equal(published,failure==='none'?1:0);assert.equal(f.signs,0);
  if(failure!=='none'){assert.ok(f.elements.has('j3-publish'));assert.match(f.html,failure==='program'?/Synthetic deployment mismatch/:/Complete verified bridge history is required/);}
 });
});
test('native approval retries a failed fresh check from the same button and validates again',async t=>{
 let attempts=0,verified=0;const manifest=transferableManifest(XMR20_MINT);
 const f=setup(t,{registered:true,configureClient:()=>({async publishMove(review,{validateSnapshot}){attempts++;await validateSnapshot({schema:'joint-index-v3',manifest,complete:attempts>1,positions:[]});verified++;}})});
 await transferReview(f);await clicked(f,'j3-publish');assert.match(f.html,/Complete verified bridge history is required/);assert.equal(f.elements.get('j3-publish').disabled,false);
 await clicked(f,'j3-publish');assert.equal(attempts,2);assert.equal(verified,1);assert.ok(!f.elements.has('j3-publish'));assert.doesNotMatch(f.html,/Complete verified bridge history is required/);assert.equal(f.signs,0);
});
test('saved native proof replaces approval immediately and retains action-local recovery after a lost publication reply',async t=>{
 let fail,attempts=0;
 const f=setup(t,{registered:true,configureClient:o=>({async publishMove(review){
  attempts++;const s=recoveryState(o);s.proofs[review.nonce]={phase:'publication-unknown',envelope:{record:{op:'transfer',nonce:review.nonce,amount:review.amount,owner:native,to:review.to}}};o.store.save(s);o.onProgress('Publishing your saved Monero record…');await new Promise((_,reject)=>fail=reject);
 }})});
 await transferReview(f);f.elements.get('j3-publish').onclick();await new Promise(r=>setImmediate(r));
 assert.ok(!f.elements.has('j3-publish'));assert.ok(!f.elements.has('j3-cancel'));assert.ok(!f.elements.has('j3-cancel-request'));assert.match(f.html,/Sending on Monero/);
 assert.ok(f.html.indexOf('Sending on Monero')<f.html.indexOf('id="j3-move-feedback"'));assert.ok(f.html.indexOf('id="progress"')<f.html.indexOf('id="j3-resume-move-0"'));assert.match(f.html,/Publishing your saved Monero record/);
 fail(Error('Synthetic lost publication reply'));for(let i=0;i<30&&f.d.isBusy();i++)await new Promise(r=>setImmediate(r));
 assert.equal(attempts,1);assert.ok(!f.elements.has('j3-publish'));assert.ok(f.elements.has('j3-resume-move-0'));assert.match(f.html,/publication is not yet confirmed/);
 assert.ok(f.html.indexOf('id="j3-move-feedback"')<f.html.indexOf('role="alert"'));assert.ok(f.html.indexOf('role="alert"')<f.html.indexOf('id="j3-resume-move-0"'));assert.equal(f.signs,0);
});
test('Cancel review aborts a stalled unsigned native check and blocks late publication',async t=>{
 let finish,published=0;const blocked=new Promise(r=>finish=r);
 const f=setup(t,{registered:true,configureClient:o=>({async publishMove(){o.onProgress('Checking confirmed balance and recipient…');await blocked;o.provider.assertCurrent();published++;}})});
 await transferReview(f);f.elements.get('j3-publish').onclick();await new Promise(r=>setImmediate(r));
 assert.equal(f.elements.get('j3-cancel').disabled,false);await f.elements.get('j3-cancel').onclick();assert.equal(f.d.isBusy(),false);assert.match(f.html,/Request cancelled/);
 finish();for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r));assert.equal(published,0);assert.ok(!f.elements.has('j3-publish'));assert.equal(f.signs,0);
});
test('closing or switching account while native snapshot verification waits prevents a late approval',async t=>{
 for(const close of [false,true])await t.test(close?'close':'account switch',async t=>{
  let finish,checking=false,published=0;const blocked=new Promise(r=>finish=r),manifest=transferableManifest(XMR20_MINT);
  const f=setup(t,{registered:true,verify:async()=>{if(checking)await blocked;},configureClient:()=>({async publishMove(review,{validateSnapshot}){await validateSnapshot({schema:'joint-index-v3',manifest,complete:true,positions:[]});published++;}})});
  await transferReview(f);checking=true;f.elements.get('j3-publish').onclick();await new Promise(r=>setImmediate(r));const renders=f.renders;
  if(close)f.ui.clear();else f.a.id='different-account';finish();for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
  assert.equal(published,0);assert.equal(f.renders,renders);assert.equal(f.signs,0);
 });
});
test('lost submission reply exposes the saved registration immediately and repeated clicks cannot approve again',async t=>{
 let attempts=0;
 const f=setup(t,{configureClient:o=>({async approveRegistration(review){attempts++;const s=recoveryState(o);s.operations.registration={proposal:review.proposal,phase:'submission-unknown',ownerSignature:'public-synthetic-signature'};o.store.save(s);throw Error('Synthetic lost submission reply');}})});
 await f.ui.open();await clicked(f,'j3-register');const approve=f.elements.get('j3-confirm');approve.onclick();approve.onclick();
 for(let i=0;i<30&&f.d.isBusy();i++)await new Promise(r=>setImmediate(r));
 assert.equal(attempts,1);assert.equal(f.errors.length,0);assert.match(f.html,/Synthetic lost submission reply/);assert.match(f.html,/Your registration approval is saved/);assert.ok(f.elements.has('j3-check-0'));assert.ok(!f.elements.has('j3-confirm')&&!f.elements.has('j3-register'));
});
test('failure before owner approval preserves the review without inventing a saved submission',async t=>{
 const f=setup(t,{configureClient:()=>({approveRegistration:async()=>{throw Error('Synthetic preparation failure');}})});
 await f.ui.open();await clicked(f,'j3-register');await clicked(f,'j3-confirm');assert.equal(f.errors.length,0);assert.match(f.html,/Synthetic preparation failure/);assert.ok(f.elements.has('j3-confirm'));assert.ok(!f.elements.has('j3-check-0'));
});
test('confirmed expiry skips an unnecessary history read and replacement review stays visible',async t=>{
 let state,options,failHistory=false;
 const f=setup(t,{configureClient:o=>{options=o;state=recoveryState(o);state.operations.registration={proposal:{operation:'register',nonce:'ab'.repeat(32)},envelope:{record:{owner:native}},phase:'submission-unknown',ownerSignature:'public-synthetic-signature'};o.store.save(state);return {
  snapshot:async()=>{if(failHistory)throw Error('Synthetic failed history refresh');return {schema:'joint-index-v3',manifest:transferableManifest(XMR20_MINT),complete:true,positions:[]};},
  check:async()=>{state.operations.registration.phase='approval-expired';options.store.save(state);failHistory=true;return {retryApprovalRequired:true};}
 };}});
 await f.ui.open();await clicked(f,'j3-check-0');assert.equal(f.errors.length,0);assert.match(f.html,/previous registration approval expired or failed/);assert.ok(f.elements.has('j3-renew-0'));assert.ok(!f.elements.has('j3-register'));
 failHistory=false;await clicked(f,'j3-renew-0');assert.ok(f.elements.has('j3-confirm'));assert.match(f.html,/Link your wallets/);
});
test('a finalized Solana registration awaiting its Monero link cannot offer a duplicate registration',async t=>{
 const f=setup(t,{configureClient:o=>{const s=recoveryState(o);s.operations.registration={proposal:{operation:'register',nonce:'ab'.repeat(32)},phase:'finalized',ownerSignature:'public-synthetic-signature'};o.store.save(s);return {};}});
 await f.ui.open();assert.match(f.html,/Solana registration confirmed/);assert.ok(f.elements.has('j3-check-0'));assert.ok(!f.elements.has('j3-register'));assert.equal(f.approvals,0);
});


test('registration has one primary action, readable status and secondary recovery inside details',async t=>{
 const f=setup(t,{configureClient:o=>{const s=recoveryState(o);s.operations.registration={proposal:{operation:'register',nonce:'cd'.repeat(32)},phase:'submission-unknown',ownerSignature:'public-synthetic-signature'};o.store.save(s);return {};}});
 await f.ui.open();assert.equal([...f.html.matchAll(/class="primary wide"/g)].length,1);assert.match(f.html,/Check registration status/);assert.doesNotMatch(f.html,/submission-unknown|Saved Solana approvals/);
 assert.ok(f.html.indexOf('<summary>Receipts and recovery')<f.html.indexOf('id="j3-retry-0"'));
 assert.ok(f.html.indexOf('<summary>Other bridge balances')<f.html.indexOf('id="j3-legacy"'));
});

test('registration error is next to the main action and retains a single review after a pre-sign failure',async t=>{
 const f=setup(t,{configureClient:()=>({approveRegistration:async()=>{throw Error('Transferable service unavailable. Keep the public recovery receipt.');}})});
 await f.ui.open();await clicked(f,'j3-register');await clicked(f,'j3-confirm');
 assert.match(f.html,/The bridge service could not finish this request/);
 assert.ok(f.html.indexOf('role="alert"')<f.html.indexOf('id="j3-confirm"'));assert.ok(f.html.indexOf('id="progress"')<f.html.indexOf('id="j3-confirm"'));
 assert.equal([...f.html.matchAll(/class="primary wide"/g)].length,1);assert.equal(f.elements.get('j3-confirm').disabled,false);
});

test('the selected extension account preserves the verifier registration signature while adding only its own',async()=>{
 const {approveRegistrationExternal}=await import('../../engine/shared/bridge-sdk/core-transferable/sdk.mjs'),{ed25519}=await import('@noble/curves/ed25519');
 const key=Keypair.generate(),verifier=Keypair.generate(),account={sol:key.publicKey.toBase58(),solSecret:bs58.encode(key.secretKey)},config={...transferableManifest(XMR20_MINT),owner:account.sol,verifier:verifier.publicKey.toBase58(),binding:digest(native)},proposal={operation:'register',network:config.network,nonce:'ce'.repeat(32),commitment:'ab'.repeat(32),blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:500},tx=transaction(config,proposal);tx.sign([verifier]);
 const signature=Buffer.from(tx.signatures[1]),provider=jointAccountProvider({account:()=>account,assert(){}}),signed=await approveRegistrationExternal(config,proposal,tx.serialize(),provider);
 assert.ok(ed25519.verify(signed.signatures[0],signed.message.serialize(),key.publicKey.toBytes()));assert.deepEqual(Buffer.from(signed.signatures[1]),signature);
});

test('successful registration replaces the review immediately while later publication and history reads are still pending',async t=>{
 let finishCheck,finishPublish,finishHistory,options,state,historyAfterApproval=false;
 const checking=new Promise(r=>finishCheck=r),publishing=new Promise(r=>finishPublish=r),history=new Promise(r=>finishHistory=r);
 const f=setup(t,{configureClient:o=>{options=o;return {
  async approveRegistration(review){state=recoveryState(o);state.operations.registration={proposal:review.proposal,phase:'submission-unknown',ownerSignature:'public-synthetic-signature'};o.store.save(state);return {operationId:'registration'};},
  async check(){await checking;state.operations.registration.phase='finalized';options.store.save(state);return {confirmed:true};},
  async publishCreditOrLink(){await publishing;state.operations.registration.publication={txid:'ab'.repeat(32)};options.store.save(state);historyAfterApproval=true;},
  async snapshot(){if(historyAfterApproval)await history;return {schema:'joint-index-v3',manifest:transferableManifest(XMR20_MINT),complete:true,positions:[]};}
 };}});
 await f.ui.open();await clicked(f,'j3-register');f.elements.get('j3-confirm').onclick();
 for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
 assert.ok(!f.elements.has('j3-confirm'));assert.match(f.html,/Your registration approval is saved/);assert.equal(f.elements.get('j3-check-0').disabled,true);
 finishCheck();for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
 assert.match(f.html,/Solana registration confirmed/);assert.ok(!f.elements.has('j3-confirm'));assert.equal(f.elements.get('j3-check-0').disabled,true);
 finishPublish();for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
 assert.match(f.html,/View Monero link record/);assert.ok(f.html.includes('https://xmrchain.net/tx/'+'ab'.repeat(32)));assert.ok(!f.elements.has('j3-confirm'));
 finishHistory();for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));assert.equal(f.elements.get('j3-check-0').disabled,false);assert.equal(f.errors.length,0);
});

test('accepted background deposit shows a pending balance and prevents duplicate approval until verified complete',async t=>{
 let state,opts,status='monero-pending',checks=0,published=0;
 const f=setup(t,{registered:true,configureClient:o=>{opts=o;state=recoveryState(o);state.operations.deposit={proposal:{operation:'deposit',nonce:'aa'.repeat(32),amount:'1000000'},envelope:{record:{amount:'985000'}},phase:'submission-unknown',ownerSignature:'fixture'};o.store.save(state);return {
  async backgroundStatus(){state.operations.deposit.background={enabled:true,phase:status,checkedAt:100};opts.store.save(state);return {accepted:true,backgroundEnabled:true,phase:status};},
  async check(){checks++;state.operations.deposit.phase='finalized';opts.store.save(state);return {confirmed:true};},
  async publishCreditOrLink(){published++;}
 };}});
 await f.ui.open();assert.match(f.html,/Bridging to Monero/);assert.match(f.html,/0\.985 XMR20/);assert.match(f.html,/You can close the wallet/);assert.match(f.html,/not spendable yet/);
 assert.ok(!f.elements.has('j3-review'));assert.equal(f.approvals,0);assert.equal(checks,0);
 status='complete';await clicked(f,'j3-background');assert.equal(checks,1);assert.equal(published,0);assert.equal(f.approvals,0);assert.ok(f.elements.has('j3-bridge'));
});

test('unacknowledged approval never claims automatic completion or that it is safe to close',async t=>{
 const f=setup(t,{configureClient:o=>{const s=recoveryState(o);s.operations.registration={proposal:{operation:'register'},phase:'submission-unknown',ownerSignature:'fixture'};o.store.save(s);return {backgroundStatus:async()=>({accepted:false,backgroundEnabled:true})};}});
 await f.ui.open();assert.doesNotMatch(f.html,/You can close the wallet/);assert.match(f.html,/Your registration approval is saved/);assert.ok(f.elements.has('j3-check-0'));
});


test('pending screen polls automatically, stops on close and ignores late responses without signing',async t=>{
 let next,cancelled=0,polls=0,release,state,opts;
 const f=setup(t,{uiOptions:{setTimer:fn=>(next=fn),clearTimer:()=>cancelled++},configureClient:o=>{opts=o;state=recoveryState(o);state.operations.registration={proposal:{operation:'register'},phase:'submission-unknown',ownerSignature:'fixture'};o.store.save(state);return {
  async backgroundStatus(){polls++;if(polls===2)await new Promise(r=>release=r);state.operations.registration.background={enabled:true,phase:'monero-pending'};opts.store.save(state);return {accepted:true,backgroundEnabled:true,phase:'monero-pending'};}
 };}});
 await f.ui.open();assert.equal(polls,1);const checking=next();await new Promise(r=>setImmediate(r));assert.equal(polls,2);
 const renders=f.renders;f.ui.clear();release();await checking;assert.equal(f.renders,renders);assert.equal(f.approvals,0);assert.ok(cancelled>0);
});

test('registration advances its visible waiting stage without another approval or full history read',async t=>{
 let state,opts,phase='solana-pending';
 const f=setup(t,{configureClient:o=>{opts=o;state=recoveryState(o);state.operations.registration={proposal:{operation:'register'},phase:'submission-unknown',ownerSignature:'fixture'};o.store.save(state);return {
  async backgroundStatus(){state.operations.registration.background={enabled:true,phase,...(phase==='delayed'?{confirmations:6}:{})};opts.store.save(state);return {accepted:true,backgroundEnabled:true,phase};},
  check:async()=>({confirmed:false}),
  snapshot:async()=>{throw Error('Pending progress must not wait on history');}
 };}});
 await f.ui.open();assert.match(f.html,/<div class="bridge-secondary" hidden>/);assert.doesNotMatch(f.html,/Your bridge is in progress|Bridge connection unavailable/);assert.ok(f.elements.has('j3-export'),'recovery receipt remains available when recovery is needed');assert.match(f.html,/Waiting for Solana confirmation/);assert.match(f.html,/No tokens have moved/);assert.match(f.html,/data-loading="true"/);assert.doesNotMatch(f.html,/around 20 minutes/);
 phase='monero-pending';await clicked(f,'j3-background');assert.match(f.html,/[Ww]aiting for Monero confirmations/);assert.match(f.html,/Allow about 20 minutes for 10 Monero confirmations/);assert.match(f.html,/Solana confirmation<\/span><span>Confirmed/);assert.match(f.html,/Ten Monero confirmations<\/span><span[^>]*>—\/10/);
 phase='publishing';state.operations.registration.publication={txid:'aa'.repeat(32),confirmed:false};opts.store.save(state);await clicked(f,'j3-background');assert.match(f.html,/[Ww]aiting for Monero confirmations/);assert.match(f.html,/Monero wallet link<\/span><span>Published/);assert.doesNotMatch(f.html,/Publishing your Monero wallet link/);
 phase='delayed';await clicked(f,'j3-background');assert.match(f.html,/Wallet link published — checking confirmations/);assert.match(f.html,/confirmation check is delayed and will retry/);assert.match(f.html,/Ten Monero confirmations<\/span><span[^>]*>6\/10/);assert.match(f.html,/<div class="bridge-secondary" hidden>/);assert.doesNotMatch(f.html,/data-loading="true"/);assert.ok(!f.elements.has('j3-bridge'));
 assert.match(f.html,new RegExp('href="https://xmrchain.net/tx/'+'aa'.repeat(32)+'" target="_blank" rel="noopener noreferrer">View Monero transaction'));
 assert.ok(!f.elements.has('j3-register')&&!f.elements.has('j3-confirm'));assert.equal(f.approvals,0);assert.equal(f.signs,0);
});

test('Monero confirmation progress distinguishes known counts from unknown and links only the saved transaction',()=>{
 const txid='ce'.repeat(32),job={proposal:{operation:'register'},publication:{txid,confirmed:false},background:{phase:'monero-pending'}},render=()=>jointWaiting(job,v=>String(v));
 for(const confirmations of [0,1,2,9]){job.background.confirmations=confirmations;assert.match(render(),new RegExp('aria-label="'+confirmations+' of 10 Monero confirmations">'+confirmations+'/10'));}
 for(const confirmations of [null,undefined,10,-1,1.5,'2']){job.background.confirmations=confirmations;assert.match(render(),/aria-label="Checking Monero confirmations">—\/10/);}
 job.background.phase='complete';job.background.confirmations=null;assert.doesNotMatch(render(),/>10\/10</);job.publication.confirmed=true;assert.match(render(),/>10\/10</);
 job.background.phase='monero-pending';job.background.confirmations=2;assert.match(jointWaiting(job,String,{updatesUnavailable:true}),/Last known:/);
 for(const invalid of [undefined,'0'.repeat(64),'x'.repeat(64),txid+'?redirect=other','"><script>']){job.publication.txid=invalid;assert.doesNotMatch(render(),/href="https:\/\/xmrchain.net/);assert.doesNotMatch(render(),/<script>/);}
});

test('an unavailable progress update labels the previous stage as last known instead of showing live activity',async t=>{
 let next,state,opts,polls=0;
 const f=setup(t,{uiOptions:{setTimer:fn=>(next=fn),clearTimer(){}},configureClient:o=>{opts=o;state=recoveryState(o);state.operations.registration={proposal:{operation:'register'},phase:'submission-unknown',ownerSignature:'fixture'};o.store.save(state);return {
  async backgroundStatus(){if(++polls>1)throw Error('Offline');state.operations.registration.background={enabled:true,phase:'monero-pending'};opts.store.save(state);return {accepted:true,backgroundEnabled:true,phase:'monero-pending'};}
 };}});
 await f.ui.open();await next();assert.doesNotMatch(f.html,/<div class="bridge-secondary" hidden>/);assert.ok(f.elements.has('j3-export'));assert.match(f.html,/Last known: Wallet linking — waiting for Monero confirmations/);assert.match(f.html,/Status updates are temporarily unavailable/);assert.match(f.html,/class="joint-busy joint-wait-label" data-loading="false"/);assert.equal(f.approvals,0);assert.equal(f.signs,0);
});

test('completed registration never blocks a newer pending deposit with redundant history checks',async t=>{
 let opts,state,calls=[],snapshots=0;
 const f=setup(t,{configureClient:o=>{opts=o;state=recoveryState(o);state.operations.link={proposal:{operation:'register'},phase:'finalized',background:{enabled:true,phase:'complete'}};state.operations.deposit={proposal:{operation:'deposit',amount:'1000000'},envelope:{record:{amount:'985000'}},phase:'submission-unknown'};o.store.save(state);return {
  async backgroundStatus(id){calls.push(id);assert.equal(id,'deposit');state.operations[id].background={enabled:true,phase:'monero-pending'};opts.store.save(state);return {accepted:true,backgroundEnabled:true,phase:'monero-pending'};},
  async snapshot(){snapshots++;throw Error('No full history needed for public pending progress');},
  async check(){throw Error('No repeated registration reconciliation');}
 };}});
 await f.ui.open();assert.deepEqual(calls,['deposit']);assert.equal(snapshots,0);assert.match(f.html,/Bridging to Monero/);assert.doesNotMatch(f.html,/Wallet linking|Updating the wallet/);assert.equal(f.errors.length,0);
});

test('an expired deposit is surfaced as one fresh review after checking, never an automatic retry',async t=>{
 let opts,state,checks=0,renewed=0;
 const f=setup(t,{registered:true,configureClient:o=>{opts=o;state=recoveryState(o);state.operations.deposit={proposal:{operation:'deposit',amount:'1000000',nonce:'ef'.repeat(32)},envelope:{record:{owner:native,amount:'985000'}},phase:'submission-unknown'};o.store.save(state);return {
  async backgroundStatus(){state.operations.deposit.background={enabled:true,phase:'approval-required'};opts.store.save(state);return {accepted:true,backgroundEnabled:true,phase:'approval-required'};},
  async check(){checks++;state.operations.deposit.phase='approval-expired';opts.store.save(state);return {retryApprovalRequired:true};},
  async reviewCredit(input){renewed++;assert.equal(input.nonce,'ef'.repeat(32));return {proposal:{operation:'deposit',amount:input.amount,nonce:input.nonce},envelope:{record:{owner:native}}};}
 };}});
 await f.ui.open();assert.equal(checks,1);assert.match(f.html,/Deposit approval expired/);assert.doesNotMatch(f.html,/You can close the wallet/);assert.ok(!f.elements.has('j3-review'));assert.equal([...f.html.matchAll(/id="j3-renew-0"/g)].length,1);assert.equal(renewed,0);
 await clicked(f,'j3-renew-0');assert.equal(renewed,1);assert.match(f.html,/Review bridge/);assert.equal(f.signs,0);
});

test('a saved completed registration uses one attested history read on reopen without reconciling it again',async t=>{
 let snapshots=0,checks=0;
 const f=setup(t,{configureClient:o=>{const s=recoveryState(o);s.operations.link={proposal:{operation:'register'},phase:'finalized',background:{enabled:true,phase:'complete'}};o.store.save(s);return {
  async backgroundStatus(){checks++;throw Error('Completed operation must not restart');},
  async snapshot(){snapshots++;return {schema:'joint-index-v3',manifest:o.manifest,complete:true,positions:[{position:addresses(s.config).position.toBase58(),available:'0'}]};}
 };}});
 await f.ui.open();assert.equal(checks,0);assert.equal(snapshots,1);assert.equal(f.elements.get('j3-bridge').disabled,true);await f.preview();assert.equal(f.elements.get('j3-bridge').disabled,false);
 await f.ui.open();assert.equal(checks,0);assert.equal(snapshots,2);
});

test('a lost deposit submission reply blocks a second funding form even without a worker acknowledgement',async t=>{
 const f=setup(t,{registered:true,configureClient:o=>{const s=recoveryState(o);s.operations.deposit={proposal:{operation:'deposit',amount:'1000000'},phase:'submission-unknown'};o.store.save(s);return {backgroundStatus:async()=>({accepted:false,backgroundEnabled:false})};}});
 await f.ui.open();assert.match(f.html,/Your signed deposit is saved/);assert.ok(!f.elements.has('j3-review'));assert.ok(f.elements.has('j3-check-0'));assert.equal(f.approvals,0);
});

test('one funding button shows exact terms and submits once without a second approval screen',async t=>{
 let submits=0,release,options,state,submitted;
 const f=setup(t,{registered:true,configureClient:o=>{options=o;return {
  async approveCredit(review){submits++;submitted=review;await new Promise(r=>release=r);state=recoveryState(o);state.operations.deposit={...review,envelope:{record:{owner:native,amount:'985000'}},phase:'submission-unknown',ownerSignature:'synthetic-public-signature'};o.store.save(state);return {operationId:'deposit'};},
  async backgroundStatus(){state.operations.deposit.background={enabled:true,phase:'solana-pending'};options.store.save(state);return {accepted:true,backgroundEnabled:true,phase:'solana-pending'};}
 };}});
 await f.ui.open();assert.equal(submits,0);assert.equal(f.elements.get('j3-bridge').disabled,true);
 await f.preview();assert.equal(submits,0);assert.match(f.html,/0\.015 XMR20/);assert.match(f.html,/data-raw="985000"/);assert.ok(f.html.includes(native));assert.match(f.html,/SOL network and account costs are additional/);
 assert.ok(!f.elements.has('j3-review'));assert.ok(!f.elements.has('j3-confirm'));
 const button=f.elements.get('j3-bridge');button.onclick();button.onclick();await new Promise(r=>setImmediate(r));assert.equal(submits,1);assert.equal(submitted.proposal.amount,'1000000');assert.equal(submitted.envelope.record.owner,native);
 release();for(let i=0;i<30&&f.d.isBusy();i++)await new Promise(r=>setImmediate(r));
 assert.equal(submits,1);assert.match(f.html,/Bridging to Monero/);assert.match(f.html,/Status updates automatically/);assert.ok(!f.elements.has('j3-bridge'));assert.ok(!f.elements.has('j3-confirm'));
 assert.ok(f.html.indexOf('<summary>Receipts and recovery')<f.html.indexOf('id="j3-background"'));assert.equal(f.errors.length,0);
});

test('Phantom deposit failure and real approval phase stay beside the funding button without automatic submission',async t=>{
 let rejectWallet,requests=0,submits=0;
 const f=setup(t,{registered:true,configureClient:o=>({async approveCredit(review){
  o.onProgress('Signing your reviewed transaction…');requests++;
  await new Promise((_,reject)=>rejectWallet=reject);
  submits++;return {operationId:'must-not-submit'};
 }})});
 await f.ui.open();await f.preview();assert.equal(requests,0);assert.equal(submits,0);
 const original=f.elements.get('j3-bridge');original.onclick();await new Promise(r=>setImmediate(r));
 assert.equal(requests,1);assert.equal(submits,0);assert.equal(f.elements.get('j3-bridge').disabled,true);
 const feedback=f.html.indexOf('id="j3-credit-feedback"'),button=f.html.indexOf('id="j3-bridge"');
 assert.ok(f.html.indexOf('id="j3-amount"')<feedback);assert.ok(feedback<f.html.indexOf('id="progress"')&&f.html.indexOf('id="progress"')<button);
 assert.equal(f.elements.get('joint-stage').textContent,'Signing your reviewed transaction…');assert.equal([...f.html.matchAll(/id="progress"/g)].length,1);assert.equal([...f.html.matchAll(/id="joint-stage"/g)].length,1);
 rejectWallet(Error('Phantom could not approve this transaction. Check the wallet error before retrying.'));
 for(let i=0;i<30&&f.d.isBusy();i++)await new Promise(r=>setImmediate(r));
 const failure=f.html.indexOf('role="alert"');assert.ok(f.html.indexOf('id="j3-credit-feedback"')<failure&&failure<f.html.indexOf('id="j3-bridge"'));assert.match(f.html,/Phantom could not approve/);assert.equal([...f.html.matchAll(/role="alert"/g)].length,1);
 assert.equal(requests,1);assert.equal(submits,0);assert.equal(f.signs,0);assert.ok(!f.elements.has('j3-confirm'));
 await f.preview();assert.equal(f.elements.get('j3-bridge').disabled,false);assert.equal(requests,1);assert.equal(submits,0);assert.match(f.html,/Phantom could not approve/);
});

test('editing while a quote is pending preserves typing and cannot enable an obsolete amount',async t=>{
 let release,previews=0,submits=0;
 const f=setup(t,{registered:true,configureClient:()=>({async reviewCredit(input){previews++;if(previews===1)await new Promise(r=>release=r);return {proposal:{operation:'deposit',amount:input.amount,expectedFee:'15000'},envelope:{record:{owner:native}}};},async approveCredit(){submits++;throw Error('Must not approve');}})});
 await f.ui.open();const loading=f.preview();const amount=f.elements.get('j3-amount');amount.focus();amount.selectionStart=1;amount.selectionEnd=1;amount.oninput({target:{value:'2'}});
 assert.equal(document.activeElement.id,'j3-amount');assert.equal(document.activeElement.selectionStart,1);assert.equal(f.elements.get('j3-amount').disabled,false);assert.equal(f.elements.get('j3-bridge').disabled,true);
 release();await loading;assert.equal(f.elements.get('j3-bridge').disabled,true);await f.preview();assert.match(f.html,/data-raw="1985000"/);assert.equal(submits,0);
 f.elements.get('j3-amount').oninput({target:{value:'bad'}});assert.equal(f.elements.get('j3-bridge').disabled,true);assert.doesNotMatch(f.html,/data-raw="1985000"/);assert.equal(submits,0);
});

test('private cap and invalid input block automatic preparation and one-button approval',async t=>{
 let previews=0,submits=0;
 const f=setup(t,{registered:true,privateTest:true,configureClient:()=>({async reviewCredit(){previews++;throw Error('No preview for invalid input');},async approveCredit(){submits++;}})});
 await f.ui.open({amountRaw:'2000000'});assert.equal(f.elements.get('j3-bridge').disabled,true);assert.match(f.html,/Enter an amount up to 1 XMR20/);
 for(const value of ['0','-1','2','0.0000001','abc']){f.elements.get('j3-amount').oninput({target:{value}});assert.equal(f.elements.get('j3-bridge').disabled,true);}
 assert.equal(previews,0);assert.equal(submits,0);
});

test('a late quote for a changed account or closed wallet cannot repaint or approve',async t=>{
 let release;
 const f=setup(t,{registered:true,configureClient:()=>({async reviewCredit(input){await new Promise(r=>release=r);return {proposal:{operation:'deposit',amount:input.amount},envelope:{record:{owner:native}}};}})});
 await f.ui.open();const pending=f.preview();f.a.sol=Keypair.generate().publicKey.toBase58();const renders=f.renders;release();await pending;
 assert.equal(f.renders,renders);assert.equal(f.signs,0);assert.equal(f.elements.get('j3-bridge').disabled,true);f.ui.clear();
});

test('a changed fee stops the click and requires the refreshed inline terms before another click',async t=>{
 let previews=0,submits=0;
 const f=setup(t,{registered:true,configureClient:()=>({async reviewCredit(input){return {proposal:{operation:'deposit',amount:input.amount,expectedFee:++previews===1?'15000':'20000'},envelope:{record:{owner:native}}};},async approveCredit(){submits++;throw Error('Amount, destination, fee or ownership changed. Review again.');}})});
 await f.ui.open();await f.preview();await clicked(f,'j3-bridge');assert.equal(submits,1);assert.match(f.html,/fee or ownership changed/);assert.equal(f.elements.get('j3-bridge').disabled,true);
 await f.preview();assert.match(f.html,/0\.02 XMR20/);assert.match(f.html,/data-raw="980000"/);assert.equal(f.elements.get('j3-bridge').disabled,false);assert.equal(submits,1);assert.equal(f.signs,0);
});

test('return flow shows one inline action and clears a pending deposit quote',async t=>{
 const f=setup(t,{registered:true});await f.ui.open();f.elements.get('j3-operation').onchange({target:{value:'release'}});
 assert.ok(!f.elements.has('j3-bridge'));assert.ok(!f.elements.has('j3-review'));await f.preview();assert.match(f.html,/You receive/);assert.equal(f.elements.get('j3-return').disabled,false);assert.ok(!f.elements.has('j3-publish'));assert.equal(f.signs,0);
});

test('home balance return action selects the private return route without signing or preparing funding',async t=>{
 let funding=0;const f=setup(t,{privateTest:true,registered:true,configureClient:()=>({async reviewCredit(){funding++;throw Error('No new funding from a return action');}})});
 await f.ui.open({mint:XMR20_MINT,amountRaw:'985000',direction:'xmr-to-sol'});
 assert.match(f.html,/value="release" selected/);assert.match(f.html,/value="0\.99" title="0\.985000"/);
 assert.match(f.html,/Bridge to Solana/);assert.ok(!f.elements.has('j3-bridge'));
 await f.preview();assert.equal(f.elements.get('j3-return').disabled,false);assert.ok(!f.elements.has('j3-publish'));
 assert.equal(funding,0);assert.equal(f.signs,0);assert.equal(f.approvals,0);
});

test('home balance send action selects the new peer-transfer route and still requires native approval',async t=>{
 let funding=0;const f=setup(t,{registered:true,configureClient:()=>({async reviewCredit(){funding++;throw Error('No funding from a peer transfer');}})});
 await f.ui.open({mint:XMR20_MINT,amountRaw:'985000',direction:'xmr-to-xmr'});
 assert.match(f.html,/monero-send-form/);assert.ok(f.elements.has('j3-recipient'));assert.ok(!f.elements.has('j3-swap'));
 assert.match(f.html,/>Next<\/button>/);assert.ok(!f.elements.has('j3-bridge'));
 assert.equal(funding,0);assert.equal(f.signs,0);assert.equal(f.approvals,0);
});

test('reopening a completed bridge for return never presents registration as pending during history loading',async t=>{
 let finish,reads=0;
 const f=setup(t,{privateTest:true,configureClient:o=>{
  const state=recoveryState(o);state.operations.link={proposal:{operation:'register'},phase:'finalized',background:{enabled:true,phase:'complete'}};
  state.operations.deposit={proposal:{operation:'deposit',amount:'1000000'},phase:'finalized',background:{enabled:true,phase:'complete'}};o.store.save(state);
  return {async snapshot(){reads++;await new Promise(r=>finish=r);return {schema:'joint-index-v3',manifest:o.manifest,privateTestPolicy:PRIVATE_TEST_POLICY,complete:true,positions:[{position:addresses(state.config).position.toBase58(),available:'985000'}]};}};
 }});
 const opening=f.ui.open({amountRaw:'985000',direction:'xmr-to-sol'});await new Promise(r=>setImmediate(r));
 assert.match(f.html,/Checking your return/);assert.doesNotMatch(f.html,/Monero link needs ten|Connect your linked wallets|Check registration status/);
 assert.ok(!f.elements.has('j3-register'));assert.ok(!f.elements.has('j3-review'));assert.ok(!f.elements.has('j3-ready'));
 finish();await opening;assert.equal(reads,1);assert.match(f.html,/Available: 0\.99/);assert.match(f.html,/Bridge to Solana/);
 await f.preview();assert.equal(f.elements.get('j3-return').disabled,false);assert.equal(f.signs,0);assert.equal(f.approvals,0);
});

test('failed return history read keeps saved receipts and offers connection retry without inventing a new confirmation wait',async t=>{
 const f=setup(t,{configureClient:o=>{const state=recoveryState(o);state.operations.link={proposal:{operation:'register'},phase:'finalized',background:{enabled:true,phase:'complete'}};o.store.save(state);return {async snapshot(){throw Error('Synthetic unavailable history');}};}});
 await f.ui.open({amountRaw:'985000',direction:'xmr-to-sol'});
 assert.match(f.html,/Your balance could not be verified/);assert.doesNotMatch(f.html,/Monero link needs ten|Check registration status/);
 assert.equal(f.elements.get('j3-ready').disabled,false);assert.ok(f.elements.has('j3-export'));
 assert.ok(!f.elements.has('j3-register'));assert.ok(!f.elements.has('j3-review'));assert.equal(f.approvals,0);assert.equal(f.signs,0);
});

test('completed saved registration absent from a complete report requires reconciliation rather than another registration',async t=>{
 const f=setup(t,{configureClient:o=>{const state=recoveryState(o);state.operations.link={proposal:{operation:'register'},phase:'finalized',background:{enabled:true,phase:'complete'}};o.store.save(state);return {};}});
 await f.ui.open({direction:'xmr-to-sol'});assert.match(f.html,/saved registration is complete/);assert.match(f.html,/Do not register again/);
 assert.doesNotMatch(f.html,/Monero link needs ten/);assert.ok(!f.elements.has('j3-register'));assert.equal(f.signs,0);assert.equal(f.approvals,0);
});

test('return progress shows the steps and the Monero transaction link once the record is published',async t=>{
 let state,opts;
 const f=setup(t,{registered:true,configureClient:o=>{opts=o;state=o.store.load()??recoveryState(o);return {async publishMove(review){state.proofs[review.nonce]={envelope:{record:{p:'xmr20-joint',v:3,net:'mainnet',op:'burn',owner:native,mint:state.config.mint,program:state.config.program,amount:review.amount,nonce:review.nonce,to:state.config.owner,from:addresses(state.config).position.toBase58()}},phase:'publication-unknown',result:{txid:'ab'.repeat(32)}};opts.store.save(state);}};}});
 await f.ui.open({direction:'xmr-to-sol',amountRaw:'985000'});await f.preview();await clicked(f,'j3-return');
 assert.match(f.html,/class="bridge-steps"/);assert.match(f.html,/<li class="done">[^]*?Monero record published/);
 assert.ok(f.html.includes('href="https://xmrchain.net/tx/'+'ab'.repeat(32)+'"'),'Monero transaction link');
 assert.match(f.html,/<li class="active">[^]*?10 Monero confirmations[^]*?About 20 minutes/);assert.match(f.html,/<li class="todo">[^]*?Solana approval/);
 assert.ok(!f.elements.has('j3-return-retry'));assert.doesNotMatch(f.html,/has not reached the network/);
});

test('a saved return record that never reached Monero says so and offers only the exact retry',async t=>{
 let state,opts;const retried=[];
 const f=setup(t,{registered:true,configureClient:o=>{opts=o;state=o.store.load()??recoveryState(o);return {async publishMove(review){state.proofs[review.nonce]={envelope:{record:{p:'xmr20-joint',v:3,net:'mainnet',op:'burn',owner:native,mint:state.config.mint,program:state.config.program,amount:review.amount,nonce:review.nonce,to:state.config.owner,from:addresses(state.config).position.toBase58()}},phase:'publication-unknown'};opts.store.save(state);},async retryProof(nonce){retried.push(nonce);state.proofs[nonce].result={txid:'cd'.repeat(32)};opts.store.save(state);return state.proofs[nonce].result;}};}});
 await f.ui.open({direction:'xmr-to-sol',amountRaw:'985000'});await f.preview();await clicked(f,'j3-return');
 assert.match(f.html,/has not reached the network yet/);assert.match(f.html,/<li class="blocked">[^]*?Publish your Monero record/);assert.doesNotMatch(f.html,/xmrchain\.net\/tx\//);
 assert.ok(f.elements.has('j3-return-retry'));assert.equal(f.signs,0);
 const nonce=Object.keys(state.proofs).find(k=>!state.proofs[k].result);await clicked(f,'j3-return-retry');
 assert.deepEqual(retried,[nonce],'retries exactly the saved record');assert.equal(f.signs,0,'no new signature');
});

test('published return stays on one saved continuation and cannot offer or replay another native approval',async t=>{
 let publications=0,state,opts;
 const f=setup(t,{registered:true,configureClient:o=>{opts=o;state=o.store.load()??recoveryState(o);return {async publishMove(review){publications++;state.proofs[review.nonce]={envelope:{record:{p:'xmr20-joint',v:3,net:'mainnet',op:'burn',owner:native,mint:state.config.mint,program:state.config.program,amount:review.amount,nonce:review.nonce,to:state.config.owner,from:addresses(state.config).position.toBase58()}},phase:'publication-unknown',result:{txid:'ab'.repeat(32)}};opts.store.save(state);}};}});
 await f.ui.open({direction:'xmr-to-sol',amountRaw:'985000'});await f.preview();const publish=f.elements.get('j3-return');
 await clicked(f,'j3-return');assert.equal(publications,1);assert.match(f.html,/Returning to Solana/);assert.match(f.html,/Waiting for 10 Monero confirmations/);
 assert.ok(f.elements.has('j3-pause-return'));assert.ok(!f.elements.has('j3-review'));assert.ok(!f.elements.has('j3-publish'));assert.ok(!f.elements.has('j3-bridge'));
 assert.equal([...f.html.matchAll(/class="primary wide"/g)].length,0);
 publish.onclick();for(let i=0;i<20&&f.d.isBusy();i++)await new Promise(r=>setImmediate(r));assert.equal(publications,1);
 await f.ui.open({direction:'xmr-to-sol'});assert.match(f.html,/Returning to Solana/);assert.ok(!f.elements.has('j3-review'));assert.equal(f.signs,0);
});

test('lost native publication reply preserves the exact saved return instead of offering a second approval',async t=>{
 let publications=0,reviewed;
 const f=setup(t,{registered:true,movesConfirmed:true,configureClient:o=>({async publishMove(review){publications++;const state=recoveryState(o);state.proofs[review.nonce]={envelope:{record:{p:'xmr20-joint',v:3,net:'mainnet',op:'burn',owner:native,mint:state.config.mint,program:state.config.program,amount:review.amount,nonce:review.nonce,to:state.config.owner,from:addresses(state.config).position.toBase58()}},phase:'publication-unknown'};o.store.save(state);throw Error('Synthetic lost reply');},async reviewMove(id){reviewed=id;throw Error('Synthetic record awaiting confirmations');}})});
 await f.ui.open({direction:'xmr-to-sol',amountRaw:'985000'});await f.preview();await clicked(f,'j3-return');
 assert.match(f.html,/publication is not yet confirmed/);assert.ok(!f.elements.has('j3-publish'));assert.ok(!f.elements.has('j3-review'));
 await clicked(f,'j3-move-0');assert.match(reviewed,/^[a-f0-9]{64}$/);assert.equal(publications,1);assert.match(f.html,/awaiting confirmations/);assert.ok(f.elements.has('j3-return'));assert.equal(f.signs,0);
});

test('saved Solana return approval is checked before any new release review',async t=>{
 let checks=0,reviews=0;
 const f=setup(t,{registered:true,configureClient:o=>{const state=recoveryState(o),id='ac'.repeat(32);state.proofs[id]={envelope:{record:{op:'burn',amount:'985000',nonce:id}},result:{txid:'ba'.repeat(32)}};state.operations.release={proposal:{operation:'release',nonce:id,amount:'985000'},phase:'submission-unknown'};o.store.save(state);return {async check(operation){checks++;assert.equal(operation,'release');return {pending:true};},async reviewMove(){reviews++;throw Error('Must not prepare another release');}};}});
 await f.ui.open({direction:'xmr-to-sol'});assert.match(f.html,/Check Solana confirmation/);assert.equal(checks,1);await clicked(f,'j3-resume-move-0');
 assert.equal(checks,2);assert.equal(reviews,0);assert.equal(f.signs,0);assert.ok(!f.elements.has('j3-review'));assert.ok(!f.elements.has('j3-publish'));
});

test('two old return records retain both receipts but continue the earliest without publishing another',async t=>{
 const ids=['bc'.repeat(32),'cd'.repeat(32)];let continued;
 const f=setup(t,{registered:true,movesConfirmed:true,configureClient:o=>{const state=recoveryState(o);ids.forEach((id,i)=>{state.proofs[id]={envelope:{record:{op:'burn',nonce:id,amount:'985000'}},result:{txid:(i?'ab':'de').repeat(32)}};});o.store.save(state);return {async reviewMove(id){continued=id;throw Error('Synthetic waiting for confirmation');}};}});
 await f.ui.open({direction:'xmr-to-sol'});assert.equal([...f.html.matchAll(/class="primary wide"/g)].length,1);assert.match(f.html,/Additional saved records/);
 assert.ok(f.elements.has('j3-proof-0'));assert.ok(f.elements.has('j3-proof-1'));assert.ok(!f.elements.has('j3-review'));
 await clicked(f,'j3-move-0');assert.equal(continued,ids[0]);assert.equal(f.signs,0);assert.equal(f.approvals,0);
});

test('an already signed Solana release takes precedence over an earlier unsubmitted return proof',async t=>{
 const ids=['ab'.repeat(32),'ba'.repeat(32)];let checked;
 const f=setup(t,{registered:true,configureClient:o=>{const state=recoveryState(o);ids.forEach(id=>{state.proofs[id]={envelope:{record:{op:'burn',nonce:id,amount:'985000'}}};});state.operations.second={proposal:{operation:'release',nonce:ids[1],amount:'985000'},phase:'submission-unknown'};o.store.save(state);return {async check(id){checked=id;return {pending:true};},async reviewMove(){throw Error('Must check the signed release first');}};}});
 await f.ui.open({direction:'xmr-to-sol'});assert.match(f.html,/Check Solana confirmation/);await clicked(f,'j3-resume-move-0');assert.equal(checked,'second');assert.equal(f.signs,0);
});

test('a return below confirmed history waits normally and prepares only after its exact receipt appears',async t=>{
 const id='ad'.repeat(32);let confirmed=false,reviews=0;
 const f=setup(t,{registered:true,configureClient:o=>{const state=recoveryState(o);state.proofs[id]={envelope:{record:{op:'burn',nonce:id,amount:'985000'}},result:{txid:'da'.repeat(32)}};o.store.save(state);return {
  async snapshot(){return {schema:'joint-index-v3',manifest:o.manifest,complete:true,positions:[{position:addresses(state.config).position.toBase58(),available:'985000'}],pending:[{operation:'burn',receipt:receiptAddress(state.config,confirmed?id:'ae'.repeat(32)).toBase58()}],accepted:[]};},
  async reviewMove(nonce){reviews++;assert.equal(nonce,id);return {proposal:{operation:'release',nonce:id,amount:'985000',expectedFee:'14775'},envelope:state.proofs[id].envelope};}
 };}});
 await f.ui.open({direction:'xmr-to-sol'});await clicked(f,'j3-move-0');
 assert.equal(reviews,0);assert.match(f.html,/Waiting for 10 Monero confirmations/);assert.doesNotMatch(f.html,/joint-error|service could not finish/);assert.ok(!f.elements.has('j3-confirm'));
 confirmed=true;await clicked(f,'j3-move-0');assert.equal(reviews,1);assert.match(f.html,/Review return/);assert.ok(f.elements.has('j3-confirm'));assert.equal(f.signs,0);
});

test('an unavailable return snapshot stays a service error, never a fabricated confirmation status',async t=>{
 let fail=false,reviews=0;
 const f=setup(t,{registered:true,configureClient:o=>{const state=recoveryState(o),id='af'.repeat(32);state.proofs[id]={envelope:{record:{op:'burn',nonce:id,amount:'985000'}},result:{txid:'fa'.repeat(32)}};o.store.save(state);return {async snapshot(){if(fail)throw Error('Transferable service unavailable. Keep the public recovery receipt.');return {schema:'joint-index-v3',manifest:o.manifest,complete:true,positions:[{position:addresses(state.config).position.toBase58(),available:'985000'}]};},async reviewMove(){reviews++;}};}});
 await f.ui.open({direction:'xmr-to-sol'});await clicked(f,'j3-move-0');assert.match(f.html,/The latest history check has not confirmed this record yet/);fail=true;await clicked(f,'j3-move-0');assert.match(f.html,/bridge service could not finish this request/);assert.doesNotMatch(f.html,/The latest history check has not confirmed this record yet/);assert.equal(reviews,0);assert.equal(f.signs,0);
});

function automaticReturn(t,{deferSigning=false}={}){
 const timers=new Map();let next=0,options,state,release,publications=0,signatures=0;
 const f=setup(t,{registered:true,movesConfirmed:true,uiOptions:{setTimer:fn=>{timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id)},configureClient:o=>{
  options=o;state=recoveryState(o);
  return {
   async publishMove({amount,nonce}){publications++;state.proofs[nonce]={envelope:{record:{p:'xmr20-joint',v:3,net:'mainnet',op:'burn',owner:native,mint:state.config.mint,program:state.config.program,amount,nonce,to:state.config.owner,from:addresses(state.config).position.toBase58()},signature:'synthetic'},result:{txid:'ab'.repeat(32)}};o.store.save(state);},
   async reviewMove(nonce){return {config:state.config,proposal:{operation:'release',nonce,amount:'985000',expectedFee:'14775'},envelope:state.proofs[nonce].envelope};},
   async approveMove(review){if(deferSigning)await new Promise(r=>release=r);options.provider.assertCurrent();signatures++;state.operations.return={...review,phase:'submission-unknown'};o.store.save(state);return {operationId:'return'};},
   async check(){state.operations.return.phase='finalized';o.store.save(state);return {confirmed:true};}
  };
 }});
 return {f,get publications(){return publications;},get signatures(){return signatures;},get pending(){return !!release;},release:()=>release(),tick(){const [id,fn]=timers.entries().next().value??[];assert.ok(fn,'return continuation scheduled');timers.delete(id);fn();}};
}

test('one return button automatically completes both approvals and confirmation without review or continue clicks',async t=>{
 const a=automaticReturn(t),f=a.f;await f.ui.open({direction:'xmr-to-sol',amountRaw:'985000'});await f.preview();
 assert.match(f.html,/0\.014775 XMR20/);assert.match(f.html,/data-raw="970225"/);assert.ok(f.html.includes(f.a.sol));assert.equal(a.publications,0);assert.equal(a.signatures,0);
 await clicked(f,'j3-return');assert.equal(a.publications,1);assert.equal(a.signatures,0);assert.ok(!f.elements.has('j3-confirm'));assert.ok(!f.elements.has('j3-publish'));
 a.tick();for(let i=0;i<30&&f.d.isBusy();i++)await new Promise(r=>setImmediate(r));assert.equal(a.signatures,1);assert.match(f.html,/Waiting for Solana confirmation/);
 a.tick();for(let i=0;i<30&&f.d.isBusy();i++)await new Promise(r=>setImmediate(r));assert.match(f.html,/Your return is confirmed on Solana/);assert.equal(a.signatures,1);assert.equal(a.publications,1);
});

test('an automatic return keeps checking while Monero confirms and continues once the burn is confirmed (26 Oct stall)',async t=>{
 const timers=new Map();let next=0,state,confirmed=false,snapshots=0,signatures=0;
 const f=setup(t,{registered:true,uiOptions:{setTimer:(fn,delay)=>{timers.set(++next,{fn,delay});return next;},clearTimer:id=>timers.delete(id)},configureClient:o=>{
  state=recoveryState(o);
  return {
   async snapshot(){snapshots++;const nonce=Object.keys(state.proofs)[0];return {schema:'joint-index-v3',manifest:o.manifest,complete:true,positions:[{position:addresses(state.config).position.toBase58(),available:'985000'}],accepted:[],pending:confirmed&&nonce?[{operation:'burn',receipt:receiptAddress(state.config,nonce).toBase58()}]:[]};},
   async publishMove({amount,nonce}){state.proofs[nonce]={envelope:{record:{p:'xmr20-joint',v:3,net:'mainnet',op:'burn',owner:native,mint:state.config.mint,program:state.config.program,amount,nonce,to:state.config.owner,from:addresses(state.config).position.toBase58()},signature:'synthetic'},result:{txid:'ab'.repeat(32)}};o.store.save(state);},
   async reviewMove(nonce){return {config:state.config,proposal:{operation:'release',nonce,amount:'985000',expectedFee:'14775'},envelope:state.proofs[nonce].envelope};},
   async approveMove(review){signatures++;state.operations.return={...review,phase:'submission-unknown'};o.store.save(state);return {operationId:'return'};},
   async check(){state.operations.return.phase='finalized';o.store.save(state);return {confirmed:true};}
  };
 }});
 const settle=async()=>{for(let i=0;i<60&&(f.d.isBusy()||[...timers.values()].length===0);i++)await new Promise(r=>setImmediate(r));};
 const fire=async()=>{const entries=[...timers.entries()];const ret=entries.find(([,v])=>v.delay===60000)??entries[0];assert.ok(ret,'a continuation is scheduled');timers.delete(ret[0]);await ret[1].fn();await settle();return ret[1].delay;};
 await f.ui.open({direction:'xmr-to-sol',amountRaw:'985000'});await f.preview();await clicked(f,'j3-return');await settle();
 const log=[];
 for(let i=0;i<4;i++){log.push(await fire());assert.match(f.html,/10 Monero confirmations/,'still waiting while unconfirmed');assert.equal(signatures,0);}
 confirmed=true;
 for(let i=0;i<4&&signatures===0;i++)log.push(await fire());
 assert.equal(signatures,1,'the Solana step ran automatically after confirmation; fired delays: '+JSON.stringify(log)+' timers left: '+JSON.stringify([...timers.values()].map(v=>v.delay)));
});

test('extension returns ask the background to watch once published, say the wallet can close, and stop watching when complete',async t=>{
 const timers=new Map();let next=0,state,confirmed=false;const calls=[];
 const f=setup(t,{registered:true,uiOptions:{setTimer:(fn,delay)=>{timers.set(++next,{fn,delay});return next;},clearTimer:id=>timers.delete(id)},configureClient:o=>{
  state=recoveryState(o);
  return {
   async snapshot(){const nonce=Object.keys(state.proofs)[0];return {schema:'joint-index-v3',manifest:o.manifest,complete:true,positions:[{position:addresses(state.config).position.toBase58(),available:'985000'}],accepted:[],pending:confirmed&&nonce?[{operation:'burn',receipt:receiptAddress(state.config,nonce).toBase58()}]:[]};},
   async publishMove({amount,nonce}){state.proofs[nonce]={envelope:{record:{p:'xmr20-joint',v:3,net:'mainnet',op:'burn',owner:native,mint:state.config.mint,program:state.config.program,amount,nonce,to:state.config.owner,from:addresses(state.config).position.toBase58()},signature:'synthetic'},result:{txid:'ab'.repeat(32)}};o.store.save(state);},
   async reviewMove(nonce){return {config:state.config,proposal:{operation:'release',nonce,amount:'985000',expectedFee:'14775'},envelope:state.proofs[nonce].envelope};},
   async approveMove(review){state.operations.return={...review,phase:'submission-unknown'};o.store.save(state);return {operationId:'return'};},
   async check(){state.operations.return.phase='finalized';o.store.save(state);return {confirmed:true};}
  };
 }});
 f.d.notifyReturn=m=>calls.push(m);
 const settle=async()=>{for(let i=0;i<60&&(f.d.isBusy()||timers.size===0);i++)await new Promise(r=>setImmediate(r));};
 const fire=async()=>{const [id,v]=[...timers.entries()].find(([,v])=>v.delay===60000)??[...timers.entries()][0];timers.delete(id);await v.fn();await settle();};
 await f.ui.open({direction:'xmr-to-sol',amountRaw:'985000'});await f.preview();await clicked(f,'j3-return');await settle();
 const nonce=Object.keys(state.proofs)[0];
 assert.deepEqual(calls,[{action:'watch',mint:state.config.mint,nonce,receipt:receiptAddress(state.config,nonce).toBase58(),amount:'0.970225',symbol:'XMR20'}]);
 assert.match(f.html,/You can close the wallet while Monero confirms/);assert.doesNotMatch(f.html,/Keep this wallet open and unlocked/);
 await fire();assert.equal(calls.length,1,'one watch request per return');
 confirmed=true;for(let i=0;i<6&&!calls.some(c=>c.action==='done');i++)await fire();
 assert.deepEqual(calls.at(-1),{action:'done',nonce});assert.match(f.html,/Your return is confirmed on Solana|Returned to Solana/);
});

test('pausing during final preparation revokes the actual provider guard before it can sign',async t=>{
 const a=automaticReturn(t,{deferSigning:true}),f=a.f;await f.ui.open({direction:'xmr-to-sol',amountRaw:'985000'});await f.preview();await clicked(f,'j3-return');
 a.tick();for(let i=0;i<30&&!a.pending;i++)await new Promise(r=>setImmediate(r));assert.ok(a.pending);f.elements.get('j3-pause-return').onclick();a.release();for(let i=0;i<30&&f.d.isBusy();i++)await new Promise(r=>setImmediate(r));
 assert.equal(a.signatures,0);assert.match(f.html,/Automatic completion is paused/);assert.ok(!f.elements.has('j3-publish'));assert.ok(f.elements.has('j3-return'));
});

test('a failed saved-return connection offers reconnect above the saved amount, without a fake fee spinner or disabled resume',async t=>{
 let fail=true;
 const f=setup(t,{registered:true,configureClient:o=>{const state=recoveryState(o),id='ba'.repeat(32);state.proofs[id]={envelope:{record:{op:'burn',nonce:id,amount:'985000'}},result:{txid:'ab'.repeat(32)}};o.store.save(state);return {async snapshot(){if(fail)throw Error('Synthetic interrupted history request');return {schema:'joint-index-v3',manifest:o.manifest,complete:true,positions:[{position:addresses(state.config).position.toBase58(),available:'985000'}]};}};}});
 await f.ui.open({direction:'xmr-to-sol'});assert.match(f.html,/Bridge connection unavailable/);assert.match(f.html,/Reconnect bridge/);
 assert.ok(f.html.indexOf('id="j3-ready"')<f.html.indexOf('Returning to Solana'));assert.ok(!f.elements.has('j3-return'));assert.doesNotMatch(f.html,/Checking the amount and token fee/);
 fail=false;await clicked(f,'j3-ready');await f.preview();assert.equal(f.elements.get('j3-return').disabled,false);assert.equal(f.signs,0);
});

test('wallet testing exposes all token and holder actions for a different selected wallet',async t=>{
 const f=setup(t,{privateTest:true,authorizedAccount:false,registered:true,uiOptions:{walletTest:true},ready:async()=>({manifest:transferableManifest(XMR20_MINT),privateTestPolicy:WALLET_TEST_POLICY})});await f.ui.open({rows:[{mint:XCAT_MINT}]});
 assert.match(f.html,/Any linked wallet/);assert.match(f.html,/upgradeable/);assert.ok(!f.html.includes(XCAT_MINT));for(const label of ['Airdrop to a registered','Send to another','Bridge back to my'])assert.ok(f.html.includes(label));await f.preview();assert.equal(f.elements.get('j3-bridge').disabled,false);assert.equal(f.signs,0);
});
test('bridge controls and cached balances paint before a stalled history request; no cached approval is enabled',async t=>{
 let release;const stalled=new Promise(r=>release=r),f=setup(t,{registered:true,ready:()=>stalled});
 const {saveBridgeDisplay}=await import('../../engine/shared/bridge-display.js'),manifest=transferableManifest(XMR20_MINT),position=addresses({...manifest,owner:f.a.sol,binding:digest(native)}).position.toBase58();
 saveBridgeDisplay(f.a,manifest,{schema:'joint-index-v3',complete:true,manifest,positions:[{position,available:'985000'}]});
 f.d.rows=()=>[{network:'solana',mint:XMR20_MINT,amountRaw:'123456789'}];
 const start=performance.now(),opening=f.ui.open();await new Promise(r=>setImmediate(r));
 assert.ok(performance.now()-start<5000);assert.match(f.html,/123\.46/);assert.match(f.html,/Last known: 0\.99/);assert.match(f.html,/Last known/);
 assert.equal(f.elements.get('j3-token').disabled,false);assert.equal(f.elements.get('j3-amount').disabled,false);assert.equal(f.elements.get('j3-bridge').disabled,true);assert.equal(f.signs,0);
 release({ready:true,manifest});await opening;
});
test('Monero Max fills the exact available amount without signing',async t=>{
 const f=setup(t,{registered:true});await f.ui.open({direction:'xmr-to-xmr'});await f.elements.get('j3-amount-max').onclick();assert.match(f.html,/value="98.50"/);assert.equal(f.signs,0);assert.equal(f.approvals,0);
});

test('a saved Solana return is reconciled on open without waiting for a full history scan',async t=>{
 let state,opts,historyReads=0,checks=0;
 const f=setup(t,{configureClient:o=>{opts=o;state=recoveryState(o);const id='cd'.repeat(32);state.proofs[id]={envelope:{record:{op:'burn',amount:'985000',nonce:id}},result:{txid:'ab'.repeat(32)}};state.operations.release={proposal:{operation:'release',nonce:id,amount:'985000',expectedFee:'14775'},phase:'submission-unknown'};o.store.save(state);return {
  async check(){checks++;return {pending:true};},
  async snapshot(){historyReads++;throw Error('Full history is not needed to check a saved Solana approval');}
 };}});
 await f.ui.open({direction:'xmr-to-sol'});
 assert.equal(checks,1);assert.equal(historyReads,0);assert.equal(f.elements.get('j3-resume-move-0').disabled,false);assert.equal(f.signs,0);
});

test('a finalized saved return is visible before slow history and never reoffers that return',async t=>{
 let releaseHistory,historyReads=0;
 const history=new Promise(r=>releaseHistory=r);
 const f=setup(t,{configureClient:o=>{const state=recoveryState(o),id='dc'.repeat(32);state.proofs[id]={envelope:{record:{op:'burn',amount:'985000',nonce:id}},result:{txid:'ba'.repeat(32)}};state.operations.release={proposal:{operation:'release',nonce:id,amount:'985000',expectedFee:'14775'},phase:'submission-unknown'};o.store.save(state);return {
  async check(){state.operations.release.phase='finalized';o.store.save(state);return {confirmed:true};},
  async snapshot(){historyReads++;await history;return {schema:'joint-index-v3',complete:true,manifest:o.manifest,positions:[{position:addresses(state.config).position.toBase58(),available:'0'}]};}
 };}});
 const opening=f.ui.open();await new Promise(r=>setImmediate(r));
 assert.equal(historyReads,1);assert.match(f.html,/Returned to Solana/);assert.match(f.html,/0\.970225/);assert.ok(!f.elements.has('j3-return'));assert.equal(f.signs,0);
 releaseHistory();await opening;assert.match(f.html,/Returned to Solana/);assert.ok(!f.elements.has('j3-return'));assert.ok(!f.elements.has('j3-move-0'));assert.ok(!f.elements.has('j3-proof-0'));
});

test('history completing during amount entry preserves focus, selection and expanded recovery',async t=>{
 let done;const waiting=new Promise(r=>done=r),f=setup(t,{registered:true,ready:()=>waiting});
 const opening=f.ui.open();await new Promise(r=>setImmediate(r));
 const input=f.elements.get('j3-amount');input.focus();input.selectionStart=2;input.selectionEnd=3;input.oninput({target:{value:'12.345'}});
 const recovery=f.elements.get('j3-receipts');assert.ok(recovery);recovery.open=true;
 done({manifest:transferableManifest(XMR20_MINT)});await opening;
 assert.match(f.html,/value="12\.345"/);assert.equal(document.activeElement.id,'j3-amount');assert.equal(document.activeElement.selectionStart,2);assert.equal(document.activeElement.selectionEnd,3);assert.equal(f.elements.get('j3-receipts').open,true);
});

test('saved Solana checks poll without replaying native history and stop on close',async t=>{
 const timers=new Map();let timerId=0,checks=0,finish;
 const f=setup(t,{uiOptions:{setTimer:fn=>{timers.set(++timerId,fn);return timerId;},clearTimer:id=>timers.delete(id)},configureClient:o=>{const state=recoveryState(o),id='ed'.repeat(32);state.proofs[id]={envelope:{record:{op:'burn',nonce:id,amount:'985000'}}};state.operations.release={proposal:{operation:'release',nonce:id,amount:'985000'},phase:'submission-unknown'};o.store.save(state);return {
  async check(){if(++checks===2)await new Promise(r=>finish=r);return {pending:true};},
  async snapshot(){assert.fail('Pending Solana confirmation does not need history');}
 };}});
 await f.ui.open();assert.equal(checks,1);assert.equal(timers.size,1);
 const [id,poll]=timers.entries().next().value;timers.delete(id);const polling=poll();await new Promise(r=>setImmediate(r));assert.equal(checks,2);
 f.ui.clear();const renders=f.renders;finish();await polling;assert.equal(f.renders,renders);assert.equal(timers.size,0);assert.equal(f.signs,0);
});

test('a failed automatic Solana status check keeps the exact manual check available without signing',async t=>{
 let checks=0;
 const f=setup(t,{configureClient:o=>{const state=recoveryState(o),id='de'.repeat(32);state.proofs[id]={envelope:{record:{op:'burn',nonce:id,amount:'985000'}}};state.operations.release={proposal:{operation:'release',nonce:id,amount:'985000'},phase:'submission-unknown'};o.store.save(state);return {async check(){checks++;if(checks===1)throw Error('Synthetic connection failure');return {pending:true};},async snapshot(){assert.fail('No native replay during a saved approval check');}};}});
 await f.ui.open();assert.equal(f.elements.get('j3-resume-move-0').disabled,false);assert.ok(!f.elements.has('j3-return'));assert.ok(!f.elements.has('j3-ready'));
 await clicked(f,'j3-resume-move-0');assert.equal(checks,2);assert.equal(f.signs,0);assert.equal(f.approvals,0);assert.doesNotMatch(f.html,/joint-error/);
});

test('an index-sync response automatically retries only the read and then enables the verified form',async t=>{
 const timers=new Map();let timerId=0,reads=0;const sync=()=>Object.assign(Error('Sanitized sync status'),{code:'index-sync'});
 const f=setup(t,{uiOptions:{setTimer:(fn,delay)=>{assert.equal(delay,15000);timers.set(++timerId,fn);return timerId;},clearTimer:id=>timers.delete(id)},configureClient:o=>({async snapshot(){if(++reads===1)throw sync();return {schema:'joint-index-v3',complete:true,manifest:o.manifest,positions:[]};}})});
 await f.ui.open();assert.match(f.html,/Syncing recent Monero blocks/);assert.match(f.html,/updates automatically/);assert.ok(!f.elements.has('j3-ready'));assert.equal(timers.size,1);assert.equal(f.signs,0);assert.equal(f.approvals,0);
 document.hidden=true;let [id,retry]=timers.entries().next().value;timers.delete(id);await retry();assert.equal(reads,1);assert.equal(timers.size,1);
 document.hidden=false;[id,retry]=timers.entries().next().value;timers.delete(id);await retry();assert.equal(reads,2);assert.equal(f.elements.get('j3-register').disabled,false);assert.equal(timers.size,0);assert.equal(f.signs,0);assert.equal(f.approvals,0);assert.doesNotMatch(f.html,/syncing recent/);
});

test('sync retry stops on close and an ordinary network failure remains an explicit reconnect',async t=>{
 const timers=new Map();let timerId=0,reads=0,offline=false;
 const f=setup(t,{uiOptions:{setTimer:fn=>{timers.set(++timerId,fn);return timerId;},clearTimer:id=>timers.delete(id)},configureClient:()=>({async snapshot(){reads++;throw offline?Error('Synthetic offline'):Object.assign(Error('Sanitized sync status'),{code:'index-sync'});}})});
 await f.ui.open();const retry=timers.values().next().value;f.ui.clear();assert.equal(timers.size,0);await retry();assert.equal(reads,1);
 await f.ui.open();offline=true;const [id,next]=timers.entries().next().value;timers.delete(id);await next();assert.equal(timers.size,0);assert.equal(f.elements.get('j3-ready').disabled,false);assert.doesNotMatch(f.html,/syncing recent/);assert.equal(f.signs,0);
});

test('a syncing amount preview keeps the entered amount and requires fresh history and a fresh quote before approval',async t=>{
 const timers=new Map();let timerId=0,reads=0;const amounts=[];
 const f=setup(t,{registered:true,ready:async()=>{reads++;return {manifest:transferableManifest(XMR20_MINT)};},uiOptions:{setTimer:(fn,delay)=>{assert.equal(delay,15000);timers.set(++timerId,fn);return timerId;},clearTimer:id=>timers.delete(id)},configureClient:()=>({async reviewCredit(input){amounts.push(input.amount);if(amounts.length===1)throw Object.assign(Error('Sanitized synchronization'),{code:'index-sync'});return {proposal:{operation:'deposit',amount:input.amount,expectedFee:'30000',nonce:input.nonce},envelope:{record:{owner:native}}};}})});
 await f.ui.open();await f.preview();assert.match(f.html,/Syncing recent Monero blocks/);assert.equal(timers.size,1);assert.equal(f.elements.get('j3-bridge').disabled,true);
 f.elements.get('j3-amount').oninput({target:{value:'2'}});assert.deepEqual(amounts,['1000000']);
 const [id,retry]=timers.entries().next().value;timers.delete(id);await retry();assert.equal(reads,2);assert.equal(f.elements.get('j3-bridge').disabled,true);assert.deepEqual(amounts,['1000000']);
 await f.preview();assert.deepEqual(amounts,['1000000','2000000']);assert.match(f.html,/value="2\.00" title="2"/);assert.equal(f.elements.get('j3-bridge').disabled,false);assert.equal(timers.size,0);assert.equal(f.signs,0);assert.equal(f.approvals,0);
});

test('generic bridge opens the held token and a late launch catalog cannot add unowned tokens or reset typing',async t=>{
 let catalog;const f=setup(t,{holdings:[{network:'solana',mint:XCAT_MINT,amountRaw:'9000'}],registered:true,uiOptions:{loadCatalog:()=>new Promise(resolve=>catalog=resolve)}});
 await f.ui.open();assert.match(f.html,new RegExp('value="'+XCAT_MINT+'" selected'));assert.ok(!f.html.includes('value="'+XMR20_MINT+'"'));
 const input=f.elements.get('j3-amount');input.focus();input.selectionStart=2;input.selectionEnd=3;input.oninput({target:{value:'12.34'}});
 catalog([{mint:XMR20_MINT},{mint:XCAT_MINT}]);await new Promise(r=>setImmediate(r));
 assert.match(f.html,/value="12\.34"/);assert.equal(document.activeElement.id,'j3-amount');assert.equal(document.activeElement.selectionStart,2);assert.ok(!f.html.includes('value="'+XMR20_MINT+'"'));assert.equal(f.signs,0);
});

test('empty bridge has no default tokens or financial reads, and late holdings populate it automatically',async t=>{
 let reads=0;const holdings=[],f=setup(t,{holdings,configureClient:()=>({async snapshot(){reads++;return {schema:'joint-index-v3',complete:true,manifest:transferableManifest(XCAT_MINT),positions:[]};}})});
 await f.ui.open();assert.match(f.html,/No bridgeable tokens found/);assert.ok(!f.elements.has('j3-token'));assert.ok(f.elements.has('j3-import-empty'));assert.equal(reads,0);
 holdings.push({network:'solana',mint:XCAT_MINT,amountRaw:'1'});f.ui.refreshAssets();for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));
 assert.equal(reads,1);assert.match(f.html,new RegExp('value="'+XCAT_MINT+'" selected'));assert.equal(f.signs,0);
});

test('holdings refresh preserves the selected token and input while adding another held token only',async t=>{
 const holdings=[{network:'solana',mint:XCAT_MINT,amountRaw:'1'}],f=setup(t,{holdings,registered:true});
 await f.ui.open();f.elements.get('j3-amount').oninput({target:{value:'0.75'}});
 holdings[0].amountRaw='0';holdings.push({network:'monero',bridge:'joint-v3',mint:XMR20_MINT,amountRaw:'4'});f.ui.refreshAssets();
 assert.match(f.html,/value="0\.75"/);assert.match(f.html,new RegExp('value="'+XCAT_MINT+'" selected'));assert.ok(f.html.includes('value="'+XMR20_MINT+'"'));
 f.ui.clear();const renders=f.renders;f.ui.refreshAssets();assert.equal(f.renders,renders);assert.equal(f.signs,0);
});

test('an explicit positive portfolio row is preserved but an unowned catalog mint waits for a balance',async t=>{
 const f=setup(t,{holdings:[]});await f.ui.open({mint:XCAT_MINT,rows:[{mint:XCAT_MINT}]});assert.match(f.html,/Waiting for this token’s balance/);assert.ok(!f.elements.has('j3-token'));
 await f.ui.open({mint:XCAT_MINT,rows:[{network:'monero',bridge:'joint-v3',mint:XCAT_MINT,amountRaw:'1'}]});assert.match(f.html,new RegExp('value="'+XCAT_MINT+'" selected'));assert.equal(f.signs,0);
});

test('zero-balance saved return remains discoverable only for its linked wallet',async t=>{
 let checks=0;const f=setup(t,{holdings:[],configureClient:()=>({check:async()=>{checks++;return {pending:true};}})});
 const m=transferableManifest(XCAT_MINT),config={abi:3,network:m.network,program:m.program,mint:m.mint,verifier:m.verifier,owner:f.a.sol,binding:digest(native)},store=publicReceiptStore({config,moneroOwner:native});
 store.save({schema:'joint-owner-v3',scope:digest(awaitCanonical(config)),config,moneroOwner:native,proofs:{},operations:{return:{proposal:{operation:'release',amount:'1',nonce:'ab'.repeat(32)},phase:'submission-unknown'}}});
 await f.ui.open();assert.equal(checks,1);assert.ok(f.elements.has('j3-token'));assert.match(f.html,new RegExp('value="'+XCAT_MINT+'" selected'));
 f.a.sol=Keypair.generate().publicKey.toBase58();await f.ui.open();assert.match(f.html,/No bridgeable tokens found/);assert.equal(checks,1);assert.equal(f.signs,0);
});

test('generic bridge selects the return direction when only new Monero holdings exist',async t=>{
 const f=setup(t,{registered:true,holdings:[{network:'monero',bridge:'joint-v3',mint:XMR20_MINT,amountRaw:'985000'}]});
 await f.ui.open();assert.match(f.html,/<option value="release" selected>/);assert.ok(f.elements.has('j3-return'));assert.equal(f.signs,0);
});

test('a held launch such as COVERT becomes the default instead of adding XMR20 or zero XCAT',async t=>{
 const mint=Keypair.generate().publicKey.toBase58(),f=setup(t,{holdings:[{network:'solana',mint,amountRaw:'9000000000',ticker:'COVERT',name:'Covert'},{network:'solana',mint:XCAT_MINT,amountRaw:'0'}],configureClient:o=>({snapshot:async()=>({schema:'joint-index-v3',complete:true,manifest:o.manifest,positions:[]})})});
 await f.ui.open();assert.match(f.html,new RegExp('value="'+mint+'" selected>COVERT'));assert.ok(!f.html.includes('value="'+XMR20_MINT+'"'));assert.ok(!f.html.includes('value="'+XCAT_MINT+'"'));assert.equal(f.signs,0);
});

test('an explicit delayed token waits for its own holding and preserves amount and direction when another holding arrives first',async t=>{
 const mint=Keypair.generate().publicKey.toBase58(),holdings=[];let reads=0;
 const f=setup(t,{holdings,configureClient:o=>({snapshot:async()=>{reads++;return {schema:'joint-index-v3',complete:true,manifest:o.manifest,positions:[{position:addresses(recoveryState(o).config).position.toBase58(),available:'12000000'}]};}})});
 await f.ui.open({mint,amountRaw:'1234567',direction:'xmr-to-xmr'});assert.match(f.html,/Waiting for this token’s balance/);assert.equal(reads,0);
 holdings.push({mint:XMR20_MINT,network:'solana',amountRaw:'500'});f.ui.refreshAssets();await new Promise(r=>setImmediate(r));assert.equal(reads,0);assert.ok(!f.elements.has('j3-token'));
 holdings.push({mint,network:'monero',bridge:'joint-v3',amountRaw:'12000000',ticker:'COVERT'});f.ui.refreshAssets();for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));
 assert.equal(reads,1);assert.match(f.html,/monero-send-form/);assert.match(f.html,/COVERT/);assert.match(f.html,/value="1\.23" title="1\.234567"/);assert.ok(!f.elements.has('j3-operation'));assert.equal(f.signs,0);
});

test('invalid and limited-policy explicit mints fail accurately before any balance lookup',async t=>{
 const f=setup(t,{privateTest:true,holdings:[]});await assert.rejects(()=>f.ui.open({mint:'not-a-mint'}),/valid token mint/);await assert.rejects(()=>f.ui.open({mint:XCAT_MINT}),/private test supports XMR20 only/);assert.equal(f.signs,0);
});

test('generic opening chooses a held token before an unrelated zero-balance recovery token',async t=>{
 const mint=Keypair.generate().publicKey.toBase58(),f=setup(t,{holdings:[{mint,network:'solana',amountRaw:'3',ticker:'COVERT'}]});
 const m=transferableManifest(XMR20_MINT),config={abi:3,network:m.network,program:m.program,mint:m.mint,verifier:m.verifier,owner:f.a.sol,binding:digest(native)};
 publicReceiptStore({config,moneroOwner:native}).save({schema:'joint-owner-v3',scope:digest(awaitCanonical(config)),config,moneroOwner:native,proofs:{},operations:{r:{proposal:{operation:'release',nonce:'ab'.repeat(32),amount:'1'},phase:'submission-unknown'}}});
 await f.ui.open();assert.match(f.html,new RegExp('value="'+mint+'" selected>COVERT'));assert.ok(f.html.includes('value="'+XMR20_MINT+'"'));assert.equal(f.signs,0);
});

test('overlapping bridge panels keep input handlers, progress and passive focus inside their own host',async t=>{
 let finish,stage;const pending=new Promise(resolve=>finish=resolve),listeners=new Set();
 const f=setup(t,{registered:true,ready:()=>pending,configureClient:options=>{stage=options.onProgress;return {};}});
 f.d.getElement=id=>f.elements.get(id);
 const foreign=new Map(['j3-amount','j3-token','joint-stage','joint-elapsed','progress'].map(id=>[id,{id,tagName:'INPUT',textContent:'Other panel',dataset:{paused:'false'},selectionStart:3,selectionEnd:4}]));
 document.getElementById=id=>foreign.get(id);document.addEventListener=(name,fn)=>{if(name==='visibilitychange')listeners.add(fn);};document.removeEventListener=(name,fn)=>{if(name==='visibilitychange')listeners.delete(fn);};
 const opening=f.ui.open();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(typeof f.elements.get('j3-amount').oninput,'function');assert.equal(typeof f.elements.get('j3-token').onchange,'function');assert.equal(foreign.get('j3-amount').oninput,undefined);assert.equal(foreign.get('j3-token').onchange,undefined);
 stage('Checking this panel’s saved approval…');assert.equal(f.elements.get('joint-stage').textContent,'Checking this panel’s saved approval…');assert.equal(foreign.get('joint-stage').textContent,'Other panel');
 f.elements.get('progress').dataset={};document.hidden=true;for(const update of listeners)update();assert.equal(f.elements.get('progress').dataset.paused,'true');assert.equal(foreign.get('progress').dataset.paused,'false');
 document.hidden=false;for(const update of listeners)update();assert.match(f.elements.get('joint-elapsed').textContent,/^[0-9]+s$/);assert.equal(foreign.get('joint-elapsed').textContent,'Other panel');
 document.activeElement=foreign.get('j3-amount');f.elements.get('j3-amount').oninput({target:{value:'12.34'}});f.ui.refreshAssets();assert.equal(document.activeElement,foreign.get('j3-amount'));
 finish({manifest:transferableManifest(XMR20_MINT)});await opening;assert.match(f.html,/value="12\.34"/);assert.equal(document.activeElement,foreign.get('j3-amount'));assert.equal(listeners.size,0);
 const own=f.elements.get('j3-amount');own.focus();own.selectionStart=1;own.selectionEnd=2;f.ui.refreshAssets();assert.equal(document.activeElement,f.elements.get('j3-amount'));assert.equal(document.activeElement.selectionStart,1);assert.equal(document.activeElement.selectionEnd,2);assert.equal(f.signs,0);assert.equal(f.approvals,0);
});

test('cancelling a stalled preparation releases the UI lock and ignores its late reply',async t=>{
 let finish,started=0;const blocked=new Promise(r=>finish=r);
 const f=setup(t,{configureClient:()=>({async reviewRegistration(nonce){started++;await blocked;return {proposal:{operation:'register',nonce},envelope:{record:{owner:native}}};}})});
 await f.ui.open();f.elements.get('j3-register').onclick();await new Promise(r=>setImmediate(r));
 assert.equal(f.d.isBusy(),true);await f.elements.get('j3-cancel-request').onclick();
 assert.equal(f.d.isBusy(),false);assert.match(f.html,/Request cancelled/);assert.ok(f.elements.has('j3-register'));
 finish();await new Promise(r=>setImmediate(r));assert.ok(!f.elements.has('j3-confirm'));assert.equal(started,1);
});
test('unsigned bridge draft expires at ten minutes, while submitted receipts never expire locally',async t=>{
 const timers=new Map();let next=0,store;
 const lifetimeOptions={setTimer:(fn,ms)=>{assert.equal(ms,600000);timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id)};
 const f=setup(t,{uiOptions:{lifetimeOptions},configureClient:o=>{store=o.store;return {};}});
 await f.ui.open();await clicked(f,'j3-register');assert.ok(f.elements.has('j3-confirm'));
 timers.values().next().value();await new Promise(r=>setImmediate(r));assert.match(f.html,/expired after 10 minutes/);assert.ok(!f.elements.has('j3-confirm'));
 await clicked(f,'j3-register');const old=store.load();assert.equal(old,null,'Unsigned fixture reviews do not create a transaction');
});

function delayedPublication(t,{operation='deposit',accepted='exact',confirmed=true,errorAt,holdAt}={}){
 const timers=new Map();let timerId=0,checkedAt=100,checks=0,snapshots=0,publishes=0,release,opts,state;
 const held=holdAt?new Promise(resolve=>release=resolve):null;
 const f=setup(t,{registered:true,uiOptions:{setTimer:fn=>{timers.set(++timerId,fn);return timerId;},clearTimer:id=>timers.delete(id)},configureClient:o=>{
  opts=o;state=recoveryState(o);const record={op:operation==='register'?'link':'credit',nonce:'ec'.repeat(32),owner:native,amount:'985000',to:state.config.owner,mint:o.manifest.mint,program:o.manifest.program};
  state.operations.saved={config:state.config,proposal:{operation,nonce:record.nonce,amount:'1000000'},envelope:{record,...(operation==='register'?{signature:'fixture-native-proof'}:{})},phase:'submission-unknown',ownerSignature:'fixture-owner-signature',publication:{txid:'ce'.repeat(32),confirmed:false}};o.store.save(state);
  return {
   async backgroundStatus(){state.operations.saved.background={enabled:true,phase:'delayed',checkedAt};opts.store.save(state);return {accepted:true,backgroundEnabled:true,phase:'delayed',checkedAt};},
   async check(){checks++;if(holdAt==='check')await held;if(errorAt==='check')throw Error('Synthetic custody check unavailable');if(confirmed)state.operations.saved.phase='finalized';opts.store.save(state);return {confirmed};},
   async snapshot(){snapshots++;if(holdAt==='snapshot')await held;if(errorAt==='snapshot')throw Error('Synthetic history unavailable');if(errorAt==='sync')throw Object.assign(Error('Synthetic synchronization'),{code:'index-sync'});
    const envelope=structuredClone(state.operations.saved.envelope);if(accepted==='wrong')envelope.record.nonce='ed'.repeat(32);if(accepted==='wrong-signature')envelope.signature='another-native-proof';
    return {schema:'joint-index-v3',complete:true,manifest:o.manifest,positions:[{position:addresses(state.config).position.toBase58(),available:'985000'}],accepted:accepted==='missing'?[]:[{envelope,txid:'ce'.repeat(32)}]};
   },
   async publishCreditOrLink(){publishes++;throw Error('Already published record must never be republished');}
  };
 }});
 return {...f,get html(){return f.html;},get renders(){return f.renders;},get signs(){return f.signs;},get approvals(){return f.approvals;},timers,get state(){return opts.store.load();},counts:()=>({checks,snapshots,publishes}),tick:()=>{checkedAt++;},release:()=>release?.(),async poll(){const [id,fn]=timers.entries().next().value??[];assert.ok(fn,'background poll is scheduled');timers.delete(id);await fn();}};
}
test('delayed published registration, deposit and donation finish only after exact accepted history and confirmed custody',async t=>{
 for(const operation of ['register','deposit','donate'])await t.test(operation,async t=>{
  const f=delayedPublication(t,{operation});await f.ui.open();assert.deepEqual(f.counts(),{checks:1,snapshots:1,publishes:0});assert.ok(f.elements.has('j3-bridge'));assert.ok(!f.elements.has('j3-background'));
  assert.equal(f.state.operations.saved.background.phase,'delayed');assert.equal(f.state.operations.saved.publication.confirmed,false);assert.equal(f.timers.size,0);assert.equal(f.signs,0);assert.equal(f.approvals,0);
 });
});
test('a displayed balance cannot finish a delayed publication with missing or different accepted proof',async t=>{
 for(const accepted of ['missing','wrong','wrong-signature'])await t.test(accepted,async t=>{
  const f=delayedPublication(t,{operation:accepted==='wrong-signature'?'register':'deposit',accepted});await f.ui.open();assert.ok(f.elements.has('j3-background'));assert.ok(!f.elements.has('j3-bridge'));assert.equal(f.state.operations.saved.publication.confirmed,false);assert.equal(f.signs,0);assert.equal(f.approvals,0);
 });
 await t.test('unconfirmed custody',async t=>{const f=delayedPublication(t,{confirmed:false});await f.ui.open();assert.deepEqual(f.counts(),{checks:1,snapshots:0,publishes:0});assert.ok(f.elements.has('j3-background'));});
});
test('delayed history recovery is bounded per observed service timestamp; manual checks and new timestamps may retry',async t=>{
 const f=delayedPublication(t,{accepted:'missing'});await f.ui.open();await f.poll();await f.poll();assert.deepEqual(f.counts(),{checks:1,snapshots:1,publishes:0});
 await clicked(f,'j3-background');assert.deepEqual(f.counts(),{checks:2,snapshots:2,publishes:0});await f.poll();assert.equal(f.counts().checks,2);
 f.tick();await f.poll();assert.deepEqual(f.counts(),{checks:3,snapshots:3,publishes:0});assert.equal(f.signs,0);assert.equal(f.approvals,0);
});
test('custody, snapshot and synchronization failures preserve recovery without repeatedly replaying delayed history',async t=>{
 for(const errorAt of ['check','snapshot','sync'])await t.test(errorAt,async t=>{
  const f=delayedPublication(t,{errorAt});await f.ui.open();const counts=f.counts();assert.ok(f.elements.has('j3-background'));assert.ok(f.elements.has('j3-export'));assert.ok(!f.elements.has('j3-bridge'));
  await f.poll();assert.deepEqual(f.counts(),counts);await clicked(f,'j3-background');assert.equal(f.counts().checks,2);assert.equal(f.counts().publishes,0);assert.equal(f.state.operations.saved.publication.confirmed,false);assert.equal(f.signs,0);assert.equal(f.approvals,0);
 });
});
test('closing or changing accounts during delayed reconciliation prevents completion and late rendering',async t=>{
 for(const holdAt of ['check','snapshot'])for(const action of ['close','account'])await t.test(holdAt+' '+action,async t=>{
  const f=delayedPublication(t,{holdAt}),opening=f.ui.open();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.counts()[holdAt==='check'?'checks':'snapshots'],1);
  if(action==='close')f.ui.clear();else f.a.sol=Keypair.generate().publicKey.toBase58();const renders=f.renders;f.release();
  if(action==='close')await opening;else await assert.rejects(()=>opening,/Wallet changed or locked/);
  assert.equal(f.renders,renders);assert.equal(f.counts().publishes,0);assert.equal(f.state.operations.saved.publication.confirmed,false);assert.equal(f.signs,0);assert.equal(f.approvals,0);
 });
});

test('an empty wallet explicitly enters receive setup and reviews registration without holding or spending tokens',async t=>{
 const f=setup(t,{holdings:[]});await f.ui.open();assert.equal(f.approvals,0);assert.ok(!f.elements.has('j3-token'));
 await f.elements.get('j3-receive-setup').onclick();assert.match(f.html,/No token balance|do not need to hold it first/);assert.ok(f.elements.has('j3-register'));assert.ok(!f.elements.has('j3-amount'));assert.equal(f.signs,0);assert.equal(f.approvals,0);
 await clicked(f,'j3-register');assert.match(f.html,/Link your wallets/);assert.ok(f.elements.has('j3-confirm'));assert.equal(f.approvals,1);assert.equal(f.signs,0);
});
test('receive setup retains an unowned token through catalog and holdings updates and token changes',async t=>{
 let catalog;const mint=Keypair.generate().publicKey.toBase58(),f=setup(t,{holdings:[],uiOptions:{loadCatalog:()=>new Promise(r=>catalog=r)},configureClient:o=>({snapshot:async()=>({schema:'joint-index-v3',manifest:o.manifest,complete:true,positions:[]})})});
 await f.ui.open({mint:XCAT_MINT,receiveSetup:true});assert.match(f.html,new RegExp('value="'+XCAT_MINT+'" selected'));
 catalog([{mint,symbol:'OTHER'}]);await new Promise(r=>setImmediate(r));f.ui.refreshAssets();assert.match(f.html,new RegExp('value="'+XCAT_MINT+'" selected'));assert.match(f.html,/OTHER/);
 f.elements.get('j3-token').onchange({target:{value:mint}});for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));assert.match(f.html,new RegExp('value="'+mint+'" selected'));assert.ok(f.elements.has('j3-register'));assert.equal(f.signs,0);
 await f.ui.open();assert.match(f.html,/No bridgeable tokens found/);assert.ok(!f.elements.has('j3-token'));
});
test('verified zero-balance link shows ready to receive without preparing a deposit',async t=>{
 let quotes=0;const f=setup(t,{holdings:[],configureClient:o=>({snapshot:async()=>({schema:'joint-index-v3',manifest:o.manifest,complete:true,positions:[{position:addresses(recoveryState(o).config).position.toBase58(),available:'0'}]}),reviewCredit:async()=>{quotes++;throw Error('Unexpected deposit preparation');}})});
 await f.ui.open({mint:XMR20_MINT,receiveSetup:true});assert.match(f.html,/Ready to receive XMR20/);assert.match(f.html,/No token deposit is required/);assert.ok(!f.elements.has('j3-register'));assert.ok(!f.elements.has('j3-bridge'));assert.ok(!f.elements.has('j3-amount'));assert.equal(quotes,0);assert.equal(f.signs,0);
});
test('receive setup still fails closed on unverified history and preserves a saved registration',async t=>{
 const f=setup(t,{holdings:[],snapshotComplete:false});await f.ui.open({mint:XMR20_MINT,receiveSetup:true});assert.ok(!f.elements.has('j3-register'));assert.doesNotMatch(f.html,/Ready to receive/);assert.equal(f.signs,0);
});
test('receive setup exposes pending registration recovery instead of another approval',async t=>{
 const f=setup(t,{holdings:[],configureClient:o=>{const s=recoveryState(o);s.operations.registration={proposal:{operation:'register',nonce:'bd'.repeat(32)},phase:'submission-unknown',ownerSignature:'public-synthetic-signature'};o.store.save(s);return {};}});
 await f.ui.open({mint:XMR20_MINT,receiveSetup:true});assert.match(f.html,/registration approval is saved/);assert.ok(f.elements.has('j3-check-0'));assert.ok(!f.elements.has('j3-register'));assert.equal(f.signs,0);
});

test('compact wallet linking keeps one cancel and one approval, with exact destination behind details',async t=>{
 let submitted=0;
 const f=setup(t,{configureClient:()=>({approveRegistration:async()=>{submitted++;throw Error('No approval in this test');}})});
 await f.ui.open();await clicked(f,'j3-register');
 assert.equal([...f.html.matchAll(/>Cancel<\/button>/g)].length,1);
 assert.equal([...f.html.matchAll(/class="primary wide"/g)].length,1);
 assert.match(f.html,/id="j3-confirm"[^>]*>Link your wallets/);
 assert.match(f.html,/20 minutes for 10 Monero confirmations/);
 const details=f.html.slice(f.html.indexOf('<details id="j3-transaction-details"'),f.html.indexOf('</details>',f.html.indexOf('<details id="j3-transaction-details"')));
 assert.ok(details.includes(native));assert.match(details,/verifier must also sign/);
 assert.ok(!details.startsWith('<details id="j3-transaction-details" open'));
 assert.equal(f.signs,0);assert.equal(submitted,0);
 await f.elements.get('j3-cancel').onclick();assert.match(f.html,/Request cancelled/);assert.equal(submitted,0);
});

test('paired token preview shows an exact net amount with one fee and cannot retain it after reversing direction',async t=>{
 const f=setup(t,{registered:true});await f.ui.open();
 f.elements.get('j3-amount').oninput({target:{value:'7530668.912636'}});await f.preview();
 assert.match(f.html,/aria-label="You send"/);assert.match(f.html,/aria-label="You receive"/);
 assert.match(f.html,/data-raw="7417708878947">7\.42M/);
 assert.equal(f.elements.get('j3-bridge').disabled,false);
 f.elements.get('j3-swap').onclick();
 assert.match(f.html,/value=""/);assert.equal(f.elements.get('j3-return').disabled,true);
 assert.doesNotMatch(f.html,/data-raw="7417708878947"/);
 assert.ok(f.html.indexOf('<span>Monero</span>')<f.html.indexOf('<span>Solana</span>'));
 assert.equal(f.signs,0);assert.equal(f.approvals,0);
});

test('unknown balances remain unknown and validated artwork appears on both network previews',async t=>{
 let release;const f=setup(t,{ready:()=>new Promise(r=>release=r)});
 f.d.tokenImage=()=> 'data:image/png;base64,aGVsbG8=';
 const opening=f.ui.open();await new Promise(r=>setImmediate(r));
 assert.match(f.html,/Last known: —/);assert.doesNotMatch(f.html,/Available: 0/);
 assert.equal([...f.html.matchAll(/<img src="data:image\/png/g)].length,2);
 assert.match(f.html,/title="Solana"/);assert.match(f.html,/title="Monero"/);
 assert.equal(f.elements.get('j3-bridge').disabled,true);
 release({schema:'joint-readiness-v3',ready:true,manifest:transferableManifest(XMR20_MINT)});await opening;
 assert.match(f.html,/data-raw="0">0/);assert.equal(f.signs,0);
});

test('Bridge and holdings share the same explicit website scope while extension transport remains the fallback',async t=>{
 const cases=[
  {label:'node-safe default transport',uiOptions:{},scope:'http://127.0.0.1:8928'},
  {label:'hosted extension transport',uiOptions:{endpoint:'https://api.xmr20.org'},scope:'https://api.xmr20.org'},
  {label:'same-origin website',uiOptions:{endpoint:'',snapshotShareKey:'https://wallet.example.invalid'},scope:'https://wallet.example.invalid'}
 ];
 for(const {label,uiOptions,scope} of cases)await t.test(label,async t=>{
  let release,requests=0;const waiting=new Promise(resolve=>{release=resolve;});
  const report={schema:'joint-index-v3',complete:true,manifest:transferableManifest(XMR20_MINT),positions:[],accepted:[]};
  const fetcher=async()=>{requests++;await waiting;return new Response(JSON.stringify(report));};
  const holdings=createRuntimeHttpClient({endpoint:'/api/joint-transferable/'+XMR20_MINT,shareKey:scope,fetcher}).snapshot();
  const f=setup(t,{uiOptions,configureRuntime:options=>createRuntimeHttpClient({...options,fetcher}),configureClient:options=>({snapshot:()=>options.runtime.snapshot()})});
  if(uiOptions.endpoint==='')f.d.rpcEndpoint=scope+'/api/bridge-solana-read';
  const opening=f.ui.open();await new Promise(resolve=>setImmediate(resolve));assert.equal(requests,1,'The Bridge must join the matching holdings snapshot.');
  release();await holdings;await opening;assert.equal(f.elements.get('j3-register').disabled,false);assert.equal(f.signs,0);
 });
});
test('typing an amount shows the current token fee from chain reads within the loading state; the exact review still gates the button',async t=>{
 let releaseReview,fees=0;const review=new Promise(r=>releaseReview=r);
 const f=setup(t,{registered:true,configureClient:o=>({snapshot:async()=>({schema:'joint-index-v3',complete:true,manifest:o.manifest,positions:[{position:addresses(recoveryState(o).config).position.toBase58(),available:'0'}]}),reviewCredit:async input=>{await review;return {proposal:{operation:'deposit',amount:input.amount,expectedFee:'15000',nonce:input.nonce},envelope:{record:{owner:input.recipient}}};}})});
 f.d.tokenImage=undefined;await f.ui.open();f.elements.get('j3-amount').oninput({target:{value:'1'}});
 const pending=f.preview();for(let i=0;i<20&&!/current rate/.test(f.html);i++)await new Promise(r=>setImmediate(r));
 assert.match(f.html,/Token fee \(current rate\)/);assert.match(f.html,/0\.015 XMR20/);assert.match(f.html,/Confirming the exact review/);assert.equal(f.elements.get('j3-bridge').disabled,true,'estimate never enables bridging');assert.equal(f.signs,0);
 releaseReview();await pending;assert.doesNotMatch(f.html,/current rate/);assert.match(f.html,/Token fee<\/span><span>0\.015 XMR20/);assert.equal(f.elements.get('j3-bridge').disabled,false);
 void fees;
});
test('pending background jobs poll cheap progress every five seconds; saved Solana checks keep fifteen',async t=>{
 const delays=[];const f=setup(t,{registered:true,uiOptions:{setTimer:(fn,delay)=>{delays.push(delay);return delays.length;},clearTimer(){}},configureClient:o=>{const state=recoveryState(o);state.operations.deposit={config:state.config,proposal:{operation:'deposit',nonce:'fa'.repeat(32),amount:'1000000'},envelope:{record:{op:'credit',nonce:'fa'.repeat(32),owner:native,amount:'985000'}},phase:'finalized',ownerSignature:'fixture-owner-signature',background:{enabled:true,phase:'monero-pending',checkedAt:1}};o.store.save(state);
  return {async backgroundStatus(){return {accepted:true,backgroundEnabled:true,phase:'monero-pending',checkedAt:2,confirmations:3};},async snapshot(){throw Error('No history needed while a background credit is pending');}};}});
 await f.ui.open();assert.match(f.html,/Waiting for Monero confirmations/);assert.ok(delays.includes(5000),'progress poll scheduled at five seconds: '+delays.join(','));assert.ok(!delays.includes(15000));
});
test('saved Solana confirmation checks keep the fifteen-second cadence',async t=>{
 const delays=[];
 const g=setup(t,{registered:true,uiOptions:{setTimer:(fn,delay)=>{delays.push(delay);return delays.length;},clearTimer(){}},configureClient:o=>{const state=recoveryState(o),id='fb'.repeat(32);state.proofs[id]={envelope:{record:{op:'burn',nonce:id,amount:'985000'}}};state.operations.release={proposal:{operation:'release',nonce:id,amount:'985000'},phase:'submission-unknown'};o.store.save(state);return {async check(){return {pending:true};},async snapshot(){assert.fail('No native replay during a saved approval check');}};}});
 delays.length=0;await g.ui.open();assert.ok(delays.includes(15000),'saved Solana confirmation checks keep fifteen seconds: '+delays.join(','));
});


test('exact credit review guidance stops on readiness, error or closing without authorizing a transfer',async t=>{
 for(const end of ['ready','error','close'])await t.test(end,async t=>{
  const timers=new Map();let id=0;
  const f=setup(t,{registered:true,uiOptions:{reviewWaitOptions:{setTimer:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)}},...(end==='error'?{configureClient:()=>({reviewCredit:async()=>{throw Error('Synthetic review unavailable');}})}:{})});
  await f.ui.open();assert.ok(f.elements.has('j3-review-wait'));assert.match(f.elements.get('j3-review-wait').textContent,/Confirming the exact review/);assert.match(f.html,/Estimated wait: 15–40 seconds/);assert.ok(f.elements.has('j3-review-estimate'));assert.doesNotMatch(f.html,/role="log"/);assert.ok([...timers.values()].some(v=>v.ms<=5000));assert.equal(f.elements.get('j3-bridge').disabled,true);
  if(end==='close')f.ui.clear();else await f.preview();
  assert.equal([...timers.values()].filter(v=>v.ms<=5000).length,0);
  if(end!=='close'){assert.ok(!f.elements.has('j3-review-wait'));assert.equal(f.elements.get('j3-bridge').disabled,end!=='ready');}
  assert.equal(f.signs,0);assert.equal(f.approvals,0);
 });
});


test('compact bridge input restores exact editable amount and never rounds the reviewed transfer',async t=>{
 const amounts=[];const f=setup(t,{registered:true,configureClient:()=>({reviewCredit:async input=>{amounts.push(input.amount);return {proposal:{operation:'deposit',amount:input.amount,expectedFee:'0',nonce:input.nonce},envelope:{record:{owner:input.recipient}}};}})});
 await f.ui.open();f.elements.get('j3-amount').oninput({target:{value:'7530668.912636'}});await f.preview();
 assert.match(f.html,/value="7.53M"/);assert.equal(amounts.at(-1),'7530668912636');
 const input=f.elements.get('j3-amount');input.onfocus();assert.equal(input.value,'7530668.912636');input.onblur();assert.equal(input.value,'7.53M');
 assert.equal(f.elements.get('j3-bridge').disabled,false);assert.equal(f.signs,0);assert.equal(f.approvals,0);
});

test('Monero send validates inputs, preserves exact Max, and Next only opens a review',async t=>{
 const published=[],f=setup(t,{registered:true,configureClient:()=>({publishMove:async input=>{published.push(input);}})});
 await f.ui.open({mint:XMR20_MINT,direction:'xmr-to-xmr'});
 assert.match(f.html,/placeholder="0" value="" title=""/);assert.equal(f.elements.get('j3-review').disabled,true);
 f.elements.get('j3-recipient').oninput({target:{value:'invalid'}});assert.equal(f.elements.get('j3-review').disabled,true);
 f.elements.get('j3-recipient').oninput({target:{value:native}});assert.equal(f.elements.get('j3-review').disabled,true);
 f.elements.get('j3-amount').oninput({target:{value:'1.234567'}});assert.equal(f.elements.get('j3-review').disabled,false);
 f.elements.get('j3-amount').oninput({target:{value:'100'}});assert.equal(f.elements.get('j3-review').disabled,true);
 await f.elements.get('j3-amount-max').onclick();assert.match(f.html,/title="98.5"/);assert.equal(f.elements.get('j3-review').disabled,false);
 f.elements.get('j3-amount').oninput({target:{value:'1.234567'}});
 f.elements.get('j3-review').onclick();for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));
 assert.ok(f.elements.has('j3-publish'));assert.ok(!f.elements.has('j3-swap'));assert.match(f.html,/1.234567 XMR20/);assert.match(f.html,new RegExp(native));
 assert.equal(published.length,0);assert.equal(f.signs,0);assert.equal(f.approvals,0);
});

test('empty Bridge resumes saved universal link outside host run and Back does not loop',async t=>{
 let opened=0,back;const f=setup(t,{holdings:[],uiOptions:{walletTest:true,linkOptions:{enabled:true,hasSaved:()=>true,createUI:(d,o)=>({clear(){},async open(){assert.equal(d.isBusy(),false);opened++;back=o.onBack;d.show('Link wallets','Saved linking progress');}})}}});
 await f.ui.open();assert.equal(opened,1);assert.match(f.html,/Saved linking progress/);assert.equal(f.signs,0);assert.equal(f.approvals,0);
 await back();assert.equal(opened,1);assert.match(f.html,/View wallet link/);
 await f.elements.get('j3-receive-setup').onclick();assert.equal(opened,2);
 f.ui.clear();await f.ui.open();assert.equal(opened,3);
});
test('empty Bridge with no saved identity keeps first-link entry',async t=>{
 const f=setup(t,{holdings:[],uiOptions:{walletTest:true,linkOptions:{enabled:true,hasSaved:()=>false,createUI:()=>{throw Error('Unexpected identity route');}}}});
 await f.ui.open();assert.match(f.html,/No bridgeable tokens found/);assert.match(f.html,/Link your wallets/);assert.equal(f.signs,0);
});
test('unreadable identity receipts route to recovery rather than suggesting a new approval',async t=>{
 let opened=0;const f=setup(t,{holdings:[],uiOptions:{walletTest:true,linkOptions:{enabled:true,hasSaved:()=>{throw Error('Corrupt receipt');},createUI:()=>({clear(){},async open(){opened++;}})}}});
 await f.ui.open();assert.equal(opened,1);assert.equal(f.approvals,0);
});
test('explicit token selection keeps its balance recovery instead of redirecting to identity',async t=>{
 const f=setup(t,{holdings:[],uiOptions:{walletTest:true,linkOptions:{enabled:true,hasSaved:()=>true,createUI:()=>{throw Error('Unexpected redirect');}}}});
 await f.ui.open({mint:XMR20_MINT});assert.match(f.html,/Waiting for this token/);assert.equal(f.signs,0);
});
test('closing between host run and saved-link routing cannot reopen the modal',async t=>{
 let opened=0;const f=setup(t,{holdings:[],uiOptions:{walletTest:true,linkOptions:{enabled:true,hasSaved:()=>true,createUI:()=>({clear(){},async open(){opened++;}})}}});
 const run=f.d.run;f.d.run=async fn=>{await run(fn);f.ui.clear();f.d.modal.open=false;};
 await assert.rejects(()=>f.ui.open(),/Wallet changed/);assert.equal(opened,0);assert.equal(f.signs,0);
});

const recipient='47zk7yrx6CeD1Xjxb6ogocPtpgrKN2wcXcUSynYUqn5xaxPL6h2Lu5Ndjs9o3gqfRbZKGsAGKiH2N42Jw4wm5ktbRa439Ee';
function autoSetupFixture(t,{confirm,prepare,client,uiOptions={}}={}){
 const events=[];let guard;
 const f=setup(t,{registered:true,uiOptions:{...uiOptions,linkOptions:{enabled:true,createUI:()=>{throw Error('Separate setup screen must not open');},createRecipientSetup:(d,o)=>{guard=o.assertCurrent;return {
  prepare:async input=>{events.push('review');return prepare?prepare(input):Object.freeze({...input,rentLamports:2500000});},
  confirm:async plan=>{events.push('setup');if(confirm)await confirm(plan);guard();},needsReview:()=>false
 };}}},configureClient:o=>({publishMove:async(review,{validateSnapshot})=>{events.push(['send',structuredClone(review)]);await validateSnapshot(await o.runtime.snapshot?.()??{schema:'joint-index-v3',complete:true,manifest:o.manifest,positions:[]});},...client?.(o,events)})});
 return Object.assign(f,{events,async review(){await f.ui.open({direction:'xmr-to-xmr'});f.elements.get('j3-amount').oninput({target:{value:'1.234567'}});f.elements.get('j3-recipient').oninput({target:{value:recipient}});await clicked(f,'j3-review');}});
}
test('missing recipient account is included in one send review and continues automatically after explicit confirmation',async t=>{
 const f=autoSetupFixture(t);await f.review();assert.deepEqual(f.events,['review']);assert.equal(f.signs,0);
 assert.match(f.html,/0.002500000 SOL/);assert.match(f.html,/Confirm and send/);assert.match(f.html,/1.234567 XMR20/);assert.ok(!f.elements.has('j3-prepare-recipient'));
 await clicked(f,'j3-publish');assert.deepEqual(f.events.slice(0,2),['review','setup']);assert.equal(f.events[2][0],'send');assert.equal(f.events[2][1].amount,'1234567');assert.equal(f.events[2][1].to,recipient);
});
test('recipient lookup failure shows inline review retry without signing or opening another screen',async t=>{
 const f=autoSetupFixture(t,{prepare:async()=>{throw Error('Recipient has not linked yet');}});await f.review();assert.match(f.html,/Recipient has not linked yet/);assert.ok(f.elements.has('j3-review-recipient'));assert.ok(!f.elements.has('j3-publish'));assert.equal(f.signs,0);
});
test('late missing recipient check offers a fresh combined review even with readiness cleared',async t=>{
 let prepares=0;const f=setup(t,{registered:true,uiOptions:{linkOptions:{enabled:true,createRecipientSetup:()=>({prepare:async input=>{prepares++;return {...input,rentLamports:2500000};}})}},configureClient:o=>({
  snapshot:async()=>({schema:'joint-index-v3',complete:true,manifest:o.manifest,positions:[{position:addresses(recoveryState(o).config).position.toBase58(),moneroOwner:native,available:'98500000'}]}),
  publishMove:async()=>{throw Error('Registered recipient required.');}
 })});
 await transferReview(f);await clicked(f,'j3-publish');assert.ok(f.elements.has('j3-review-recipient'));await clicked(f,'j3-review-recipient');assert.equal(prepares,1);assert.match(f.html,/Confirm and send/);assert.equal(f.signs,0);
});
test('existing token account skips recipient setup entirely',async t=>{
 const f=setup(t,{registered:true,uiOptions:{linkOptions:{enabled:true,createRecipientSetup:()=>{throw Error('No account setup needed');}}},configureClient:o=>({snapshot:async()=>({schema:'joint-index-v3',complete:true,manifest:o.manifest,positions:[{position:addresses(recoveryState(o).config).position.toBase58(),moneroOwner:native,available:'98500000'}]})})});
 await transferReview(f);assert.ok(f.elements.has('j3-publish'));assert.ok(!f.elements.has('j3-prepare-recipient'));assert.equal(f.signs,0);
});
test('closing during recipient setup stops automatic send and preserves receipt ownership',async t=>{
 let finish;const f=autoSetupFixture(t,{confirm:()=>new Promise(r=>finish=r)});await f.review();f.elements.get('j3-publish').onclick();await new Promise(r=>setImmediate(r));assert.deepEqual(f.events,['review','setup']);f.ui.clear();finish();for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));assert.ok(!f.events.some(e=>Array.isArray(e)));
});
test('pending setup failure stays in send review and does not publish',async t=>{
 const f=autoSetupFixture(t,{prepare:async input=>({...input,rentLamports:null}),confirm:async()=>{throw Error('Account setup still confirming. Approval is saved.');}});await f.review();assert.match(f.html,/Already approved/);await clicked(f,'j3-publish');assert.match(f.html,/Approval is saved/);assert.ok(!f.events.some(e=>Array.isArray(e)));assert.equal(f.signs,0);
});
test('balance changes and failed program verification stop before recipient account payment',async t=>{
 let count=0;const f=autoSetupFixture(t,{client:o=>({snapshot:async()=>({schema:'joint-index-v3',complete:true,manifest:o.manifest,positions:[{position:addresses(recoveryState(o).config).position.toBase58(),available:++count===1?'98500000':'0'}]})})});await f.review();await clicked(f,'j3-publish');assert.deepEqual(f.events,['review']);assert.match(f.html,/Insufficient confirmed/);
});
test('activation finality is followed by fresh publish validation and bounded index catchup',async t=>{
 let tries=0;const f=autoSetupFixture(t,{uiOptions:{setTimer:(fn,ms)=>{if(ms===2000){queueMicrotask(fn);return 0;}return setTimeout(fn,ms);}},client:(o,events)=>({publishMove:async review=>{if(++tries<3)throw Error('Registered recipient required.');events.push(['send',review]);}})});await f.review();await clicked(f,'j3-publish');assert.equal(tries,3);assert.equal(f.events.filter(e=>e==='setup').length,1);assert.equal(f.events.filter(e=>Array.isArray(e)).length,1);
});

test('fast send review states Solana settlement and uses one fast approval without native publication',async t=>{
 let fastReviews=0,fastApprovals=0,published=0;
 const f=setup(t,{registered:true,configureClient:o=>({publishMove:async()=>{published++;},fast:{review:async input=>{fastReviews++;return {intent:{...input,owner:o.provider.publicKey.toBase58()}};},approve:async r=>{fastApprovals++;const state=recoveryState(o),id='fast-fixture';state.fastOperations={[id]:{intent:{amount:r.intent.amount,nonce:r.intent.nonce},phase:'finalized',ownerSignature:'synthetic-signature'}};o.store.save(state);return {confirmed:true,operationId:id};}}})});
 await transferReview(f);assert.match(f.html,/Settles on Solana/);assert.doesNotMatch(f.html,/allow about 20 minutes|Approve Monero record/);assert.equal(fastApprovals,0);await clicked(f,'j3-publish');assert.equal(fastReviews,1);assert.equal(fastApprovals,1);assert.equal(published,0);assert.match(f.html,/Send confirmed/);assert.match(f.html,/View Solana transaction/);
});
test('fast send lost reply reopens its durable recovery and checks Solana without native publication',async t=>{
 const timers=new Map();let id=0,checks=0,approved=0,published=0,options;
 const f=setup(t,{registered:true,uiOptions:{setTimer:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimer:key=>timers.delete(key)},configureClient:o=>{options=o;return {publishMove:async()=>{published++;},fast:{review:async input=>({intent:input}),approve:async r=>{approved++;const state=recoveryState(o);state.fastOperations={saved:{intent:{amount:r.intent.amount,nonce:r.intent.nonce},phase:'submission-unknown',ownerSignature:'synthetic'}};o.store.save(state);throw Error('Lost reply');},check:async()=>{checks++;return {pending:true};}}};}});
 await transferReview(f);await clicked(f,'j3-publish');assert.match(f.html,/Waiting for Solana confirmation/);assert.ok(!f.elements.has('j3-publish'));assert.equal(approved,1);assert.equal(published,0);assert.ok([...timers.values()].some(x=>x.ms===5000));
 await f.ui.open({direction:'xmr-to-xmr'});assert.equal(checks,1);assert.match(f.html,/Your signed transaction is saved/);assert.equal(approved,1);assert.equal(options.store.load().fastOperations.saved.phase,'submission-unknown');
});

test('saved native send opens exact fast recovery review without deleting receipts or repeating native publication',async t=>{
 const recipient='4AMg1kDaXkWckE3uyd1YqoBKvn4z8ATxmWQVdtjF6aGU4sT278XoyhUV1Ve88ZMCXNXQJpjW2553NWERfMZcNsBtCkMLiNM',toOwner=Keypair.generate().publicKey.toBase58(),nonce='72'.repeat(32);let options,original,approved=0,published=0;
 const f=setup(t,{registered:true,configureClient:o=>{options=o;let state=o.store.load();if(!state){state=recoveryState(o);original={phase:'publication-unknown',envelope:{record:{p:'xmr20-joint',v:3,net:'mainnet',op:'transfer',owner:native,to:recipient,amount:'1000000',nonce,program:state.config.program,mint:state.config.mint,from:addresses(state.config).position.toBase58(),into:addresses({...state.config,owner:toOwner}).position.toBase58()},signature:'SigV2'+'1'.repeat(88)}};state.proofs[nonce]=original;o.store.save(state);}
 return {publishMove:async()=>published++,fast:{review:async input=>{assert.equal(input.nonce,nonce);assert.equal(input.amount,'1000000');assert.equal(input.to,recipient);return {intent:{schema:'joint-solana-send-v1',network:state.config.network,program:state.config.program,mint:state.config.mint,verifier:state.config.verifier,owner:state.config.owner,recipient:toOwner,fromMonero:native,toMonero:recipient,amount:input.amount,nonce}};},approve:async review=>{approved++;state.fastOperations={recovered:{intent:review.intent,phase:'finalized',ownerSignature:'synthetic'}};o.store.save(state);return {confirmed:true,operationId:'recovered'};},check:async()=>({confirmed:true,operationId:'recovered'})}};}});
 await f.ui.open({direction:'xmr-to-xmr'});assert.match(f.html,/Finish your send/);assert.ok(!f.elements.has('j3-resume-move-0'));assert.match(f.html,/class="bridge-secondary" hidden/);
 await clicked(f,'j3-recover-fast-0');assert.match(f.html,/Review send/);assert.match(f.html,/Continues your saved send/);assert.equal(approved,0);await clicked(f,'j3-publish');assert.equal(approved,1);assert.equal(published,0);assert.match(f.html,/Send confirmed/);assert.deepEqual(options.store.load().proofs[nonce],original);
 await f.ui.open({direction:'xmr-to-xmr'});assert.doesNotMatch(f.html,/Finish your send|Sending on Monero/);assert.deepEqual(options.store.load().proofs[nonce],original);
});

test('wallet-link setup is checked before amount entry and opens directly without approval',async t=>{
 let release,opened=[];const waiting=new Promise(r=>release=r);
 const f=setup(t,{ready:()=>waiting,uiOptions:{linkOptions:{enabled:true,hasSaved:()=>false,createUI:()=>({clear(){},async open(options){opened.push(options);}})}}});
 const opening=f.ui.open();await new Promise(r=>setImmediate(r));
 assert.ok(!f.elements.has('j3-amount'),'no amount field until link is known');assert.equal(opened.length,0);
 release({schema:'joint-readiness-v3',ready:true,manifest:transferableManifest(XMR20_MINT)});await opening;
 assert.equal(opened.length,1);assert.equal(opened[0].mint,XMR20_MINT);assert.equal(f.signs,0);assert.equal(f.approvals,0);
});
