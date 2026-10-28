// Public candidate policy, captured before deployment. Enabling this requires a
// coordinated program, carrier, index, verifier and client release.
import {universalTransferableManifest,operatorTransferableManifest} from '../core-transferable/mainnet-config.mjs';
import {canonical} from './records.mjs';
const {mint,abi,...base}=universalTransferableManifest('Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR');
export const identityRegistry=Object.freeze({...base,nativeAnchor:Object.freeze({"height": 3787101, "hash": "18d89637e1315db5cc968c8e724751577211a1446af2bd20ea07da7c6335bfc0"})});
export function operatorIdentityRegistry(){
 const {mint,abi,fastSend,...candidate}=operatorTransferableManifest('Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR');
 return Object.freeze({...candidate,nativeAnchor:identityRegistry.nativeAnchor});
}
// This exact additive upgrade does not change identity record decoding, chain
// anchor, or the native confirmation rule. Preserve its public discovery cache.
// Financial admission still receives the new registry and verifies new code.
export function identityHistoryRegistry(registry){
 return canonical(registry)===canonical(operatorIdentityRegistry())?identityRegistry:registry;
}
