import {Buffer} from 'buffer';
import {PublicKey,TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {LAUNCHPAD_PROGRAM,CREATE_CPMM_POOL_PROGRAM,sellExactInInstruction,makeSwapCpmmBaseInInstruction,getPdaLaunchpadAuth,getPdaLaunchpadPoolId,getPdaLaunchpadVaultId,getPdaPlatformVault,getPdaCreatorVault,getPdaPoolAuthority,getPdaObservationId} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import {addresses,WXMR,PLATFORM,CONFIG} from './fund-client.js';
export const GLOBAL=new PublicKey('GC1ZWMKnnPBGmTkoNNKnR17SbqZwMN9coSWgW3UH5JSr');
const meta=(pubkey,isWritable=false)=>({pubkey,isWritable,isSigner:false});
const amounts=(tag,amount,min)=>{const d=Buffer.alloc(17);d[0]=tag;d.writeBigUInt64LE(BigInt(amount),1);d.writeBigUInt64LE(BigInt(min),9);return d;};
export function collectTransferTaxIx(program,mint,sources=[]) {
 if(sources.length>20)throw Error('Collect at most 20 tax accounts per transaction');
 const a=addresses(program),ata=getAssociatedTokenAddressSync(mint,a.state,true,TOKEN_2022_PROGRAM_ID);
 return new TransactionInstruction({programId:program,data:Buffer.from([4]),keys:[meta(a.state,true),meta(mint,true),meta(ata,true),meta(TOKEN_2022_PROGRAM_ID),...sources.map(s=>meta(s,true))]});
}
export function convertCurveTaxIx(program,mint,creator,amount,minNetWxmr) {
 const a=addresses(program),pool=getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM,mint,WXMR).publicKey;
 const sell=sellExactInInstruction(LAUNCHPAD_PROGRAM,a.state,getPdaLaunchpadAuth(LAUNCHPAD_PROGRAM).publicKey,GLOBAL,PLATFORM,pool,
 getAssociatedTokenAddressSync(mint,a.state,true,TOKEN_2022_PROGRAM_ID),a.quoteAta,getPdaLaunchpadVaultId(LAUNCHPAD_PROGRAM,pool,mint).publicKey,
 getPdaLaunchpadVaultId(LAUNCHPAD_PROGRAM,pool,WXMR).publicKey,mint,WXMR,TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID,
 getPdaPlatformVault(LAUNCHPAD_PROGRAM,PLATFORM,WXMR).publicKey,getPdaCreatorVault(LAUNCHPAD_PROGRAM,creator,WXMR).publicKey,new BN(String(amount)),new BN(String(minNetWxmr)));
 return new TransactionInstruction({programId:program,data:amounts(5,amount,minNetWxmr),keys:[...sell.keys.map(k=>({...k,isSigner:false})),meta(taxSaleState(program,mint),true)]});
}
export function convertCpmmTaxIx(program,mint,pool,baseVault,quoteVault,amount,minNetWxmr) {
 const a=addresses(program);
 return new TransactionInstruction({programId:program,data:amounts(6,amount,minNetWxmr),keys:[meta(a.state,true),meta(getPdaPoolAuthority(CREATE_CPMM_POOL_PROGRAM).publicKey),meta(CONFIG),meta(pool,true),
 meta(getAssociatedTokenAddressSync(mint,a.state,true,TOKEN_2022_PROGRAM_ID),true),meta(a.quoteAta,true),meta(baseVault,true),meta(quoteVault,true),
 meta(TOKEN_2022_PROGRAM_ID),meta(TOKEN_PROGRAM_ID),meta(mint),meta(WXMR),meta(getPdaObservationId(CREATE_CPMM_POOL_PROGRAM,pool).publicKey,true),meta(CREATE_CPMM_POOL_PROGRAM),meta(getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM,mint,WXMR).publicKey),meta(taxSaleState(program,mint),true)]});
}

export const MAX_TAX_SALE_RAW=10_000_000_000_000n,TAX_SALE_INTERVAL=600n;
export const taxSaleState=(program,mint)=>PublicKey.findProgramAddressSync([Buffer.from('tax-sale-v1'),mint.toBuffer()],program)[0];
export function registerTaxSaleIx(program,mint,payer){return new TransactionInstruction({programId:program,data:Buffer.from([7]),keys:[meta(addresses(program).state,true),meta(mint),meta(getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM,mint,WXMR).publicKey),meta(taxSaleState(program,mint),true),{pubkey:payer,isWritable:true,isSigner:true},meta(SystemProgram.programId)]});}
export function taxSaleReady(last,now,interval=TAX_SALE_INTERVAL){if(interval!==600n&&interval!==60n)throw Error('Unknown fee-sale interval');return now>=last&&now-last>=interval;}
export function taxConversionMinimum(amount,reserveIn,reserveOut){
 if(amount<=0n||amount>MAX_TAX_SALE_RAW||reserveIn<=0n||reserveOut<=0n)throw Error('Invalid tax sale quote');
 const net=amount*9850n/10000n*9800n/10000n;
 return reserveOut*net/(reserveIn+net)*9500n/10000n;
}
