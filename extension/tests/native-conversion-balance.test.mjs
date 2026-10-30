import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {AccountLayout,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {addresses} from '../../engine/shared/bridge-sdk/core-transferable/sdk.mjs';
import {digest} from '../../engine/shared/bridge-sdk/core-transferable/records.mjs';
import {createConversionBalanceReader} from '../../engine/shared/native-conversion-balance.js';
const pk=n=>Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
function fixture(){
 const owner=pk(1),mint=pk(2),verifier=pk(3),program=pk(4);
 const account={solana:owner.toBase58(),monero:'4'+'1'.repeat(94)};
 const backing={mint:mint.toBase58(),verifier:verifier.toBase58(),program:program.toBase58()};
 const configuration={backing,operatorDeployment:{...backing,abi:3,network:'mainnet-beta'}};
 const position=Buffer.alloc(169);position[0]=3;owner.toBuffer().copy(position,1);verifier.toBuffer().copy(position,33);mint.toBuffer().copy(position,65);Buffer.from(digest(account.monero),'hex').copy(position,97);position.writeBigUInt64LE(7530668912636n,161);
 const token=Buffer.alloc(AccountLayout.span);mint.toBuffer().copy(token);owner.toBuffer().copy(token,32);token.writeBigUInt64LE(123456789n,64);token[108]=1;
 const positionKey=addresses({...configuration.operatorDeployment,owner:account.solana}).position;
 const ata=getAssociatedTokenAddressSync(mint,owner,false,TOKEN_2022_PROGRAM_ID);
 const info={position:{owner:program,data:position,executable:false},token:{owner:TOKEN_2022_PROGRAM_ID,data:token,executable:false}};
 const calls=[];let active=true,genesis='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
 const connection={getGenesisHash:async()=>genesis,getAccountInfo:async(key,options)=>{calls.push({key:key.toBase58(),options});return key.equals(positionKey)?info.position:key.equals(ata)?info.token:assert.fail('Unexpected balance account');}};
 const read=createConversionBalanceReader({configuration,connection,assertCurrent:()=>assert.ok(active,'Wallet changed')});
 return {read,account,info,calls,positionKey,ata,connection,configuration,lock:()=>active=false,wrongNetwork:()=>genesis='wrong'};
}
test('Max reads distinct finalized bridge and Solana balances with exact atomic precision',async()=>{
 const f=fixture();
 assert.equal(await f.read({kind:'migrate-output',account:f.account}),'7530668912636');
 assert.equal(await f.read({kind:'deposit',account:f.account}),'123456789');
 assert.deepEqual(f.calls.map(c=>c.key),[f.positionKey.toBase58(),f.ata.toBase58()]);
 assert.ok(f.calls.every(c=>c.options.commitment==='finalized'));
 f.info.token.data.writeBigUInt64LE(9007199254740993n,64);
 assert.equal(await f.read({kind:'deposit',account:f.account}),'9007199254740993');
});
test('Max refuses other owners, mints, Monero bindings, frozen tokens and wrong programs',async()=>{
 for(const kind of ['migrate-output','deposit']){
  for(const mutate of [
   f=>{f.info[kind==='deposit'?'token':'position'].owner=pk(8);},
   f=>{f.info[kind==='deposit'?'token':'position'].executable=true;},
   f=>{pk(8).toBuffer().copy(f.info[kind==='deposit'?'token':'position'].data,kind==='deposit'?32:1);},
   f=>{pk(8).toBuffer().copy(f.info[kind==='deposit'?'token':'position'].data,kind==='deposit'?0:65);}
  ]){const f=fixture();mutate(f);await assert.rejects(f.read({kind,account:f.account}));}
 }
 const frozen=fixture();frozen.info.token.data[108]=2;await assert.rejects(frozen.read({kind:'deposit',account:frozen.account}));
 const link=fixture();link.info.position.data[97]^=1;await assert.rejects(link.read({kind:'migrate-output',account:link.account}));
});
test('Max distinguishes zero from unavailable and rechecks wallet scope after reads',async()=>{
 const f=fixture();f.info.position=null;assert.equal(await f.read({kind:'migrate-output',account:f.account}),'0');
 const offline=fixture();offline.connection.getAccountInfo=async()=>{throw Error('Offline');};await assert.rejects(offline.read({kind:'deposit',account:offline.account}),/Offline/);
 const changed=fixture();changed.connection.getAccountInfo=async()=>{changed.lock();return changed.info.token;};await assert.rejects(changed.read({kind:'deposit',account:changed.account}),/Wallet changed/);
 const network=fixture();network.wrongNetwork();await assert.rejects(network.read({kind:'deposit',account:network.account}),/Wrong balance network/);
 assert.equal(network.calls.length,1); // Independent public reads run together; wrong genesis still rejects.
});
test('Max uses concurrent read-only wallet RPC requests independent of the native scanner',async()=>{
 const f=fixture(),calls=[];let release;
 const bothStarted=new Promise(resolve=>release=resolve);
 const fetchImpl=async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({url,options,body});
  if(calls.length===2)release();
  await bothStarted;
  assert.equal(url,'https://xmr20.org/api/wallet');
  assert.equal(body.action,'walletRpc');
  assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  assert.equal(options.cache,'no-store');assert.ok(options.signal instanceof AbortSignal);
  const {rpc}=body;assert.equal(rpc.id,1);
  if(rpc.method==='getGenesisHash')return Response.json({jsonrpc:'2.0',id:1,result:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'});
  assert.equal(rpc.method,'getMultipleAccounts');
  assert.deepEqual(rpc.params[0],[f.positionKey.toBase58()]);
  assert.equal(rpc.params[1].commitment,'finalized');
  const info=f.info.position;
  return Response.json({jsonrpc:'2.0',id:1,result:{context:{slot:42},value:[{...info,owner:info.owner.toBase58(),data:[info.data.toString('base64'),'base64']}] }});
 };
 const read=createConversionBalanceReader({configuration:f.configuration,fetchImpl});
 assert.equal(await read({kind:'migrate-output',account:f.account}),'7530668912636');
 assert.equal(calls.length,2);
});
test('Max reports transport failures as retryable errors instead of a zero balance',async()=>{
 const f=fixture();
 for(const [error,message] of [
  [new DOMException('signal timed out','TimeoutError'),/balance check took too long.*try Max again/],
  [new DOMException('aborted','AbortError'),/balance check took too long/],
  [new TypeError('Failed to fetch'),/Could not reach the balance service/]
 ]){
  const read=createConversionBalanceReader({configuration:f.configuration,fetchImpl:async()=>{throw error;}});
  await assert.rejects(read({kind:'migrate-output',account:f.account}),message);
 }
 for(const reply of [
  {jsonrpc:'2.0',id:1,error:{message:'Unavailable'}},
  {jsonrpc:'2.0',id:2,result:null}
 ]){
  const read=createConversionBalanceReader({configuration:f.configuration,fetchImpl:async()=>Response.json(reply)});
  await assert.rejects(read({kind:'deposit',account:f.account}),/Could not refresh your balance/);
 }
});
