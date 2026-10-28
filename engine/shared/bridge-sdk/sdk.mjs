import {PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID as TOKEN,createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
export const SCALE=1_000_000n, SUPPLY=1_000_000_000_000_000n;
export const tax=n=>(BigInt(n)*150n+9999n)/10000n;
export const net=n=>BigInt(n)-tax(n);
export function raw(value){if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value))throw Error('Enter a positive amount with at most 6 decimal places.');const [a,b='']=value.split('.');const n=BigInt(a)*SCALE+BigInt(b.padEnd(6,'0'));if(n<=0n||n>50_000_000_000_000n||net(n)<=0n)throw Error('Amount is outside the test limits.');return n;}
export function format(n){n=BigInt(n);return `${n/SCALE}.${(n%SCALE).toString().padStart(6,'0')}`;}
const pk=v=>v instanceof PublicKey?v:new PublicKey(v);
const hex=v=>{if(!/^[a-f0-9]{64}$/.test(v)||/^0+$/.test(v))throw Error('Invalid commitment or receipt ID.');return Buffer.from(v,'hex');};
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
export function addresses(c){const program=pk(c.program),owner=pk(c.owner),mint=pk(c.mint),id=hex(c.id);const position=PublicKey.findProgramAddressSync([Buffer.from('joint'),mint.toBuffer(),owner.toBuffer(),id],program)[0];return {program,owner,mint,position,vault:getAssociatedTokenAddressSync(mint,position,true,TOKEN),ata:getAssociatedTokenAddressSync(mint,owner,false,TOKEN)};}
export function instruction(c,operation,amount,nonce){
 const a=addresses(c);const base=[a.owner,a.position,a.mint,a.vault,TOKEN,SystemProgram.programId,a.ata].map((pubkey,i)=>({pubkey,isSigner:i===0,isWritable:[0,1,3,6].includes(i)}));
 let data;if(operation==='deposit'){if(pk(c.verifier).equals(a.owner))throw Error('The verifier must be a different key.');data=Buffer.concat([Buffer.from([0]),u64(amount),hex(c.id),hex(c.binding),pk(c.verifier).toBuffer()]);}
 else if(operation==='release'){const receipt=PublicKey.findProgramAddressSync([Buffer.from('redemption'),a.position.toBuffer(),hex(nonce)],a.program)[0];base.push({pubkey:pk(c.verifier),isSigner:true,isWritable:false},{pubkey:receipt,isSigner:false,isWritable:true});data=Buffer.concat([Buffer.from([1]),u64(amount),hex(nonce)]);}
 else throw Error('Unsupported operation.');
 return new TransactionInstruction({programId:a.program,keys:base,data});
}
export function transaction(c,proposal){
 if(proposal.network!=='local-svm')throw Error('Only the local test network is supported.');
 const a=addresses(c),ix=instruction(c,proposal.operation,proposal.amount,proposal.nonce);
 const instructions=proposal.operation==='deposit'?[createAssociatedTokenAccountIdempotentInstruction(a.owner,a.vault,a.position,a.mint,TOKEN),ix]:[ix];
 return new VersionedTransaction(new TransactionMessage({payerKey:a.owner,recentBlockhash:proposal.blockhash,instructions}).compileToV0Message());
}
export function validateTransaction(c,p,bytes){
 const tx=VersionedTransaction.deserialize(bytes),expected=transaction(c,p);
 if(!Buffer.from(tx.message.serialize()).equals(Buffer.from(expected.message.serialize())))throw Error('Approval changed. Amount, owner, destination, program and instructions must match the review.');
 if(tx.signatures.some(s=>s.some(b=>b!==0)))throw Error('Approval must start unsigned.');
 return tx;
}
export function signReviewed(c,p,bytes,key){if(key.publicKey.toBase58()!==c.owner)throw Error('Wrong owner key.');const tx=validateTransaction(c,p,bytes);tx.sign([key]);return tx;}
export function sameConfig(a,b){return ['network','program','owner','verifier','mint','id','binding'].every(k=>a?.[k]===b?.[k]);}
export function validateState(c,state){const a=addresses(c);if(!state||state.position!==a.position.toBase58()||typeof state.created!=='boolean'||!['ownerBalance','vaultBalance','locked'].every(k=>typeof state[k]==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(state[k])&&BigInt(state[k])<=SUPPLY)||BigInt(state.locked)>BigInt(state.vaultBalance)||(!state.created&&BigInt(state.locked)!==0n))throw Error('Saved balance does not match this test position. Refresh before approving.');return state;}
