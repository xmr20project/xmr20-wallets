// Solana is used only for bridge custody, never ordinary account transfers.
// Local draft instructions. No deployed program accepts these operations yet.
import {PublicKey,SystemProgram,TransactionInstruction} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID as TOKEN,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {addresses} from '../core-transferable/sdk.mjs';
import {need,hash,digest,amount} from './records.mjs';
import {custodyPolicyIdentity} from './custody-policy.mjs';
const pk=x=>new PublicKey(x),meta=(pubkey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
const hex=x=>{need(hash(x),'Nonzero commitment required.');return Buffer.from(x,'hex');};
const u64=x=>{const n=amount(x,{zero:true}),b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};
export function bridgePolicy(config,options){
 const custody=custodyPolicyIdentity(config,options);
 if(config.owner===config.verifier&&custody.mode==='operator-verified-v1'){
  // Operator-paid redemption has no legacy holder position. Keep the old SDK's
  // distinct-holder requirement intact; never use this branch for migration.
  need(config.abi===3&&['local-svm','mainnet-beta'].includes(config.network),'Explicit native custody deployment required.');
  const owner=pk(config.owner),pool=PublicKey.findProgramAddressSync([Buffer.from('joint-v3-pool'),custody.mint.toBuffer(),custody.verifier.toBuffer()],custody.program)[0];
  return {...custody,owner,pool,position:null,link:null,vault:getAssociatedTokenAddressSync(custody.mint,pool,true,TOKEN),ata:getAssociatedTokenAddressSync(custody.mint,owner,false,TOKEN)};
 }
 return {...addresses(config),...custody};
}
export function initializePolicy(config,options){const a=bridgePolicy(config,options);return new TransactionInstruction({programId:a.program,data:Buffer.concat([Buffer.from([a.mode==='operator-verified-v1'?13:8]),hex(a.manifest),Buffer.from([a.signers.length]),a.packed]),keys:[meta(a.owner,true,true),meta(a.verifier,false,true),meta(a.policy,true),meta(a.pool,true),meta(a.mint),meta(a.vault),meta(TOKEN),meta(SystemProgram.programId)]});}
export function bridgeInstruction(config,options,intent){
 const a=bridgePolicy(config,options),tag={migrate:9,deposit:10,redeem:a.mode==='operator-verified-v1'?14:11,'migrate-output':12}[intent.kind];need(tag,'Unknown Monero bridge operation.');
 const redemption=tag===11||tag===14;
 const migration=tag===9||tag===12;
 need(!migration||a.position!==null,'Legacy conversion requires the distinct position holder.');
 need(amount(intent.amount)<=50000000000000n,'Bridge operation limit exceeded.');const binding=redemption?pk(intent.destination).toBuffer():hex(intent.binding),fee=migration?'0':intent.fee;
 need(amount(intent.amount)>amount(fee,{zero:true}),'Bridge fee consumes the amount.');
 const data=Buffer.concat([Buffer.from([tag]),u64(intent.amount),hex(intent.nonce),binding,...(migration?[]:[u64(fee)])]);
 const source=migration?a.position:a.policy,receipt=PublicKey.findProgramAddressSync([Buffer.from(redemption?'monero-redemption-v1':'joint-v3-receipt'),source.toBuffer(),hex(intent.nonce)],a.program)[0];
 const keys=[meta(a.owner,true,true),meta(a.policy,true),meta(a.pool,true),meta(a.mint),meta(a.vault,true),meta(TOKEN),meta(SystemProgram.programId),meta(receipt,true)];
 if(migration)keys.push(meta(a.position,true),meta(a.verifier,false,true));
 else if(tag===10)keys.push(meta(a.ata,true));
 else{
  need(Array.isArray(intent.signers)&&intent.signers.length===a.requiredSignatures&&new Set(intent.signers.map(k=>pk(k).toBase58())).size===a.requiredSignatures&&intent.signers.every(k=>a.signers.some(s=>s.equals(pk(k)))),'Exact configured custody signatures required.');
  keys.push(meta(getAssociatedTokenAddressSync(a.mint,pk(intent.destination),false,TOKEN),true),...intent.signers.map(k=>meta(pk(k),false,true)));
 }
 return {instruction:new TransactionInstruction({programId:a.program,data,keys}),receipt,policy:a.policy};
}
export function decodePolicy(data){const b=Buffer.from(data);need(b.length===202&&((b[0]===1&&[2,3].includes(b[97]))||(b[0]===2&&b[97]===1)),'Monero custody policy required.');return {mint:pk(b.subarray(1,33)).toBase58(),verifier:pk(b.subarray(33,65)).toBase58(),manifest:b.subarray(65,97).toString('hex'),signers:Array.from({length:b[97]},(_,i)=>pk(b.subarray(98+32*i,130+32*i)).toBase58()),requiredSignatures:b[0]===2?1:2,mode:b[0]===2?'operator-verified-v1':'quorum-draft-v1',reserve:b.readBigUInt64LE(194).toString()};}
export function decodeBridgeReceipt(data){const b=Buffer.from(data);need(b.length===185&&[9,10,11,12,14].includes(b[0]),'Monero custody receipt required.');return {kind:b[0],from:pk(b.subarray(1,33)).toBase58(),to:pk(b.subarray(33,65)).toBase58(),nonce:b.subarray(65,97).toString('hex'),commitment:b.subarray(97,129).toString('hex'),gross:b.readBigUInt64LE(129).toString(),net:b.readBigUInt64LE(137).toString(),fee:b.readBigUInt64LE(145).toString(),binding:b.subarray(153,185).toString('hex')};}
