import {PublicKey} from '@solana/web3.js';
export const JOINT_BINARY='942e4747c9e295a011418c70bcf3e482641f813b84dedde25791599cb033be38';
export const WALLET_ORIGIN='http://127.0.0.1:8924';
const codes=['deployment','mint-policy','monero-publication','return-routing','independent-review'];
export const REQUIREMENTS=Object.freeze([
 'Deploy and verify the joint escrow program and its upgrade authority.',
 'Verify compatible token authorities, extensions and transfer fees.',
 'Publish and independently replay real position-bound Monero claims and burns.',
 'Route the return to the same position and original depositing wallet.',
 'Complete real-chain recovery tests and independent security review.'
]);
function key(v){try{return typeof v==='string'&&new PublicKey(v).toBase58()===v;}catch{return false;}}
export function walletScope(value){
 if(!value||Object.keys(value).sort().join(',')!=='direction,mint,owner'||!['sol-to-xmr','xmr-to-sol'].includes(value.direction)||value.owner!==null&&!key(value.owner)||!key(value.mint))throw Error('Provide only the public wallet, mint and bridge direction.');
 return {owner:value.owner,mint:value.mint,direction:value.direction};
}
// Readiness is derived from this reviewed local implementation, never a client
// flag or a production service's advertised ready boolean. No live activation.
export function localWalletStatus(input,programHash){
 const scope=walletScope(input);if(programHash!==JOINT_BINARY)throw Error('Joint program fingerprint changed.');
 return {schema:'xmr20-joint-wallet-status-v1',scope,network:'local-svm',programSha256:JOINT_BINARY,liveEnabled:false,publication:'mocked-monero',transferable:false,requirements:codes.map((code,i)=>({code,verified:false,description:REQUIREMENTS[i]}))};
}
export function validateWalletStatus(report,input){
 const expected=localWalletStatus(input,JOINT_BINARY);
 if(JSON.stringify(report)!==JSON.stringify(expected))throw Error('Bridge readiness changed or is unverified. No approval is available.');
 return report;
}
export function assertLiveBridge(){throw Error('Real-token joint bridging is disabled. The current program and Monero flow are local experiments.');}
export function routeJointReturn(receipt,owner){
 if(!receipt||receipt.protocol!=='xmr20-joint'||receipt.network!=='local-svm'||receipt.transferable!==false||receipt.owner!==owner||!key(receipt.position)||!key(receipt.mint))throw Error('This balance has no matching joint escrow position. Legacy withdrawal is not a fallback.');
 return {position:receipt.position,owner:receipt.owner,mint:receipt.mint};
}
