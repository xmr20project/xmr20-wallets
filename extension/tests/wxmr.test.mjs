import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey} from '@solana/web3.js';
import {AccountLayout,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {readWxmrBalance,WXMR_MINT} from '../src/wxmr-screens.js';
import {rawUnits} from '../src/sol-token-send.js';
import {SOLANA_GENESIS} from '../../engine/shared/solana-rpc.js';

const owner=Keypair.generate().publicKey,other=Keypair.generate().publicKey,ATA=getAssociatedTokenAddressSync(new PublicKey(WXMR_MINT),owner,false,TOKEN_PROGRAM_ID).toBase58();
function account({amount=2_500_000_000_000n,mint=new PublicKey(WXMR_MINT),wallet=owner,program=TOKEN_PROGRAM_ID,length=AccountLayout.span}={}){
 const b=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint,owner:wallet,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},b);
 return {data:[b.subarray(0,length).toString('base64'),'base64'],lamports:2039280,owner:program.toBase58(),executable:false,rentEpoch:0};}
function nodes(answer){const calls=[];return {calls,fetcher:async(url,o)=>{const body=JSON.parse(o.body),rpc=body.rpc??body;calls.push([url,rpc.method,!!body.action]);
 const a=answer(url,rpc);if(a instanceof Response)return a;return Response.json({jsonrpc:'2.0',id:rpc.id,result:a});}};}
const ok=(value=account())=>(url,rpc)=>rpc.method==='getGenesisHash'?SOLANA_GENESIS:(assert.deepEqual(rpc.params[0],[ATA]),{context:{slot:1},value:[value]});

test('the public wXMR balance is read from the account\'s own wXMR account, exactly',async()=>{
 const n=nodes(ok());assert.equal(await readWxmrBalance(owner.toBase58(),{fetcher:n.fetcher,endpoints:['https://node-a.test/']}),'2500000000000');
 assert.deepEqual(n.calls.map(c=>c[1]),['getGenesisHash','getMultipleAccounts']);
 const none=nodes(ok(null));assert.equal(await readWxmrBalance(owner.toBase58(),{fetcher:none.fetcher,endpoints:['https://node-b.test/']}),'0','no wXMR account: zero');
});
test('an account of another mint, owner, program or size is refused, not shown',async()=>{
 for(const [i,bad] of [account({mint:other}),account({wallet:other}),account({program:TOKEN_2022_PROGRAM_ID}),account({length:100})].entries()){
  const n=nodes(ok(bad));await assert.rejects(readWxmrBalance(owner.toBase58(),{fetcher:n.fetcher,endpoints:['https://bad-'+i+'.test/']}),/Unexpected wXMR account/);}
});
test('a node of another network or a failing node is passed over; the read service gets its envelope',async()=>{
 const n=nodes((url,rpc)=>url==='https://down.test/'?new Response('busy',{status:429}):url==='https://devnet.test/'&&rpc.method==='getGenesisHash'?'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG':ok()(url,rpc));
 assert.equal(await readWxmrBalance(owner.toBase58(),{fetcher:n.fetcher,endpoints:['https://down.test/','https://devnet.test/','https://xmr20.org/api/wallet']}),'2500000000000');
 assert.ok(!n.calls.some(c=>c[0]==='https://devnet.test/'&&c[1]==='getMultipleAccounts'),'no balance taken from the wrong network');
 assert.ok(n.calls.filter(c=>c[0]==='https://xmr20.org/api/wallet').every(c=>c[2]));
 const all=nodes(()=>new Response('down',{status:503}));await assert.rejects(readWxmrBalance(owner.toBase58(),{fetcher:all.fetcher,endpoints:['https://d1.test/','https://d2.test/']}));
});
test('token amounts: 6 decimals for XMR20 tokens as before, 12 for wXMR',()=>{
 assert.equal(rawUnits('1.5'),1500000n);assert.throws(()=>rawUnits('1.1234567'),/at most 6 decimals/);assert.throws(()=>rawUnits('1000000001'),/1 billion/);
 assert.equal(rawUnits('0.000000000001',12),1n);assert.equal(rawUnits('2.5',12),2500000000000n);
 assert.throws(()=>rawUnits('1.0000000000001',12),/at most 12 decimals/);assert.throws(()=>rawUnits('0',12),/smaller|between|amount/i);assert.throws(()=>rawUnits('abc',12),/12 decimals/);
});

// Token sends on Solana (XMR20 tokens and wXMR): the transaction carries the recent blockhash and the token's decimals.
import {MintLayout,TOKEN_2022_PROGRAM_ID as T22} from '@solana/spl-token';
import {prepareSolanaTokenSend} from '../src/sol-token-send.js';
function chainFor({mint,decimals,program,from,balance=10_000_000_000_000n,lamports=1_000_000_000}){
 const info=(data,owner)=>({data,executable:false,lamports:2039280,owner,rentEpoch:0});
 const m=Buffer.alloc(MintLayout.span);MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:balance,decimals,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},m);
 const t=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint,owner:from,amount:balance,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},t);
 const source=getAssociatedTokenAddressSync(mint,from,false,program).toBase58(),seen={};
 return {seen,rpc:{
  getAccountInfo:async k=>{const key=k.toBase58();return key===mint.toBase58()?info(m,program):key===source?info(t,program):null;},
  getEpochInfo:async()=>({epoch:800}),getLatestBlockhash:async()=>({blockhash:'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',lastValidBlockHeight:12345}),
  getFeeForMessage:async message=>{seen.message=message;return {value:5000};},getMinimumBalanceForRentExemption:async()=>2039280,getBalance:async()=>lamports,
  simulateTransaction:async tx=>{seen.tx=tx;return {value:{err:null}};}}};
}
test('a token send carries the recent blockhash (it was missing: every token send stopped) and the token\'s decimals',async()=>{
 const from=Keypair.generate().publicKey,to=Keypair.generate().publicKey.toBase58();
 for(const [mint,decimals,program,amount,raw] of [[new PublicKey(WXMR_MINT),12,TOKEN_PROGRAM_ID,'2.5','2500000000000'],[Keypair.generate().publicKey,6,T22,'1.5','1500000']]){
  const {rpc,seen}=chainFor({mint,decimals,program,from});
  const p=await prepareSolanaTokenSend({row:{mint:mint.toBase58(),decimals},owner:from.toBase58(),to,amount,rpc});
  assert.equal(p.tx.recentBlockhash,'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi');assert.equal(p.blockhash,'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi');
  assert.equal(p.netRaw,raw);assert.equal(p.feeRaw,'5000');assert.equal(p.rentRaw,'2039280','the recipient gets its token account');
  const ix=p.tx.instructions.at(-1);assert.ok(ix.programId.equals(program));assert.equal(ix.data[ix.data.length-1],decimals,'transferChecked carries the decimals');
 }
});
test('a token send refuses a mint whose decimals differ from the row\'s',async()=>{
 const from=Keypair.generate().publicKey,mint=new PublicKey(WXMR_MINT),{rpc}=chainFor({mint,decimals:12,program:TOKEN_PROGRAM_ID,from});
 await assert.rejects(prepareSolanaTokenSend({row:{mint:WXMR_MINT},owner:from.toBase58(),to:Keypair.generate().publicKey.toBase58(),amount:'1',rpc}),/decimals differ/);
});
