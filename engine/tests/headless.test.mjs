// The headless layer (engine/headless/token-ops.js) drives the REAL token module in Chromium, offline. Stand-in workers
// and a stand-in bridge reply replace the network, so nothing leaves the machine. Checked: an operation stops at the fee
// review with its rows, Cancel releases the quoted XMR input and reserves nothing, a refusal comes back as an error, and
// "Enable private transfers" stops at its review, then relays only the reviewed split on approval.
// Needs Playwright's Chromium (cli: npm run setup).
import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {createRequire} from 'node:module';import {join} from 'node:path';
const here=import.meta.dirname,require=createRequire(join(here,'../package.json'));
const FIXTURE=`
import {createHeadlessTokens} from '../headless/token-ops.js';
const calls=[];const mem=new Map();
const holder={tip:100,tokenAddress:'xmr20t1standin',shieldedAddress:'',records:{},
 public:{balances:{a1:'10000000'},notes:[{id:'n1',asset:'a1',amount:'10000000'}]},shielded:{balances:{a1:'0'},notes:[],spent:[]},
 native:{tip:100,unlocked:'900000000',locked:'0',reserved:'0',outputs:[{spent:false,reserved:false,unlockedAt:0,amount:'900000000'}]}};
const client={call:async(action,args)=>{calls.push(action);switch(action){
 case 'open':return {tokenAddress:'xmr20t1standin',shieldedAddress:'',ownerKey:'0'.repeat(64),nativeAddress:'4standin',domain:'d',engine:'standin',parameters:null};
 case 'sync':return holder;case 'selectPublic':return {notes:['n1']};case 'plan':return {transactions:1,wireLengths:[300]};
 case 'carrierQuote':return {quoteId:'q1',keyImage:'k1',fee:'40000000',weight:1000,feePerWeight:40000,inputAmount:'900000000',changeAmount:'860000000'};
 default:return {};}},close(){},get alive(){return true;}};
window.calls=calls;
window.fetch=async(url,init)=>{const action=String(url).split('/action/')[1];calls.push('bridge:'+action);
 if(action==='state')return new Response(JSON.stringify({network:'mainnet',confirmations:10,registered:true,features:{bridge:true},assets:[{asset:'a1',mint:'MINT1',symbol:'XMR20',name:'XMR20',decimals:6,payouts:[],legacy:[]}]}));
 return new Response(JSON.stringify({error:'stand-in'}),{status:400});};
const amount=(raw,d=6)=>{const n=BigInt(raw),b=10n**BigInt(d),f=String(n%b).padStart(d,'0').replace(/0+$/,'');return String(n/b)+(f?'.'+f:'');};
const units=(v,d)=>{const [w,f='']=v.split('.');return BigInt(w)*10n**BigInt(d)+BigInt(f.padEnd(d,'0'));};
let split=null;
window.tokens=createHeadlessTokens({account:()=>({id:'t1',sol:'11111111111111111111111111111111',xmr:'4standin',xmrSeed:'standin',height:0}),
 workerClient:()=>client,oneShot:async()=>({}),store:{get:async k=>mem.get(k)??null,set:async(k,v)=>{mem.set(k,v);}},secret:()=>'standin-secret',
 endpoint:'http://standin/api/private-bridge',node:'http://standin/node',amount,units,compactTokenBalance:r=>amount(r),importSol:()=>{throw Error('no key');},
 splitXmr:{prepare:async()=>(calls.push('split:prepare'),split={id:'r1',partRaw:'300000000',feeRaw:'30000000',hash:'h'.repeat(64),expires:Date.now()+120000}),checkCoins:async()=>{},relay:async r=>(calls.push('split:relay:'+r.id),{hash:'f'.repeat(64)})}});
window.ready=true;`;
test('headless layer stops at reviews; cancel releases; split relays only on approval',{timeout:120000},async t=>{
 const {build}=require('esbuild'),{chromium}=require('playwright');
 const out=await build({stdin:{contents:FIXTURE,resolveDir:here,loader:'js'},bundle:true,format:'esm',platform:'browser',target:'chrome120',write:false,
  inject:[join(here,'../shared/polyfill.js')],define:{__XMR20_PRIVATE_LAZY_REGISTER__:'true'},logLevel:'silent'});
 const js=out.outputFiles[0].contents;
 const server=createServer((req,res)=>{if(req.url==='/f.js'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(js);}res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><body><script type="module" src="/f.js"></script></body>');});
 let browser;try{browser=await chromium.launch({headless:true});}catch{t.skip('Chromium is not installed yet: run "npm run setup -w cli" once.');return;}
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.ready===true);
  const s=await page.evaluate(()=>tokens.sync());assert.equal(s.error,null);assert.equal(s.tokens[0].open,'10000000');assert.equal(s.xmrForFees.coins,1);
  // Make private: stops at the fee review (1 transaction, 0.00004 XMR) without proving or signing anything.
  const r=await page.evaluate(()=>tokens.makePrivate({mint:'MINT1',amount:'2.5'}));
  assert.equal(r.stage,'review');assert.match(r.review.head,/Make private: 1 Monero transaction/);
  assert.deepEqual(r.review.rows.find(x=>x[0]==='Network fee'),['Network fee','0.00004 XMR']);assert.match(r.review.button,/Approve 0\.00004 XMR/);
  let calls=await page.evaluate(()=>window.calls.slice());assert.ok(calls.includes('carrierQuote')&&!calls.includes('build')&&!calls.includes('carrierSign'));
  const c=await page.evaluate(()=>tokens.cancel());assert.equal(c.stage,'error');assert.match(c.error,/Cancelled before proving/);
  calls=await page.evaluate(()=>window.calls.slice());assert.ok(calls.includes('carrierCancel')&&calls.includes('nativeRelease'));assert.ok(!calls.includes('build'));
  // A refusal inside the module comes back as an error stage.
  const big=await page.evaluate(()=>tokens.makePrivate({mint:'MINT1',amount:'11'}));assert.equal(big.stage,'error');assert.match(big.error,/Insufficient open balance/);
  // Enable private transfers: offered with 1 coin; stops at the split review; relays exactly the reviewed split on approve.
  const sp=await page.evaluate(()=>tokens.enablePrivate({mint:'MINT1'}));assert.equal(sp.stage,'review');assert.match(sp.review.head,/Split XMR/);
  assert.ok(!(await page.evaluate(()=>window.calls.slice())).some(x=>x.startsWith('split:relay')));
  const done=await page.evaluate(()=>tokens.approve());assert.equal(done.stage,'done');assert.equal(done.result.title,'Private transfers enabled');
  assert.ok((await page.evaluate(()=>window.calls.slice())).includes('split:relay:r1'));
  assert.deepEqual(errors,[]);
 }finally{await browser.close();server.close();}
});
