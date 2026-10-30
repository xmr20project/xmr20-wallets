import {Buffer} from 'buffer';
import {NATIVE_MARKET_CONFIGURATION} from '../../engine/shared/website/native-market-config.js';
import {createOperatorCustodyAdapter,createOperatorRefundAdapter} from '../../engine/shared/bridge-sdk/core-monero-send/solana-custody-adapter.mjs';
import {createSolanaReadConnection} from '../../engine/shared/native-market/wallet/solana-read-connection.mjs';

// Website counterpart of the extension's native custody signer: the connected Solana
// wallet (Phantom/Solflare) signs the holder slot. Program, policy, fee and holder state
// are verified again here first, and any wallet change to the reviewed transaction is
// rejected before it reaches the bridge.
export function createWebsiteCustodySigner({provider,account,configuration=NATIVE_MARKET_CONFIGURATION,fetchImpl=(...args)=>fetch(...args),connection}){
 return async({plan,proposal,assertCurrent=()=>{}})=>{
  const refund=plan?.schema==='xmr20-operator-unissued-refund-v1',source=refund?plan.source:plan;
  if(!configuration||source?.record?.owner!==account.monero||source?.request?.owner!==account.solana||plan?.request?.owner!==account.solana)
   throw Error('This custody approval belongs to another wallet.');
  const current=()=>{assertCurrent();provider?.assertCurrent?.();if(provider?.publicKey?.toBase58?.()!==account.solana)throw Error('Wallet changed. Reconnect before approving.');};
  const rpc=async(method,params)=>{
   const response=await fetchImpl('/api/native-market/solana',{method:'POST',credentials:'omit',redirect:'error',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000)});
   current();if(!response.ok)throw Error('Custody verification is unavailable.');
   const text=await response.text();if(text.length>4*1024*1024)throw Error('Custody read exceeded its limit.');
   const value=JSON.parse(text);if(value.error||value.result===undefined)throw Error('Custody verification failed.');return value.result;
  };
  const adapter=(refund?createOperatorRefundAdapter:createOperatorCustodyAdapter)({configuration,manifest:configuration.operatorDeployment,privateTestPolicy:configuration.operatorTestPolicy,
   connection:connection??createSolanaReadConnection({rpc,assertCurrent:current}),
   signer:{publicKey:configuration.backing.verifier,signCustody(){throw Error('Holder cannot sign for the bridge');},signRefund(){throw Error('Holder cannot sign for the bridge');}}});
  const tx=await adapter.reviewForHolder(plan,proposal);current();
  // Keep the reviewed programs: a wallet may mutate the object it is given.
  const reviewed=programs(tx.message);
  const signed=await provider.signTransaction(tx);current();
  const transaction=Buffer.from(signed.serialize()).toString('hex');
  // Accepts only a deposit's wallet-added priority fee and Lighthouse checks; rejects any
  // other changed message or a missing/invalid holder signature.
  try{adapter.validateApproval(plan,proposal,transaction);}
  catch(error){throw walletChangeError(error,reviewed,signed);}
  return {transaction};
 };
}

const PROGRAM_NAMES={ComputeBudget111111111111111111111111111111:'a priority fee',L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95:'Lighthouse safety checks',
 '11111111111111111111111111111111':'a SOL transfer',MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr:'a memo'};
function programs(message){return message.compiledInstructions.map(i=>message.staticAccountKeys[i.programIdIndex]?.toBase58()??'lookup');}
// Name what the wallet added without exposing transaction bytes or signatures.
function walletChangeError(error,reviewed,signed){
 if(error?.message!=='Holder approval changed the exact custody transaction')return error;
 let added=[];
 try{const counts=new Map();for(const p of reviewed)counts.set(p,(counts.get(p)||0)+1);
  for(const p of programs(signed.message)){const n=counts.get(p)||0;if(n)counts.set(p,n-1);else added.push(p);}}catch{}
 added=[...new Set(added)].map(p=>PROGRAM_NAMES[p]??'program '+p.slice(0,6)+'…');
 const change=added.length?'added '+added.join(', '):'changed the transaction';
 const result=Error(`Your Solana wallet ${change} that the bridge does not accept. Nothing was sent; your tokens did not move.`);
 result.cause=error;return result;
}
