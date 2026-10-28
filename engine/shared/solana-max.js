import {PublicKey,SystemProgram,Transaction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackMint,getAccount,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {connection} from './core.js';
import {maximumRaw} from '../token/max-amount.js';
export async function solanaTokenMaximum(owner,mintAddress,{rpc=connection,limit='1000000000000000'}={}){
 const mint=new PublicKey(mintAddress),sender=new PublicKey(owner),info=await rpc.getAccountInfo(mint,'confirmed');
 if(!info||![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(info.owner)))throw Error('Token program could not be verified.');
 const m=unpackMint(mint,info,info.owner);if(m.decimals!==6)throw Error('Token decimals differ from the wallet.');
 let holding;try{holding=await getAccount(rpc,getAssociatedTokenAddressSync(mint,sender,false,info.owner),'confirmed',info.owner);}catch(error){if(error.name==='TokenAccountNotFoundError')return '0';throw error;}
 if(!holding.owner.equals(sender)||!holding.mint.equals(mint)||holding.isFrozen)throw Error('Available tokens could not be verified.');
 return maximumRaw(holding.amount,{limit});
}
export async function solanaMaximum(owner,to,{rpc=connection}={}){
 const from=new PublicKey(owner),recipient=new PublicKey(to);
 if(from.equals(recipient))throw Error('Choose a different recipient.');
 const [latest,balance]=await Promise.all([rpc.getLatestBlockhash('confirmed'),rpc.getBalance(from,'confirmed')]);
 const tx=new Transaction({feePayer:from,...latest}).add(SystemProgram.transfer({fromPubkey:from,toPubkey:recipient,lamports:1n}));
 const fee=await rpc.getFeeForMessage(tx.compileMessage(),'confirmed');if(fee.value===null)throw Error('Network fee unavailable. Try Max again.');
 return maximumRaw(balance,{fee:fee.value});
}
