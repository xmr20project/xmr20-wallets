import {Buffer} from 'buffer';
// Instruction builders contain public addresses only; no signer or submission.
import {PublicKey,TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {LAUNCHPAD_PROGRAM,CREATE_CPMM_POOL_PROGRAM,getPdaPlatformFeeVaultAuth,getPdaPoolAuthority,getPdaObservationId,getPdaVault} from '@raydium-io/raydium-sdk-v2';
import {PLATFORM_OWNER} from './platform-identity.js';
export const OWNER=new PublicKey(PLATFORM_OWNER);
export const WXMR=new PublicKey('WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp');
export const MOUSE=new PublicKey('CNTcaYTBBrSjYQXrWSL3T126eCjYnmvAhSwYBXBScLLM');
export const POOL=new PublicKey('Bg9DC5rDRBqtCZM9YTWxnisehoUooZ19SenaxEzDYfiV');
export const CONFIG=new PublicKey('CRRS5ieQmBrZjWhcj99JuGrT5tyuWDaGAXLXLFjbAtjQ');
export const PLATFORM=new PublicKey('AvnRU5mzuQujakZeMLTPRiGYdqFw3LF5QUCXmk27ZCTo');
export const FEE_VAULT=new PublicKey('FeVqYgtrobkQ83SdTF1FM8f94yadLovAnf1aDgULNYgV');
const meta=(pubkey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
export function addresses(programId) {
  const [state,bump]=PublicKey.findProgramAddressSync([Buffer.from('mouse-fund-v1')],programId);
  return {state,bump,quoteAta:getAssociatedTokenAddressSync(WXMR,state,true,TOKEN_PROGRAM_ID),
    mouseAta:getAssociatedTokenAddressSync(MOUSE,state,true,TOKEN_2022_PROGRAM_ID),
    observation:getPdaObservationId(CREATE_CPMM_POOL_PROGRAM,POOL).publicKey,
    inputVault:getPdaVault(CREATE_CPMM_POOL_PROGRAM,POOL,WXMR).publicKey,
    outputVault:getPdaVault(CREATE_CPMM_POOL_PROGRAM,POOL,MOUSE).publicKey};
}
export function initializeIx(programId) {
  return new TransactionInstruction({programId,data:Buffer.from([0,1]),keys:[meta(addresses(programId).state,true),meta(OWNER,true,true),meta(SystemProgram.programId)]});
}
export function collectIx(programId) {
  const a=addresses(programId);
  return new TransactionInstruction({programId,data:Buffer.from([1]),keys:[meta(a.state,true),meta(getPdaPlatformFeeVaultAuth(LAUNCHPAD_PROGRAM).publicKey),meta(PLATFORM),meta(FEE_VAULT,true),meta(a.quoteAta,true),meta(WXMR),meta(TOKEN_PROGRAM_ID),meta(SystemProgram.programId),meta(ASSOCIATED_TOKEN_PROGRAM_ID),meta(LAUNCHPAD_PROGRAM)]});
}
export function sampleIx(programId) {
  const a=addresses(programId);
  return new TransactionInstruction({programId,data:Buffer.from([3]),keys:[meta(a.state,true),meta(a.observation)]});
}
export function buyIx(programId,amount,minNet) {
  const a=addresses(programId),data=Buffer.alloc(17);data[0]=2;data.writeBigUInt64LE(BigInt(amount),1);data.writeBigUInt64LE(BigInt(minNet),9);
  return new TransactionInstruction({programId,data,keys:[meta(a.state,true),meta(getPdaPoolAuthority(CREATE_CPMM_POOL_PROGRAM).publicKey),meta(CONFIG),meta(POOL,true),meta(a.quoteAta,true),meta(a.mouseAta,true),meta(a.inputVault,true),meta(a.outputVault,true),meta(TOKEN_PROGRAM_ID),meta(TOKEN_2022_PROGRAM_ID),meta(WXMR),meta(MOUSE,true),meta(a.observation,true),meta(CREATE_CPMM_POOL_PROGRAM)]});
}
export function decodeState(data) {
  if(data.length!==128||data.subarray(0,8).toString()!=='MOUSEFD1'||data[9]!==1)throw Error('Unrecognized fund state');
  const u=o=>data.readBigUInt64LE(o).toString();
  return {mode:'buy-and-burn',bump:data[8],collectedWxmrRaw:u(16),spentWxmrRaw:u(24),boughtMouseRaw:u(32),burnedMouseRaw:u(40),lastBuyTimestamp:u(48),windowStart:u(56),windowSpentRaw:u(64),buybacks:u(72),sampleTimestamp:u(96),referencePriceX32:(data.readBigUInt64LE(104)+(data.readBigUInt64LE(112)<<64n)).toString(),referenceTimestamp:u(120)};
}
