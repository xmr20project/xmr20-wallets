import {Buffer} from 'buffer';
import {PublicKey,TransactionInstruction,SystemProgram,SYSVAR_RENT_PUBKEY,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {OWNER,addresses} from './fund-client.js';
export const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const PROGRAM_SEED='mouse-fund-657fd907-v1',BUFFER_SEED='mouse-buffer-657fd907-v1';
export const FUND_PROGRAM=new PublicKey('ALyxxeFRi5V7jSEJZjQC47A1H5qQ4uaasMCzyVt42gNx');
export const BUFFER_ACCOUNT=new PublicKey('7TMcx4QQb73YJqEMWY5QxCrSKNnkrfoowAuBj2kN9Tus');
export const PROGRAM_DATA=PublicKey.findProgramAddressSync([FUND_PROGRAM.toBuffer()],LOADER)[0];
export const FUND=addresses(FUND_PROGRAM);
export const BINARY_HASH='657fd907e1c0011bfa1bb07d7c694a40bd790c5cf09fe6650d7d92abd5759068';
export const BINARY_SIZE=117984,CHUNK_SIZE=700,BATCH_SIZE=12;
const meta=(pubkey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
const ix=(data,keys)=>new TransactionInstruction({programId:LOADER,data,keys});
const tag=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
export function createBufferIxs(rent){return [SystemProgram.createAccountWithSeed({fromPubkey:OWNER,basePubkey:OWNER,seed:BUFFER_SEED,newAccountPubkey:BUFFER_ACCOUNT,lamports:rent,space:BINARY_SIZE+37,programId:LOADER}),ix(tag(0),[meta(BUFFER_ACCOUNT,true),meta(OWNER)])];}
export function writeBufferIx(offset,bytes){
  if(offset<0||offset%CHUNK_SIZE||bytes.length!==Math.min(CHUNK_SIZE,BINARY_SIZE-offset)||offset>=BINARY_SIZE)throw Error('Invalid binary chunk');
  const d=Buffer.alloc(16+bytes.length);d.writeUInt32LE(1);d.writeUInt32LE(offset,4);d.writeBigUInt64LE(BigInt(bytes.length),8);Buffer.from(bytes).copy(d,16);
  return ix(d,[meta(BUFFER_ACCOUNT,true),meta(OWNER,false,true)]);
}
export function deployIxs(rent){const d=Buffer.alloc(12);d.writeUInt32LE(2);d.writeBigUInt64LE(BigInt(BINARY_SIZE),4);
  return [SystemProgram.createAccountWithSeed({fromPubkey:OWNER,basePubkey:OWNER,seed:PROGRAM_SEED,newAccountPubkey:FUND_PROGRAM,lamports:rent,space:36,programId:LOADER}),ix(d,[meta(OWNER,true,true),meta(PROGRAM_DATA,true),meta(FUND_PROGRAM,true),meta(BUFFER_ACCOUNT,true),meta(SYSVAR_RENT_PUBKEY),meta(SYSVAR_CLOCK_PUBKEY),meta(SystemProgram.programId),meta(OWNER,false,true)])];
}
export function closeBufferIx(){return ix(tag(5),[meta(BUFFER_ACCOUNT,true),meta(OWNER,true),meta(OWNER,false,true)]);}
export function missingChunks(buffer,binary){
  const missing=[];for(let offset=0;offset<BINARY_SIZE;offset+=CHUNK_SIZE){const end=Math.min(offset+CHUNK_SIZE,BINARY_SIZE);if(!Buffer.from(buffer.subarray(37+offset,37+end)).equals(binary.subarray(offset,end)))missing.push(offset);}return missing;
}
