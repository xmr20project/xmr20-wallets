import {Connection,PublicKey,SystemProgram,Transaction,ComputeBudgetProgram,VersionedMessage,VersionedTransaction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getMint,getAccount,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createTransferCheckedInstruction,createTransferCheckedWithFeeInstruction,getTransferFeeConfig,calculateEpochFee} from '@solana/spl-token';
import bs58 from 'bs58';
import {Buffer} from 'buffer';
import {ed25519} from '@noble/curves/ed25519';
import {LIGHTHOUSE_PROGRAM} from '../shared/pilot-transaction.js';

const rpc=new URL('/api/wallet',location.origin).href;
const connection=()=>new Connection(rpc,{commitment:'confirmed',fetch:async(_url,options)=>{
 const payload=JSON.parse(options.body);
 return fetch(rpc,{...options,headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'walletRpc',rpc:payload})});
}});
// XMR20 tokens have 6 decimals; wXMR (30 Oct 2026, owner: wXMR in the wallet with Send) has 12.
export function rawUnits(amount,decimals=6){if(typeof amount!=='string'||!new RegExp('^(0|[1-9][0-9]*)(\\.[0-9]{1,'+decimals+'})?$').test(amount))throw Error(`Enter an amount with at most ${decimals} decimals.`);const unit=10n**BigInt(decimals),[whole,fraction='']=amount.split('.');const raw=BigInt(whole)*unit+BigInt(fraction.padEnd(decimals,'0'));if(raw<1n||raw>1000000000n*unit)throw Error(`Amount must be between 0.${'0'.repeat(decimals-1)}1 and 1 billion tokens.`);return raw;}
export const solanaRpc=()=>connection();
// Native SOL payment, such as a ChangeNOW deposit. The exact lamports, fee and
// balance are checked before review; signing reuses the token-send guards.
export async function prepareSolTransfer({owner,to,lamports}){
 const sender=new PublicKey(owner),recipient=new PublicKey(to),amount=BigInt(lamports);
 if(recipient.equals(sender))throw Error('Choose another Solana wallet.');
 if(amount<1n||amount>18446744073709551615n)throw Error('Invalid SOL amount.');
 const c=connection(),latest=await c.getLatestBlockhash('confirmed');
 const tx=new Transaction({feePayer:sender,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight}).add(SystemProgram.transfer({fromPubkey:sender,toPubkey:recipient,lamports:amount}));
 const fee=await c.getFeeForMessage(tx.compileMessage(),'confirmed');if(fee?.value===null||fee?.value===undefined)throw Error('Network fee unavailable. Try again.');
 const balance=await c.getBalance(sender,'confirmed');if(!Number.isSafeInteger(balance)||amount+BigInt(fee.value)>BigInt(balance))throw Error('Not enough SOL for this amount and the network fee.');
 return {tx,fee:BigInt(fee.value),blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight};
}
export async function prepareSolanaTokenSend({row,owner,to,amount}){
 const decimals=row.decimals??6,sender=new PublicKey(owner),recipient=new PublicKey(to),mint=new PublicKey(row.mint),raw=rawUnits(amount,decimals);
 if(recipient.equals(sender))throw Error('Choose another Solana wallet.');
 const c=connection(),info=await c.getAccountInfo(mint,'confirmed');
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
 return {tx,fee,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,source:source.toBase58(),destination:destination.toBase58()};
}
// Phantom may add its own priority fee (ComputeBudget) and Lighthouse safety checks to a transaction that only this
// wallet signs. Those additions are accepted, as the bridge accepts them: every reviewed instruction stays exactly the
// same and in the same order, the payer and only signer stay the owner, no reviewed account changes privilege, added
// accounts are read-only, the added priority fee is at most 0.005 SOL, and safety checks are pure Lighthouse assertions
// (the same rules as core-transferable/wallet-guards.mjs). Any other change is refused before anything is submitted.
const BUDGET=ComputeBudgetProgram.programId.toBase58(),MAX_UNITS=1400000n,MAX_PRIORITY_LAMPORTS=5000000n;
const assertionAccounts=new Map([[2,1],[3,1],[4,2],[5,1],[6,1],[7,1],[8,1],[9,1],[10,1],[11,1],[12,1],[13,1],[14,1],[15,0],[17,1]]),assertionLogs=new Set([0,1,2,4,5]);
export function checkWalletAdditions(before,after){
 if(Buffer.from(before.serialize()).equals(Buffer.from(after.serialize())))return;
 const fail=reason=>{throw Error(`Wallet changed the reviewed transaction (${reason}). Nothing was submitted.`);};
 if(after.version!==before.version||after.addressTableLookups.length||before.addressTableLookups.length||after.recentBlockhash!==before.recentBlockhash)fail('version or blockhash');
 const b=before.staticAccountKeys.map(k=>k.toBase58()),a=after.staticAccountKeys.map(k=>k.toBase58());
 if(a[0]!==b[0]||after.header.numRequiredSignatures!==1||before.header.numRequiredSignatures!==1)fail('payer or signers');
 if(new Set(a).size!==a.length||b.some(k=>!a.includes(k)))fail('accounts');
 for(let i=0;i<a.length;i++){const j=b.indexOf(a[i]),signer=after.isAccountSigner(i),writable=after.isAccountWritable(i);
  if(j<0?signer||writable:signer!==before.isAccountSigner(j)||writable!==before.isAccountWritable(j))fail('account permissions');}
 const view=(m,ix)=>JSON.stringify([m.staticAccountKeys[ix.programIdIndex].toBase58(),ix.accountKeyIndexes.map(i=>m.staticAccountKeys[i].toBase58()),Buffer.from(ix.data).toString('hex')]);
 const reviewed=before.compiledInstructions.map(ix=>view(before,ix)),kept=[];let limit=null,price=null,loaded=null,guards=0;
 if(reviewed.some(v=>JSON.parse(v)[0]===BUDGET))fail('priority fee');
 for(const ix of after.compiledInstructions){
  const program=after.staticAccountKeys[ix.programIdIndex].toBase58(),d=Buffer.from(ix.data);
  if(program===BUDGET){
   if(ix.accountKeyIndexes.length)fail('priority fee');
   if(d.length===5&&d[0]===2&&limit===null)limit=BigInt(d.readUInt32LE(1));
   else if(d.length===9&&d[0]===3&&price===null)price=d.readBigUInt64LE(1);
   else if(d.length===5&&d[0]===4&&loaded===null)loaded=d.readUInt32LE(1);
   else fail('priority fee');
  }else if(program===LIGHTHOUSE_PROGRAM){
   if(++guards>16||!assertionAccounts.has(d[0])||ix.accountKeyIndexes.length!==assertionAccounts.get(d[0])||d.length<3||d.length>512||!assertionLogs.has(d[1]))fail('safety check');
  }else kept.push(view(after,ix));
 }
 if(JSON.stringify(kept)!==JSON.stringify(reviewed))fail('reviewed instructions');
 const units=limit??BigInt(200000*(kept.length+guards));
 if(units>MAX_UNITS||((price??0n)*units+999999n)/1000000n>MAX_PRIORITY_LAMPORTS)fail('priority fee too high');
}
export async function signAndSubmitSolanaTokenSend({prepared,provider,owner,row,to,amount,assertCurrent=()=>{},onSubmitted=()=>{}}){
 assertCurrent();provider?.assertCurrent?.();
 if(provider?.publicKey?.toBase58()!==owner)throw Error('Wallet changed. Reconnect before sending.');
 const tx=prepared.tx,before=VersionedMessage.deserialize(tx.serializeMessage()),returned=await provider.signTransaction(tx);
 // Closing/cancelling while the wallet prompt is open must not send a late reply.
 assertCurrent();provider?.assertCurrent?.();
 if(provider?.publicKey?.toBase58()!==owner)throw Error('Wallet changed the reviewed transaction. Nothing was submitted.');
 // Check the exact bytes the wallet signed, whatever object type it returned.
 const bytes=Uint8Array.from(returned.serialize({requireAllSignatures:false,verifySignatures:false})),signed=VersionedTransaction.deserialize(bytes);
 checkWalletAdditions(before,signed.message);
 if(signed.signatures.length!==1||!ed25519.verify(signed.signatures[0],signed.message.serialize(),signed.message.staticAccountKeys[0].toBytes()))throw Error('Wallet signature is missing or invalid. Nothing was submitted.');
 const signature=bs58.encode(signed.signatures[0]);
 const key=`xmr20-sol-send:${owner}:${row.mint}:${to}:${amount}`;
 sessionStorage.setItem(key,JSON.stringify({signature,transaction:Buffer.from(bytes).toString('base64'),blockhash:prepared.blockhash,lastValidBlockHeight:prepared.lastValidBlockHeight}));
 onSubmitted({signature,confirmed:false,savedKey:key});
 const c=connection();try{await c.sendRawTransaction(bytes,{skipPreflight:false,maxRetries:2});}catch(e){const status=await c.getSignatureStatuses([signature],{searchTransactionHistory:true}).catch(()=>null);if(!status?.value?.[0])throw Error(`Submission uncertain. Saved receipt ${signature}; check its status before retrying.`);}
 const confirmed=await checkSolanaTokenSend(signature,{connection:c});
 if(confirmed)sessionStorage.removeItem(key);return {signature,confirmed};
}
export async function checkSolanaTokenSend(signature,{connection:c=connection(),attempts=8}={}){
 for(let i=0;i<attempts;i++){
  const status=await c.getSignatureStatuses([signature],{searchTransactionHistory:true}).catch(()=>null);
  const result=status?.value?.[0];if(result?.err)throw Error('Solana reported a failed transfer. Keep the saved receipt.');
  if(['confirmed','finalized'].includes(result?.confirmationStatus))return true;
  if(i+1<attempts)await new Promise(resolve=>setTimeout(resolve,2500));
 }
 return false;
}
