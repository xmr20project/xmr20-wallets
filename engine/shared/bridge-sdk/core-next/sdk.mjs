import {PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID as TOKEN,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {ed25519} from '@noble/curves/ed25519';
import {XCAT_MINT,supportedMint} from './mint-policy.mjs';
export const SELECTED_MINT=XCAT_MINT;
// Set the budget before review so wallets do not rewrite the signed message.
// The fixed priority fee is 4,000 lamports; no caller can override these values.
export const COMPUTE_UNIT_LIMIT=400000,COMPUTE_UNIT_PRICE=10000;
const budget=()=>[ComputeBudgetProgram.setComputeUnitLimit({units:COMPUTE_UNIT_LIMIT}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:COMPUTE_UNIT_PRICE})];
export function reviewedBridgeInstruction(msg,operation){
 const deposit=operation==='deposit';if(!deposit&&operation!=='release')return null;
 if(msg.addressTableLookups?.length!==0||msg.compiledInstructions?.length!==(deposit?4:3)||msg.header?.numRequiredSignatures!==(deposit?1:2))return null;
 const expected=budget();for(let i=0;i<2;i++){const ix=msg.compiledInstructions[i];if(!msg.staticAccountKeys[ix.programIdIndex]?.equals(expected[i].programId)||ix.accountKeyIndexes?.length!==0||!Buffer.from(ix.data).equals(expected[i].data))return null;}
 return msg.compiledInstructions[deposit?3:2];
}
const pk=v=>new PublicKey(v),hex=v=>{if(!/^[a-f0-9]{64}$/.test(v)||/^0+$/.test(v))throw Error('Invalid position or receipt nonce.');return Buffer.from(v,'hex');};
const u64=v=>{if(typeof v!=='string'||! /^(0|[1-9][0-9]{0,15})$/.test(v))throw Error('Invalid exact token amount.');const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return b;};
export function addresses(c){
 if(c.abi!==2||!supportedMint(c.mint)||!['local-svm','devnet','mainnet-beta'].includes(c.network)||c.owner===c.verifier)throw Error('Wrong selected-mint joint bridge configuration.');
 const program=pk(c.program),owner=pk(c.owner),mint=pk(c.mint),position=PublicKey.findProgramAddressSync([Buffer.from('joint-v2'),mint.toBuffer(),owner.toBuffer(),hex(c.id)],program)[0];
 return {program,owner,mint,position,vault:getAssociatedTokenAddressSync(mint,position,true,TOKEN),ata:getAssociatedTokenAddressSync(mint,owner,false,TOKEN)};
}
export function transaction(c,p){
 if(p.network!==c.network||!['deposit','release'].includes(p.operation)||BigInt(p.amount)<=0n||BigInt(p.amount)>50000000000000n||BigInt(p.expectedFee)>=BigInt(p.amount))throw Error('Wrong network, operation, amount or fee.');
 const a=addresses(c),keys=[a.owner,a.position,a.mint,a.vault,TOKEN,SystemProgram.programId,a.ata].map((pubkey,i)=>({pubkey,isSigner:i===0,isWritable:[0,1,3,6].includes(i)}));
 let data;if(p.operation==='deposit'){if(p.nonce!==c.id)throw Error('Changed deposit nonce.');data=Buffer.concat([Buffer.from([2]),u64(p.amount),hex(c.id),hex(c.binding),pk(c.verifier).toBuffer(),u64(p.expectedFee)]);}
 else{const receipt=PublicKey.findProgramAddressSync([Buffer.from('redemption-v2'),a.position.toBuffer(),hex(p.nonce)],a.program)[0];keys.push({pubkey:pk(c.verifier),isSigner:true,isWritable:false},{pubkey:receipt,isSigner:false,isWritable:true});data=Buffer.concat([Buffer.from([3]),u64(p.amount),hex(p.nonce),u64(p.expectedFee)]);}
 const ix=new TransactionInstruction({programId:a.program,keys,data});return new VersionedTransaction(new TransactionMessage({payerKey:a.owner,recentBlockhash:p.blockhash,instructions:[...budget(),...(p.operation==='deposit'?[createAssociatedTokenAccountIdempotentInstruction(a.owner,a.vault,a.position,a.mint,TOKEN),ix]:[ix])]}).compileToV0Message());
}
export async function approveExternal(c,p,bytes,provider){
 if(!provider||provider.publicKey?.toBase58()!==c.owner)throw Error('Connect the original depositing wallet.');provider.assertCurrent?.();
 const tx=VersionedTransaction.deserialize(bytes),expected=transaction(c,p);if(!Buffer.from(tx.message.serialize()).equals(Buffer.from(expected.message.serialize()))||tx.signatures.some(s=>s.some(x=>x!==0)))throw Error('The transaction differs from the exact review.');
 const original=Buffer.from(expected.message.serialize());const signed=await provider.signTransaction(tx);provider.assertCurrent?.();
 const invalid=reason=>{throw Error('Wallet returned a changed or invalid owner approval ('+reason+'). Nothing was submitted.');};
 if(provider.publicKey?.toBase58()!==c.owner)invalid('owner changed');
 let returned;try{returned=Buffer.from(signed.message.serialize());}catch{invalid('malformed message');}
 if(!returned.equals(original))invalid('message changed');
 if(!Array.isArray(signed.signatures)||signed.signatures.length!==expected.message.header.numRequiredSignatures||signed.signatures.some(s=>!(s instanceof Uint8Array)||s.length!==64))invalid('signature count or format');
 if(signed.signatures.slice(1).some(s=>s.some(x=>x!==0)))invalid('unexpected additional signature');
 let valid=false;try{valid=ed25519.verify(signed.signatures[0],original,new PublicKey(c.owner).toBytes());}catch{}if(!valid)invalid('owner signature invalid');return signed;
}
