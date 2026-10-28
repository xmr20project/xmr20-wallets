import {PublicKey} from '@solana/web3.js';
import {addresses,decodePosition} from './sdk.mjs';
import {digest,message,commitment,payload} from './records.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
// Browser/extension may obtain the public envelope from the service, but reads
// its custody independently and verifies the native signature locally.
export async function verifyLinkProof({config,moneroAddress,envelope,chain,signatureVerifier}){
 payload(envelope);const r=envelope.record,a=addresses(config);need(r.op==='link'&&r.owner===moneroAddress&&r.to===config.owner&&r.program===config.program&&r.mint===config.mint&&config.binding===digest(moneroAddress),'Recipient link differs from the typed wallet.');
 need(await signatureVerifier.verify(message(r),r.owner,envelope.signature),'Recipient’s native ownership signature is invalid.');await chain.verifyProgram();
 const [raw,link]=await Promise.all([chain.readAccount(a.position.toBase58()),chain.readAccount(a.link.toBase58())]);need(raw?.finalized===true&&link?.finalized===true&&raw.owner===config.program&&link.owner===config.program&&!raw.executable&&!link.executable,'Independently finalized recipient link required.');
 const p=decodePosition(raw.data),b=Buffer.from(link.data);need(p.owner===config.owner&&p.verifier===config.verifier&&p.mint===config.mint&&p.binding===config.binding&&p.linkProof===commitment(envelope)&&b.length===129&&b[0]===3&&b.subarray(1,33).toString('hex')===config.binding&&new PublicKey(b.subarray(33,65)).toBase58()===config.owner&&new PublicKey(b.subarray(65,97)).equals(a.position)&&b.subarray(97,129).toString('hex')===p.linkProof,'Recipient custody differs from the native ownership proof.');
 return true;
}
