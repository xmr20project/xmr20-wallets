import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

test('uncertain signed submission removes new approval, reconciles only by account read; unsigned expiry permits fresh preparation',async()=>{
 const directory=await mkdtemp(resolve(tmpdir(),'xmr20-bridge-signed-ui-test-'));
 let ui;
 try{
  const result=await build({entryPoints:[resolve(import.meta.dirname,'../src/bridge-ui.js')],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',inject:[resolve(import.meta.dirname,'../../engine/shared/polyfill.js')],define:{__XMR20_JOINT_PREVIEW__:'false',__XMR20_JOINT_MAINNET_REVIEW__:'false',__XMR20_JOINT_TRANSFERABLE_REVIEW__:'false'},plugins:[{name:'synthetic-signed-review',setup(b){
   b.onLoad({filter:/[\\/]core\.js$/},()=>({contents:`export const amount=n=>(BigInt(n)/1000000n).toString();export const units=()=>{throw Error('New bridge forbidden');};export const login=async()=> 'synthetic-session';export const walletRequest=(_token,action,data)=>globalThis.__bridgeSignedUiFixture.request(action,data);export const jsonFetch=async()=>({tokens:globalThis.__bridgeSignedUiFixture.catalog});`,loader:'js'}));
   b.onLoad({filter:/[\\/]bridge-solana\.js$/},()=>({contents:`export const bridgeSolReserve=async()=>10000;export async function prepareBridgeSolana(){return {feeRaw:'10000'};}export function signBridgeSolana(){const fixture=globalThis.__bridgeSignedUiFixture;fixture.signCalls++;if(fixture.expired)throw Error('Approval expired. Prepare it again.');return fixture.signed;}export const signedAttemptResolved=(t,s)=>t.destinationSignature===s.signature;`,loader:'js'}));
   b.onLoad({filter:/[\\/]joint-(escrow|mainnet|transferable)-ui\.js$/},args=>({contents:`export function ${args.path.includes('escrow')?'createJointEscrowUI':args.path.includes('mainnet')?'createJointMainnetUI':'createJointTransferableUI'}(){throw Error('Optional bridge forbidden');}`,loader:'js'}));
  }}]});
  const modulePath=resolve(directory,'controller.mjs');await writeFile(modulePath,result.outputFiles[0].text);const {createBridgeUI}=await import(pathToFileURL(modulePath).href);
  const originalDocument=globalThis.document;
  try{
   for(const expired of [false,true]){
    const account={id:'synthetic-account',sol:'11111111111111111111111111111111',xmr:'4'+'A'.repeat(94),solSecret:'synthetic-never-read'};
    const row={id:'synthetic-launch',mint:'So11111111111111111111111111111111111111112',deployment:'a'.repeat(64),ticker:'TEST',bridgeVersion:3};
    const transfer={id:'synthetic-return',owner:account.sol,moneroAddress:account.xmr,launchId:row.id,mint:row.mint,direction:'xmr-to-sol',state:'source_finalized',amountRaw:'2240000000000',transferTaxRaw:'33600000000',netReceivedRaw:'2206400000000',sourceTxid:'b'.repeat(64),destinationSignature:null};
    const receipt={kind:'bridge',accountId:account.id,intent:transfer.id,row,transfer};
    const catalog={...row,moneroTxid:row.deployment,bridgeProgramId:'2wEBASzbdj13KJtmjK7UFhug38oGaWsfvMGhQ3umr265',moneroNetwork:'mainnet',network:'mainnet-beta',solanaFinalized:true,proofVerified:true,bridgeReady:true,confirmations:10};
    const actions=[],handlers=new Map(),elements=new Map();let pending,currentHtml='',busy=false,submitted=false,resolveAccount,persistedSigned=0;
    const modal={open:true,querySelector(selector){if(selector.startsWith('[data-bridge-view='))return currentHtml.includes('data-bridge-view=')?{}:null;return elements.get(selector.slice(1))||null;}};
    const fixture={catalog:[catalog],expired,signCalls:0,signed:{operation:'Withdrawal',transaction:'synthetic-signed-transaction',signature:'synthetic-signature',ticket:'synthetic-ticket',blockhash:'synthetic-block'},async request(action){actions.push(action);if(action==='account')return submitted?new Promise(r=>resolveAccount=r):{transfers:[transfer]};if(action==='prepareWithdrawal')return {transaction:'synthetic-unsigned-review'};if(action==='submitWithdrawal'){assert.equal(persistedSigned,1);submitted=true;throw Error('Reply lost after broadcast');}throw Error('Automatic retry/new intent forbidden');}};
    globalThis.__bridgeSignedUiFixture=fixture;globalThis.document={getElementById:id=>elements.get(id)||null};
    ui=createBridgeUI({modal,account:()=>account,rows:()=>[],vault:()=>({receipts:[receipt]}),esc:String,isBusy:()=>busy,same(){},on:(id,fn)=>handlers.set(id,fn),record:async()=>{throw Error('New receipt forbidden');},persist:async()=>{if(receipt.signed)persistedSigned++;},show(_title,html){currentHtml=html;elements.clear();for(const [,id]of html.matchAll(/id="([^"]+)"/g))elements.set(id,{textContent:'',hidden:id==='bridge-error'});},run(fn){busy=true;pending=(async()=>{try{await fn(0);}catch{if(elements.has('progress'))elements.get('progress').textContent='';}finally{busy=false;}})();return pending;}});
    await ui.open({legacyReceiptId:transfer.id});const originalPrepare=handlers.get('bridge-prepare');originalPrepare();await pending;assert.ok(elements.has('bridge-sign'));
    const originalSign=handlers.get('bridge-sign');originalSign();await pending;
    assert.equal(elements.has('bridge-sign'),false);assert.equal(elements.get('bridge-error').hidden,false);
    if(expired){
     assert.ok(elements.has('bridge-prepare'));assert.match(elements.get('bridge-error').textContent,/Prepare a fresh approval/);assert.equal(receipt.signed,undefined);assert.equal(actions.includes('submitWithdrawal'),false);
    }else{
     assert.equal(elements.has('bridge-prepare'),false);assert.ok(elements.has('bridge-retry'));assert.match(elements.get('bridge-error').textContent,/do not approve a new transaction/);assert.equal(receipt.signed,fixture.signed);assert.equal(actions.filter(a=>a==='submitWithdrawal').length,1);
     originalPrepare();await pending;assert.equal(elements.has('bridge-sign'),false);assert.equal(actions.filter(a=>a==='prepareWithdrawal').length,1);assert.equal(receipt.signed,fixture.signed);
     originalSign();await pending;assert.equal(fixture.signCalls,1);assert.equal(actions.filter(a=>a==='submitWithdrawal').length,1);
     resolveAccount({transfers:[{...transfer,state:'complete',destinationSignature:fixture.signed.signature}]});await new Promise(setImmediate);
     assert.equal(receipt.transfer.state,'complete');assert.equal(receipt.signed,undefined);assert.equal(elements.has('bridge-sign'),false);assert.equal(elements.has('bridge-prepare'),false);assert.equal(elements.has('bridge-retry'),false);
    }
    assert.equal(actions.some(action=>action==='bridgeIntent'||action==='authorizeBurn'),false);ui.clear();
   }
  }finally{globalThis.document=originalDocument;delete globalThis.__bridgeSignedUiFixture;ui?.clear();}
 }finally{await rm(directory,{recursive:true,force:true});}
});
