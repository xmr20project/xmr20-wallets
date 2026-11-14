import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey} from '@solana/web3.js';
import {MintLayout,AccountLayout,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {loadSolanaHoldings,solanaDisplayRows} from '../../engine/shared/solana-holdings.js';
const owner=Keypair.generate().publicKey,other=Keypair.generate().publicKey;
const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
function token(i=0){return {id:'11111111-1111-1111-1111-'+String(i).padStart(12,'0'),mint:Keypair.generate().publicKey.toBase58(),name:'Monero Extremist',ticker:'EXTREMIST',moneroTxid:'ab'.repeat(32),solanaFinalized:true,proofVerified:false,bridgeReady:false,state:'Inscribing'};}
function mintInfo(program){const b=Buffer.alloc(MintLayout.span);MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000000000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},b);return raw(b,program);}
function holding(t,program,{amount=7530668912636n,wallet=owner,mint=new PublicKey(t.mint)}={}){
 const b=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint,owner:wallet,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},b);return raw(b,program);
}
const raw=(b,program)=>({data:[b.toString('base64'),'base64'],lamports:2000000,owner:program.toBase58(),executable:false,rentEpoch:0});
function fixture(tokens=[token()],{program=TOKEN_2022_PROGRAM_ID,patchHolding,patchReply,patchCatalog,genesis=GENESIS}={}){
 const calls=[],accounts=new Map();
 for(const t of tokens){accounts.set(t.mint,mintInfo(program));accounts.set(getAssociatedTokenAddressSync(new PublicKey(t.mint),owner,false,program).toBase58(),patchHolding?patchHolding(t,program):holding(t,program));}
 const fetcher=async(url,o)=>{
  calls.push({url,o});if(!o.method){const value={schema:'xmr20-launches-v1',solanaNetwork:'mainnet-beta',moneroNetwork:'mainnet',tokens};patchCatalog?.(value);return Response.json(value);}
  const {action,rpc}=JSON.parse(o.body);assert.equal(action,'walletRpc');assert.equal(url,'https://xmr20.org/api/wallet');
  assert.ok(['getGenesisHash','getMultipleAccounts'].includes(rpc.method));
  let result;if(rpc.method==='getGenesisHash')result=genesis;
  else{assert.equal(rpc.params[1].commitment,'finalized');assert.ok(rpc.params[0].length<=90);result={context:{slot:100},value:rpc.params[0].map(k=>accounts.get(k)??null)};}
  const reply={jsonrpc:'2.0',id:rpc.id,result};patchReply?.(reply,rpc);return Response.json(reply);
 };
 return {load:options=>loadSolanaHoldings(owner.toBase58(),{fetcher,...options}),calls,fetcher};
}
test('finalized owned Token-2022 balance appears despite missing Monero admission; no bridge readiness invented',async()=>{
 const f=fixture(),r=await f.load();assert.equal(r.complete,true);assert.equal(r.rows.length,1);assert.equal(r.rows[0].amountRaw,'7530668912636');assert.equal(r.rows[0].ticker,'EXTREMIST');assert.equal(r.rows[0].listed,false);assert.equal(r.rows[0].balanceSource,'solana-finalized');assert.equal(r.rows[0].bridgeReady,undefined);
 assert.equal(f.calls.length,3);assert.ok(f.calls.every(({o})=>o.credentials==='omit'&&o.redirect==='error'&&o.cache==='no-store'));
});
test('classic SPL balances use their own ATA and keep raw integer precision',async()=>{
 const r=await fixture(undefined,{program:TOKEN_PROGRAM_ID}).load();assert.equal(r.rows[0].amountRaw,'7530668912636');assert.equal(r.complete,true);
});
test('unheld and zero tokens never enter wallet or bridge choices',async()=>{
 for(const patchHolding of [()=>null,(t,p)=>holding(t,p,{amount:0n})]){const r=await fixture(undefined,{patchHolding}).load();assert.equal(r.complete,true);assert.deepEqual(r.rows,[]);}
});
test('wrong wallet, mint, program or uninitialized accounts cannot become a displayed balance',async()=>{
 const variants=[(t,p)=>holding(t,p,{wallet:other}),(t,p)=>holding(t,p,{mint:other}),(t,p)=>({...holding(t,p),owner:other.toBase58()}),(t,p)=>({...holding(t,p),executable:true}),(t,p)=>{const v=holding(t,p);const b=Buffer.from(v.data[0],'base64');b[108]=0;return raw(b,p);}];
 for(const patchHolding of variants){const r=await fixture(undefined,{patchHolding}).load();assert.equal(r.complete,false);assert.deepEqual(r.rows,[]);}
});
test('provider errors, wrong response identity, truncated results and wrong network reject a false empty success',async()=>{
 await assert.rejects(fixture(undefined,{genesis:'another-network'}).load(),/Wrong Solana network/);
 for(const patchReply of [(r)=>r.id='wrong',(r)=>r.error={code:-32000},(r,q)=>{if(q.method==='getMultipleAccounts')r.result.value.pop();}])await assert.rejects(fixture(undefined,{patchReply}).load());
});
test('duplicate discovery cannot count a holding twice',async()=>{
 const t=token();await assert.rejects(fixture([t,t]).load(),/Duplicate token identity/);
});
test('multiple batches are bounded and contain no signing or submission requests',async()=>{
 const f=fixture(Array.from({length:61},(_,i)=>token(i))),r=await f.load();assert.equal(r.complete,true);assert.equal(r.rows.length,61);assert.equal(f.calls.filter(c=>c.o.method).length,4);
});
test('cancelled account refresh cannot publish rows from the previous account',async()=>{
 const c=new AbortController();c.abort();const f=fixture();await assert.rejects(f.load({signal:c.signal}));assert.equal(f.calls.length,0);
});
test('partial reads preserve unseen last-known balances; complete zero clears them',()=>{
 const old={network:'solana',mint:'old',amountRaw:'23'},monero={network:'monero',mint:'monero',amountRaw:'42'},fresh={mint:'new',amountRaw:'12'};
 assert.deepEqual(solanaDisplayRows([old,monero],{rows:[fresh],complete:false}),[fresh,{...old,stale:true}]);
 assert.deepEqual(solanaDisplayRows([old],{rows:[],complete:true}),[]);
 assert.deepEqual(solanaDisplayRows([old],{rows:[{...fresh,mint:'old'}],complete:false}),[{...fresh,mint:'old'}]);
});
test('a repeated refresh reuses the fresh shared catalog and network identity, then re-proves the network after ten minutes',async()=>{
 let time=Date.now();const f=fixture(Array.from({length:31},(_,i)=>token(i)));
 const first=await f.load({now:()=>time});assert.equal(first.rows.length,31);
 const methods=()=>f.calls.map(c=>c.o.method?JSON.parse(c.o.body).rpc.method:'catalog');
 assert.deepEqual(methods().sort(),['catalog','getGenesisHash','getMultipleAccounts','getMultipleAccounts']);
 f.calls.length=0;time+=15000;const second=await f.load({now:()=>time});assert.equal(second.rows.length,31);assert.equal(second.complete,true);
 assert.deepEqual(methods(),['getMultipleAccounts','getMultipleAccounts'],'only finalized account reads repeat within the window');
 f.calls.length=0;time+=600001;await f.load({now:()=>time});assert.ok(methods().includes('getGenesisHash'));
});
test('account batches travel concurrently while rows keep catalog order',async()=>{
 const tokens=Array.from({length:61},(_,i)=>token(i)),f=fixture(tokens);let inFlight=0,peak=0;
 const slow=f.load;const delayed=(options={})=>slow({...options,fetcher:async(url,o)=>{if(o.method&&JSON.parse(o.body).rpc.method==='getMultipleAccounts'){inFlight++;peak=Math.max(peak,inFlight);await new Promise(r=>setTimeout(r,5));inFlight--;}return f.fetcher(url,o);}});
 const r=await delayed();assert.equal(r.rows.length,61);assert.deepEqual(r.rows.map(x=>x.mint),tokens.map(t=>t.mint));assert.ok(peak>=2&&peak<=3,'bounded concurrency, observed '+peak);
});
// Launches of the trading service: catalog rows of venue 'xmr20-trade', exactly as its catalog writes them.
function launch(change={}){return {mint:Keypair.generate().publicKey.toBase58(),ticker:'TEST',name:'Test launch',owner:Keypair.generate().publicKey.toBase58(),venue:'xmr20-trade',launchMode:'monero',state:'Launched',bridgeReady:true,hidden:false,transferTaxBps:0,decimals:6,moneroNetwork:'mainnet',...change};}
test('a launch of the trading service held on Solana is listed by its mint; no launch record or Monero inscription is invented',async()=>{
 const t=launch(),r=await fixture([token(),t]).load();assert.equal(r.complete,true);assert.equal(r.rows.length,2);
 const [pad,row]=r.rows;assert.match(pad.id,/^[a-f0-9-]{36}$/);assert.equal(pad.deployment,'ab'.repeat(32));assert.equal(pad.venue,undefined);assert.equal('venue' in pad,false);
 assert.deepEqual({...row,checkedAt:0},{id:t.mint,mint:t.mint,name:'Test launch',ticker:'TEST',image:null,deployment:null,listed:false,venue:'xmr20-trade',amountRaw:'7530668912636',checkedAt:0,stale:false,balanceSource:'solana-finalized',frozen:false});
});
test('the launch row kind is exact: a row that is not launched for bridging, carries a launchpad record field, or has another value in a known field is left out',async()=>{
 for(const change of [{state:'Reserved'},{state:undefined},{bridgeReady:false},{bridgeReady:'true'},{hidden:true},{hidden:undefined},{venue:'raydium-launchlab'},{venue:undefined},{halted:true},{cancelledAt:1793910155355},{ticker:''},{ticker:'ELEVENCHARS'},{name:7},{mint:'not-a-mint'},
  {id:null},{id:''},{moneroTxid:'ab'.repeat(32)},{moneroTxid:null},{solanaFinalized:false},{solanaFinalized:true},{launchMode:'solana'},{launchMode:undefined},{decimals:9},{decimals:undefined},{transferTaxBps:150},{moneroNetwork:'stagenet'},{moneroNetwork:undefined}]){
  const r=await fixture([launch()],{patchCatalog:value=>{value.tokens[0]={...value.tokens[0],...change};}}).load();assert.equal(r.complete,true,JSON.stringify(change));assert.deepEqual(r.rows,[],JSON.stringify(change));
 }
});
test('a row with a launch id must pass the launchpad checks; dressing it as a trading-service launch admits nothing',async()=>{
 for(const change of [{solanaFinalized:false},{moneroTxid:undefined},{moneroTxid:'ab'.repeat(31)},{hidden:true},{halted:true},{id:'not-a-launch-id'}]){
  const t={...token(),venue:'xmr20-trade',launchMode:'monero',state:'Launched',bridgeReady:true,hidden:false,...change};
  const r=await fixture([t]).load();assert.equal(r.complete,true,JSON.stringify(change));assert.deepEqual(r.rows,[],JSON.stringify(change));
 }
});
test('the launchpad row stands when a launch row names the same mint, in either order and whatever its state',async()=>{
 const pad=token();
 for(const tokens of [[pad,launch({mint:pad.mint})],[launch({mint:pad.mint}),pad]]){const r=await fixture(tokens).load();assert.equal(r.complete,true);assert.equal(r.rows.length,1);assert.equal(r.rows[0].id,pad.id);assert.equal(r.rows[0].deployment,pad.moneroTxid);assert.equal('venue' in r.rows[0],false);}
 // A row with a launch id that fails its own checks (hidden, or an id that is not one) still keeps a launch row for its mint out.
 for(const change of [{hidden:true},{id:'not-a-launch-id'},{solanaFinalized:false}]){const failing={...token(),...change},none=await fixture([launch({mint:failing.mint}),failing]).load();assert.equal(none.complete,true,JSON.stringify(change));assert.deepEqual(none.rows,[],JSON.stringify(change));}
});
test('a repeated launch row is read once: the first row for the mint stands and no other balance is affected',async()=>{
 const pad=token(),t=launch(),r=await fixture([pad,t,{...t,name:'Second row'},{...t}]).load();
 assert.equal(r.complete,true);assert.deepEqual(r.rows.map(x=>[x.id,x.name]),[[pad.id,pad.name],[t.mint,'Test launch']]);
 await assert.rejects(fixture([pad,{...pad}]).load(),/Duplicate token identity/,'a repeated launchpad row is refused as before');
});
test('a launch row is never marked as listed, and things that are not rows are skipped',async()=>{
 const t=launch({proofVerified:true}),r=await fixture([token(),t],{patchCatalog:value=>{value.tokens=[null,5,'row',[],...value.tokens,null];}}).load();
 assert.equal(r.complete,true);assert.equal(r.rows.length,2);assert.equal(r.rows[1].id,t.mint);assert.equal(r.rows[1].listed,false);
});
test('launch rows share the bounded batches and keep catalog order beside launchpad rows',async()=>{
 const tokens=Array.from({length:40},(_,i)=>i%2?launch({ticker:'L'+i}):token(i)),f=fixture(tokens),r=await f.load();
 assert.equal(r.complete,true);assert.deepEqual(r.rows.map(x=>x.mint),tokens.map(t=>t.mint));assert.equal(r.rows.filter(x=>x.venue==='xmr20-trade').length,20);
 assert.equal(f.calls.filter(c=>c.o.method).length,3,'one network check and two account batches');
});
