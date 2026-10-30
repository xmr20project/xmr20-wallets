// wXMR bridge (wxmr.io) client, 29 Oct 2026 (owner: "lets build the wxmr.io bridge thing" — wXMR <-> native XMR in the wallet).
// The bridge is a public Solana program run by the wXMR team; its interface is published on-chain (Anchor IDL account
// GJsDgfPM…, saved in operations/claude-wxmr-bridge-20261029/wxmr-bridge-idl.json). wxmr.io itself only calls this program:
//   XMR -> wXMR: once per Solana wallet `create_deposit_account`; their relayer then writes a reusable Monero deposit address into
//     the deposit record; XMR sent there is minted as wXMR to the wallet after 10 Monero confirmations (fee in wXMR).
//   wXMR -> XMR: `request_withdrawal(nonce, amount, xmr_address, exact_out)` moves the wXMR (amount, fee included) into a withdrawal
//     record; the relayer sends the XMR and marks it Sending, then Completed. A request still Pending after 5 minutes can be
//     cancelled (`cancel_withdrawal`, the fee is kept by the bridge).
// No API key or account with them. The program can be upgraded by its owner, so every action first checks that the deployed
// program is the one this code was written for (programdata slot) and refuses otherwise: nothing is built for an unknown version.
// Instructions are built here from the IDL (Anchor discriminators, Borsh arguments); the wallet adds its own fee instructions.
import {PublicKey,SystemProgram,Transaction,TransactionInstruction} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {Buffer} from 'buffer';

export const WXMR={
 program:new PublicKey('EzBkC8P5wxab9kwrtV5hRdynHAfB5w3UPcPXNgMseVA8'),
 mint:new PublicKey('WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp'),
 programData:new PublicKey('BN6jykVy93Zcc1syZifTPGRWWM49hXRSWxCeFgF6ZHGJ'),
 deployedSlot:460229431,decimals:12,
 // Minimums of the deployed program (wxmr-frontend core/constants.ts, mirroring the program): 0.1 XMR each way.
 minDeposit:100000000000n,minWithdrawal:100000000000n,cancelAfterSeconds:300};
const DISC={createDepositAccount:[25,217,82,207,22,150,122,181],requestWithdrawal:[251,85,121,205,56,201,12,177],
 cancelWithdrawal:[183,104,181,250,28,128,210,70],claimPendingMint:[231,97,226,31,241,172,157,190]};
const ACCOUNT={BridgeConfig:[40,206,51,233,246,40,178,85],DepositRecord:[83,232,10,31,251,49,189,167],FeeOverride:[45,33,41,248,253,236,239,85],
 UserWithdrawalState:[206,93,63,106,34,146,231,230],WithdrawalRecord:[88,59,154,202,216,210,211,237]};
const enc=new TextEncoder(),dec=new TextDecoder();
const seed=s=>enc.encode(s);
const pda=parts=>PublicKey.findProgramAddressSync(parts,WXMR.program)[0];
const u64le=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
export const configPda=()=>pda([seed('config')]);
export const depositPda=owner=>pda([seed('deposit'),new PublicKey(owner).toBuffer()]);
export const withdrawalPda=(owner,nonce)=>pda([seed('withdrawal'),new PublicKey(owner).toBuffer(),u64le(nonce)]);
export const withdrawalStatePda=owner=>pda([seed('withdrawal_state'),new PublicKey(owner).toBuffer()]);
export const feeOverridePda=owner=>pda([seed('fee_override'),new PublicKey(owner).toBuffer()]);
export const feeTreasuryPda=()=>pda([seed('fee_treasury')]);
export const tokenAccount=owner=>getAssociatedTokenAddressSync(WXMR.mint,new PublicKey(owner),true,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID);

// ---- Borsh account readers (layouts from the IDL; the 8-byte Anchor discriminator is checked first)
function reader(data,name){
 const b=Buffer.from(data);if(b.length<8||!ACCOUNT[name].every((v,i)=>b[i]===v))throw Error('Unexpected wXMR bridge account ('+name+').');
 let at=8;const need=n=>{if(at+n>b.length)throw Error('Short wXMR bridge account ('+name+').');};
 return {key(){need(32);const k=new PublicKey(b.subarray(at,at+32));at+=32;return k;},u64(){need(8);const v=b.readBigUInt64LE(at);at+=8;return v;},
  i64(){need(8);const v=b.readBigInt64LE(at);at+=8;return v;},u16(){need(2);const v=b.readUInt16LE(at);at+=2;return v;},u8(){need(1);return b[at++];},
  str(){need(4);const n=b.readUInt32LE(at);at+=4;if(n>256)throw Error('Unexpected wXMR bridge account ('+name+').');need(n);const s=dec.decode(b.subarray(at,at+n));at+=n;return s;},
  rest:()=>b.length-at};
}
export function readConfig(data){const r=reader(data,'BridgeConfig');const c={authority:r.key(),mint:r.key(),totalDeposits:r.u64(),totalWithdrawals:r.u64(),bump:r.u8()};c.feeBps=r.rest()>=2?r.u16():0;return c;}
export function readDeposit(data){const r=reader(data,'DepositRecord');const owner=r.key(),address=r.str(),total=r.u64(),status=['pending','active','closed'][r.u8()]??'unknown';r.u8();return {owner,address,totalDeposited:total,status,createdAt:Number(r.i64())};}
export function readWithdrawal(data){const r=reader(data,'WithdrawalRecord');const w={user:r.key(),nonce:r.u64(),amount:r.u64(),xmrAddress:r.str(),exactOut:r.u8()===1,status:['pending','sending','completed'][r.u8()]??'unknown'};r.u8();w.createdAt=Number(r.i64());w.fee=r.rest()>=8?r.u64():0n;return w;}
export function readWithdrawalState(data){const r=reader(data,'UserWithdrawalState');return {user:r.key(),lastNonce:r.u64()};}
export function readFeeOverride(data){const r=reader(data,'FeeOverride');return {user:r.key(),feeBps:r.u16()};}

// Reads go one account at a time: the website's Solana gateway (/api/wallet) serves getAccountInfo, not getMultipleAccounts.
const one=(connection,key,slice)=>connection.getAccountInfo(key,slice?{commitment:'confirmed',dataSlice:slice}:'confirmed');
// The deployed program must be the version this code was written for.
export async function checkProgram(connection){
 const [prog,data]=await Promise.all([one(connection,WXMR.program,{offset:0,length:36}),one(connection,WXMR.programData,{offset:0,length:12})]);
 if(!prog||prog.data.length<36||!new PublicKey(prog.data.subarray(4,36)).equals(WXMR.programData))throw Error('The wXMR bridge program could not be checked. Nothing was sent.');
 if(!data||data.data.length<12||Number(data.data.readBigUInt64LE(4))!==WXMR.deployedSlot)throw Error('The wXMR bridge was updated by its operators. This wallet needs an update before it can use the new version; nothing was sent.');
}
// Everything the bridge screens show for one Solana wallet, in one read.
export async function readBridge(connection,owner){
 const o=new PublicKey(owner),dep=depositPda(o);
 const keys=[configPda(),dep,tokenAccount(o),tokenAccount(dep),feeOverridePda(o),withdrawalStatePda(o)];
 const [cfg,deposit,mine,pending,override,state]=await Promise.all(keys.map(k=>one(connection,k)));
 if(!cfg)throw Error('The wXMR bridge is not available right now.');
 const config=readConfig(cfg.data);if(!config.mint.equals(WXMR.mint))throw Error('Unexpected wXMR mint in the bridge configuration.');
 const amountOf=a=>a&&a.data.length>=72?Buffer.from(a.data).readBigUInt64LE(64):0n;
 let feeBps=config.feeBps;if(override){const f=readFeeOverride(override.data);if(f.user.equals(o))feeBps=f.feeBps;}
 return {config,feeBps,deposit:deposit?readDeposit(deposit.data):null,balance:amountOf(mine),tokenAccountExists:Boolean(mine),pendingMint:amountOf(pending),
  lastNonce:state?readWithdrawalState(state.data).lastNonce:0n};
}
export const feeOf=(amount,bps)=>BigInt(amount)*BigInt(bps)/10000n;

// ---- Transactions (unsigned; the connected wallet signs; the site's sign-and-submit checks what it signed)
// A legacy transaction, as the site's sign-and-submit (wallet-sol-send.js) expects and every wallet signs.
async function v0(connection,payer,instructions){const {blockhash,lastValidBlockHeight}=await connection.getLatestBlockhash('confirmed');
 const tx=new Transaction({feePayer:new PublicKey(payer),blockhash,lastValidBlockHeight}).add(...instructions);return {tx,blockhash,lastValidBlockHeight};}
const meta=(pubkey,isWritable,isSigner=false)=>({pubkey,isWritable,isSigner});
// Once per Solana wallet: the wXMR token account (if missing) and the deposit record the relayer fills with a Monero address.
export async function buildCreateDeposit(connection,owner){
 const o=new PublicKey(owner);
 return v0(connection,o,[createAssociatedTokenAccountIdempotentInstruction(o,tokenAccount(o),o,WXMR.mint,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID),
  new TransactionInstruction({programId:WXMR.program,data:Buffer.from(DISC.createDepositAccount),keys:[meta(configPda(),false),meta(depositPda(o),true),meta(o,true,true),meta(SystemProgram.programId,false)]})]);
}
// Moves `amount` atomic wXMR (fee included; exact_out false) into a new withdrawal record for `xmrAddress`.
export async function buildWithdrawal(connection,owner,{amount,xmrAddress,lastNonce}){
 const o=new PublicKey(owner),n=BigInt(Date.now())>lastNonce+1n?BigInt(Date.now()):lastNonce+1n,address=enc.encode(xmrAddress);
 if(address.length<90||address.length>110)throw Error('Enter a valid Monero address.');
 const len=Buffer.alloc(4);len.writeUInt32LE(address.length);
 const data=Buffer.concat([Buffer.from(DISC.requestWithdrawal),u64le(n),u64le(amount),len,Buffer.from(address),Buffer.from([0])]);
 const keys=[meta(configPda(),false),meta(withdrawalPda(o,n),true),meta(WXMR.mint,true),meta(tokenAccount(o),true),meta(feeTreasuryPda(),true),meta(feeOverridePda(o),false),
  meta(o,true,true),meta(TOKEN_PROGRAM_ID,false),meta(SystemProgram.programId,false),meta(withdrawalStatePda(o),true)];
 return {...await v0(connection,o,[new TransactionInstruction({programId:WXMR.program,data,keys})]),nonce:n,withdrawal:withdrawalPda(o,n)};
}
export async function buildCancelWithdrawal(connection,owner,{withdrawal,authority}){
 const o=new PublicKey(owner);
 return v0(connection,o,[new TransactionInstruction({programId:WXMR.program,data:Buffer.from(DISC.cancelWithdrawal),keys:[meta(configPda(),false),meta(new PublicKey(withdrawal),true),
  meta(WXMR.mint,true),meta(tokenAccount(o),true),meta(o,true,true),meta(new PublicKey(authority),true),meta(withdrawalStatePda(o),true),
  meta(TOKEN_PROGRAM_ID,false),meta(ASSOCIATED_TOKEN_PROGRAM_ID,false),meta(SystemProgram.programId,false)]})]);
}
// wXMR minted while the wallet had no token account waits in the deposit record's own account until claimed.
export async function buildClaimPending(connection,owner,{authority}){
 const o=new PublicKey(owner),dep=depositPda(o);
 return v0(connection,o,[new TransactionInstruction({programId:WXMR.program,data:Buffer.from(DISC.claimPendingMint),keys:[meta(configPda(),false),meta(dep,false),meta(o,true,true),
  meta(tokenAccount(dep),true),meta(tokenAccount(o),true),meta(WXMR.mint,false),meta(new PublicKey(authority),true),
  meta(TOKEN_PROGRAM_ID,false),meta(ASSOCIATED_TOKEN_PROGRAM_ID,false),meta(SystemProgram.programId,false)]})]);
}
export async function readWithdrawalAt(connection,address){const a=await connection.getAccountInfo(new PublicKey(address),'confirmed');return a?readWithdrawal(a.data):null;}
