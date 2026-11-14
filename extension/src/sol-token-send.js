import {Connection,PublicKey,Transaction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getMint,getAccount,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createTransferCheckedInstruction,createTransferCheckedWithFeeInstruction,getTransferFeeConfig,calculateEpochFee,getAccountLenForMint} from '@solana/spl-token';
import bs58 from 'bs58';
import {Buffer} from 'buffer';

import {solanaSendEndpoint} from '../../engine/shared/solana-rpc.js';
const connection=()=>new Connection(solanaSendEndpoint(),'confirmed');
// decimals: 6 for XMR20 tokens (the default, with the 1 billion token limit as before), 12 for wXMR.
export function rawUnits(amount,decimals=6){if(decimals!==6){if(!Number.isInteger(decimals)||decimals<0||decimals>18||typeof amount!=='string'||!new RegExp('^(0|[1-9][0-9]*)(\\.[0-9]{1,'+decimals+'})?$').test(amount))throw Error(`Enter an amount with at most ${decimals} decimals.`);const [whole,fraction='']=amount.split('.');const raw=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0'));if(raw<1n)throw Error('Enter an amount above zero.');if(raw>18446744073709551615n)throw Error('Enter a smaller amount.');return raw;}
 if(typeof amount!=='string'||!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(amount))throw Error('Enter an amount with at most 6 decimals.');const [whole,fraction='']=amount.split('.');const raw=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));if(raw<1n||raw>1000000000000000n)throw Error('Amount must be between 0.000001 and 1 billion tokens.');return raw;}
// rpc: the Solana connection (the node chosen in Settings; tests pass their own).
export async function prepareSolanaTokenSend({row,owner,to,amount,rpc=null}){
 const decimals=row.decimals??6,sender=new PublicKey(owner),recipient=new PublicKey(to),mint=new PublicKey(row.mint),raw=rawUnits(amount,decimals);
 if(recipient.equals(sender))throw Error('Choose another Solana wallet.');
 const c=rpc||connection(),info=await c.getAccountInfo(mint,'confirmed');
 if(!info||!info.owner.equals(TOKEN_PROGRAM_ID)&&!info.owner.equals(TOKEN_2022_PROGRAM_ID))throw Error('Token program could not be verified.');
 const program=info.owner,m=await getMint(c,mint,'confirmed',program);
 if(m.decimals!==decimals)throw Error('Token decimals differ from the XMR20 index.');
 const source=getAssociatedTokenAddressSync(mint,sender,false,program),destination=getAssociatedTokenAddressSync(mint,recipient,false,program);
 const holding=await getAccount(c,source,'confirmed',program);if(holding.amount<raw)throw Error('Not enough available tokens.');
 const feeConfig=program.equals(TOKEN_2022_PROGRAM_ID)?getTransferFeeConfig(m):null;
 const fee=feeConfig?calculateEpochFee(feeConfig,(await c.getEpochInfo('confirmed')).epoch,raw):0n;
 const latest=await c.getLatestBlockhash('confirmed'),tx=new Transaction({feePayer:sender,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight});
 tx.add(createAssociatedTokenAccountIdempotentInstruction(sender,destination,recipient,mint,program));
 tx.add(feeConfig?createTransferCheckedWithFeeInstruction(source,mint,destination,sender,raw,decimals,fee,[],program):createTransferCheckedInstruction(source,mint,destination,sender,raw,decimals,[],program));
 const networkFee=await c.getFeeForMessage(tx.compileMessage(),'confirmed');if(networkFee.value===null)throw Error('Network fee unavailable.');
 const destinationInfo=await c.getAccountInfo(destination,'confirmed');const rentRaw=destinationInfo?0:await c.getMinimumBalanceForRentExemption(getAccountLenForMint(m),'confirmed');
 if(await c.getBalance(sender,'confirmed')<networkFee.value+rentRaw)throw Error('Insufficient SOL for network fee and recipient account rent.');
 const sim=await c.simulateTransaction(tx);if(sim.value.err)throw Error('Transfer simulation failed. Check SOL for network and token-account costs.');
 return {tx,fee,rentRaw:String(rentRaw),feeRaw:String(networkFee.value),netRaw:String(raw-fee),expires:Date.now()+45000,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,source:source.toBase58(),destination:destination.toBase58()};
}
