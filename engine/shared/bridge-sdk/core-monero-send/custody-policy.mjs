// Public immutable custody identity. No wallet account, provider or RPC needed.
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {sha256} from '@noble/hashes/sha256';
const need=(yes,message)=>{if(!yes)throw Error(message);};
export function custodyPolicyIdentity(config,{manifest,signers,mode='quorum-draft-v1'}) {
  need(['quorum-draft-v1','operator-verified-v1'].includes(mode),'Unknown custody policy.');
  need(typeof manifest==='string'&&/^[a-f0-9]{64}$/.test(manifest)&&!/^0+$/.test(manifest),'Nonzero manifest required.');
  const operator=mode==='operator-verified-v1';
  need(Array.isArray(signers)&&(operator?signers.length===1:[2,3].includes(signers.length)),'Wrong number of configured custody signers.');
  const program=new PublicKey(config.program),mint=new PublicKey(config.mint),verifier=new PublicKey(config.verifier);
  const keys=signers.map(k=>new PublicKey(k)).sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));
  need(keys.every((k,i)=>PublicKey.isOnCurve(k.toBuffer())&&(i===0||!k.equals(keys[i-1]))),'Distinct bridge signing keys required.');
  need(!operator||keys[0].equals(verifier),'Operator policy must use the configured verifier.');
  const packed=Buffer.alloc(96);keys.forEach((k,i)=>k.toBuffer().copy(packed,32*i));
  const id=Buffer.from(sha256(Buffer.concat([Buffer.from(operator?'XMR20-MONERO-OPERATOR-POLICY-V1\n':'XMR20-MONERO-POLICY-DRAFT-V1\n'),Buffer.from(manifest,'hex'),Buffer.from([keys.length]),packed]))).toString('hex');
  const policy=PublicKey.findProgramAddressSync([Buffer.from(operator?'monero-operator-v1':'monero-account-v1'),mint.toBuffer(),verifier.toBuffer(),Buffer.from(id,'hex')],program)[0];
  return {program,mint,verifier,policy,id,manifest,signers:keys,packed,mode,requiredSignatures:operator?1:2};
}
