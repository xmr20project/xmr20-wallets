import {Buffer} from 'buffer';
import {PublicKey,SystemProgram,TransactionInstruction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {LAUNCHPAD_PROGRAM,getPdaLaunchpadPoolId} from '@raydium-io/raydium-sdk-v2';
import {addresses,WXMR} from './fund-client.js';
import {convertCurveTaxIx,convertCpmmTaxIx} from './fund-tax-client.js';
import {creatorFeeSharing,creatorShareHash} from './creator-fee-sharing.js';
export const DEFAULT_CREATOR_FEE_BPS=1500;
export const APPROVED_CREATOR_FEE_BPS=Object.freeze([1500,0,5000]);
export const creatorFeeBps=n=>{if(!Number.isInteger(n)||!APPROVED_CREATOR_FEE_BPS.includes(n))throw Error('Choose an approved creator fee split.');return n;};
export const feeSplitState=(program,mint)=>PublicKey.findProgramAddressSync([Buffer.from('fee-split-v1'),mint.toBuffer()],program)[0];
export const creatorQuoteAccount=creator=>getAssociatedTokenAddressSync(WXMR,creator,true,TOKEN_PROGRAM_ID);
export function registerFeeSplitIx(program,mint,creator,bps=DEFAULT_CREATOR_FEE_BPS,sharing=null,payoutWallet=null){
 const share=creatorFeeSharing(sharing);
 if(share&&bps!==5000)throw Error('Fee sharing requires the new Quick fee policy.');
 const d=Buffer.alloc(share?70:3);d[0]=share?17:12;d.writeUInt16LE(creatorFeeBps(bps),1);
 if(share){const recipient=new PublicKey(share.network==='solana'?share.address:payoutWallet);if(!PublicKey.isOnCurve(recipient.toBytes()))throw Error('Invalid fee sharing receiving wallet.');d.writeUInt16LE(share.bps,3);d[5]=share.network==='solana'?1:2;recipient.toBuffer().copy(d,6);Buffer.from(creatorShareHash(share),'hex').copy(d,38);}
 return new TransactionInstruction({programId:program,data:d,keys:[{pubkey:creator,isSigner:true,isWritable:true},{pubkey:mint,isSigner:true,isWritable:false},{pubkey:getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM,mint,WXMR).publicKey,isSigner:false,isWritable:false},{pubkey:feeSplitState(program,mint),isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}]});
}
export function decodeFeeSplit(program,mint,creator,info){
 return decodeFeePolicy(program,mint,creator,info).bps;
}
export function decodeFeePolicy(program,mint,creator,info){
 if(!info||(info.owner.equals(SystemProgram.programId)&&info.data.length===0))return {bps:DEFAULT_CREATOR_FEE_BPS,sharing:null};
 const d=info.data;
 if(!info.owner.equals(program)||![42,109].includes(d.length)||d.subarray(0,8).toString()!=='XMRSPLT1'||!new PublicKey(d.subarray(8,40)).equals(creator))throw Error('Invalid token fee split account.');
 const bps=creatorFeeBps(d.readUInt16LE(40));
 if(d.length===42)return {bps,sharing:null};
 const shareBps=d.readUInt16LE(42),recipient=new PublicKey(d.subarray(45,77)),network=d[44];
 if(bps!==5000||shareBps<1||shareBps>10000||![1,2].includes(network)||recipient.equals(SystemProgram.programId)||recipient.equals(addresses(program).state)||d.subarray(77).every(n=>n===0))throw Error('Invalid fee sharing policy.');
 return {bps,sharing:{bps:shareBps,network:network===1?'solana':'monero',recipient:recipient.toBase58(),targetHash:d.subarray(77).toString('hex')}};
}
export const PROTOCOL_TREASURY=new PublicKey('5drd6SQcjiY3pYhwpCowahaqsp7ybqQjHQv6Uy3Bp7QE');
export function appendSharingAccount(ix,bps,sharing){if(sharing){if(bps!==5000)throw Error('Invalid sharing policy');ix.keys.push({pubkey:creatorQuoteAccount(new PublicKey(sharing.recipient)),isSigner:false,isWritable:true});}return ix;}
function append(ix,program,mint,creator,bps,sharing){ix.keys.push({pubkey:creatorQuoteAccount(creator),isSigner:false,isWritable:true},{pubkey:feeSplitState(program,mint),isSigner:false,isWritable:false});if(bps===5000)ix.keys.push({pubkey:creatorQuoteAccount(PROTOCOL_TREASURY),isSigner:false,isWritable:true});return appendSharingAccount(ix,bps,sharing);}
export const convertCurveFeeSplitIx=(program,mint,creator,amount,min,bps=1500,sharing=null)=>append(convertCurveTaxIx(program,mint,creator,amount,min),program,mint,creator,creatorFeeBps(bps),sharing);
export const convertCpmmFeeSplitIx=(program,mint,pool,baseVault,quoteVault,amount,min,creator,bps=1500,sharing=null)=>append(convertCpmmTaxIx(program,mint,pool,baseVault,quoteVault,amount,min),program,mint,creator,creatorFeeBps(bps),sharing);
