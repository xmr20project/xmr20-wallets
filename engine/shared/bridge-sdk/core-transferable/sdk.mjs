// Exact ABI-3 local messages. No deployment identity or live signer is enabled.
import {PublicKey,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID as TOKEN,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {digest} from '../core-next/records.mjs';
import {ed25519} from '@noble/curves/ed25519';
import {matchesWalletApproval,LIGHTHOUSE_PROGRAM} from './wallet-guards.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const pk=x=>new PublicKey(x),hex=x=>{need(typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)&&!/^0+$/.test(x),'Nonzero public commitment required.');return Buffer.from(x,'hex');};
const u64=x=>{need(typeof x==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(x),'Exact integer amount required.');const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(x));return b;};
export function addresses(c){
 need(c?.abi===3&&['local-svm','mainnet-beta'].includes(c.network)&&c.owner!==c.verifier,'Explicit transferable deployment configuration required.');
 const program=pk(c.program),mint=pk(c.mint),owner=pk(c.owner),verifier=pk(c.verifier);
 const position=PublicKey.findProgramAddressSync([Buffer.from('joint-v3-position'),mint.toBuffer(),verifier.toBuffer(),owner.toBuffer()],program)[0];
 const pool=PublicKey.findProgramAddressSync([Buffer.from('joint-v3-pool'),mint.toBuffer(),verifier.toBuffer()],program)[0];
 const link=c.binding?PublicKey.findProgramAddressSync([Buffer.from('joint-v3-link'),mint.toBuffer(),verifier.toBuffer(),hex(c.binding)],program)[0]:null;
 return {program,mint,owner,verifier,position,pool,link,vault:getAssociatedTokenAddressSync(mint,pool,true,TOKEN),ata:getAssociatedTokenAddressSync(mint,owner,false,TOKEN)};
}
export function receiptAddress(c,nonce){const a=addresses(c);return PublicKey.findProgramAddressSync([Buffer.from('joint-v3-receipt'),a.position.toBuffer(),hex(nonce)],a.program)[0];}
export function creditCommitment(c,p){const a=addresses(c);return digest(Buffer.concat([Buffer.from('XMR20-JOINT-CREDIT-V3\n'),a.program.toBuffer(),a.mint.toBuffer(),a.position.toBuffer(),pk(p.actor??c.owner).toBuffer(),hex(p.nonce),u64((BigInt(p.amount)-BigInt(p.expectedFee)).toString())]));}
const meta=(pubkey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
export function transaction(c,p){
 const a=addresses(c);need(p?.network===c.network&&['register','deposit','donate','transfer','release'].includes(p.operation),'Wrong network or operation.');
 const actor=pk(p.actor??c.owner),instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:500000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000})];
 let keys,data;
 if(p.operation==='register'){
  need(actor.equals(a.owner)&&a.link,'Link registration owner required.');
  data=Buffer.concat([Buffer.from([1]),hex(c.binding),hex(p.commitment)]);
  keys=[meta(a.owner,true,true),meta(a.verifier,false,true),meta(a.position,true),meta(a.link,true),meta(a.pool,true),meta(a.mint),meta(a.vault),meta(TOKEN),meta(SystemProgram.programId)];
  instructions.push(createAssociatedTokenAccountIdempotentInstruction(actor,a.vault,a.pool,a.mint,TOKEN),createAssociatedTokenAccountIdempotentInstruction(actor,a.ata,a.owner,a.mint,TOKEN));
 }else{
  need(typeof p.amount==='string'&&BigInt(p.amount)>0n&&BigInt(p.amount)<=50000000000000n,'Amount is outside the transferable limit.');
  const fee=p.operation==='transfer'?'0':p.expectedFee;u64(fee);need(BigInt(p.amount)>BigInt(fee),'Transfer fee consumes the amount.');
  need(p.operation==='donate'||actor.equals(a.owner),'Only donations may use another funding wallet.');
  if(p.operation==='deposit'||p.operation==='donate')need(p.commitment===creditCommitment(c,p),'Credit commitment differs from exact public backing.');
  const kind={deposit:2,release:3,transfer:4,donate:5}[p.operation];
  data=Buffer.concat([Buffer.from([kind]),u64(p.amount),hex(p.nonce),hex(p.commitment),...(kind===4?[]:[u64(fee)])]);
  const ata=getAssociatedTokenAddressSync(a.mint,actor,false,TOKEN);
  keys=[meta(actor,true,true),meta(a.position,true),meta(a.pool,true),meta(a.mint),meta(a.vault,true),meta(TOKEN),meta(SystemProgram.programId),meta(ata,true),meta(receiptAddress(c,p.nonce),true)];
  if(kind===3||kind===4)keys.push(meta(a.verifier,false,true));
  if(kind===4){need(p.toOwner&&p.toOwner!==c.owner,'A different registered recipient required.');keys.push(meta(addresses({...c,owner:p.toOwner}).position,true));}
 }
 instructions.push(new TransactionInstruction({programId:a.program,keys,data}));
 return new VersionedTransaction(new TransactionMessage({payerKey:actor,recentBlockhash:p.blockhash,instructions}).compileToV0Message());
}
export function decodePosition(data){const b=Buffer.from(data);need(b.length===169&&b[0]===3,'Invalid transferable position.');return {owner:new PublicKey(b.subarray(1,33)).toBase58(),verifier:new PublicKey(b.subarray(33,65)).toBase58(),mint:new PublicKey(b.subarray(65,97)).toBase58(),binding:b.subarray(97,129).toString('hex'),linkProof:b.subarray(129,161).toString('hex'),balance:b.readBigUInt64LE(161).toString()};}
export function decodeReceipt(data){const b=Buffer.from(data);need(b.length===153&&[2,3,4,5].includes(b[0]),'Invalid transferable receipt.');return {kind:b[0],from:new PublicKey(b.subarray(1,33)).toBase58(),to:new PublicKey(b.subarray(33,65)).toBase58(),nonce:b.subarray(65,97).toString('hex'),commitment:b.subarray(97,129).toString('hex'),gross:b.readBigUInt64LE(129).toString(),net:b.readBigUInt64LE(137).toString(),fee:b.readBigUInt64LE(145).toString()};}
// Verifier-authorized messages are byte-exact: an added instruction would
// invalidate the existing signature, even when it is a wallet safety assertion.
export async function approveRegistrationExternal(c,p,bytes,provider){
 need(p.operation==='register','Preauthorized signing is registration-only.');
 return approveAuthorizedExternal(c,p,bytes,provider);
}
export async function approveMoveExternal(c,p,bytes,provider){
 need(['transfer','release'].includes(p.operation),'Preauthorized signing requires a holder move.');
 return approveAuthorizedExternal(c,p,bytes,provider);
}
async function approveAuthorizedExternal(c,p,bytes,provider){
 const expected=transaction(c,p),tx=VersionedTransaction.deserialize(bytes),msg=expected.message.serialize(),owner=pk(c.owner),verifier=pk(c.verifier);
 provider.assertCurrent?.();
 need(provider.publicKey?.toBase58()===owner.toBase58()&&Buffer.from(tx.message.serialize()).equals(Buffer.from(msg))&&tx.signatures.length===2&&tx.signatures[0].every(n=>n===0)&&ed25519.verify(tx.signatures[1],msg,verifier.toBytes()),'Verifier authorization or selected wallet changed.');
 const verifierSignature=Buffer.from(tx.signatures[1]);
 const signed=await provider.signTransaction(tx);provider.assertCurrent?.();
 need(provider.publicKey?.toBase58()===owner.toBase58()&&Buffer.from(signed.message.serialize()).equals(Buffer.from(msg))&&signed.signatures.length===2&&ed25519.verify(signed.signatures[0],msg,owner.toBytes())&&Buffer.from(signed.signatures[1]).equals(verifierSignature),'Wallet approval differs from the exact verifier-authorized transaction.');return signed;
}
export async function approveExternal(c,p,bytes,provider){
 const expected=transaction(c,p),tx=VersionedTransaction.deserialize(bytes),actor=pk(p.actor??c.owner),msg=expected.message.serialize();provider.assertCurrent?.();
 need(provider.publicKey?.toBase58()===actor.toBase58()&&Buffer.from(tx.message.serialize()).equals(Buffer.from(msg))&&tx.signatures.every(s=>s.every(n=>n===0)),'Unsigned review or selected wallet changed.');
 const signed=await provider.signTransaction(tx);provider.assertCurrent?.();
 // Keep the independent expected message: a provider may mutate the object it
 // was given. Diagnostics never authorize those changed bytes or retain them.
 const verify=(signature,data)=>{try{return ed25519.verify(signature,data,actor.toBytes());}catch{return false;}};
 const diagnostic={reason:null,selectedOwnerMatches:provider.publicKey?.toBase58()===actor.toBase58(),messageMatches:false,signatureCountMatches:false,ownerSignatureValidForReviewed:false,ownerSignatureValidForReturned:false,extraSignaturesUnchanged:false,walletGuardsAllowed:false,blockhashChanged:false,computeBudgetChanged:false,otherInstructionsChanged:false,accountsChanged:false,accountOrderOnlyChanged:false,addedSolTransfer:false,addedMemoInstruction:false,addedOtherProgramInstruction:false,addedProgramIds:[],messageVersionChanged:false,expectedMessageHash:digest(msg),returnedMessageHash:null};
 let returned;
 try{
  returned=signed.message.serialize();diagnostic.returnedMessageHash=digest(returned);diagnostic.messageMatches=Buffer.from(returned).equals(Buffer.from(msg));
  diagnostic.signatureCountMatches=signed.signatures.length===expected.signatures.length;
  diagnostic.ownerSignatureValidForReviewed=verify(signed.signatures[0],msg);diagnostic.ownerSignatureValidForReturned=verify(signed.signatures[0],returned);diagnostic.extraSignaturesUnchanged=signed.signatures.slice(1).every(s=>s.every(n=>n===0));
  const shape=m=>({version:m.version,header:[m.header.numRequiredSignatures,m.header.numReadonlySignedAccounts,m.header.numReadonlyUnsignedAccounts],keys:m.staticAccountKeys.map(k=>k.toBase58()),lookups:(m.addressTableLookups||[]).map(l=>({key:l.accountKey.toBase58(),writable:Array.from(l.writableIndexes),readonly:Array.from(l.readonlyIndexes)})),instructions:m.compiledInstructions.map(i=>({program:m.staticAccountKeys[i.programIdIndex]?.toBase58()??'lookup:'+i.programIdIndex,accounts:Array.from(i.accountKeyIndexes,n=>m.staticAccountKeys[n]?.toBase58()??'lookup:'+n),data:Buffer.from(i.data).toString('hex')}))});
  const before=shape(expected.message),budget=ComputeBudgetProgram.programId.toBase58(),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);let after=shape(signed.message);
  // For diagnostics only, distinguish permitted safety assertions from other
  // changes. The original signed message still faces the exact approval check
  // below; this projection is never signed, saved, returned or submitted.
  if(signed.message.version===0&&!signed.message.addressTableLookups.length&&after.instructions.some(i=>i.program===LIGHTHOUSE_PROGRAM)){
   const decoded=TransactionMessage.decompile(signed.message),projected=new TransactionMessage({payerKey:decoded.payerKey,recentBlockhash:decoded.recentBlockhash,instructions:decoded.instructions.filter(i=>i.programId.toBase58()!==LIGHTHOUSE_PROGRAM)}).compileToV0Message();
   diagnostic.walletGuardsAllowed=matchesWalletApproval(projected,signed.message,p.operation);
   if(diagnostic.walletGuardsAllowed)after=shape(projected);
  }
  diagnostic.blockhashChanged=signed.message.recentBlockhash!==expected.message.recentBlockhash;
  diagnostic.messageVersionChanged=before.version!==after.version;
  diagnostic.accountsChanged=!same([before.header,before.keys,before.lookups],[after.header,after.keys,after.lookups]);
  diagnostic.computeBudgetChanged=!same(before.instructions.filter(i=>i.program===budget),after.instructions.filter(i=>i.program===budget));
  diagnostic.otherInstructionsChanged=!same(before.instructions.filter(i=>i.program!==budget),after.instructions.filter(i=>i.program!==budget));
  // Resolve account indexes for diagnostics only. Even a semantic-only reorder
  // remains rejected by the exact serialized-message predicate above.
  const privileges=s=>s.keys.map((key,i)=>[key,i<s.header[0],i<s.header[0]?i<s.header[0]-s.header[1]:i<s.keys.length-s.header[2]]).sort((a,b)=>a[0].localeCompare(b[0]));
  diagnostic.accountOrderOnlyChanged=diagnostic.accountsChanged&&!same(before.keys,after.keys)&&!diagnostic.messageVersionChanged&&!diagnostic.blockhashChanged&&same(before.lookups,after.lookups)&&same(before.keys.slice(0,before.header[0]),after.keys.slice(0,after.header[0]))&&same(privileges(before),privileges(after))&&same(before.instructions,after.instructions);
  const counts=new Map();for(const i of before.instructions){const key=JSON.stringify(i);counts.set(key,(counts.get(key)||0)+1);}
  const extra=after.instructions.filter(i=>{const key=JSON.stringify(i),count=counts.get(key)||0;if(count){counts.set(key,count-1);return false;}return true;});
  const system=SystemProgram.programId.toBase58(),memo='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',programs=new Set(before.instructions.map(i=>i.program));
  diagnostic.addedSolTransfer=extra.some(i=>i.program===system&&i.data.startsWith('02000000'));
  diagnostic.addedMemoInstruction=extra.some(i=>i.program===memo);
  diagnostic.addedOtherProgramInstruction=extra.some(i=>!programs.has(i.program)&&![system,memo,budget].includes(i.program));
  diagnostic.addedProgramIds=Object.freeze([...new Set(extra.map(i=>i.program).filter(p=>/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p)&&!programs.has(p)))].slice(0,8));
 }catch{diagnostic.reason='invalid-wallet-response';}
 if(!diagnostic.reason){
  if(!diagnostic.selectedOwnerMatches)diagnostic.reason='selected-owner-changed';
  else if(!diagnostic.messageMatches&&!matchesWalletApproval(expected.message,signed.message,p.operation))diagnostic.reason=diagnostic.addedSolTransfer?'added-sol-transfer':diagnostic.addedMemoInstruction?'added-memo-instruction':diagnostic.addedOtherProgramInstruction?'added-program-instruction':diagnostic.accountOrderOnlyChanged?'account-order-only-changed':diagnostic.otherInstructionsChanged||diagnostic.accountsChanged||diagnostic.messageVersionChanged?'instructions-or-accounts-changed':diagnostic.blockhashChanged&&!diagnostic.computeBudgetChanged?'blockhash-changed':diagnostic.computeBudgetChanged&&!diagnostic.blockhashChanged?'compute-budget-changed':'reviewed-message-changed';
  else if(!diagnostic.signatureCountMatches)diagnostic.reason='signature-count-changed';
  else if(!diagnostic.ownerSignatureValidForReturned)diagnostic.reason='owner-signature-invalid';
  else if(!diagnostic.extraSignaturesUnchanged)diagnostic.reason='extra-signatures-changed';
 }
 if(diagnostic.reason){
  const descriptions={'invalid-wallet-response':'Your wallet returned an invalid signed transaction.','selected-owner-changed':'Your selected Solana wallet changed during approval.','added-sol-transfer':'Your wallet added an unreviewed SOL transfer.','added-memo-instruction':'Your wallet added an unreviewed memo instruction.','added-program-instruction':'Your wallet added an unreviewed program instruction.','account-order-only-changed':'Your wallet reordered the reviewed transaction accounts.','instructions-or-accounts-changed':'Your wallet changed the reviewed transaction instructions or accounts.','blockhash-changed':'Your wallet changed the reviewed transaction blockhash.','compute-budget-changed':'Your wallet changed the reviewed transaction network fee or compute budget.','reviewed-message-changed':'Your wallet changed the reviewed transaction.','signature-count-changed':'Your wallet returned a different number of transaction signatures.','owner-signature-invalid':'Your wallet signature does not match the exact reviewed transaction.','extra-signatures-changed':'Your wallet added or changed another signer’s approval.'};
  const detail=diagnostic.reason==='added-program-instruction'&&diagnostic.addedProgramIds.length?' Program: '+diagnostic.addedProgramIds.join(', ')+'.':'';
  const error=Error(descriptions[diagnostic.reason]+detail+' Nothing was submitted.');error.code='WALLET_APPROVAL_MISMATCH';error.approvalDiagnostic=Object.freeze(diagnostic);throw error;
 }
 return signed;
}
