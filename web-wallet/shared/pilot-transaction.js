import {resolved} from './resolved-wallet.js';
import {splitLookupTables} from './launch-split-table.js';
import {registerFeeSplitIx,creatorQuoteAccount} from './fund-fee-split.js';
import {FUND_PROGRAM} from './fund-deployment.js';
import {ASSOCIATED_TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {Buffer} from 'buffer';
import {VersionedTransaction,ComputeBudgetProgram,PublicKey,SystemProgram} from '@solana/web3.js';
import {LAUNCH_FEE_LAMPORTS,LAUNCH_TREASURY} from './xmr20/launch-policy.js';
export const LIGHTHOUSE_PROGRAM='L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
// Lighthouse instruction.rs at 4c579479c98635e419b1b167f08be02a71604a71.
// Only single-account, read-only assertion handlers. Memory writes/closes,
// cross-program assertions and unknown future instructions are not allowed.
const LIGHTHOUSE_ASSERTIONS=new Set([2,3,5,6,7,8,9,10,11,12,13,14]);
function instructionView(msg,ix) {
  return {program:msg.staticAccountKeys[ix.programIdIndex].toBase58(),
    accounts:Array.from(ix.accountKeyIndexes,i=>({key:msg.staticAccountKeys[i].toBase58(),signer:msg.isAccountSigner(i),writable:msg.isAccountWritable(i)})),
    data:Buffer.from(ix.data).toString('hex')};
}

// Diagnostics deliberately omit signatures, transaction bytes, account addresses
// and instruction payloads. They are shown locally, never uploaded automatically.
export function walletCompatibilityReport(before,after,reason) {
  const original=before.compiledInstructions.map(ix=>JSON.stringify(instructionView(before,ix)));
  const list=msg=>msg.compiledInstructions.map(ix=>({
    program:msg.staticAccountKeys[ix.programIdIndex].toBase58(),
    instructionType:ix.data[0]??null,dataBytes:ix.data.length,accounts:ix.accountKeyIndexes.length,
    matchesOriginalInstruction:original.indexOf(JSON.stringify(instructionView(msg,ix))),
  }));
  return {version:'xmr20-wallet-4',reason,
    blockhashUnchanged:before.recentBlockhash===after.recentBlockhash,
    original:list(before),returned:list(after)};
}

export function validateWalletMessage(before,after) {
  if(Buffer.from(before.serialize()).equals(Buffer.from(after.serialize())))return 0;
  const reject=reason=>{const error=new Error(`The wallet returned a different transaction (${reason}). Nothing was submitted by XMR20. Copy the compatibility report below so the difference can be checked.`);error.code='WALLET_MESSAGE_CHANGED';error.diagnostic=walletCompatibilityReport(before,after,reason);throw error;};
  if(after.version!==before.version||after.addressTableLookups.length||after.recentBlockhash!==before.recentBlockhash)reject('message version, lookup tables or blockhash');
  if(after.staticAccountKeys[0]?.toBase58()!==before.staticAccountKeys[0].toBase58()||after.header.numRequiredSignatures!==before.header.numRequiredSignatures)reject('payer or signers');
  const originalKeys=new Map(before.staticAccountKeys.map((key,i)=>[key.toBase58(),{signer:before.isAccountSigner(i),writable:before.isAccountWritable(i)}]));
  const returnedKeys=new Set();
  for(let i=0;i<after.staticAccountKeys.length;i++){
    const key=after.staticAccountKeys[i].toBase58(),original=originalKeys.get(key);
    if(returnedKeys.has(key))reject('duplicate account');returnedKeys.add(key);
    if(original?(original.signer!==after.isAccountSigner(i)||original.writable!==after.isAccountWritable(i)):(after.isAccountSigner(i)||after.isAccountWritable(i)))reject('account permissions');
  }
  if([...originalKeys.keys()].some(key=>!returnedKeys.has(key)))reject('removed account');
  // Wallet assertions can appear before or between launch instructions too.
  // Validate them individually, then compare the entire remaining instruction
  // sequence, preserving the reviewed relative order and every operand.
  const guards=after.compiledInstructions.filter(ix=>after.staticAccountKeys[ix.programIdIndex].toBase58()===LIGHTHOUSE_PROGRAM);
  if(guards.length>8)reject('too many wallet safety checks');
  for(const ix of guards){
    const program=after.staticAccountKeys[ix.programIdIndex].toBase58();
    if(program!==LIGHTHOUSE_PROGRAM||after.isAccountWritable(ix.programIdIndex)||after.isAccountSigner(ix.programIdIndex)||
      !LIGHTHOUSE_ASSERTIONS.has(ix.data[0])||ix.data.length<3||ix.accountKeyIndexes.length!==1){
      reject(`unsupported added instruction: ${program}, type ${ix.data[0]??'empty'}`);
    }
  }
  const originalCount=before.compiledInstructions.length;
  const actions=after.compiledInstructions.filter(ix=>after.staticAccountKeys[ix.programIdIndex].toBase58()!==LIGHTHOUSE_PROGRAM);
  if(actions.length!==originalCount)reject('added or removed non-assertion instructions');
  for(let i=0;i<originalCount;i++){
    const expected=instructionView(before,before.compiledInstructions[i]),actual=instructionView(after,actions[i]);
    if(JSON.stringify(expected)!==JSON.stringify(actual)){
      const field=expected.program!==actual.program?'program or order':expected.data!==actual.data?'instruction data':'accounts or permissions';
      reject(`reviewed instruction ${i+1}: changed ${field}`);
    }
  }
  return guards.length;
}

export function decodePilotTransaction(prepared,owner,launchProgram,mint) {
  const tx=VersionedTransaction.deserialize(Buffer.from(prepared.transaction,'base64'));
  if(prepared.launchTables){if(!mint||prepared.creatorFeeBps===undefined)throw Error('Unexpected launch table');splitLookupTables(prepared.launchTables);}
  const msg=prepared.launchTables?resolved(tx.message,prepared.launchTables):tx.message;
  if(msg.addressTableLookups.length)throw new Error('Unexpected address lookup table.');
  const signers=msg.staticAccountKeys.slice(0,msg.header.numRequiredSignatures).map(k=>k.toBase58());
  const expected=mint?[owner,mint]:[owner];
  if(msg.staticAccountKeys[0].toBase58()!==owner||signers.length!==expected.length||expected.some(k=>!signers.includes(k)))throw new Error('Unexpected transaction signer.');
  if(msg.recentBlockhash!==prepared.blockhash||prepared.network!=='mainnet-beta'||!prepared.simulationPassed)throw new Error('Unverified pilot transaction.');
  if(!Number.isSafeInteger(prepared.estimatedSolDebitLamports)||prepared.estimatedSolDebitLamports<0||prepared.estimatedSolDebitLamports>100000000)throw new Error('Unexpected transaction cost.');
  let feeInstructions=[];
  if(prepared.creatorFeeBps!==undefined){
    if(!mint)throw Error('Creator fee choice requires a token launch');
    const expectedSplit=registerFeeSplitIx(FUND_PROGRAM,new PublicKey(mint),new PublicKey(owner),prepared.creatorFeeBps,prepared.creatorFeeSharing,prepared.creatorFeeShareWallet);
    const split=msg.compiledInstructions.filter(ix=>msg.staticAccountKeys[ix.programIdIndex].equals(FUND_PROGRAM));
    const ix=split[0];
    if(split.length!==1||!Buffer.from(ix.data).equals(expectedSplit.data)||ix.accountKeyIndexes.length!==expectedSplit.keys.length||expectedSplit.keys.some((k,i)=>!msg.staticAccountKeys[ix.accountKeyIndexes[i]].equals(k.pubkey)||(k.isSigner&&!msg.isAccountSigner(ix.accountKeyIndexes[i]))||(k.isWritable&&!msg.isAccountWritable(ix.accountKeyIndexes[i]))))throw Error('Creator fee instruction differs from launch review');
    const init=msg.compiledInstructions.findIndex(v=>msg.staticAccountKeys[v.programIdIndex].toBase58()===launchProgram);
    if(msg.compiledInstructions.indexOf(ix)>init)throw Error('Creator fee must be fixed before launch');
    feeInstructions=[ix];
  }
  if(prepared.creatorPayoutSetup){
    if(!mint||![1500,5000].includes(prepared.creatorFeeBps)||prepared.developerPurchase)throw Error('Unexpected creator payout setup');
    const recipient=creatorQuoteAccount(new PublicKey(owner)).toBase58();
    const setup=msg.compiledInstructions.filter(ix=>msg.staticAccountKeys[ix.programIdIndex].equals(ASSOCIATED_TOKEN_PROGRAM_ID));
    const ix=setup[0],keys=[owner,recipient,owner,'WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp',SystemProgram.programId.toBase58(),TOKEN_PROGRAM_ID.toBase58()];
    if(setup.length!==1||ix.data.length!==1||ix.data[0]!==1||ix.accountKeyIndexes.length!==6||keys.some((key,i)=>msg.staticAccountKeys[ix.accountKeyIndexes[i]].toBase58()!==key))throw Error('Unexpected creator receiving account');
  }
  const programIds=msg.compiledInstructions.map(ix=>msg.staticAccountKeys[ix.programIdIndex].toBase58());
  const ataProgram=ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
  if(!programIds.includes(launchProgram)||programIds.some(id=>id!==launchProgram&&id!==ComputeBudgetProgram.programId.toBase58()&&!(mint&&(prepared.developerPurchase||prepared.creatorPayoutSetup)&&id===ataProgram)&&!(mint&&prepared.creatorFeeBps!==undefined&&id===FUND_PROGRAM.toBase58())&&!(mint&&prepared.inscriptionFee&&id===SystemProgram.programId.toBase58())))throw new Error('Unexpected program in transaction.');
  if(prepared.inscriptionFee){
    const f=prepared.inscriptionFee,fees=msg.compiledInstructions.filter(ix=>msg.staticAccountKeys[ix.programIdIndex].equals(SystemProgram.programId));
    const ix=fees[0],d=ix&&Buffer.from(ix.data);
    if(!mint||f.recipient!==LAUNCH_TREASURY||f.lamports!==LAUNCH_FEE_LAMPORTS.toString()||fees.length!==1||d.length!==12||d.readUInt32LE(0)!==2||d.readBigUInt64LE(4)!==LAUNCH_FEE_LAMPORTS||ix.accountKeyIndexes.length!==2||msg.staticAccountKeys[ix.accountKeyIndexes[0]].toBase58()!==owner||msg.staticAccountKeys[ix.accountKeyIndexes[1]].toBase58()!==LAUNCH_TREASURY)throw Error('Invalid inscription treasury fee.');
  }
  if(prepared.developerPurchase){
    const reject=()=>{throw new Error('Developer purchase differs from its atomic launch preview.');};
    if(!mint||prepared.developerPurchase.atomic!==true)reject();
    const actions=msg.compiledInstructions.filter(ix=>!feeInstructions.includes(ix)&&msg.staticAccountKeys[ix.programIdIndex].toBase58()!==ComputeBudgetProgram.programId.toBase58()&&msg.staticAccountKeys[ix.programIdIndex].toBase58()!==SystemProgram.programId.toBase58());
    const account=(ix,i)=>msg.staticAccountKeys[ix.accountKeyIndexes[i]]?.toBase58();
    const [init,ata,buy]=actions;
    if(actions.length!==3||!init||!ata||!buy)reject();
    if(msg.staticAccountKeys[init.programIdIndex].toBase58()!==launchProgram||!Buffer.from(init.data.subarray(0,8)).equals(Buffer.from([37,190,126,222,44,154,171,17]))||account(init,0)!==owner||account(init,1)!==owner||account(init,6)!==mint)reject();
    const baseAta=getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(owner),true,TOKEN_2022_PROGRAM_ID).toBase58();
    const quoteMint='WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp';
    const quoteAta=getAssociatedTokenAddressSync(new PublicKey(quoteMint),new PublicKey(owner),true,TOKEN_PROGRAM_ID).toBase58();
    if(msg.staticAccountKeys[ata.programIdIndex].toBase58()!==ataProgram||ata.data.length!==1||ata.data[0]!==1||ata.accountKeyIndexes.length!==6||[owner,baseAta,owner,mint,SystemProgram.programId.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].some((key,i)=>account(ata,i)!==key))reject();
    const data=Buffer.from(buy.data);
    if(msg.staticAccountKeys[buy.programIdIndex].toBase58()!==launchProgram||data.length!==32||!data.subarray(0,8).equals(Buffer.from([250,234,13,123,213,156,19,236]))||data.readBigUInt64LE(8).toString()!==prepared.developerPurchase.inputWxmrRaw||data.readBigUInt64LE(16).toString()!==prepared.developerPurchase.minimumTokensRaw||data.readBigUInt64LE(24)!==0n)reject();
    if(account(buy,0)!==owner||account(buy,5)!==baseAta||account(buy,6)!==quoteAta||account(buy,9)!==mint||account(buy,10)!==quoteMint||account(buy,2)!==account(init,2)||account(buy,3)!==account(init,3)||account(buy,4)!==account(init,5)||account(buy,7)!==account(init,8)||account(buy,8)!==account(init,9))reject();
  }
  return tx;
}

