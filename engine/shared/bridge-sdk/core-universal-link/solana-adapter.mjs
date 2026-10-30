import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {unpackMint,getExtensionTypes,TOKEN_2022_PROGRAM_ID as TOKEN} from '@solana/spl-token';
import {addresses,decodePosition} from '../core-transferable/sdk.mjs';
import bs58 from 'bs58';
import {canonical,digest} from './records.mjs';
import {identityAddresses,registerIdentity,decodeIdentity,activateAsset} from './sdk.mjs';
import {MAINNET_GENESIS} from '../core-next/deployment-policy.mjs';
import {WALLET_TEST_POLICY} from '../core-transferable/private-test.mjs';
import {BINARY_HASH,BINARY_SIZE,CAPABILITY} from './deployment-policy.mjs';
import {BINARY_HASH as OPERATOR_HASH,BINARY_SIZE as OPERATOR_SIZE,CUSTODY_CAPABILITY} from '../core-monero-send/deployment-policy.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const PROGRAM_DATA_HEADER=45,verifiedDeployments=new Map();
export function createIdentitySolanaAdapter({connection,manifest,privateTestPolicy}){
 const operator=manifest?.custodyCapability===CUSTODY_CAPABILITY;
 need(manifest?.custodyCapability===undefined||operator,'Reviewed operator custody capability required.');
 const binaryHash=operator?OPERATOR_HASH:BINARY_HASH,binarySize=operator?OPERATOR_SIZE:BINARY_SIZE;
 need(manifest?.network==='mainnet-beta'&&manifest.genesisHash===MAINNET_GENESIS&&manifest.capability===CAPABILITY
  &&manifest.binaryHash===binaryHash&&manifest.binarySize===binarySize,'Exact reviewed identity deployment required.');
 const pinned=canonical(manifest),program=new PublicKey(manifest.program),verifier=new PublicKey(manifest.verifier);
 need(PublicKey.isOnCurve(verifier.toBytes()),'Identity verifier signing key required.');
 const testPolicy=privateTestPolicy??null;
 if(testPolicy)need(canonical(testPolicy)===canonical(WALLET_TEST_POLICY)&&manifest.program===testPolicy.program,'Exact retained upgrade authority policy required.');
 const dataKey=PublicKey.findProgramAddressSync([program.toBuffer()],LOADER)[0];
 const checkedConfig=c=>{need(c.network===manifest.network&&c.program===manifest.program&&c.verifier===manifest.verifier,'Wrong identity registry.');identityAddresses(c);};
 // Verified program-data headers by RPC endpoint, manifest and policy. The
 // upgradeable loader stores the deployment slot in this 45-byte header and
 // refuses a second deployment in the same slot, so an unchanged header after a
 // full code hash means unchanged bytes. Any difference re-reads and re-hashes
 // the whole account. Network, program, authority and header checks still run
 // on every call; nothing here caches readiness, balances or fees.
 const registryKey=typeof connection.rpcEndpoint==='string'?connection.rpcEndpoint+'|'+pinned+'|'+canonical(testPolicy??null):null;
 let verifying=null;
 async function verifyProgram(){
  need(canonical(manifest)===pinned,'Changed deployment or Solana network.');
  // Concurrent callers on this adapter share one fresh verification.
  if(!verifying){verifying=verifyDeployment(registryKey?verifiedDeployments.get(registryKey)??null:null).finally(()=>{verifying=null;});}
  return verifying;
 }
 async function verifyDeployment(known){
  const [genesis,p,d]=await Promise.all([connection.getGenesisHash(),connection.getAccountInfo(program,'finalized'),known?connection.getAccountInfo(dataKey,{commitment:'finalized',dataSlice:{offset:0,length:PROGRAM_DATA_HEADER}}):connection.getAccountInfo(dataKey,'finalized')]);
  need(genesis===MAINNET_GENESIS&&canonical(manifest)===pinned,'Changed deployment or Solana network.');
  need(p?.executable&&p.owner.equals(LOADER)&&p.data.length===36&&p.data.readUInt32LE(0)===2,'Transferable program is not deployed.');
  need(new PublicKey(p.data.subarray(4)).equals(dataKey),'Changed program-data address.');
  need(d?.owner.equals(LOADER)&&!d.executable&&d.data.length>=PROGRAM_DATA_HEADER&&d.data.readUInt32LE(0)===3,'Reviewed transferable program-data required.');
  if(testPolicy)need(d.data[12]===1&&new PublicKey(d.data.subarray(13,PROGRAM_DATA_HEADER)).toBase58()===testPolicy.upgradeAuthority,'Private test requires the exact retained upgrade authority.');
  else need(d.data[12]===0,'Transferable program must be immutable.');
  const header=d.data.subarray(0,PROGRAM_DATA_HEADER).toString('hex');
  if(!known||d.data.length>PROGRAM_DATA_HEADER){
   // Full bytes in hand: always hash them, whether or not a header was known.
   need(d.data.length>=PROGRAM_DATA_HEADER+binarySize,'Reviewed transferable program-data required.');
   need(digest(d.data.subarray(PROGRAM_DATA_HEADER,PROGRAM_DATA_HEADER+binarySize))===binaryHash&&d.data.subarray(PROGRAM_DATA_HEADER+binarySize).every(x=>x===0),'Transferable deployed code differs from review.');
   if(registryKey)verifiedDeployments.set(registryKey,{header});
   return;
  }
  if(header===known.header)return;
  // A new deployment slot or authority means different bytes: hash them again.
  verifiedDeployments.delete(registryKey);
  return verifyDeployment(null);
 }

 async function readAccount(key){const a=await connection.getAccountInfo(new PublicKey(key),'finalized');return a?{owner:a.owner.toBase58(),executable:a.executable,finalized:true,data:Uint8Array.from(a.data)}:null;}
 function signed(config,proposal,tx){
  checkedConfig(config);const expected=registerIdentity(config,proposal),msg=tx.message.serialize();
  need(Buffer.from(msg).equals(Buffer.from(expected.message.serialize()))&&tx.signatures.length===2&&tx.message.header.numRequiredSignatures===2
   &&tx.message.staticAccountKeys.slice(0,2).every((key,i)=>ed25519.verify(tx.signatures[i],msg,key.toBytes())),'Exact owner and verifier identity signatures required.');
  return bs58.encode(tx.signatures[0]);
 }
 async function custody(config,proposal){
  const a=identityAddresses(config),rows=await Promise.all([a.identity,a.reverse].map(k=>readAccount(k.toBase58())));
  for(const row of rows){need(row?.finalized&&row.owner===manifest.program&&!row.executable,'Finalized identity missing.');const v=decodeIdentity(row.data);
   need(v.owner===config.owner&&v.verifier===config.verifier&&v.binding===config.binding&&v.commitment===proposal.commitment,'Finalized identity differs from approval.');}
 }
 async function mintPolicy(mint){
  const key=new PublicKey(mint),raw=await connection.getAccountInfo(key,'finalized');need(raw?.owner.equals(TOKEN),'Token-2022 asset required.');const value=unpackMint(key,raw,TOKEN);
  need(value.decimals===6&&!value.mintAuthority&&!value.freezeAuthority&&value.supply>0n&&value.supply<=1000000000000000n&&getExtensionTypes(value.tlvData).every(v=>[1,18,19].includes(v)),'Unsupported asset policy.');
 }
 function signedActivation(config,proposal,tx){
  checkedConfig(config);need(proposal.payer!==config.verifier,'A distinct explicit activation payer is required.');
  const msg=tx.message.serialize(),expected=activateAsset(config,proposal);
  need(Buffer.from(msg).equals(Buffer.from(expected.message.serialize()))&&tx.signatures.length===2&&tx.message.header.numRequiredSignatures===2&&tx.message.staticAccountKeys.slice(0,2).every((key,i)=>ed25519.verify(tx.signatures[i],msg,key.toBytes())),'Exact payer and verifier activation signatures required.');
  return bs58.encode(tx.signatures[0]);
 }
 async function activated(config){
  const a=addresses(config),[raw,link]=await Promise.all([readAccount(a.position.toBase58()),readAccount(a.link.toBase58())]);
  need(raw?.owner===config.program&&!raw.executable&&link?.owner===config.program&&!link.executable,'Finalized asset activation missing.');
  const p=decodePosition(raw.data),b=Buffer.from(link.data);
  need(p.owner===config.owner&&p.verifier===config.verifier&&p.mint===config.mint&&p.binding===config.binding
   &&b.length===129&&b[0]===3&&b.subarray(1,33).toString('hex')===p.binding&&new PublicKey(b.subarray(33,65)).toBase58()===p.owner&&new PublicKey(b.subarray(65,97)).equals(a.position)&&b.subarray(97,129).toString('hex')===p.linkProof,'Asset activation differs from the linked identity.');
  return p;
 }
 async function pendingOutcome({bytes,lastValidBlockHeight}){
  await verifyProgram();need(Number.isSafeInteger(lastValidBlockHeight)&&lastValidBlockHeight>0,'Saved identity expiry required.');
  const tx=VersionedTransaction.deserialize(bytes),msg=tx.message.serialize(),keys=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures);
  need(keys.length===2&&tx.signatures.length===2&&keys.every((key,i)=>ed25519.verify(tx.signatures[i],msg,key.toBytes())),'Saved identity signatures changed.');
  const signature=bs58.encode(tx.signatures[0]);
  const status=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
  if(status)return {kind:status.confirmationStatus==='finalized'?(status.err?'failed':'finalized'):'pending',signature};
  if(await connection.getBlockHeight('finalized')<=lastValidBlockHeight)return {kind:'pending',signature};
  const txRecord=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
  if(txRecord)return {kind:txRecord.meta?.err?'failed':'finalized',signature};
  if((await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0])return {kind:'pending',signature};
  need((await connection.isBlockhashValid(tx.message.recentBlockhash,{commitment:'finalized'})).value===false,'Identity expiry evidence disagrees.');
  return {kind:'expired',signature};
 }
 return Object.freeze({verifyProgram,readAccount,pendingOutcome,
  async prepareActivation(config,{payer,identityCommitment}){
   checkedConfig(config);need(PublicKey.isOnCurve(new PublicKey(payer).toBytes())&&payer!==config.verifier,'Explicit activation payer required.');await verifyProgram();await mintPolicy(config.mint);await custody(config,{commitment:identityCommitment});
   const a=addresses(config),specs=[[a.position,169],[a.link,129],[a.pool,105],[a.vault,300],[a.ata,300]];
   // Conservative ATA rent estimate for the admitted extensions. The exact
   // transaction only runs idempotent ATA creation and zero-balance activation.
   const costs=await Promise.all(specs.map(async([key,size])=>await readAccount(key.toBase58())?0:await connection.getMinimumBalanceForRentExemption(size,'confirmed')));
   need(costs.every(n=>Number.isSafeInteger(n)&&n>=0),'Bounded account rent estimate required.');const rentLamports=costs.reduce((a,b)=>a+b,0);need(rentLamports<=30000000,'Activation account costs exceed the reviewed limit.');
   const latest=await connection.getLatestBlockhash('confirmed'),proposal={payer,identityCommitment,rentLamports,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight};
   return {config,proposal,transaction:activateAsset(config,proposal)};
  },
  async submitActivation(config,proposal,tx){await verifyProgram();signedActivation(config,proposal,tx);await mintPolicy(config.mint);await custody(config,{commitment:proposal.identityCommitment});return connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:2});},
  async finalizedActivation({config,proposal,bytes}){
   await verifyProgram();const tx=VersionedTransaction.deserialize(bytes),signature=signedActivation(config,proposal,tx),result=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!result)return null;
   need(result.meta?.err===null&&result.transaction.signatures[0]===signature&&Buffer.from(result.transaction.message.serialize()).equals(Buffer.from(tx.message.serialize())),'Activation did not finalize with the exact approval.');
   await custody(config,{commitment:proposal.identityCommitment});await activated(config);return {signature,confirmed:true};
  },
  async identityReviewFresh(config,proposal){
   checkedConfig(config);await verifyProgram();
   need(Number.isSafeInteger(proposal.lastValidBlockHeight)&&proposal.lastValidBlockHeight>0,'Reviewed identity expiry required.');
   const [height,valid]=await Promise.all([connection.getBlockHeight('confirmed'),connection.isBlockhashValid(proposal.blockhash,{commitment:'confirmed'})]);
   need(Number.isSafeInteger(height)&&height>=0&&typeof valid?.value==='boolean','Identity freshness unavailable.');
   return valid.value&&proposal.lastValidBlockHeight-height>=50;
  },
  async prepareIdentity(config,{commitment}){
   checkedConfig(config);await verifyProgram();const a=identityAddresses(config);
   const existing=await Promise.all([a.identity,a.reverse].map(k=>readAccount(k.toBase58())));
   need(existing.every(v=>v===null),'An identity account already exists. Recover its original approval.');
   const latest=await connection.getLatestBlockhash('confirmed'),proposal={commitment,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight};
   return {config,proposal,transaction:registerIdentity(config,proposal)};
  },
  async submitIdentity(config,proposal,tx){await verifyProgram();signed(config,proposal,tx);return connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:2});},
  async finalizedIdentity({config,proposal,bytes}){
   await verifyProgram();const tx=VersionedTransaction.deserialize(bytes),signature=signed(config,proposal,tx);
   const result=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!result)return null;
   need(result.meta?.err===null&&result.transaction.signatures[0]===signature&&Buffer.from(result.transaction.message.serialize()).equals(Buffer.from(tx.message.serialize())),'Identity did not finalize with the exact approval.');
   await custody(config,proposal);return {signature,confirmed:true};
  }
 });
}
