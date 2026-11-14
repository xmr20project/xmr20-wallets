import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey} from '@solana/web3.js';
import {MintLayout,AccountLayout,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {normalizeSolanaRpc,solanaRpcLabel,configureSolanaRpc,solanaReadEndpoints,solanaSendEndpoint,solanaRpcBody,checkSolanaRpc,PUBLIC_SOLANA_RPCS,XMR20_SOLANA_READS,SOLANA_GENESIS} from '../../engine/shared/solana-rpc.js';
import {normalizePreferences} from '../../engine/shared/preferences.js';
import {createPublicBalanceReader} from '../../engine/shared/public-balance.js';
import {loadSolanaHoldings} from '../../engine/shared/solana-holdings.js';
import {connection,solanaConnection} from '../../engine/shared/core.js';

const OWN='https://mainnet.helius-rpc.com/?api-key=00000000-0000-0000-0000-000000000000';
test.afterEach(()=>configureSolanaRpc(null));

test('an own node address is https, without a user name, password or fragment; a path and query are kept',()=>{
 assert.equal(normalizeSolanaRpc(OWN),OWN);
 assert.equal(normalizeSolanaRpc('  https://rpc.example.com/solana  '),'https://rpc.example.com/solana');
 for(const bad of [null,undefined,7,'','not a url','http://rpc.example.com','ws://rpc.example.com','https://user:pass@rpc.example.com','https://rpc.example.com/#x','https://'+'a'.repeat(520)+'.com','javascript:alert(1)'])assert.equal(normalizeSolanaRpc(bad),null,String(bad));
 assert.equal(solanaRpcLabel(OWN),'mainnet.helius-rpc.com','the label never shows the API key');assert.equal(solanaRpcLabel(null),'Free public nodes');
});

test('without an own node: public nodes for reads (then the xmr20.org read service), the first public node for sends',()=>{
 assert.deepEqual(solanaReadEndpoints(),[...PUBLIC_SOLANA_RPCS,XMR20_SOLANA_READS]);assert.equal(solanaSendEndpoint(),PUBLIC_SOLANA_RPCS[0]);
 configureSolanaRpc(()=>'http://insecure.example.com');assert.deepEqual(solanaReadEndpoints(),[...PUBLIC_SOLANA_RPCS,XMR20_SOLANA_READS],'an invalid saved address is ignored');
});

test('with an own node: it alone is used for reads and sends, and the send connection follows the choice',()=>{
 let saved=OWN;configureSolanaRpc(()=>saved);
 assert.deepEqual(solanaReadEndpoints(),[OWN]);assert.equal(solanaSendEndpoint(),OWN);
 assert.equal(solanaConnection().rpcEndpoint,OWN);assert.equal(connection.rpcEndpoint,OWN);assert.equal(typeof connection.getBalance,'function');
 saved=null;assert.equal(solanaConnection().rpcEndpoint,PUBLIC_SOLANA_RPCS[0]);assert.equal(connection.rpcEndpoint,PUBLIC_SOLANA_RPCS[0]);
});

test('JSON-RPC goes as it is, except to the xmr20.org read service',()=>{
 const rpc={jsonrpc:'2.0',id:'1',method:'getBalance',params:[]};
 assert.deepEqual(solanaRpcBody(PUBLIC_SOLANA_RPCS[0],rpc),rpc);assert.deepEqual(solanaRpcBody(OWN,rpc),rpc);assert.deepEqual(solanaRpcBody(XMR20_SOLANA_READS,rpc),{action:'walletRpc',rpc});
});

test('preferences keep an own node only when one is chosen, and the other settings stay',()=>{
 const p=normalizePreferences({autoLockMinutes:30,solanaRpc:OWN});assert.equal(p.solanaRpc,OWN);assert.equal(p.autoLockMinutes,30);
 assert.equal('solanaRpc' in normalizePreferences({autoLockMinutes:30}),false);assert.equal('solanaRpc' in normalizePreferences({...p,solanaRpc:null}),false);
 assert.equal('solanaRpc' in normalizePreferences({solanaRpc:'http://x.example.com'}),false);
 assert.equal(normalizePreferences({...p,autoLockMinutes:5}).solanaRpc,OWN,'changing another setting keeps the node');
});

test('an address is saved only if it answers as Solana mainnet',async()=>{
 const answer=(result,{status=200,id}={})=>async(url,o)=>{assert.equal(url,OWN);const body=JSON.parse(o.body);assert.equal(body.method,'getGenesisHash');assert.equal(o.credentials,'omit');
  return new Response(JSON.stringify({jsonrpc:'2.0',id:id??body.id,result}),{status});};
 assert.equal(await checkSolanaRpc(OWN,{fetcher:answer(SOLANA_GENESIS)}),OWN);
 await assert.rejects(checkSolanaRpc(OWN,{fetcher:answer('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')}),/not Solana mainnet/);
 await assert.rejects(checkSolanaRpc(OWN,{fetcher:answer(SOLANA_GENESIS,{id:'other'})}),/not a Solana RPC node/);
 await assert.rejects(checkSolanaRpc(OWN,{fetcher:answer(SOLANA_GENESIS,{status:401})}),/HTTP 401/);
 await assert.rejects(checkSolanaRpc(OWN,{fetcher:async()=>{throw TypeError('fetch failed');}}),/did not answer/);
 await assert.rejects(checkSolanaRpc('http://insecure.example.com',{fetcher:answer(SOLANA_GENESIS)}),/https address/);
});

test('the SOL balance reader follows the chosen nodes: public nodes as plain JSON-RPC, then the read service; an own node alone',async()=>{
 const calls=[];const fetcher=async(url,o)=>{const body=JSON.parse(o.body);calls.push([url,!!body.action]);const rpc=body.rpc??body;
  if(url===PUBLIC_SOLANA_RPCS[0]||url===PUBLIC_SOLANA_RPCS[1])return new Response('busy',{status:429});
  return Response.json({jsonrpc:'2.0',id:rpc.id,result:{value:42}});};
 const read=createPublicBalanceReader({fetcher,endpoints:solanaReadEndpoints,hedgeMs:1});
 assert.equal(await read('11111111111111111111111111111111'),'42');
 assert.deepEqual(calls.sort(),[[PUBLIC_SOLANA_RPCS[0],false],[PUBLIC_SOLANA_RPCS[1],false],[XMR20_SOLANA_READS,true]].sort());
 calls.length=0;configureSolanaRpc(()=>OWN);
 assert.equal(await read('11111111111111111111111111111112'),'42');assert.deepEqual(calls,[[OWN,false]]);
});

// Token balances: the same chain checks on whichever node answers.
const owner=Keypair.generate().publicKey,GENESIS=SOLANA_GENESIS;
const raw=b=>({data:[b.toString('base64'),'base64'],lamports:2000000,owner:TOKEN_2022_PROGRAM_ID.toBase58(),executable:false,rentEpoch:0});
const mintInfo=()=>{const b=Buffer.alloc(MintLayout.span);MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},b);return raw(b);};
const holding=m=>{const b=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint:new PublicKey(m),owner,amount:7n,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},b);return raw(b);};
function chain({node=()=>({genesis:GENESIS})}={}){
 const t={id:'11111111-1111-1111-1111-000000000001',mint:Keypair.generate().publicKey.toBase58(),name:'Token',ticker:'TKN',moneroTxid:'ab'.repeat(32),solanaFinalized:true};
 const accounts=new Map([[t.mint,mintInfo()],[getAssociatedTokenAddressSync(new PublicKey(t.mint),owner,false,TOKEN_2022_PROGRAM_ID).toBase58(),holding(t.mint)]]),calls=[];
 const fetcher=async(url,o)=>{
  if(!o.method)return Response.json({schema:'xmr20-launches-v1',solanaNetwork:'mainnet-beta',moneroNetwork:'mainnet',tokens:[t]});
  const body=JSON.parse(o.body),rpc=body.rpc??body;calls.push([url,rpc.method,!!body.action]);const n=node(url);
  if(n.down)return new Response('down',{status:503});
  return Response.json({jsonrpc:'2.0',id:rpc.id,result:rpc.method==='getGenesisHash'?n.genesis:{context:{slot:9},value:rpc.params[0].map(k=>accounts.get(k)??null)}});
 };
 return {t,calls,load:options=>loadSolanaHoldings(owner.toBase58(),{fetcher,catalogEndpoint:'https://catalog.test/'+Math.random(),...options})};
}
test('token balances: the first node that answers as mainnet is used, plain JSON-RPC, each node checked for its network',async()=>{
 const c=chain({node:url=>url===PUBLIC_SOLANA_RPCS[0]?{down:true}:url===PUBLIC_SOLANA_RPCS[1]?{genesis:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'}:{genesis:GENESIS}});
 const r=await c.load({endpoints:solanaReadEndpoints});assert.equal(r.complete,true);assert.deepEqual(r.rows.map(x=>x.amountRaw),['7']);
 assert.deepEqual(c.calls.filter(x=>x[0]!==XMR20_SOLANA_READS).map(x=>x.slice(0,2)),[[PUBLIC_SOLANA_RPCS[0],'getGenesisHash'],[PUBLIC_SOLANA_RPCS[1],'getGenesisHash']],'the wrong-network node gave no balances');
 assert.ok(c.calls.filter(x=>x[0]===XMR20_SOLANA_READS).every(x=>x[2]),'the read service gets its envelope');
});
test('token balances with an own node use it alone, and a failing own node is reported, not replaced',async()=>{
 configureSolanaRpc(()=>OWN);
 const ok=chain();const r=await ok.load({endpoints:solanaReadEndpoints});assert.equal(r.rows.length,1);assert.ok(ok.calls.every(x=>x[0]===OWN&&!x[2]));
 const down=chain({node:()=>({down:true})});await assert.rejects(down.load({endpoints:solanaReadEndpoints}));assert.ok(down.calls.every(x=>x[0]===OWN));
});
test('the single endpoint option keeps its old meaning (the website passes its read route this way)',async()=>{
 const c=chain();const r=await c.load({endpoint:'xmr20-chain-read'});assert.equal(r.rows.length,1);assert.ok(c.calls.every(x=>x[0]==='xmr20-chain-read'&&x[2]),'always the walletRpc envelope');
});
