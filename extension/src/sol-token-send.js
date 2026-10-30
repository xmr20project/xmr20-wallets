import {Connection,PublicKey,Transaction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getMint,getAccount,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createTransferCheckedInstruction,createTransferCheckedWithFeeInstruction,getTransferFeeConfig,calculateEpochFee,getAccountLenForMint} from '@solana/spl-token';
import bs58 from 'bs58';
import {Buffer} from 'buffer';

const connection=()=>new Connection('https://solana-rpc.publicnode.com','confirmed');
export function rawUnits(amount){if(typeof amount!=='string'||!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(amount))throw Error('Enter an amount with at most 6 decimals.');const [whole,fraction='']=amount.split('.');const raw=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));if(raw<1n||raw>1000000000000000n)throw Error('Amount must be between 0.000001 and 1 billion tokens.');return raw;}
export async function prepareSolanaTokenSend({row,owner,to,amount}){
 const sender=new PublicKey(owner),recipient=new PublicKey(to),mint=new PublicKey(row.mint),raw=rawUnits(amount);
 if(recipient.equals(sender))throw Error('Choose another Solana wallet.');
 const c=connection(),info=await c.getAccountInfo(mint,'confirmed');
 if(!info||!info.owner.equals(TOKEN_PROGRAM_ID)&&!info.owner.equals(TOKEN_2022_PROGRAM_ID))throw Error('Token program could not be verified.');
 const program=info.owner,m=await getMint(c,mint,'confirmed',program);
 if(m.decimals!==6)throw Error('Token decimals differ from the XMR20 index.');
 const source=getAssociatedTokenAddressSync(mint,sender,false,program),destination=getAssociatedTokenAddressSync(mint,recipient,false,program);
 const holding=await getAccount(c,source,'confirmed',program);if(holding.amount<raw)throw Error('Not enough available tokens.');
 const feeConfig=program.equals(TOKEN_2022_PROGRAM_ID)?getTransferFeeConfig(m):null;
 const fee=feeConfig?calculateEpochFee(feeConfig,(await c.getEpochInfo('confirmed')).epoch,raw):0n;
 const latest=await c.getLatestBlockhash('confirmed'),tx=new Transaction({feePayer:sender,recentBlockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight});
 tx.add(createAssociatedTokenAccountIdempotentInstruction(sender,destination,recipient,mint,program));
 tx.add(feeConfig?createTransferCheckedWithFeeInstruction(source,mint,destination,sender,raw,6,fee,[],program):createTransferCheckedInstruction(source,mint,destination,sender,raw,6,[],program));
 const networkFee=await c.getFeeForMessage(tx.compileMessage(),'confirmed');if(networkFee.value===null)throw Error('Network fee unavailable.');
 const destinationInfo=await c.getAccountInfo(destination,'confirmed');const rentRaw=destinationInfo?0:await c.getMinimumBalanceForRentExemption(getAccountLenForMint(m),'confirmed');
 if(await c.getBalance(sender,'confirmed')<networkFee.value+rentRaw)throw Error('Insufficient SOL for network fee and recipient account rent.');
 const sim=await c.simulateTransaction(tx);if(sim.value.err)throw Error('Transfer simulation failed. Check SOL for network and token-account costs.');
 return {tx,fee,rentRaw:String(rentRaw),feeRaw:String(networkFee.value),netRaw:String(raw-fee),expires:Date.now()+45000,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,source:source.toBase58(),destination:destination.toBase58()};
}
