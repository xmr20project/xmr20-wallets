import {Buffer} from 'buffer';
import {Connection,PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,unpackMint,unpackAccount,getTransferFeeConfig,getAccountLenForMint,calculateEpochFee} from '@solana/spl-token';
import {sha256} from '@noble/hashes/sha256';
import {bridgeAmounts,validateBridgeReceipt} from './bridge-policy.js';
import {importSol,bs58} from '../../engine/shared/core.js';
const pk=x=>new PublicKey(x),hash=x=>Buffer.from(sha256(new TextEncoder().encode(x)));
const meta=(key,isSigner=false,isWritable=false)=>({pubkey:pk(key),isSigner,isWritable});
const verificationMethods=new Set(['getGenesisHash','getMultipleAccounts','getAccountInfo','getMinimumBalanceForRentExemption','getBalance','getEpochInfo','getBlockHeight','getFeeForMessage','simulateTransaction']);
const verificationEndpoint='https://xmr20.org/api/wallet';
// This scope performs public reads and unsigned simulation only. One deadline
// covers the entire review; an RPC retry cannot leave its button busy forever.
export async function withBridgeVerification(work,{c,timeoutMs=15000,signal,fetcher=globalThis.fetch}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>60000)throw Error('Invalid bridge verification deadline.');
 const controller=new AbortController();let expired=false,timer,stop;
 const timeoutError=()=>Error('Solana checks did not finish. Your existing bridge is saved; retry preparation.');
 const interrupted=()=>Error('Bridge review was closed or changed. Resume the saved bridge.');
 const blocked=new Promise((_,reject)=>{
  stop=()=>{controller.abort();reject(interrupted());};
  if(signal?.aborted){stop();return;}
  signal?.addEventListener('abort',stop,{once:true});
  timer=setTimeout(()=>{expired=true;controller.abort();reject(timeoutError());},timeoutMs);
 });
 const rpc=c||new Connection(verificationEndpoint,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:async(_url,options)=>{
  const request=JSON.parse(options.body);if(!verificationMethods.has(request.method))throw Error('Only bridge verification reads are allowed.');
  // The wallet service holds the Helius credential. Only this public RPC
  // envelope leaves the extension; transaction validation remains local.
  return fetcher(verificationEndpoint,{...options,headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'walletRpc',rpc:request}),credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
 }});
 try{return await Promise.race([blocked,Promise.resolve().then(()=>{if(controller.signal.aborted)throw interrupted();return work(rpc,controller.signal);})]);}
 catch(error){if(expired)throw timeoutError();if(signal?.aborted)throw interrupted();throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);controller.abort();}
}
export function escrowAddresses(program,mint){const p=pk(program),m=pk(mint),[config]=PublicKey.findProgramAddressSync([Buffer.from('xmr20'),m.toBuffer()],p);return {config,vault:getAssociatedTokenAddressSync(m,config,true,TOKEN_2022_PROGRAM_ID),receipt:(type,id)=>PublicKey.findProgramAddressSync([Buffer.from(type),config.toBuffer(),id],p)[0]};}
export function expectedBridgeInstructions(t,a,row,attestor){
 const p=pk(row.program),m=pk(row.mint),owner=pk(a.sol),s=escrowAddresses(p,m),ata=getAssociatedTokenAddressSync(m,owner,false,TOKEN_2022_PROGRAM_ID);
 const common=[meta(owner,true,true),meta(s.config,false,true),meta(m),meta(s.vault,false,true),meta(TOKEN_2022_PROGRAM_ID),meta(SystemProgram.programId)];
 const ixs=[ComputeBudgetProgram.setComputeUnitLimit({units:300000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:0})];let data,keys;
 if(t.direction==='sol-to-xmr'){data=Buffer.alloc(73);data[0]=1;data.writeBigUInt64LE(BigInt(t.amountRaw),1);hash(t.id).copy(data,9);hash(a.xmr).copy(data,41);keys=[...common,meta(ata,false,true),meta(s.receipt('deposit',hash(t.id)),false,true)];}
 else{if(!/^[a-f0-9]{64}$/.test(t.sourceTxid||''))throw Error('Confirmed Monero burn receipt missing.');data=Buffer.alloc(41);data[0]=2;data.writeBigUInt64LE(BigInt(t.amountRaw),1);Buffer.from(t.sourceTxid,'hex').copy(data,9);keys=[...common,meta(ata,false,true),meta(s.receipt('withdraw',Buffer.from(t.sourceTxid,'hex')),false,true),meta(attestor,true)];ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner,ata,owner,m,TOKEN_2022_PROGRAM_ID));}
 ixs.push(new TransactionInstruction({programId:p,keys,data}));return ixs;
}
export function validateBridgeTransaction(prepared,t,a,row,attestor){
 validateBridgeReceipt(t,a,row);
 if(t.direction==='sol-to-xmr'?t.state!=='reserved':t.state!=='source_finalized'||t.destinationSignature)throw Error('Bridge is not awaiting this approval.');
 if(prepared?.network!=='mainnet-beta'||prepared.program!==row.program||prepared.simulationPassed!==true||typeof prepared.ticket!=='string'||prepared.ticket.length>30000||typeof prepared.transaction!=='string'||prepared.transaction.length>1800||!Number.isSafeInteger(prepared.lastValidBlockHeight)||!Number.isSafeInteger(prepared.estimatedSolDebitLamports)||prepared.estimatedSolDebitLamports<0||prepared.estimatedSolDebitLamports>50000000)throw Error('Unverified bridge transaction.');
 const bytes=Buffer.from(prepared.transaction,'base64');if(bytes.length>1232)throw Error('Bridge transaction too large.');
 const tx=VersionedTransaction.deserialize(bytes),expected=new TransactionMessage({payerKey:pk(a.sol),recentBlockhash:prepared.blockhash,instructions:expectedBridgeInstructions(t,a,row,attestor)}).compileToV0Message();
 if(!Buffer.from(tx.message.serialize()).equals(Buffer.from(expected.serialize()))||tx.signatures.some(s=>s.some(v=>v!==0)))throw Error('Transaction differs from the reviewed bridge. Nothing signed.');
 return tx;
}
async function chainState(a,row,c){
 const s=escrowAddresses(row.program,row.mint),[genesis,infos]=await Promise.all([c.getGenesisHash(),c.getMultipleAccountsInfo([s.config,pk(row.mint),s.vault],'finalized')]);
 if(genesis!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw Error('Wrong Solana network.');
 const [configInfo,mintInfo,vaultInfo]=infos;
 if(!configInfo||!configInfo.owner.equals(pk(row.program))||configInfo.data.length!==138||configInfo.data[0]!==row.bridgeVersion)throw Error('Bridge escrow could not be verified.');
 const d=Buffer.from(configInfo.data),attestor=pk(d.subarray(33,65)).toBase58();
 if(pk(d.subarray(1,33)).toBase58()!==row.mint||pk(d.subarray(65,97)).toBase58()!==s.vault.toBase58()||d.subarray(97,129).toString('hex')!==row.deployment)throw Error('Bridge escrow belongs to another token.');
 const mint=unpackMint(pk(row.mint),mintInfo,TOKEN_2022_PROGRAM_ID),vault=unpackAccount(s.vault,vaultInfo,TOKEN_2022_PROGRAM_ID);
 if(mint.decimals!==6||mint.mintAuthority||mint.freezeAuthority||!vault.mint.equals(pk(row.mint))||!vault.owner.equals(s.config)||vault.delegate||vault.closeAuthority||vault.isFrozen||vault.amount<d.readBigUInt64LE(129))throw Error('Invalid bridge token or backing.');
 const fee=getTransferFeeConfig(mint),rate=row.bridgeVersion>=2?150:0;
 if((fee?.olderTransferFee.transferFeeBasisPoints||0)!==rate||(fee?.newerTransferFee.transferFeeBasisPoints||0)!==rate)throw Error('Token transfer fee changed.');
 return {attestor,mint,fee};
}
export async function bridgeSolReserve(a,row,options={}){return withBridgeVerification(async c=>{
 const {mint}=await chainState(a,row,c),ata=getAssociatedTokenAddressSync(pk(row.mint),pk(a.sol),false,TOKEN_2022_PROGRAM_ID),exists=await c.getAccountInfo(ata,'confirmed');
 const [rent,ataRent,balance]=await Promise.all([c.getMinimumBalanceForRentExemption(row.bridgeVersion>=2?154:138,'confirmed'),exists?0:c.getMinimumBalanceForRentExemption(getAccountLenForMint(mint),'confirmed'),c.getBalance(pk(a.sol),'confirmed')]);
 const needed=rent+ataRent+10000;
 if(balance<needed)throw Error(`Add SOL to ${a.sol.slice(0,6)}…${a.sol.slice(-5)} for bridge network/account fees (about ${(needed/1e9).toFixed(6)} SOL).`);
 return needed;
},options);}
export async function prepareBridgeSolana(prepared,t,a,row,{onStage=()=>{},...options}={}){return withBridgeVerification(async(c,signal)=>{
 onStage('Checking the Solana escrow and token backing…');
 const {attestor,fee}=await chainState(a,row,c),tx=validateBridgeTransaction(prepared,t,a,row,attestor);
 if(signal.aborted)throw Error('Bridge review was closed or changed. Resume the saved bridge.');
 onStage('Checking SOL fees and simulating the exact transaction…');
 const [epoch,balance,feeResult,sim]=await Promise.all([fee?c.getEpochInfo('confirmed'):null,c.getBalance(pk(a.sol),'confirmed'),c.getFeeForMessage(tx.message,'confirmed'),c.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses:[a.sol]}})]);
 if(fee&&calculateEpochFee(fee,epoch.epoch,BigInt(t.amountRaw))!==bridgeAmounts(t,row.bridgeVersion).fee)throw Error('On-chain token fee differs from your review.');
 const networkFee=feeResult.value;
 if(!Number.isSafeInteger(networkFee)||networkFee<0)throw Error('Solana network fee unavailable.');
 if(!Number.isSafeInteger(balance)||balance<0)throw Error('Solana balance could not be verified. Retry preparation.');
 const after=sim.value.accounts?.[0]?.lamports;
 if(sim.value.err||!Number.isSafeInteger(after))throw Error('Bridge simulation failed. Check your tokens and SOL for fees.');
 const feeRaw=Math.max(0,balance-after,prepared.estimatedSolDebitLamports)+networkFee;
 if(feeRaw>50000000||balance<feeRaw)throw Error('Insufficient SOL or bridge cost exceeds 0.05 SOL.');
 // Check block height after the other reads, so slow simulation cannot make
 // an already-expired transaction appear ready for a new signature.
 if(await c.getBlockHeight('confirmed')>=prepared.lastValidBlockHeight)throw Error('Approval expired. Prepare it again.');
 return {...prepared,tx,feeRaw:String(feeRaw),expires:Date.now()+20000,attestor};
},options);}
export function signBridgeSolana(prepared,t,a,row){
 if(Date.now()>prepared.expires)throw Error('Approval expired. Prepare it again.');
 const tx=validateBridgeTransaction(prepared,t,a,row,prepared.attestor),key=importSol(a.solSecret);
 try{if(key.publicKey.toBase58()!==a.sol)throw Error('Wrong Solana account.');tx.sign([key]);return {transaction:Buffer.from(tx.serialize()).toString('base64'),signature:bs58.encode(tx.signatures[0]),ticket:prepared.ticket,blockhash:tx.message.recentBlockhash,operation:t.direction==='sol-to-xmr'?'Deposit':'Withdrawal'};}finally{key.secretKey.fill(0);}
}
export function signedAttemptResolved(t,s){
 if(!s)return false;
 const signature=s.operation==='Deposit'?t.sourceSignature:t.destinationSignature;
 if(signature===s.signature)return true;
 const history=s.operation==='Deposit'?t.depositHistory:t.withdrawalHistory;
 return history?.some(h=>h.signature===s.signature&&h.blockhash===s.blockhash&&['expired','failed'].includes(h.reason)&&Number.isSafeInteger(h.checkedAt))||false;
}
