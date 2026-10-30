// Browser checks bind the displayed reader report to the exact owner approval.
// The report is still the service's attestation, not independent chain proof.
import {sha256} from '@noble/hashes/sha256';
import {checkMoneroAddress} from '../address.js';
import {addresses} from './sdk.mjs';
const hashId=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)&&!/^0+$/.test(v);
export const bindingFor=address=>Buffer.from(sha256(new TextEncoder().encode(address))).toString('hex');
export function publicOwner(address){if(checkMoneroAddress(address,'mainnet').kind!=='standard')throw Error('Use a standard public Monero address. Never enter a seed or private key.');return address;}
export const ownerMode=p=>p.recordOwnerMode||(p.evidenceSource==='fixture-only'?'none':p.testOwner?'service-test-owner':'external-public-owner');
export function validatePolicy(p){
 if(!p||!['fixture-only','mocked-monero','public-monero-rpc'].includes(p.evidenceSource)||typeof p.persistent!=='boolean'||(p.redemptionPolicy==='fixture-only'?p.evidenceSource!=='fixture-only':!hashId(p.redemptionPolicy)||p.evidenceSource==='fixture-only')||p.testOwner&&(p.evidenceSource!=='mocked-monero'||publicOwner(p.testOwner)!==p.testOwner))throw Error('Unrecognized local proof policy. Keep the saved wallet and check the service.');
 const recordOwnerMode=ownerMode(p);
 if(!['none','service-test-owner','external-public-owner','browser-test-owner','browser-saved-test-owner'].includes(recordOwnerMode)||recordOwnerMode==='browser-test-owner'&&(p.evidenceSource!=='mocked-monero'||p.persistent||p.testOwner)||recordOwnerMode==='browser-saved-test-owner'&&(p.evidenceSource!=='mocked-monero'||!p.persistent||p.testOwner)||recordOwnerMode==='service-test-owner'&&!p.testOwner||recordOwnerMode==='none'&&p.evidenceSource!=='fixture-only')throw Error('Unrecognized record owner mode. Do not approve.');
 return {redemptionPolicy:p.redemptionPolicy,evidenceSource:p.evidenceSource,persistent:p.persistent,testOwner:p.testOwner||null,recordOwnerMode};
}
export function matchPolicy(p,data){if(data.redemptionPolicy!==p.redemptionPolicy||data.evidenceSource!==p.evidenceSource||data.persistent!==p.persistent||ownerMode(data)!==ownerMode(p))throw Error('The proof policy changed. Keep this test wallet; do not approve.');}
export function validateReview(s,prepared,now=Date.now()){
 if(s.policy.redemptionPolicy==='fixture-only'||prepared.proposal.operation!=='release')return;
 const r=prepared.reviewProof,p=prepared.proposal;
 if(!r||r.schema!=='xmr20-joint-local-redemption-v1'||r.policyId!==s.policy.redemptionPolicy||r.burnTxid!==p.nonce||r.amount!==p.amount||r.position!==addresses(s.config).position.toBase58()||r.owner!==s.moneroOwner||r.to!==s.config.owner||bindingFor(publicOwner(r.owner))!==s.config.binding||!hashId(r.claimTxid)||!hashId(r.checkpoint?.hash)||!Number.isSafeInteger(r.checkpoint?.height)||r.checkpoint.height<0||!Number.isSafeInteger(r.checkedAt)||now-r.checkedAt<0||now-r.checkedAt>30000)throw Error('The claim/burn review is missing, changed or expired. Refresh and review the redemption again.');
}
