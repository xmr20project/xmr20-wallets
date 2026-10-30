import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {unpackMint,getTransferFeeConfig,getExtensionTypes,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {ed25519} from '@noble/curves/ed25519';
import {digest,moneroOwner} from './records.mjs';
import {transaction,addresses,reviewedBridgeInstruction} from './sdk.mjs';
import {deploymentMint} from './mint-policy.mjs';
import {MAINNET_GENESIS} from './deployment-policy.mjs';
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const need=(v,m)=>{if(!v)throw Error(m);};
export function createSolanaAdapter({connection,manifest}){
 need(manifest?.network==='mainnet-beta'&&/^[a-f0-9]{64}$/.test(manifest.binaryHash)&&Number.isSafeInteger(manifest.binarySize)&&manifest.binarySize>0&&manifest.genesisHash===MAINNET_GENESIS,'Pinned reviewed mainnet deployment manifest required.');
 const mint=deploymentMint(manifest),pinned=JSON.stringify(manifest),program=new PublicKey(manifest.program),verifier=new PublicKey(manifest.verifier);
 async function verifyProgram(){
  need(JSON.stringify(manifest)===pinned,'Deployment manifest changed.');need(await connection.getGenesisHash()===manifest.genesisHash,'Wrong Solana network.');
  const p=await connection.getAccountInfo(program,'finalized');need(p?.executable&&p.owner.equals(LOADER)&&p.data.length===36&&p.data.readUInt32LE(0)===2,'Joint escrow program is not deployed.');
  const pd=new PublicKey(p.data.subarray(4,36)),expected=PublicKey.findProgramAddressSync([program.toBuffer()],LOADER)[0];need(pd.equals(expected),'Program data account changed.');
  const d=await connection.getAccountInfo(pd,'finalized');need(d?.owner.equals(LOADER)&&d.data.readUInt32LE(0)===3&&d.data[12]===0&&d.data.length>=45+manifest.binarySize,'Program upgrade authority must be revoked.');
  need(digest(d.data.subarray(45,45+manifest.binarySize))===manifest.binaryHash&&d.data.subarray(45+manifest.binarySize).every(x=>x===0),'Deployed binary differs from the reviewed program.');
 }
 async function fee(amount){
  await verifyProgram();const key=new PublicKey(mint),a=await connection.getAccountInfo(key,'finalized');need(a&&a.owner.equals(TOKEN_2022_PROGRAM_ID),'Wrong token program.');const m=unpackMint(key,a,TOKEN_2022_PROGRAM_ID);
  need(m.decimals===6&&!m.mintAuthority&&!m.freezeAuthority&&m.supply>0n&&m.supply<=1000000000000000n&&getExtensionTypes(m.tlvData).every(e=>[1,18,19].includes(e)),'Unsupported mint authorities or extensions.');
  const f=getTransferFeeConfig(m);if(!f){need(manifest.profile==='multi-token','Transfer fee config missing.');need(BigInt(amount)>0n,'Invalid amount.');return '0';}const epoch=(await connection.getEpochInfo('finalized')).epoch,current=BigInt(epoch)>=f.newerTransferFee.epoch?f.newerTransferFee:f.olderTransferFee;
  const n=BigInt(amount),rounded=(n*BigInt(current.transferFeeBasisPoints)+9999n)/10000n,expectedFee=(rounded<current.maximumFee?rounded:current.maximumFee).toString();need(n>BigInt(expectedFee),'The transfer fee consumes the amount.');return expectedFee;
 }
 return {verifyProgram,async prepareDeposit({owner,moneroAddress,id,amount}){
  // Only the unsigned transaction lifetime uses confirmed commitment. Backing,
  // deployment, token rules and completed transfers still require finalization.
  moneroOwner(moneroAddress);const expectedFee=await fee(amount),config={abi:2,network:manifest.network,program:program.toBase58(),verifier:verifier.toBase58(),mint:mint,owner,id,binding:digest(moneroAddress)},latest=await connection.getLatestBlockhash('confirmed'),proposal={network:config.network,operation:'deposit',amount,expectedFee,nonce:id,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight};return {config,proposal,transaction:transaction(config,proposal)};
 },async finalizedDeposit(signature){
  await verifyProgram();const r=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!r||r.meta?.err!==null||r.transaction.signatures[0]!==signature)return null;const msg=r.transaction.message,ix=reviewedBridgeInstruction(msg,'deposit');if(!ix)return null;
  const d=Buffer.from(ix.data);if(!msg.staticAccountKeys[ix.programIdIndex]?.equals(program)||d.length!==113||d[0]!==2)return null;
  const owner=msg.staticAccountKeys[0].toBase58(),config={abi:2,network:manifest.network,program:program.toBase58(),verifier:new PublicKey(d.subarray(73,105)).toBase58(),mint:mint,owner,id:d.subarray(9,41).toString('hex'),binding:d.subarray(41,73).toString('hex')};if(config.verifier!==verifier.toBase58())return null;const proposal={network:config.network,operation:'deposit',amount:d.readBigUInt64LE(1).toString(),expectedFee:d.readBigUInt64LE(105).toString(),nonce:config.id,blockhash:msg.recentBlockhash};
  if(!Buffer.from(transaction(config,proposal).message.serialize()).equals(Buffer.from(msg.serialize())))return null;
  const bs58=(await import('bs58')).default;need(ed25519.verify(bs58.decode(signature),msg.serialize(),new PublicKey(owner).toBytes()),'Invalid depositor signature.');
  const a=addresses(config),position=await connection.getAccountInfo(a.position,'finalized');need(position?.owner.equals(program)&&position.data.length===202&&position.data[0]===2&&position.data.subarray(1,33).equals(a.owner.toBuffer())&&position.data.subarray(33,65).equals(verifier.toBuffer())&&position.data.subarray(65,97).equals(a.mint.toBuffer())&&position.data.subarray(97,129).equals(a.vault.toBuffer())&&position.data.subarray(129,161).toString('hex')===config.binding&&position.data.subarray(161,193).toString('hex')===config.id,'Finalized position differs from the deposit.');
  return {signature,config,net:(BigInt(proposal.amount)-BigInt(proposal.expectedFee)).toString(),locked:position.data.readBigUInt64LE(193).toString()};
 },async prepareRelease({config,amount,burnTxid}){
  need(config.program===manifest.program&&config.verifier===manifest.verifier&&config.network===manifest.network&&config.mint===mint,'Wrong return deployment.');const expectedFee=await fee(amount),latest=await connection.getLatestBlockhash('confirmed'),proposal={network:config.network,operation:'release',amount,expectedFee,nonce:burnTxid,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight};return {config,proposal,transaction:transaction(config,proposal)};
 },async submit(c,p,signed){
  await verifyProgram();need(c.program===manifest.program&&c.verifier===manifest.verifier&&c.network===manifest.network&&c.mint===mint,'Wrong deployment.');const expected=transaction(c,p);need(Buffer.from(signed.message.serialize()).equals(Buffer.from(expected.message.serialize())),'Changed transaction.');const keys=signed.message.staticAccountKeys.slice(0,signed.message.header.numRequiredSignatures);need(keys.length===(p.operation==='deposit'?1:2)&&keys.every((k,i)=>ed25519.verify(signed.signatures[i],signed.message.serialize(),k.toBytes())),'Every required signature must be valid.');return connection.sendRawTransaction(signed.serialize(),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:2});
 },async pendingOutcome({bytes,lastValidBlockHeight}){
  await verifyProgram();need(Number.isSafeInteger(lastValidBlockHeight)&&lastValidBlockHeight>0,'Saved transaction expiry height required.');
  const tx=VersionedTransaction.deserialize(bytes),bs58=(await import('bs58')).default,signature=bs58.encode(tx.signatures[0]),message=tx.message.serialize();
  need(tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).every((k,i)=>ed25519.verify(tx.signatures[i],message,k.toBytes())),'Saved transaction signatures changed.');
  const status=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
  if(status?.confirmationStatus==='finalized')return {kind:status.err?'failed':'finalized',signature};
  if(status)return {kind:'pending',signature};
  const height=await connection.getBlockHeight('finalized');if(height<=lastValidBlockHeight)return {kind:'pending',signature};
  const landed=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(landed)return {kind:landed.meta?.err?'failed':'finalized',signature};
  const second=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
  if(second)return {kind:'pending',signature};
  need((await connection.isBlockhashValid(tx.message.recentBlockhash,{commitment:'finalized'})).value===false,'RPC expiry evidence disagrees.');return {kind:'expired',signature};
 },async finalizedRelease({position,burnTxid,amount,bytes}){
  await verifyProgram();const tx=VersionedTransaction.deserialize(bytes),msg=tx.message,bs58=(await import('bs58')).default,signature=bs58.encode(tx.signatures[0]);
  const ix=reviewedBridgeInstruction(msg,'release');need(ix,'Changed saved return.');const data=Buffer.from(ix.data),keys=msg.staticAccountKeys;
  need(keys[ix.programIdIndex].equals(program)&&data.length===49&&data[0]===3&&data.readBigUInt64LE(1).toString()===amount&&data.subarray(9,41).toString('hex')===burnTxid&&keys[ix.accountKeyIndexes[1]].toBase58()===position&&keys[ix.accountKeyIndexes[7]].equals(verifier)&&keys[ix.accountKeyIndexes[2]].equals(new PublicKey(mint)),'Changed saved return binding.');
  need(keys.slice(0,2).every((k,i)=>ed25519.verify(tx.signatures[i],msg.serialize(),k.toBytes())),'Changed saved signatures.');const r=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!r)return null;need(r.meta?.err===null&&Buffer.from(r.transaction.message.serialize()).equals(Buffer.from(msg.serialize()))&&r.transaction.signatures[0]===signature,'Return did not finalize successfully.');
  const receiptKey=PublicKey.findProgramAddressSync([Buffer.from('redemption-v2'),new PublicKey(position).toBuffer(),Buffer.from(burnTxid,'hex')],program)[0],a=await connection.getAccountInfo(receiptKey,'finalized');
  need(a?.owner.equals(program)&&a.data.length===89&&a.data[0]===2&&a.data.subarray(1,33).equals(new PublicKey(position).toBuffer())&&a.data.subarray(33,65).toString('hex')===burnTxid&&a.data.readBigUInt64LE(65).toString()===amount&&a.data.readBigUInt64LE(81)===data.readBigUInt64LE(41)&&a.data.readBigUInt64LE(73)===BigInt(amount)-data.readBigUInt64LE(41),'Finalized receipt differs from the signed return.');return {signature};
 }};
}
