import {Keypair} from '@solana/web3.js';
import {encryptVault,decryptVault} from '../core.js';
import {sameConfig,validateState,transaction,net} from './sdk.mjs';
import {validatePolicy,publicOwner,bindingFor} from './review-policy.mjs';
import {checkRecordReview,checkRecordState,validateRecordContext} from './record-draft.mjs';
import {payload,canonical} from './claim-record.mjs';
export const STORAGE_KEY='xmr20-joint-test-v2';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function encodeSession(s){return {kind:'xmr20-joint-lab',version:s.policy?.recordOwnerMode==='browser-saved-test-owner'?4:3,accounts:[],ownerSeed:Buffer.from(s.key.secretKey.slice(0,32)).toString('base64'),token:s.token,config:s.config,policy:s.policy||{redemptionPolicy:'fixture-only',evidenceSource:'fixture-only',persistent:true},moneroOwner:s.moneroOwner||null,revision:s.revision,state:s.state,waiting:!!s.waiting,prepared:s.prepared||null,pendingWrite:s.pendingWrite||null,receipts:s.receipts||[],...(s.policy?.recordOwnerMode==='browser-saved-test-owner'?{localDepositNet:s.localDepositNet||null,recordState:s.recordState,recordPrepared:s.recordPrepared||null}:{})};}
export function decodeSession(data){
 if(data?.kind!=='xmr20-joint-lab'||![2,3,4].includes(data.version)||!Array.isArray(data.accounts)||data.accounts.length||typeof data.ownerSeed!=='string'||Buffer.from(data.ownerSeed,'base64').length!==32||!uuid.test(data.token)||!Number.isSafeInteger(data.revision)||data.revision<0||data.config?.network!=='local-svm'||!Array.isArray(data.receipts)||data.receipts.length>1000)throw Error('This is not a saved joint escrow test wallet.');
 const policy=validatePolicy(data.version===2?{redemptionPolicy:'fixture-only',evidenceSource:'fixture-only',persistent:true}:data.policy),moneroOwner=data.version>=3?data.moneroOwner:null;
 if(policy.redemptionPolicy!=='fixture-only'&&bindingFor(publicOwner(moneroOwner))!==data.config.binding)throw Error('Saved Monero owner binding changed.');
 const key=Keypair.fromSeed(Buffer.from(data.ownerSeed,'base64'));if(key.publicKey.toBase58()!==data.config.owner||data.config.owner===data.config.verifier)throw Error('Saved test owner does not match the position.');
 validateState(data.config,data.state);
 if(data.prepared){const expected=transaction(data.config,data.prepared.proposal);if(!Buffer.from(expected.serialize()).equals(Buffer.from(data.prepared.transaction,'base64')))throw Error('Saved review does not match the position.');}
 if(data.pendingWrite){const w=data.pendingWrite;if(!['prepare','approve','cosign',...(data.version===4?['submit-record']:[])].includes(w.path)||!uuid.test(w.body?.requestId)||!Number.isSafeInteger(w.body.revision)||w.body.revision<0)throw Error('Invalid saved approval request.');if(w.path==='approve'){if(!data.prepared)throw Error('Saved approval is missing its review.');const tx=transaction(data.config,data.prepared.proposal);tx.sign([key]);if(!Buffer.from(tx.serialize()).equals(Buffer.from(w.body.transaction,'base64')))throw Error('Saved signature does not match the approved review.');}}
 if(data.version===4){
  if(policy.recordOwnerMode!=='browser-saved-test-owner')throw Error('Saved browser key policy changed.');
  const amount=data.localDepositNet,receipt=data.receipts.find(r=>r.operation==='deposit');
  if(amount!==null){validateRecordContext({config:data.config,moneroOwner,depositNet:amount});if(data.state.created?receipt?.net!==amount:!data.prepared||data.prepared.proposal.operation!=='deposit'||net(data.prepared.proposal.amount).toString()!==amount)throw Error('Saved deposit backing changed.');}
  else if(data.state.created)throw Error('Saved deposit backing is missing.');
  checkRecordState(data.recordState,amount);
  if(data.recordPrepared){const r=data.recordPrepared;if(!amount||!data.state.created||Object.keys(r).sort().join(',')!=='envelope,review')throw Error('Invalid saved record review.');checkRecordReview({config:data.config,moneroOwner,depositNet:amount},r.review);if(r.envelope){payload(r.envelope);if(canonical(r.envelope.record)!==canonical(r.review.record))throw Error('Saved record signature changed.');}}
  if(data.pendingWrite?.path==='submit-record'){const w=data.pendingWrite;if(Object.keys(w.body).sort().join(',')!=='envelope,requestId,revision'||!data.recordPrepared?.envelope||canonical(w.body.envelope)!==canonical(data.recordPrepared.envelope))throw Error('Saved record request changed.');}
 }else if(policy.recordOwnerMode==='browser-saved-test-owner')throw Error('Saved browser key material is missing.');
 return {key,token:data.token,config:data.config,policy,moneroOwner,revision:data.revision,state:data.state,waiting:!!data.waiting,prepared:data.prepared,pendingWrite:data.pendingWrite,receipts:data.receipts,saved:true,...(data.version===4?{localDepositNet:data.localDepositNet,recordState:data.recordState,recordPrepared:data.recordPrepared}:{})};
}
export function createLabVault(storage){return {
 has(){return storage.getItem(STORAGE_KEY)!==null;},
 async save(s,password,isLive=()=>true){const previous=storage.getItem(STORAGE_KEY);if(s.saved?previous!==s.storageVersion:previous!==null)throw Error('Another window updated this test wallet. Reopen it before approving.');const box=await encryptVault(encodeSession(s),password);if(!isLive())throw Error('Test closed while saving.');if(storage.getItem(STORAGE_KEY)!==previous)throw Error('Another window updated this test wallet. Reopen it before approving.');const next=JSON.stringify(box);storage.setItem(STORAGE_KEY,next);s.storageVersion=next;},
 async unlock(password){const bytes=storage.getItem(STORAGE_KEY);if(!bytes||bytes.length>2_000_000)throw Error('Saved test wallet is unavailable.');const session=decodeSession(await decryptVault(JSON.parse(bytes),password));if(storage.getItem(STORAGE_KEY)!==bytes)throw Error('Another window updated this test wallet. Reopen it before approving.');session.storageVersion=bytes;return session;},
 // Called only by the explicit new-test confirmation.
 forget(){storage.removeItem(STORAGE_KEY);}
};}
