// An identity proof is not a token position. Independently verify BOTH layers.
import {PublicKey} from '@solana/web3.js';
import {addresses,decodePosition} from '../core-transferable/sdk.mjs';
import {verifyIdentityCustody} from './identity-proof.mjs';
import {digest} from './records.mjs';
export async function verifyIdentityAsset({config,moneroAddress,envelope,chain,signatureVerifier}){
 if(envelope?.record?.owner!==moneroAddress||config.binding!==digest(moneroAddress))throw Error('Recipient identity differs from the selected address.');
 const proof=await verifyIdentityCustody({config,envelope,chain,signatureVerifier}),a=addresses(config);
 const [position,link]=await Promise.all([a.position,a.link].map(k=>chain.readAccount(k.toBase58())));
 if(![position,link].every(r=>r?.finalized===true&&r.owner===config.program&&r.executable===false))throw Error('Finalized recipient asset activation required.');
 const p=decodePosition(position.data),b=Buffer.from(link.data);
 if(p.owner!==config.owner||p.verifier!==config.verifier||p.mint!==config.mint||p.binding!==config.binding||p.linkProof!==proof.commitment
  ||b.length!==129||b[0]!==3||b.subarray(1,33).toString('hex')!==p.binding||new PublicKey(b.subarray(33,65)).toBase58()!==p.owner||!new PublicKey(b.subarray(65,97)).equals(a.position)||b.subarray(97,129).toString('hex')!==proof.commitment)throw Error('Recipient asset differs from the confirmed identity.');
 return {identity:proof.identity,position:a.position.toBase58(),commitment:proof.commitment};
}
