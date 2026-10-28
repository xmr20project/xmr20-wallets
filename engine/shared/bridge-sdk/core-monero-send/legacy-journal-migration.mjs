// Pure, bounded migration for the one reviewed additive program upgrade.
// Original records must remain backed up. Signed bytes and financial fields
// never change; new code admission remains the runtime adapter's responsibility.
import {VersionedTransaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {canonical,digest} from '../core-universal-link/records.mjs';
import {identityRegistry,operatorIdentityRegistry} from '../core-universal-link/mainnet-config.mjs';
import {registerIdentity,activateAsset} from '../core-universal-link/sdk.mjs';
import {fastTransferableManifest,operatorTransferableManifest} from '../core-transferable/mainnet-config.mjs';
import {checkedApproval} from '../core-fast-send/runtime.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const same=(a,b)=>Buffer.from(a).equals(Buffer.from(b));
const nextRegistry=operatorIdentityRegistry();
function checkedRegistry(registry){need(canonical(registry)===canonical(nextRegistry),'Only the reviewed operator registry upgrade may migrate receipts.');}
function replaceConfig(config){
 need(config&&Object.entries(identityRegistry).every(([k,v])=>canonical(config[k])===canonical(v)),'Saved registry configuration differs.');
 return {...config,...nextRegistry};
}
function upgradeJob(job,kind,signed){
 const next=structuredClone(job);next.config=replaceConfig(job.config);
 const build=kind==='identity'?registerIdentity:activateAsset;
 const oldWire=build(job.config,job.proposal),newWire=build(next.config,job.proposal);
 const bytes=job.bytes??job.authorization;
 need(typeof bytes==='string','Saved exact approval required.');
 const tx=VersionedTransaction.deserialize(Buffer.from(bytes,'base64')),message=tx.message.serialize();
 need(same(message,oldWire.message.serialize())&&same(message,newWire.message.serialize())&&tx.signatures.length===tx.message.header.numRequiredSignatures,'Upgrade would change a signed message.');
 tx.signatures.forEach((signature,i)=>need(!signed&&i===0&&signature.every(x=>x===0)||ed25519.verify(signature,message,tx.message.staticAccountKeys[i].toBytes()),'Saved approval signature differs.'));
 return next;
}
export function migrateIdentityJournal(value,{registry=nextRegistry,owner,moneroOwner,payer}={}){
 checkedRegistry(registry);
 const scopes={
  'wallet-identity-runtime-v1':[identityRegistry,registry,'identity'],
  'wallet-asset-activation-v1':[identityRegistry,registry,'activation'],
  'wallet-identity-owner-v1':[{registry:identityRegistry,owner,moneroOwner},{registry,owner,moneroOwner},'identity'],
  'wallet-activation-owner-v1':[{registry:identityRegistry,payer},{registry,payer},'activation']
 };
 const entry=scopes[value?.schema];need(entry&&value.scope===digest(canonical(entry[0])),'Saved journal is outside this reviewed upgrade.');
 const next=structuredClone(value);next.scope=digest(canonical(entry[1]));
 need(next.operations&&Object.keys(next.operations).length<=10000,'Bounded operation journal required.');
 for(const [id,job] of Object.entries(value.operations))next.operations[id]=upgradeJob(job,entry[2],true);
 if(value.reviews)for(const [id,job] of Object.entries(value.reviews))next.reviews[id]=upgradeJob(job,entry[2],false);
 return next;
}
export function migrateFastJournal(value,manifest){
 need(canonical(manifest)===canonical(operatorTransferableManifest(manifest.mint,manifest.nativeCustody)),'Only reviewed operator program pins may migrate fast receipts.');
 need(value?.schema==='joint-fast-runtime-v1'&&value.manifest===canonical(fastTransferableManifest(manifest.mint))&&value.operations&&value.reviews,'Wrong prior fast journal.');
 for(const job of Object.values(value.operations))checkedApproval(job.intent,job.proposal,Buffer.from(job.bytes,'base64'));
 for(const job of Object.values(value.reviews))checkedApproval(job.intent,job.proposal,Buffer.from(job.authorization,'base64'),{signed:false});
 return {...structuredClone(value),manifest:canonical(manifest)};
}
export function priorIdentityRegistry(registry){checkedRegistry(registry);return identityRegistry;}
