import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

// Run the real controller with only its transport and optional bridge modules
// replaced. The stub has no key access and rejects every financial operation.
test('failed preparation is visible beside its button and a late closed-view response cannot advance',async()=>{
 const directory=await mkdtemp(resolve(tmpdir(),'xmr20-bridge-ui-test-'));
 let ui;
 try{
  const result=await build({entryPoints:[resolve(import.meta.dirname,'../src/bridge-ui.js')],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',inject:[resolve(import.meta.dirname,'../../engine/shared/polyfill.js')],define:{__XMR20_JOINT_PREVIEW__:'false',__XMR20_JOINT_MAINNET_REVIEW__:'false',__XMR20_JOINT_TRANSFERABLE_REVIEW__:'false'},plugins:[{name:'nonfinancial-ui-fixture',setup(b){
   b.onLoad({filter:/[\\/]core\.js$/},()=>({contents:`export const RPC='https://rpc.invalid';export const bs58={};export function importSol(){throw Error('Signing forbidden in UI fixture');}export const amount=n=>(BigInt(n)/1000000n).toString();export const units=()=>{throw Error('New bridge forbidden in UI fixture');};export const login=async()=> 'synthetic-session';export const walletRequest=(_token,action,data)=>globalThis.__bridgeUiFixture.request(action,data);export const jsonFetch=async()=>({tokens:globalThis.__bridgeUiFixture.catalog});`,loader:'js'}));
   b.onLoad({filter:/[\\/]joint-(escrow|mainnet|transferable)-ui\.js$/},args=>({contents:`export function ${args.path.includes('escrow')?'createJointEscrowUI':args.path.includes('mainnet')?'createJointMainnetUI':'createJointTransferableUI'}(){throw Error('Optional bridge forbidden in fixture');}`,loader:'js'}));
  }}]});
  const modulePath=resolve(directory,'controller.mjs');await writeFile(modulePath,result.outputFiles[0].text);
  const {createBridgeUI}=await import(pathToFileURL(modulePath).href);
  const account={id:'synthetic-account',sol:'11111111111111111111111111111111',xmr:'4'+'A'.repeat(94),solSecret:'synthetic-never-read'};
  const row={id:'synthetic-launch',mint:'So11111111111111111111111111111111111111112',deployment:'a'.repeat(64),ticker:'TEST',bridgeVersion:3};
  const transfer={id:'synthetic-return',owner:account.sol,moneroAddress:account.xmr,launchId:row.id,mint:row.mint,direction:'xmr-to-sol',state:'source_finalized',amountRaw:'2240000000000',transferTaxRaw:'33600000000',netReceivedRaw:'2206400000000',sourceTxid:'b'.repeat(64),destinationSignature:null};
  const receipt={kind:'bridge',accountId:account.id,intent:transfer.id,row,transfer};
  const catalog={...row,moneroTxid:row.deployment,bridgeProgramId:'2wEBASzbdj13KJtmjK7UFhug38oGaWsfvMGhQ3umr265',moneroNetwork:'mainnet',network:'mainnet-beta',solanaFinalized:true,proofVerified:true,bridgeReady:true,confirmations:10};
  const actions=[],handlers=new Map();let pending,prepare=async()=>{throw Error('Solana read unavailable.');},currentHtml='',shows=0,busy=false;
  const elements=new Map(),modal={open:true,querySelector(selector){if(selector.startsWith('[data-bridge-view='))return currentHtml.includes('data-bridge-view=')?{}:null;return elements.get(selector.slice(1))||null;}};
  globalThis.__bridgeUiFixture={catalog:[catalog],async request(action){actions.push(action);if(action==='account')return {transfers:[transfer]};if(action==='prepareWithdrawal')return prepare();throw Error('Financial requests forbidden in UI fixture');}};
  const originalDocument=globalThis.document;globalThis.document={getElementById:id=>elements.get(id)||null};
  try{
   ui=createBridgeUI({modal,account:()=>account,rows:()=>[],vault:()=>({receipts:[receipt]}),esc:String,isBusy:()=>busy,same(){},on:(id,fn)=>handlers.set(id,fn),record:async()=>{throw Error('New receipt forbidden');},persist:async()=>{},show(_title,html){shows++;currentHtml=html;elements.clear();for(const [,id]of html.matchAll(/id="([^"]+)"/g))elements.set(id,{textContent:'',hidden:id==='bridge-error'});},run(fn){busy=true;pending=(async()=>{try{await fn(0);}catch{elements.get('progress').textContent='';}finally{busy=false;}})();return pending;}});
   await ui.open({legacyReceiptId:transfer.id});assert.ok(elements.has('bridge-prepare'));
   handlers.get('bridge-prepare')();await pending;
   assert.equal(elements.get('bridge-error').hidden,false);assert.match(elements.get('bridge-error').textContent,/Solana read unavailable/);assert.match(elements.get('bridge-error').textContent,/no second Monero burn/);assert.equal(elements.get('progress').textContent,'');assert.ok(elements.has('bridge-prepare'));
   let finish;prepare=()=>new Promise(r=>finish=r);handlers.get('bridge-prepare')();await Promise.resolve();const before=shows;modal.open=false;finish({transaction:'unused-late-response'});await pending;
   assert.equal(shows,before);assert.equal(actions.filter(action=>action==='prepareWithdrawal').length,2);assert.equal(actions.some(action=>/submit|authorize|Intent/.test(action)),false);assert.equal(receipt.transfer.destinationSignature,null);assert.equal(receipt.transfer.state,'source_finalized');
  }finally{globalThis.document=originalDocument;delete globalThis.__bridgeUiFixture;ui?.clear();}
 }finally{await rm(directory,{recursive:true,force:true});}
});
