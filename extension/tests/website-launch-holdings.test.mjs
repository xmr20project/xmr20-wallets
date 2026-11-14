import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey} from '@solana/web3.js';
import {MintLayout,AccountLayout,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {validateWalletHoldings,cacheWalletHoldings,cachedWalletHoldings} from '../../web-wallet/src/wallet-holdings.js';
import {mergeWalletHoldings,bridgeActionRow} from '../../web-wallet/src/bridge-portfolio.js';
import {loadSolanaWalletHoldings} from '../../web-wallet/src/solana-chain-holdings.js';
// A launch of the trading service (catalog rows of venue 'xmr20-trade') held in the connected Solana wallet: read from the chain
// like any catalog token, listed by its mint, kept in the saved holdings. Launchpad rows are read and checked as before.
const key=()=>Keypair.generate().publicKey.toBase58(),GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const padToken=()=>({id:'11111111-1111-1111-1111-000000000001',mint:key(),name:'Launchpad token',ticker:'PAD',moneroTxid:'ab'.repeat(32),solanaFinalized:true,proofVerified:true,bridgeReady:true,state:'Launched',hidden:false});
const launchToken=()=>({mint:key(),ticker:'TEST',name:'Test launch',owner:key(),venue:'xmr20-trade',launchMode:'monero',state:'Launched',bridgeReady:true,hidden:false,transferTaxBps:0,decimals:6,moneroNetwork:'mainnet'});
const raw=(b,program)=>({data:[b.toString('base64'),'base64'],lamports:2000000,owner:program.toBase58(),executable:false,rentEpoch:0});
function mintInfo(){const b=Buffer.alloc(MintLayout.span);MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000000000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},b);return raw(b,TOKEN_2022_PROGRAM_ID);}
function holding(mint,owner,amount){const b=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint:new PublicKey(mint),owner:new PublicKey(owner),amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},b);return raw(b,TOKEN_2022_PROGRAM_ID);}
// The site's own routes, answered locally: the holder index, the token catalog and the public Solana read proxy. Anything else
// (price sources) is unreachable, as in a browser without network.
function site(owner,tokens,{index=[],held={},chain=true}={}){
 const accounts=new Map(),calls=[];
 for(const t of tokens){accounts.set(t.mint,mintInfo());if(held[t.mint])accounts.set(getAssociatedTokenAddressSync(new PublicKey(t.mint),new PublicKey(owner),false,TOKEN_2022_PROGRAM_ID).toBase58(),holding(t.mint,owner,held[t.mint]));}
 return async(url,options={})=>{
  url=String(url);calls.push(url);
  if(url.startsWith('/api/wallet-holdings?'))return Response.json({schema:'xmr20-wallet-holdings-v1',address:owner,network:'solana',moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',rows:index,complete:true,checked:Date.now(),revision:1,nextCursor:null});
  if(url==='/api/xmr20/tokens')return Response.json({schema:'xmr20-launches-v1',solanaNetwork:'mainnet-beta',moneroNetwork:'mainnet',tokens});
  if(url==='/api/bridge-solana-read'){if(!chain)return new Response('busy',{status:429});const rpc=JSON.parse(options.body);assert.ok(['getGenesisHash','getMultipleAccounts'].includes(rpc.method),'public reads only');
   return Response.json({jsonrpc:'2.0',id:rpc.id,result:rpc.method==='getGenesisHash'?GENESIS:{context:{slot:100},value:rpc.params[0].map(k=>accounts.get(k)??null)}});}
  throw Error('unreachable in this test: '+url);
 };
}
// One catalog for the whole file: the page shares one catalog read between its lists for a minute.
const pad=padToken(),launch=launchToken(),other=launchToken(),CATALOG=[pad,launch,other];
test('the connected wallet lists a launch token read from the chain, beside a launchpad token, and saves both',async t=>{
 const owner=key(),before=globalThis.fetch;
 globalThis.fetch=site(owner,CATALOG,{held:{[pad.mint]:5000000n,[launch.mint]:793100000000000n}});t.after(()=>{globalThis.fetch=before;});
 const result=await loadSolanaWalletHoldings(owner,{force:true});
 assert.equal(result.complete,true);assert.equal(result.rows.length,2,'the launch token this wallet does not hold is not listed');
 const [a,b]=result.rows;assert.equal(a.id,pad.id);assert.equal(a.deployment,pad.moneroTxid);assert.equal(a.listed,true);assert.equal('venue' in a,false);
 assert.deepEqual({...b,checkedAt:0},{id:launch.mint,mint:launch.mint,name:'Test launch',ticker:'TEST',image:null,deployment:null,listed:false,venue:'xmr20-trade',amountRaw:'793100000000000',checkedAt:0,stale:false,priceUsd:null});
 // The wallet panel's own steps with the result: merge with what it showed before, save it, find the row for Send.
 const values=new Map(),storage={setItem:(k,v)=>values.set(k,v),getItem:k=>values.get(k)??null},next=mergeWalletHoldings(result,null);
 cacheWalletHoldings(owner,next,{network:'solana',storage});
 const saved=cachedWalletHoldings(owner,{network:'solana',storage});assert.deepEqual(saved.rows.map(r=>[r.id,r.venue,r.amountRaw]),[[pad.id,undefined,'5000000'],[launch.mint,'xmr20-trade','793100000000000']]);
 assert.equal(bridgeActionRow({scope:'s',row:b},next.rows,'s'),b);
});
test('a wallet that holds no launch token gets no row for one, and the read is complete',async t=>{
 const owner=key(),before=globalThis.fetch;t.after(()=>{globalThis.fetch=before;});
 globalThis.fetch=site(owner,CATALOG,{held:{[pad.mint]:1n}});
 const result=await loadSolanaWalletHoldings(owner,{force:true});assert.equal(result.complete,true);assert.deepEqual(result.rows.map(r=>r.id),[pad.id]);
});
const launchRow=(t,amountRaw)=>({id:t.mint,mint:t.mint,ticker:t.ticker,name:t.name,deployment:null,listed:false,venue:'xmr20-trade',stale:false,amountRaw,checkedAt:Date.now()-1000});
test('the chain answer stands for a launch token: an index row for one the wallet no longer holds is dropped',async t=>{
 const owner=key(),before=globalThis.fetch;t.after(()=>{globalThis.fetch=before;});
 globalThis.fetch=site(owner,CATALOG,{held:{[launch.mint]:9n},index:[launchRow(other,'77')]});
 const result=await loadSolanaWalletHoldings(owner,{force:true});assert.equal(result.complete,true);assert.deepEqual(result.rows.map(r=>[r.mint,r.amountRaw]),[[launch.mint,'9']]);
});
test('when the chain read fails, the launch rows this browser saved are kept as last known and the answer is not complete',async t=>{
 const owner=key(),stranger=key(),before=globalThis.fetch,values=new Map(),hadStorage='localStorage' in globalThis,storage=globalThis.localStorage;
 globalThis.localStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v))};
 t.after(()=>{globalThis.fetch=before;if(hadStorage)globalThis.localStorage=storage;else delete globalThis.localStorage;});
 globalThis.fetch=site(owner,CATALOG,{held:{[pad.mint]:5n,[launch.mint]:793100000000000n}});
 const good=await loadSolanaWalletHoldings(owner,{force:true});assert.equal(good.complete,true);cacheWalletHoldings(owner,good,{network:'solana'});
 // The read proxy is busy; the holder index answers, and it lists launchpad tokens only.
 const indexPad={id:pad.id,mint:pad.mint,ticker:pad.ticker,name:pad.name,deployment:pad.moneroTxid,listed:true,stale:false,amountRaw:'5',checkedAt:Date.now()-1000};
 globalThis.fetch=site(owner,CATALOG,{chain:false,index:[indexPad]});
 const result=await loadSolanaWalletHoldings(owner,{force:true});
 assert.equal(result.complete,false);assert.deepEqual(result.rows.map(r=>[r.mint,r.amountRaw,r.stale,r.venue]),[[pad.mint,'5',false,undefined],[launch.mint,'793100000000000',true,'xmr20-trade']]);
 // The panel's next steps keep the row in the saved list.
 const next=mergeWalletHoldings(result,good);cacheWalletHoldings(owner,next,{network:'solana'});
 assert.ok(cachedWalletHoldings(owner,{network:'solana'}).rows.some(r=>r.id===launch.mint));
 // A wallet with nothing saved gets the index answer as it is.
 globalThis.fetch=site(stranger,CATALOG,{chain:false});
 const plain=await loadSolanaWalletHoldings(stranger,{force:true});assert.equal(plain.complete,true);assert.deepEqual(plain.rows,[]);
});
test('saved holdings: the launch row kind is exact, exists on Solana only, and launchpad rows are checked as before',()=>{
 const owner=key(),mint=key(),row={id:mint,mint,ticker:'TEST',name:'Test launch',deployment:null,listed:false,venue:'xmr20-trade',stale:false,amountRaw:'7',checkedAt:Date.now()-1000};
 const envelope=(rows,network='solana')=>({schema:'xmr20-wallet-holdings-v1',address:owner,network,moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',complete:true,checked:Date.now()-1000,rows});
 assert.equal(validateWalletHoldings(envelope([row]),owner,'solana').rows[0].venue,'xmr20-trade');
 assert.throws(()=>validateWalletHoldings(envelope([row],'monero'),owner,'monero'),/Invalid holder/);
 for(const change of [{id:key()},{deployment:'ab'.repeat(32)},{deployment:undefined},{listed:true},{venue:'meteora-damm-v2'},{venue:undefined}])assert.throws(()=>validateWalletHoldings(envelope([{...row,...change}]),owner,'solana'),/Invalid holder/,JSON.stringify(change));
 const pad={id:'11111111-1111-1111-1111-111111111111',mint:key(),ticker:'PAD',name:'Launchpad token',deployment:'ab'.repeat(32),listed:true,stale:false,amountRaw:'7',checkedAt:Date.now()-1000};
 assert.equal('venue' in validateWalletHoldings(envelope([pad]),owner,'solana').rows[0],false);
 for(const change of [{deployment:null},{deployment:null,venue:'xmr20-trade',listed:false},{id:'short'}])assert.throws(()=>validateWalletHoldings(envelope([{...pad,...change}]),owner,'solana'),/Invalid holder/,JSON.stringify(change));
 for(const rows of [[pad,{...row,id:pad.mint,mint:pad.mint}],[{...row,id:pad.mint,mint:pad.mint},pad]])assert.throws(()=>validateWalletHoldings(envelope(rows),owner,'solana'),/Invalid holder/,'a launch row and another row share a mint');
});
