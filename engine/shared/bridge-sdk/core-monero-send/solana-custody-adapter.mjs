// Optional bridge entry only. Public callers cannot supply executable code,
// RPC endpoints, account metadata, or an arbitrary transaction to co-sign.
import {PublicKey,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {createSolanaAdapter} from '../core-transferable/solana-adapter.mjs';
import {matchesWalletApproval,hasWalletGuards,verifyWalletGuardProgram} from '../core-transferable/wallet-guards.mjs';
import {addresses,decodePosition} from '../core-transferable/sdk.mjs';
import {bridgeInstruction,decodePolicy,decodeBridgeReceipt} from './bridge-sdk.mjs';
import {marketCreditFromFinalizedReceipt} from './market-custody.mjs';
import {CUSTODY_CAPABILITY} from './deployment-policy.mjs';
import {operatorPolicy} from '../../native-market/operator-policy.mjs';
import {validateOperatorCreditPlan,operatorCustodyTerms} from '../../native-market/wallet/operator-credit-preparation.mjs';
import {need,exact,hash} from '../../native-market/xn1/bytes.mjs';
import {validateCustodyRefundPlan,assertCustodyRefundable} from '../../native-market/operator-refund-plan.mjs';
import {EXPIRING_CREDIT_PROFILE} from '../../native-market/xn1/records.mjs';
import {inspectCarrier,decodeCarrier} from '../../native-market/xn1/carrier.mjs';

// A browser wallet such as Phantom may add its own compute-budget (priority fee) and
// Lighthouse assertion instructions to a transaction that only the holder signs. A
// holder-only deposit accepts exactly those additions: without them the message must
// equal the reviewed one, no reviewed account changes privilege, and the holder's
// added fee stays bounded. Every other change is still rejected.
const BUDGET='ComputeBudget111111111111111111111111111111',MAX_UNITS=1400000n,MAX_PRIORITY_LAMPORTS=5000000n;
export function holderWalletAdditions(expected,actual){
 try{
  if(actual.version!==0||actual.addressTableLookups.length||actual.recentBlockhash!==expected.recentBlockhash||
   actual.header.numRequiredSignatures!==expected.header.numRequiredSignatures)return false;
  const before=expected.staticAccountKeys.map(k=>k.toBase58()),after=actual.staticAccountKeys.map(k=>k.toBase58());
  if(after[0]!==before[0]||new Set(after).size!==after.length||before.some(k=>!after.includes(k)))return false;
  for(let i=0;i<after.length;i++){
   const j=before.indexOf(after[i]),signer=i<actual.header.numRequiredSignatures,writable=actual.isAccountWritable(i);
   if(j<0?signer||writable:signer!==j<expected.header.numRequiredSignatures||writable!==expected.isAccountWritable(j))return false;
  }
  const decoded=TransactionMessage.decompile(actual),kept=[],used=new Set();let limit=null,price=null,loaded=null;
  for(const ix of decoded.instructions){
   used.add(ix.programId.toBase58());for(const k of ix.keys)used.add(k.pubkey.toBase58());
   if(ix.programId.toBase58()!==BUDGET){kept.push(ix);continue;}
   const d=Buffer.from(ix.data);if(ix.keys.length)return false;
   if(d.length===5&&d[0]===2&&limit===null)limit=BigInt(d.readUInt32LE(1));
   else if(d.length===9&&d[0]===3&&price===null)price=d.readBigUInt64LE(1);
   else if(d.length===5&&d[0]===4&&loaded===null)loaded=d.readUInt32LE(1);
   else return false;
  }
  if(after.some(k=>!before.includes(k)&&!used.has(k)))return false;
  if((limit??0n)>MAX_UNITS||((price??0n)*(limit??MAX_UNITS)+999999n)/1000000n>MAX_PRIORITY_LAMPORTS)return false;
  const rebuilt=new TransactionMessage({payerKey:decoded.payerKey,recentBlockhash:decoded.recentBlockhash,instructions:kept}).compileToV0Message();
  if(Buffer.from(rebuilt.serialize()).equals(Buffer.from(expected.serialize())))return kept.length<decoded.instructions.length;
  return matchesWalletApproval(expected,rebuilt,'deposit');
 }catch{return false;}
}
export const createOperatorCustodyAdapter=options=>createCustodyAdapter(options,false);
export const createOperatorRefundAdapter=options=>createCustodyAdapter(options,true);
function createCustodyAdapter({connection,manifest,configuration,signer,privateTestPolicy,readRefundState,readEntryState},refund){
 manifest=structuredClone(manifest);configuration=structuredClone(configuration);
 const p=operatorPolicy(configuration),b=configuration.backing,program=new PublicKey(b.program);
 need(manifest.custodyCapability===CUSTODY_CAPABILITY&&manifest.program===b.program&&manifest.mint===b.mint&&manifest.verifier===b.verifier,'Pinned operator custody deployment required');
 need(signer?.publicKey===b.verifier&&typeof signer[refund?'signRefund':'signCustody']==='function','Fixed custody co-signer required');
 const chain=createSolanaAdapter({connection,manifest,privateTestPolicy});let floor=0;
 const original=refund?createOperatorCustodyAdapter({connection,manifest,configuration,privateTestPolicy,
  signer:{publicKey:b.verifier,signCustody(){throw Error('Receipt verification only');}}}):null;
 function terms(plan){
  if(refund){
   validateCustodyRefundPlan(configuration,plan);
   const config={...manifest,owner:plan.request.owner,nativeCustodyMode:b.mode};
   const options={manifest:p.id,mode:b.mode,signers:[b.verifier]},built=bridgeInstruction(config,options,plan.intent);
   need(built.receipt.toBase58()===plan.receipt,'Refund receipt changed');
   return {config,instruction:built.instruction};
  }
  validateOperatorCreditPlan(configuration,plan.record?.owner,plan);
  const t=operatorCustodyTerms(configuration,plan.request),config={...manifest,owner:plan.request.owner,nativeCustodyMode:b.mode};
  const instruction=bridgeInstruction(config,t.options,{...plan.request,binding:plan.binding});
  need(instruction.receipt.toBase58()===plan.receipt,'Custody receipt changed');
  return {...t,config,instruction:instruction.instruction};
 }
 async function account(key){
  const response=await connection.getAccountInfoAndContext(new PublicKey(key),{commitment:'finalized',minContextSlot:floor});
  need(Number.isSafeInteger(response.context?.slot)&&response.context.slot>=floor,'Finalized custody context moved backwards');floor=response.context.slot;
  if(response.value)need(response.value.owner.equals(program)&&!response.value.executable,'Wrong custody account owner');
  return response.value;
 }
 async function policy(){
  await chain.verifyProgram();const a=await account(b.policy);need(a,'Native custody policy is missing');
  const row=decodePolicy(a.data);need(row.mode===b.mode&&row.mint===b.mint&&row.verifier===b.verifier&&row.manifest===p.id&&row.requiredSignatures===1&&row.signers.length===1&&row.signers[0]===b.verifier,'Native custody policy changed');
  return {address:b.policy,owner:b.program,executable:false,data:a.data};
 }
 async function fresh(plan){
  const t=terms(plan);await policy();
  if(refund){
   need(await original.receipt(plan.source),'Finalized original custody receipt required');
   need(typeof readRefundState==='function','Independent refund history required');
   assertCustodyRefundable(configuration,plan.source,await readRefundState());
   need(await chain.fee(plan.record.amount)===plan.fee,'Refund fee changed; review a fresh refund');
   return t;
  }
  if(p.manifest.profile===EXPIRING_CREDIT_PROFILE&&readEntryState){
   const state=await readEntryState(),deadline=decodeCarrier(inspectCarrier(Buffer.from(plan.recipientCarrier,'hex'))).record.epoch;
   need(Number.isSafeInteger(state.checkedAt)&&Date.now()>=state.checkedAt&&Date.now()-state.checkedAt<=30000&&
    state.checkpoint.height+20n<BigInt(deadline),'Native credit deadline is too close; prepare a fresh bridge before approving custody');
  }
  if(plan.request.kind==='deposit')need(await chain.fee(plan.request.amount)===plan.request.fee,'Deposit fee changed; prepare a new review');
  else{
   // Only the exact holder's existing claim can be converted. It remains
   // unchanged until both signatures execute instruction 12 on Solana.
   const position=await account(addresses(t.config).position);need(position,'Linked claim is missing');
   const row=decodePosition(position.data);need(row.owner===plan.request.owner&&row.mint===b.mint&&row.verifier===b.verifier&&BigInt(row.balance)>=BigInt(plan.request.amount),'Linked claim is insufficient or belongs to another holder');
  }
  return t;
 }
 function transaction(plan,blockhash){
  const t=terms(plan);
  const payer=new PublicKey(plan.request.owner),mint=new PublicKey(b.mint);
  const instructions=refund?[createAssociatedTokenAccountIdempotentInstruction(payer,
   getAssociatedTokenAddressSync(mint,payer,false,TOKEN_2022_PROGRAM_ID),payer,mint,TOKEN_2022_PROGRAM_ID),t.instruction]:[t.instruction];
  return new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:blockhash,instructions}).compileToV0Message());
 }
 function prepared(plan,value){
  exact(value,['transaction','blockhash','lastValidBlockHeight']);
  need(typeof value.transaction==='string'&&/^(?:[a-f0-9]{2})+$/.test(value.transaction)&&value.transaction.length<=4096&&Number.isSafeInteger(value.lastValidBlockHeight)&&value.lastValidBlockHeight>0,'Saved custody proposal required');
  const tx=VersionedTransaction.deserialize(Buffer.from(value.transaction,'hex')),expected=transaction(plan,value.blockhash);
  need(Buffer.from(tx.serialize()).toString('hex')===value.transaction&&Buffer.from(tx.message.serialize()).equals(Buffer.from(expected.message.serialize()))&&tx.signatures.every(s=>s.every(x=>x===0)),'Changed custody proposal');
  return tx;
 }
 function approved(plan,value,signedHex,complete=false){
  prepared(plan,value);
  need(typeof signedHex==='string'&&/^(?:[a-f0-9]{2})+$/.test(signedHex)&&signedHex.length<=4096,'Bounded custody approval required');
  const tx=VersionedTransaction.deserialize(Buffer.from(signedHex,'hex')),message=tx.message.serialize(),expected=transaction(plan,value.blockhash);
  const reviewed=Buffer.from(expected.message.serialize()).equals(Buffer.from(message))||!refund&&plan.request.kind==='deposit'&&holderWalletAdditions(expected.message,tx.message);
  need(Buffer.from(tx.serialize()).toString('hex')===signedHex&&reviewed,'Holder approval changed the exact custody transaction');
  const keys=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures),count=plan.request.kind==='deposit'?1:2;
  need(keys.length===count&&tx.signatures.length===count&&keys[0].toBase58()===plan.request.owner,'Wrong custody holder or signer set');
  need(ed25519.verify(tx.signatures[0],message,keys[0].toBytes(),{zip215:false}),'Holder signature required before bridge co-signing');
  if(count===2){
   need(keys[1].toBase58()===b.verifier,'Wrong custody verifier');
   need(complete?ed25519.verify(tx.signatures[1],message,keys[1].toBytes(),{zip215:false}):tx.signatures[1].every(x=>x===0),'Custody verifier signature differs');
  }
  return tx;
 }
 async function blockhash(value){
  const [height,valid]=await Promise.all([connection.getBlockHeight('confirmed'),connection.isBlockhashValid(value.blockhash,{commitment:'confirmed'})]);
  need(Number.isSafeInteger(height)&&height<=value.lastValidBlockHeight&&valid.value===true,'Custody approval expired; recover status before reviewing again');
 }
 async function receipt(plan){
  const t=terms(plan),policyAccount=await policy(),raw=await account(plan.receipt);if(!raw)return null;
  if(refund){
   const row=decodeBridgeReceipt(raw.data);
   need(row.kind===14&&row.from===b.policy&&row.to===plan.request.owner&&row.gross===plan.record.amount&&
    row.nonce===plan.intent.nonce&&row.binding===plan.binding,'Refund receipt belongs to a different claim');
   // Another fee revision may have finalized first. Reconstruct its exact
   // commitment rather than pretending the newest quote was the one charged.
   const actual=bridgeInstruction(t.config,{manifest:p.id,mode:b.mode,signers:[b.verifier]},
    {...plan.intent,fee:row.fee}).instruction;
   const commitment=hash(Buffer.concat([Buffer.from('XMR20-MONERO-REDEEM-DRAFT-V1\n'),program.toBuffer(),
    new PublicKey(b.policy).toBuffer(),actual.data.subarray(1)])).toString('hex');
   need(row.commitment===commitment&&BigInt(row.net)+BigInt(row.fee)===BigInt(row.gross),'Refund receipt commitment differs');
   return {receipt:plan.receipt,binding:plan.binding,amount:row.gross,net:row.net,fee:row.fee,destination:row.to,finalized:true};
  }
  const row=decodeBridgeReceipt(raw.data),deposit=plan.request.kind==='deposit';
  const actor=deposit?new PublicKey(plan.request.owner):addresses(t.config).position;
  const domain=deposit?'XMR20-MONERO-DEPOSIT-DRAFT-V1\n':'XMR20-MONERO-OUTPUT-MIGRATE-DRAFT-V1\n';
  const commitment=hash(Buffer.concat([Buffer.from(domain),program.toBuffer(),
   new PublicKey(b.policy).toBuffer(),actor.toBuffer(),t.instruction.data.subarray(1)])).toString('hex');
  need(row.kind===(deposit?10:12)&&row.gross===plan.request.amount&&row.fee===plan.request.fee&&
   row.nonce===plan.request.nonce&&row.commitment===commitment,'Custody receipt differs from the exact holder approval');
  const evidence={policyAccount,receiptAccount:{address:plan.receipt,owner:b.program,executable:false,data:raw.data}};
  const credit=marketCreditFromFinalizedReceipt({config:{...b,nativeCustodyMode:b.mode},manifest:p.manifest,transaction:Buffer.from(plan.recipientCarrier,'hex'),...evidence});
  need(credit.binding===plan.binding,'Finalized custody binding differs');
  return {receipt:plan.receipt,binding:plan.binding,amount:credit.amount,finalized:true};
 }
 return Object.freeze({
  validatePlan:terms,validatePrepared:prepared,validateApproval:approved,receipt,fee:chain.fee,
  ...(refund?{async verifyRefundSource(plan){terms(plan);need(await original.receipt(plan.source),'Original custody receipt required');}}:{}),
  async quote(request){
   exact(request,['kind','owner','amount']);
   need(['deposit','migrate-output'].includes(request.kind)&&typeof request.amount==='string'&&/^[1-9][0-9]{0,13}$/.test(request.amount)&&BigInt(request.amount)<=50000000000000n,'Exact bounded custody amount required');
   const owner=new PublicKey(request.owner).toBase58();need(owner===request.owner&&owner!==b.verifier,'Distinct custody holder required');
   await policy();let fee='0';
   if(request.kind==='deposit')fee=await chain.fee(request.amount);
   else {
    const position=await account(addresses({...manifest,owner}).position);need(position,'Linked claim is missing');
    const row=decodePosition(position.data);need(row.owner===owner&&row.mint===b.mint&&row.verifier===b.verifier&&BigInt(row.balance)>=BigInt(request.amount),'Linked claim is insufficient');
   }
   need(BigInt(fee)<BigInt(request.amount),'Amount does not cover the token fee');
   return {...request,fee,net:String(BigInt(request.amount)-BigInt(fee)),manifest:p.id,policy:b.policy};
  },
  async reviewForHolder(plan,value){
   prepared(plan,value);
   if(refund){
    // Holder approval only returns that holder's own claim. The operator's
    // separate co-signing path always checks canonical native non-issuance.
    await policy();need(await original.receipt(plan.source),'Original custody receipt required');
    need(await chain.fee(plan.record.amount)===plan.fee,'Refund fee changed; review again');
   }else await fresh(plan);
   await blockhash(value);return prepared(plan,value);
  },
  async prepare(plan){
   await fresh(plan);need(!await receipt(plan),'Custody already finalized; recover its native credit');
   const latest=await connection.getLatestBlockhash('confirmed');await blockhash(latest);
   return {transaction:Buffer.from(transaction(plan,latest.blockhash).serialize()).toString('hex'),...latest};
  },
  async cosign(plan,value,holderSigned){
   const tx=approved(plan,value,holderSigned);await fresh(plan);await blockhash(value);
   const bytes=plan.request.kind==='deposit'?tx.serialize():await signer[refund?'signRefund':'signCustody']({plan:structuredClone(plan),proposal:structuredClone(value),holderSigned});
   const result=Buffer.from(bytes).toString('hex');approved(plan,value,result,true);
   return {transaction:result,signature:bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0])};
  },
  async submit(plan,value,signed){
   const tx=approved(plan,value,signed.transaction,true);need(bs58.encode(tx.signatures[0])===signed.signature,'Saved custody signature changed');
   const done=await receipt(plan);if(done)return {status:'finalized',receipt:done};
   await fresh(plan);await blockhash(value);
   if(hasWalletGuards(tx.message))await verifyWalletGuardProgram(connection);
   const signature=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:2});
   need(signature===signed.signature,'Custody submission identity differs');return {status:'submitted',signature};
  },
  async status(plan,value,signed=null){
   prepared(plan,value);const done=await receipt(plan);if(done)return {status:'finalized',receipt:done};
   if(signed){
    approved(plan,value,signed.transaction,true);
    const signature=bs58.encode(VersionedTransaction.deserialize(Buffer.from(signed.transaction,'hex')).signatures[0]);need(signature===signed.signature,'Custody signature changed');
    const result=await connection.getSignatureStatuses([signature],{searchTransactionHistory:true}),s=result.value?.[0];
    need(Array.isArray(result.value)&&result.value.length===1,'Complete custody signature status required');
    if(s?.confirmationStatus==='finalized'){need(s.err!==null,'Successful custody signature lacks its receipt');return {status:'failed'};}
    if(s)return {status:'confirming',signature};
   }
   const height=await connection.getBlockHeight('finalized');
   need(Number.isSafeInteger(height),'Finalized block height required');
   if(height>value.lastValidBlockHeight){
    const valid=await connection.isBlockhashValid(value.blockhash,{commitment:'finalized'});need(valid.value===false,'Custody expiry evidence disagrees');
    const slot=await connection.getSlot('finalized');need(Number.isSafeInteger(slot)&&slot>=floor,'Custody expiry context moved backwards');floor=slot;
    const final=await receipt(plan);if(final)return {status:'finalized',receipt:final};
    if(signed){
     const check=await connection.getSignatureStatuses([signed.signature],{searchTransactionHistory:true});
     need(Number.isSafeInteger(check.context?.slot)&&check.context.slot>=slot&&Array.isArray(check.value)&&check.value.length===1,'Custody expiry status is stale');
     if(check.value[0])return {status:'confirming',signature:signed.signature};
    }
    return {status:'expired'};
   }
   return {status:signed?'submission-unknown':'prepared'};
  }
 });
}
