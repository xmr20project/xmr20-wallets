import test from 'node:test';import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {createJointHoldings,jointHoldingRow,replaceHoldingSource,isJointHolding,jointIncomingRows} from '../../engine/shared/joint-holdings.js';
import {PRIVATE_TEST_POLICY as policy} from '../../engine/shared/bridge-sdk/core-transferable/private-test.mjs';
import {transferableManifest} from '../../engine/shared/bridge-sdk/core-transferable/mainnet-config.mjs';
import {addresses} from '../../engine/shared/bridge-sdk/core-transferable/sdk.mjs';
import {digest,commitment} from '../../engine/shared/bridge-sdk/core-transferable/records.mjs';
import {tokenGroups} from '../../engine/shared/token-display.js';
const account={sol:policy.owner,xmr:policy.moneroOwner},asset={mint:policy.mint,name:'XMR20',symbol:'XMR20'},manifest=transferableManifest(asset.mint),config={...manifest,owner:account.sol,binding:digest(account.xmr)},position=addresses(config).position.toBase58(),at=Date.now();
function fixture(){
 const link={record:{p:'xmr20-joint',v:3,net:'mainnet',op:'link',program:manifest.program,mint:asset.mint,owner:account.xmr,to:account.sol,nonce:'a1'.repeat(32)},signature:'SigV2'+'1'.repeat(90)},credit={record:{op:'credit',program:manifest.program,mint:asset.mint,owner:account.xmr,amount:'985000'}};
 const report={schema:'joint-index-v3',complete:true,manifest,privateTestPolicy:policy,positions:[{config,position,moneroOwner:account.xmr,solanaOwner:account.sol,linkTxid:'ab'.repeat(32),balance:'985000',chainBalance:'985000',available:'985000'}],accepted:[{txid:'ab'.repeat(32),envelope:link},{txid:'cd'.repeat(32),envelope:credit}]};
 return {report,link};
}
function data(report,link){const b=Buffer.alloc(169);b[0]=3;new PublicKey(account.sol).toBuffer().copy(b,1);new PublicKey(manifest.verifier).toBuffer().copy(b,33);new PublicKey(asset.mint).toBuffer().copy(b,65);Buffer.from(config.binding,'hex').copy(b,97);Buffer.from(commitment(link),'hex').copy(b,129);b.writeBigUInt64LE(BigInt(report.positions[0].chainBalance),161);return b;}
function setup({snapshot,readAccount,verifyProgram,now=()=>at,storage,reportTtl}={}){
 const f=fixture(),disk=new Map();let calls=0,reads=0,checks=0;
 const store=storage??{getItem:k=>disk.get(k)??null,setItem:(k,v)=>disk.set(k,v)};
 const c=createJointHoldings({privateTest:true,storage:store,now,...(reportTtl?{reportTtl}:{}),adapters:{runtime:()=>({snapshot:async()=>{calls++;return snapshot?await snapshot(f.report):f.report;}}),chain:()=>({verifyProgram:async()=>{checks++;if(verifyProgram)await verifyProgram();},readAccount:async key=>{reads++;assert.equal(key,position);return readAccount?await readAccount():{owner:manifest.program,finalized:true,executable:false,data:data(f.report,f.link)};}})}});
 return {...f,c,disk,store,get calls(){return calls;},get reads(){return reads;},get checks(){return checks;}};
}
test('confirmed credit becomes one Monero row with the net amount and exact paired wallet',()=>{
 const {report}=fixture(),row=jointHoldingRow(report,account,asset,{privateTest:true,now:at});assert.equal(row.amountRaw,'985000');assert.equal(row.stale,false);assert.equal(row.network,'monero');assert.equal(row.position,position);assert.equal(row.receipt.url,'https://xmrchain.net/tx/'+'cd'.repeat(32));assert.ok(isJointHolding(row));
 const sol={network:'solana',mint:asset.mint,amountRaw:'10000000'};assert.deepEqual(tokenGroups([sol,row]).map(g=>g.items[0].row.amountRaw),['985000','10000000']);
});
test('partial history, wrong policy/account/mint, missing link and inflated available amounts cannot create a balance',()=>{
 for(const change of [r=>r.complete=false,r=>r.manifest={...manifest,mint:'bad'},r=>r.privateTestPolicy=null,r=>r.positions[0].solanaOwner='bad',r=>r.positions.push(r.positions[0]),r=>r.positions[0].available='1000000',r=>r.accepted.shift(),r=>r.accepted.pop(),r=>r.positions[0].config={...config,binding:'ab'.repeat(32)}]){const {report}=fixture();change(report);assert.throws(()=>jointHoldingRow(report,account,asset,{privateTest:true}));}
});
test('pending custody credit is not shown until native replay makes it available',()=>{
 const {report}=fixture();report.positions[0].balance='0';report.positions[0].available='0';report.accepted.pop();assert.equal(jointHoldingRow(report,account,asset,{privateTest:true}),null);
});
test('reader verifies deployment and matching finalized custody, then persists display-only public history',async()=>{
 const f=setup(),result=await f.c.load(account);assert.equal(result.complete,true);assert.equal(result.rows[0].amountRaw,'985000');assert.equal(f.checks,1);assert.equal(f.reads,2);assert.equal(f.c.cached(account)[0].stale,true);
 const saved=JSON.parse([...f.disk.values()][0]);assert.deepEqual(Object.keys(saved).sort(),['mint','report','savedAt','sol','xmr']);
});
test('changed custody or program failure cannot be displayed as a current balance',async()=>{
 for(const options of [{verifyProgram:async()=>{throw Error('Changed code');}},{readAccount:async()=>undefined},{readAccount:async()=>({owner:manifest.program,executable:true,finalized:true,data:Buffer.alloc(169)})}]){const f=setup(options),r=await f.c.load(account);assert.equal(r.complete,false);assert.deepEqual(r.rows,[]);assert.equal(f.disk.size,0);}
});
test('positive finalized custody with an omitted replay position is unavailable, never verified zero',async()=>{
 for(const positions of [[],[{position:manifest.verifier,moneroOwner:'another-wallet'}]]){
  const f=setup({snapshot:r=>({...r,positions})}),result=await f.c.load(account);
  assert.equal(result.complete,false);assert.deepEqual(result.rows,[]);assert.equal(f.disk.size,0);
 }
});
test('missing funded position preserves the last verified holding as stale',async()=>{
 const f=setup();await f.c.load(account);const saved=[...f.disk.values()][0];
 const next=setup({storage:f.store,snapshot:r=>({...r,positions:[]})}),result=await next.c.load(account);
 assert.equal(result.complete,false);assert.equal(result.rows[0].amountRaw,'985000');assert.equal(result.rows[0].stale,true);
 assert.equal([...f.disk.values()][0],saved);
});
test('known pending credit and genuinely zero custody retain their empty-balance behavior',async()=>{
 const pending=setup({snapshot:r=>{r.positions[0].balance='0';r.positions[0].available='0';r.accepted.pop();return r;}});
 const waiting=await pending.c.load(account);assert.equal(waiting.complete,true);assert.deepEqual(waiting.rows,[]);
 const empty=setup({snapshot:r=>({...r,positions:[],accepted:[]}),readAccount:()=>{const f=fixture();f.report.positions[0].chainBalance='0';return {owner:manifest.program,finalized:true,executable:false,data:data(f.report,f.link)};}});
 const zero=await empty.c.load(account);assert.equal(zero.complete,true);assert.deepEqual(zero.rows,[]);
});
test('concurrent refreshes share one read and a slow read does not cause immediate repeated scans',async()=>{
 let release,time=at;const f=setup({now:()=>time,snapshot:r=>new Promise(resolve=>release=()=>resolve(r))});
 const first=f.c.load(account),second=f.c.load(account);await new Promise(r=>setImmediate(r));assert.equal(f.calls,1);time+=90000;release();await Promise.all([first,second]);await f.c.load(account);assert.equal(f.calls,1);
});
test('a restarted wallet shows old data as last-known and does not read another private account',async()=>{
 const f=setup();await f.c.load(account);const next=setup({storage:f.store});assert.equal(next.c.cached(account)[0].stale,true);
 const other={...account,sol:manifest.verifier};assert.deepEqual(next.c.cached(other),[]);assert.deepEqual((await next.c.load(other)).rows,[]);assert.equal(next.calls,0);
});
test('outage retains only marked last-known data and a fresh zero removes it',async()=>{
 let time=at,mode='good';const f=setup({now:()=>time,snapshot:r=>{if(mode==='fail')throw Error('Offline');if(mode==='zero'){r.positions[0].available='0';r.positions[0].balance='0';r.positions[0].chainBalance='0';}return r;}});
 await f.c.load(account);time+=61000;mode='fail';let r=await f.c.load(account);assert.equal(r.complete,false);assert.equal(r.rows[0].stale,true);
 time+=61000;mode='zero';r=await f.c.load(account);assert.equal(r.complete,true);assert.deepEqual(r.rows,[]);assert.deepEqual(f.c.cached(account),[]);
});
test('clearing account state discards a late positive result and prevents display-cache writes',async()=>{
 let release;const f=setup({snapshot:r=>new Promise(resolve=>release=()=>resolve(r))});const pending=f.c.load(account);await new Promise(r=>setImmediate(r));f.c.clear();release();assert.equal((await pending).complete,false);assert.equal(f.disk.size,0);
});
test('independent index updates preserve the other bridge and never duplicate an existing new position',()=>{
 const joint=jointHoldingRow(fixture().report,account,asset,{privateTest:true}),legacy={network:'monero',mint:asset.mint,amountRaw:'2'},sol={network:'solana',mint:asset.mint,amountRaw:'9'};
 let rows=replaceHoldingSource([joint,sol],[legacy],{network:'monero'});assert.deepEqual(rows,[joint,sol,legacy]);rows=replaceHoldingSource(rows,[joint],{bridge:asset.mint});assert.equal(rows.length,3);assert.equal(rows.filter(isJointHolding).length,1);
 rows=replaceHoldingSource(rows,[],{bridge:asset.mint});assert.deepEqual(rows,[sol,legacy]);
});

test('any-wallet home reads held or selected tokens without opening unused default token runtimes',async()=>{
 const {WALLET_TEST_POLICY}=await import('../../engine/shared/bridge-sdk/core-transferable/private-test.mjs'),{XCAT_MINT,rememberJointAsset}=await import('../../engine/shared/joint-bridge-assets.js');
 const calls=[],disk=new Map(),storage={getItem:k=>disk.get(k),setItem:(k,v)=>disk.set(k,v)};
 const reader=createJointHoldings({walletTest:true,storage,adapters:{runtime:a=>({snapshot:async()=>{calls.push(a.mint);return {schema:'joint-index-v3',complete:true,manifest:transferableManifest(a.mint),privateTestPolicy:WALLET_TEST_POLICY,positions:[],accepted:[]};}}),chain:a=>({verifyProgram:async()=>{},readAccount:async()=>{const b=data(fixture().report,fixture().link);new PublicKey(a.mint).toBuffer().copy(b,65);return {owner:manifest.program,finalized:true,executable:false,data:b};}})}});
 await reader.load(account);assert.deepEqual(calls,[policy.mint]);
 rememberJointAsset({mint:XCAT_MINT,symbol:'XCAT'},storage);await reader.load(account);assert.deepEqual(calls,[policy.mint,XCAT_MINT]);
});
test('a slow token does not block other tokens from reaching the portfolio',async()=>{
 const {WALLET_TEST_POLICY}=await import('../../engine/shared/bridge-sdk/core-transferable/private-test.mjs'),{XCAT_MINT}=await import('../../engine/shared/joint-bridge-assets.js');
 let release;const wait=new Promise(r=>release=r),seen=[],reader=createJointHoldings({walletTest:true,storage:{getItem:()=>null,setItem(){}},adapters:{runtime:a=>({snapshot:async()=>{if(a.mint===policy.mint)await wait;return {schema:'joint-index-v3',complete:true,manifest:transferableManifest(a.mint),privateTestPolicy:WALLET_TEST_POLICY,positions:[],accepted:[]};}}),chain:a=>({verifyProgram:async()=>{},readAccount:async()=>{const b=data(fixture().report,fixture().link);new PublicKey(a.mint).toBuffer().copy(b,65);return {owner:manifest.program,finalized:true,executable:false,data:b};}})}});
 const result=reader.load(account,[{mint:XCAT_MINT}],{onResult:r=>seen.push(r.mint)});await new Promise(r=>setImmediate(r));assert.deepEqual(seen,[XCAT_MINT]);release();await result;assert.equal(seen.length,2);
});
test('installed profile balance refresh reaches hosted service without a local connector',async()=>{
 const {WALLET_TEST_POLICY}=await import('../../engine/shared/bridge-sdk/core-transferable/private-test.mjs');
 const calls=[],reader=createJointHoldings({walletTest:true,storage:{getItem:()=>null,setItem(){}},fetcher:async(url,o)=>{calls.push({url,o});return new Response(JSON.stringify({schema:'joint-index-v3',complete:true,manifest,privateTestPolicy:WALLET_TEST_POLICY,positions:[],accepted:[]}));},adapters:{chain:a=>({verifyProgram:async()=>{},readAccount:async()=>{const b=data(fixture().report,fixture().link);new PublicKey(a.mint).toBuffer().copy(b,65);b.writeBigUInt64LE(0n,161);return {owner:manifest.program,finalized:true,executable:false,data:b};}})}});
 const r=await reader.load(account);assert.equal(r.complete,true);assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.xmr20.org/api/joint-transferable/'+asset.mint+'/snapshot');assert.equal(calls[0].o.method,'POST');
});


test('unregistered token skips native history after a fresh deployment and finalized custody check',async()=>{
 const f=setup({readAccount:async()=>null});const r=await f.c.load(account);
 assert.equal(r.complete,true);assert.deepEqual(r.rows,[]);assert.equal(f.calls,0);assert.equal(f.checks,1);assert.equal(f.reads,1);
});
test('linked zero custody still reads incoming history and clears an old balance',async()=>{
 const f=setup();await f.c.load(account);assert.equal(f.c.cached(account).length,1);
 const next=setup({storage:f.store,snapshot:r=>{Object.assign(r.positions[0],{chainBalance:'0',balance:'0',available:'0'});return r;},readAccount:async()=>{const x=fixture();x.report.positions[0].chainBalance='0';return {owner:manifest.program,finalized:true,executable:false,data:data(x.report,x.link)};}});
 const r=await next.c.load(account);assert.equal(r.complete,true);assert.deepEqual(r.rows,[]);assert.equal(next.calls,1);assert.deepEqual(next.c.cached(account),[]);
});
test('untrusted or mismatched zero custody cannot clear a cached holding',async()=>{
 const f=setup();await f.c.load(account);
 for(const change of [v=>v.finalized=false,v=>v.owner=account.sol,v=>v.executable=true,v=>v.data[1]^=1]){
  const next=setup({storage:f.store,readAccount:async()=>{const x=fixture();x.report.positions[0].chainBalance='0';const v={owner:manifest.program,finalized:true,executable:false,data:data(x.report,x.link)};change(v);return v;}});
  const r=await next.c.load(account);assert.equal(r.complete,false);assert.equal(r.rows[0].stale,true);assert.equal(next.calls,0);
 }
});

function incomingFixture(){
 const {report}=fixture();Object.assign(report.positions[0],{balance:'0',chainBalance:'0',available:'0'});
 const sender='49DsRNquggMViexHSbSbE7C2TcV6rYBJkBQhEH3WqNV31QmJsyHAmP9MN2cw12PG5sDFZczxbLaeZ3aN4R5tL7ZDMVMokAZ';
 const envelope={record:{p:'xmr20-joint',v:3,net:'mainnet',op:'transfer',mint:asset.mint,program:manifest.program,owner:sender,to:account.xmr,from:manifest.verifier,into:position,nonce:'ab'.repeat(32),amount:'15502018636656'},signature:'SigV2'+'1'.repeat(90)};
 report.positions.push({position:manifest.verifier,moneroOwner:sender,available:'15502018636656'});
 const item={txid:'ef'.repeat(32),envelope,reason:'finalized-backing-receipt-missing',confirmations:10};report.pending=[item];return {report,item};
}
test('incoming confirmed record is separate from spendable balance for a zero-balance recipient',()=>{
 const {report}=incomingFixture();assert.equal(jointHoldingRow(report,account,asset,{privateTest:true}),null);
 const rows=jointIncomingRows(report,account,asset,{privateTest:true});assert.equal(rows.length,1);assert.equal(rows[0].state,'approval');assert.equal(rows[0].amountRaw,'15502018636656');
});
test('relay observations are pending only; duplicates and finalized transfers disappear',()=>{
 const {report,item}=incomingFixture();report.pending=[];report.observed=[item,item];let rows=jointIncomingRows(report,account,asset,{privateTest:true});assert.equal(rows.length,1);assert.equal(rows[0].state,'confirming');
 report.pending=[item];rows=jointIncomingRows(report,account,asset,{privateTest:true});assert.equal(rows.length,1);assert.equal(rows[0].state,'approval');
 report.accepted.push(item);assert.deepEqual(jointIncomingRows(report,account,asset,{privateTest:true}),[]);
});
test('wrong recipient, mint, position, unconfirmed status and malformed amounts never create incoming rows',()=>{
 for(const change of [r=>r.to=r.owner,r=>r.into=manifest.verifier,r=>r.mint=manifest.verifier,r=>r.amount='1e9']){const {report,item}=incomingFixture();change(item.envelope.record);assert.deepEqual(jointIncomingRows(report,account,asset,{privateTest:true}),[]);}
 const {report,item}=incomingFixture();item.confirmations=9;assert.deepEqual(jointIncomingRows(report,account,asset,{privateTest:true}),[]);
});
test('incoming rows are cached separately and remain nonspendable through an outage',async()=>{
 const fixture=incomingFixture();let fail=false,time=at;
 const f=setup({now:()=>time,snapshot:()=>{if(fail)throw Error('offline');return fixture.report;},readAccount:()=>({owner:manifest.program,finalized:true,executable:false,data:data(fixture.report,fixture.report.accepted[0].envelope)})});
 let r=await f.c.load(account);assert.equal(r.complete,true);assert.deepEqual(r.rows,[]);assert.equal(r.pending.length,1);assert.deepEqual(f.c.cached(account),[]);assert.equal(f.c.cachedPending(account)[0].stale,true);
 fail=true;time+=61000;r=await f.c.load(account);assert.equal(r.complete,false);assert.deepEqual(r.rows,[]);assert.equal(r.pending[0].stale,true);
});

test('unchanged finalized custody within the report window redisplays the last complete snapshot without another history request',async()=>{
 let time=at;const f=setup({now:()=>time});
 const first=await f.c.load(account);assert.equal(f.calls,1);assert.equal(f.reads,2);assert.equal(first.rows[0].amountRaw,'985000');
 time+=15000;const second=await f.c.load(account);assert.equal(f.calls,1,'no new snapshot');assert.equal(f.reads,3,'one fresh custody read');assert.equal(second.complete,true);assert.equal(second.rows[0].amountRaw,'985000');assert.equal(second.rows[0].stale,false);assert.equal(second.rows[0].historyAt,at);
 time+=15000;await f.c.load(account);assert.equal(f.calls,1);
 time+=31000;const aged=await f.c.load(account);assert.equal(f.calls,2,'window expired: fresh snapshot');assert.equal(aged.rows[0].historyAt,time);
 time+=15000;await f.c.load(account,[],{force:true});assert.equal(f.calls,3,'manual refresh always snapshots');
});
test('changed custody bytes, a failed read or a different position force a fresh snapshot',async()=>{
 let time=at,balance='985000';const base=fixture();
 const f=setup({now:()=>time,readAccount:()=>{const g=fixture();g.report.positions[0].chainBalance=balance;return {owner:manifest.program,finalized:true,executable:false,data:data(g.report,g.link)};},snapshot:r=>{r.positions[0].chainBalance=balance;r.positions[0].balance=balance;r.positions[0].available=balance;return r;}});
 await f.c.load(account);assert.equal(f.calls,1);
 time+=15000;balance='984000';const changed=await f.c.load(account);assert.equal(f.calls,2,'custody changed on chain');assert.equal(changed.rows[0].amountRaw,'984000');
 time+=15000;await f.c.load(account);assert.equal(f.calls,2,'unchanged again: reused');
 // A failed refresh clears the remembered report; the next cycle must snapshot.
 const failing=setup({now:()=>time,snapshot:r=>{if(failing.fail)throw Error('offline');return r;}});failing.fail=false;await failing.c.load(account);time+=15000;failing.fail=true;const outage=await failing.c.load(account);assert.equal(outage.complete,true,'reused within window despite offline service');time+=46000;const after=await failing.c.load(account);assert.equal(after.complete,false);assert.equal(after.rows[0].stale,true);failing.fail=false;time+=15000;await failing.c.load(account);assert.equal(failing.calls,3);
 void base;
});
test('a fast recipient holding needs no fabricated Monero credit and links to its Solana position',async()=>{
 const {receiptCommitment}=await import('../../engine/shared/bridge-sdk/core-fast-send/records.mjs');
 const {report}=fixture();report.accepted.pop();const from=manifest.verifier,nonce='71'.repeat(32),receipt=PublicKey.findProgramAddressSync([Buffer.from('joint-v3-receipt'),new PublicKey(from).toBuffer(),Buffer.from(nonce,'hex')],new PublicKey(manifest.program))[0].toBase58();
 const credit={kind:4,from,to:position,gross:'985000',net:'985000',fee:'0',nonce,receipt,settlement:'solana'};credit.commitment=receiptCommitment({...manifest,...credit});report.fastTransfers=[credit];
 const row=jointHoldingRow(report,account,asset,{privateTest:true});assert.equal(row.amountRaw,'985000');assert.equal(row.settlement,'solana');assert.equal(row.fastReceipt,receipt);assert.equal(row.receipt.url,'https://solscan.io/account/'+position);assert.equal(row.receipt.label,'View Solana position');
 report.fastTransfers[0].net='985001';assert.throws(()=>jointHoldingRow(report,account,asset,{privateTest:true}),/Confirmed token credit missing/);
});
