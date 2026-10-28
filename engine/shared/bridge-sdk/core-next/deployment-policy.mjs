// Public candidate identity; these values do not assert that it is deployed.
export const CANDIDATE_HASH='942e4747c9e295a011418c70bcf3e482641f813b84dedde25791599cb033be38';
export const CANDIDATE_SIZE=146736;
export const MAINNET_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
import {XCAT_MINT,XMR20_MINT,deploymentMint,supportedMint} from './mint-policy.mjs';
import {BINARY_HASH as TRANSFERABLE_HASH,BINARY_SIZE as TRANSFERABLE_SIZE,PROFILE as TRANSFERABLE_PROFILE} from '../core-transferable/deployment-policy.mjs';
export const XMR20_CANDIDATE_HASH='009454238b0194c33aeea9ea47941499024caa505e69dc8b06188e535df1b668';
export const XMR20_CANDIDATE_SIZE=146744;
export const MULTI_TOKEN_CANDIDATE_HASH='acaef754b151e8254451bb1bce2b48fc3e3324b62f282e68de663ba5f80e57bf';
export const MULTI_TOKEN_CANDIDATE_SIZE=149224;
export function deploymentPolicy(mint=XCAT_MINT,profile){
 if(profile===TRANSFERABLE_PROFILE){if(!supportedMint(mint))throw Error('Invalid transferable mint.');return {mint,name:'transfer3',abi:3,profile,binaryHash:TRANSFERABLE_HASH,binarySize:TRANSFERABLE_SIZE};}
 if(profile!==undefined&&profile!=='multi-token')throw Error('Unsupported deployment profile.');
 if(profile==='multi-token'){if(!supportedMint(mint))throw Error('Invalid protocol mint.');return {mint,name:'multi',profile,binaryHash:MULTI_TOKEN_CANDIDATE_HASH,binarySize:MULTI_TOKEN_CANDIDATE_SIZE};}
 if(mint===XCAT_MINT)return {mint,name:'xcat',binaryHash:CANDIDATE_HASH,binarySize:CANDIDATE_SIZE};
 if(mint===XMR20_MINT)return {mint,name:'xmr20',binaryHash:XMR20_CANDIDATE_HASH,binarySize:XMR20_CANDIDATE_SIZE};
 throw Error('Unsupported deployment mint.');
}
// This guard belongs to the historical fixed-owner runtime. Never admit ABI 3
// there merely because loader planning knows the new binary.
export function reviewedDeployment(manifest){if(manifest?.profile===TRANSFERABLE_PROFILE||manifest?.abi===3)return false;const p=deploymentPolicy(deploymentMint(manifest),manifest?.profile);return manifest?.binaryHash===p.binaryHash&&manifest.binarySize===p.binarySize;}
