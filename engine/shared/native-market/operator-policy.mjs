// Explicit bridge trust policy for native ownership. This does not authenticate
// Solana reserves or claim that a single issuer is trustless. Ordinary ownership
// comes from canonical Monero replay; only bridge boundaries use the operator.
import {PublicKey} from '@solana/web3.js';
import {custodyPolicyIdentity} from '../bridge-sdk/core-monero-send/custody-policy.mjs';
import {decodeManifest,encodeManifest,manifestId,circulatingSupply} from './xn1/records.mjs';
import {PrototypeIndex} from './xn1/replay.mjs';
import {exact,need,hash,domain} from './xn1/bytes.mjs';

export const OPERATOR_CUSTODY='operator-verified-v1';
export const OPERATOR_DISCLOSURE=Object.freeze({
  title:'Operator-verified bridge',
  summary:'XMR20’s bridge service verifies Monero ownership and authorizes withdrawals to Solana.',
  risk:'This bridge is not trustless. A compromised or dishonest operator could release backing incorrectly; an unavailable operator could delay withdrawals.',
  native:'Monero token sends and trades use your Monero wallet. No Solana wallet or link is required.',
  conversion:'Converting moves your existing linked claim into the operator-verified reserve. Your current claim stays unchanged until you approve this conversion.'
});

export function operatorPolicy(configuration) {
  need(configuration?.backed===true&&configuration.backing?.mode===OPERATOR_CUSTODY,'Explicit operator custody configuration required');
  const p=configuration.backing;
  exact(p,['mode','program','mint','verifier','policy','manifest','claimPolicy']);
  need(p.claimPolicy==='explicit-conversion-v1','Existing claims require explicit holder conversion');
  const manifest=decodeManifest(encodeManifest(configuration.manifest)),id=manifestId(manifest);
  const pub=value=>new PublicKey(value).toBuffer();
  need(configuration.manifestId===id&&configuration.chainGenesis===manifest.genesis&&p.manifest===id,'Pinned operator manifest mismatch');
  const bridgeDomain=hash(domain('XN1-J3-OPERATOR-CUSTODY-V1'),pub(p.program),pub(p.mint),pub(p.verifier)).toString('hex');
  need(circulatingSupply(manifest.profile)&&manifest.threshold===1&&manifest.issuers.length===1&&
    manifest.issuers[0]===pub(p.verifier).toString('hex')&&manifest.asset===pub(p.mint).toString('hex')&&
    manifest.bridgeDomain===bridgeDomain&&manifest.depth>=10&&manifest.decimals===6,'Manifest differs from operator custody policy');
  const identity=custodyPolicyIdentity(p,{manifest:id,mode:OPERATOR_CUSTODY,signers:[p.verifier]});
  need(identity.policy.toBase58()===p.policy,'Pinned custody policy address mismatch');
  return {manifest,id,policy:p.policy};
}

export function operatorNativeState({configuration,index,readChainTip}) {
  const p=operatorPolicy(configuration);
  need(index instanceof PrototypeIndex&&index.id===p.id,'Independent operator-native replay required');
  const before=index.stateHash(),s=typeof index.accountingSummary==='function'?index.accountingSummary():index.snapshot(),tip=readChainTip();
  need(tip&&typeof tip.height==='bigint'&&s.height===tip.height&&s.blockHash===tip.blockHash&&index.stateHash()===before,'Native replay changed or is not at the verified checkpoint');
  need(s.issued>=s.burned&&s.issued-s.burned<=p.manifest.cap,'Native circulating supply exceeds the manifest');
  return Object.freeze({mode:OPERATOR_CUSTODY,manifestId:p.id,policy:p.policy,height:s.height,blockHash:s.blockHash,
    nativeStateHash:before,circulatingRaw:(s.issued-s.burned).toString(),backingTrust:'single-operator',
    independentlyVerifiedSolanaBacking:false});
}
