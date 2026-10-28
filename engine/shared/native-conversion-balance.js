import {PublicKey} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,unpackAccount,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {addresses,decodePosition} from './bridge-sdk/core-transferable/sdk.mjs';
import {digest} from './bridge-sdk/core-transferable/records.mjs';
import {createSolanaReadConnection} from './native-market/wallet/solana-read-connection.mjs';
import {NATIVE_MARKET_CONFIGURATION} from './website/native-market-config.js';

const need=(ok,message)=>{if(!ok)throw Error(message);};
const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
// Capture before the standalone market page installs its market-only transport.
const publicFetch=globalThis.fetch.bind(globalThis);
const BALANCE_ENDPOINT='https://xmr20.org/api/wallet';
// This only fills the form. Quotes and holder approvals still independently
// verify fresh custody, fees, program/policy and the exact amount before signing.
export function createConversionBalanceReader({configuration=NATIVE_MARKET_CONFIGURATION,fetchImpl=publicFetch,assertCurrent=()=>{},connection}={}){
 const rpc=async(method,params)=>{
  assertCurrent();
  need(['getGenesisHash','getMultipleAccounts'].includes(method),'Public balance reads only.');
  try{
  // Balance selection does not depend on the Monero scanner or issuer process.
  const response=await fetchImpl(BALANCE_ENDPOINT,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'walletRpc',rpc:{jsonrpc:'2.0',id:1,method,params}}),credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)});
  need(response.ok&&response.body,'Could not refresh your balance. Try Max again.');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;need(size<=32768,'Balance reply exceeds its limit.');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  const value=JSON.parse(new TextDecoder().decode(bytes));assertCurrent();
  need(value.jsonrpc==='2.0'&&value.id===1&&!value.error&&value.result!==undefined,'Could not refresh your balance. Try Max again.');
  return value.result;
  }catch(error){
   assertCurrent();
   if(error?.name==='TimeoutError'||error?.name==='AbortError')throw Error('The balance check took too long. Please try Max again.');
   if(error instanceof TypeError)throw Error('Could not reach the balance service. Please try Max again.');
   throw error;
  }
 };
 const chain=connection??createSolanaReadConnection({rpc,assertCurrent});
 return async({kind,account})=>{
  assertCurrent();need(configuration&&['migrate-output','deposit'].includes(kind),'Choose a token source.');
  const b=configuration.backing,owner=new PublicKey(account.solana);
  need(owner.toBase58()===account.solana&&account.solana!==b.verifier,'Choose the token holder wallet.');
  const mint=new PublicKey(b.mint),key=kind==='deposit'?getAssociatedTokenAddressSync(mint,owner,false,TOKEN_2022_PROGRAM_ID):addresses({...configuration.operatorDeployment,owner:account.solana}).position;
  const [genesis,info]=await Promise.all([chain.getGenesisHash(),chain.getAccountInfo(key,{commitment:'finalized'})]);assertCurrent();
  need(genesis===GENESIS,'Wrong balance network.');
  if(!info)return '0';
  need(!info.executable,'Invalid token balance account.');
  if(kind==='deposit'){
   need(info.owner.equals(TOKEN_2022_PROGRAM_ID),'Invalid Solana token account.');
   const row=unpackAccount(key,info,TOKEN_2022_PROGRAM_ID);
   need(row.isInitialized&&!row.isFrozen&&row.owner.equals(owner)&&row.mint.equals(mint),'These Solana tokens are not available to this wallet.');
   return row.amount.toString();
  }
  need(info.owner.toBase58()===b.program,'Invalid bridge balance account.');
  const row=decodePosition(info.data);
  need(row.owner===account.solana&&row.mint===b.mint&&row.verifier===b.verifier&&row.binding===digest(account.monero),'This bridge balance belongs to another wallet.');
  return row.balance;
 };
}
