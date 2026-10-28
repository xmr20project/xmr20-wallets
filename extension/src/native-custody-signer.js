import {Buffer} from 'buffer';
import {NATIVE_MARKET_CONFIGURATION} from '../../engine/shared/website/native-market-config.js';
import {createOperatorCustodyAdapter,createOperatorRefundAdapter} from '../../engine/shared/bridge-sdk/core-monero-send/solana-custody-adapter.mjs';
import {createSolanaReadConnection} from '../../engine/shared/native-market/wallet/solana-read-connection.mjs';
import {createMarketFetch} from './market-policy.js';
import {importSol} from '../../engine/shared/core.js';

// Only the bound packaged bridge-entry screen can call this capability.
// The key stays in the background; fresh program, policy, fee and holder state
// are checked again independently of the server's prepared transaction.
export function createNativeCustodySigner({configuration=NATIVE_MARKET_CONFIGURATION,fetchImpl=createMarketFetch()}={}){
 return async({account,plan,proposal,checkCurrent,assertCurrent=()=>{}})=>{
  const refund=plan?.schema==='xmr20-operator-unissued-refund-v1',source=refund?plan.source:plan;
  if(!configuration||source?.record?.owner!==account.xmr||source?.request?.owner!==account.sol||
   plan?.request?.owner!==account.sol||!account.solSecret)throw Error('This custody approval belongs to another wallet.');
  const rpc=async(method,params)=>{
   const response=await fetchImpl('/api/native-market/solana',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000)});
   await checkCurrent();assertCurrent();if(!response.ok||!response.body)throw Error('Custody verification is unavailable.');
   const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>4*1024*1024)throw Error('Custody read exceeded its limit.');chunks.push(chunk);}
   const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(value.error||value.result===undefined)throw Error('Custody verification failed.');return value.result;
  };
  const adapter=(refund?createOperatorRefundAdapter:createOperatorCustodyAdapter)({configuration,manifest:configuration.operatorDeployment,privateTestPolicy:configuration.operatorTestPolicy,
   connection:createSolanaReadConnection({rpc,assertCurrent}),signer:{publicKey:configuration.backing.verifier,signCustody(){throw Error('Holder cannot sign for the bridge');},signRefund(){throw Error('Holder cannot sign for the bridge');}}});
  const tx=await adapter.reviewForHolder(plan,proposal);await checkCurrent();assertCurrent();
  const key=importSol(account.solSecret),secret=key.secretKey;
  try{
   if(key.publicKey.toBase58()!==account.sol)throw Error('Selected Solana key differs.');
   tx.sign([{publicKey:key.publicKey,secretKey:secret}]);await checkCurrent();assertCurrent();
   const transaction=Buffer.from(tx.serialize()).toString('hex');adapter.validateApproval(plan,proposal,transaction);
   return {transaction};
  }finally{secret.fill(0);}
 };
}
