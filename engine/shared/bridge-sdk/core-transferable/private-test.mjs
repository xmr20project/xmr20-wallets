import {validateIntent,config as fastConfig} from '../core-fast-send/records.mjs';
// Explicitly authorized, isolated mainnet canary. This policy is never supplied
// by HTTP input and never weakens ordinary immutable-program admission.
import {canonical,digest,validateRecord} from './records.mjs';
import {PublicKey} from '@solana/web3.js';
import {moneroOwner} from '../core-next/records.mjs';
import {addresses} from './sdk.mjs';
export const PRIVATE_TEST_POLICY=Object.freeze({schema:'joint-private-one-xmr20-v1',program:'8HWS1JoTRZYZEkdNvayDta3GRxCMQ2uDYEkaxD3Hs3bB',upgradeAuthority:'4x5FpZshEW9j5Nqs49k7oaAkJDYbe2edKaJD2kwmsRt3',mint:'Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR',owner:'39frGufPgDf9P7beFeHRaKKhxoszAB9F1HfDPXyD6Bns',moneroOwner:'45cQVke2TNqcDi7dkQY3dRiMgVSF89V4reM1BsBeSXDrdmBdXpbrCCqTQ39zUcvyZgVYk7kGQFjNmRfnmvaACHYz3ZMwG5q',maxGrossAtomic:'1000000'});
// Opt-in operator/wallet testing profile. Launch, custody and signatures remain
// mandatory; no wallet allowlist or cumulative one-token allowance applies.
export const WALLET_TEST_POLICY=Object.freeze({schema:'joint-wallet-testing-v1',program:PRIVATE_TEST_POLICY.program,upgradeAuthority:PRIVATE_TEST_POLICY.upgradeAuthority,maxGrossAtomic:'50000000000000'});
const need=(v,m)=>{if(!v)throw Error(m);};
export function privateTestPolicy(p,manifest){
 if(isWalletTest(p)){need(manifest?.abi===3&&manifest.program===p.program&&new PublicKey(manifest.mint).toBase58()===manifest.mint,'Pinned wallet testing program and canonical mint required.');return WALLET_TEST_POLICY;}
 need(p&&Object.getPrototypeOf(p)===Object.prototype&&canonical(p)===canonical(PRIVATE_TEST_POLICY),'Exact authorized private test policy required.');
 need(manifest?.abi===3&&manifest.program===p.program&&manifest.mint===p.mint,'Private test supports the pinned XMR20 program and mint only.');return PRIVATE_TEST_POLICY;
}
const amount=n=>need(typeof n==='string'&&/^[1-9][0-9]*$/.test(n)&&BigInt(n)<=1000000n,'Private test permits at most 1 XMR20.');
export function isWalletTest(p){return !!p&&Object.getPrototypeOf(p)===Object.prototype&&canonical(p)===canonical(WALLET_TEST_POLICY);}
const walletAmount=n=>need(typeof n==='string'&&/^[1-9][0-9]{0,13}$/.test(n)&&BigInt(n)<=BigInt(WALLET_TEST_POLICY.maxGrossAtomic),'Amount exceeds the bridge limit.');
const walletKey=k=>need(typeof k==='string'&&new PublicKey(k).toBase58()===k&&PublicKey.isOnCurve(new PublicKey(k).toBytes()),'Canonical signing wallet required.');
export function privateTestConfig(c,policy=PRIVATE_TEST_POLICY){if(isWalletTest(policy)){need(c?.program===policy.program&&c.network==='mainnet-beta'&&c.abi===3&&/^[a-f0-9]{64}$/.test(c.binding)&&!/^0+$/.test(c.binding),'Pinned bridge and linked wallet required.');walletKey(c.owner);addresses(c);return;}need(c?.owner===PRIVATE_TEST_POLICY.owner&&c.binding===digest(PRIVATE_TEST_POLICY.moneroOwner)&&c.mint===PRIVATE_TEST_POLICY.mint&&c.program===PRIVATE_TEST_POLICY.program,'Use the authorized linked wallets for this private test.');}
export function privateTestEnvelope(e,policy=PRIVATE_TEST_POLICY){
 if(isWalletTest(policy)){validateRecord(e?.record);need(e.record.program===policy.program,'Wrong wallet testing program.');return;}
 const r=e?.record,p=PRIVATE_TEST_POLICY;need(r&&r.owner===p.moneroOwner&&r.mint===p.mint&&r.program===p.program&&['link','credit','burn'].includes(r.op),'Only the authorized link, self deposit and return are available in this private test.');
 if(r.op==='link'||r.op==='burn')need(r.to===p.owner,'Private test destination must be the authorized Solana wallet.');
 if(r.op==='credit')need(r.by===p.owner,'Private test funding wallet must match.');
 if(r.op!=='link')amount(r.amount);
}
export function privateTestOperation(c,p,policy=PRIVATE_TEST_POLICY){
 if(isWalletTest(policy)){privateTestConfig(c,policy);need(['register','deposit','donate','transfer','release'].includes(p?.operation),'Unsupported wallet test operation.');if(p.operation!=='register')walletAmount(p.amount);if(p.operation==='donate')walletKey(p.actor);else need(!p.actor||p.actor===c.owner,'Owner approval required.');if(p.operation==='transfer'){walletKey(p.toOwner);need(p.toOwner!==c.owner,'Different linked recipient required.');}return;}
 privateTestConfig(c);need(['register','deposit','release'].includes(p?.operation),'Private test supports self deposit and return only.');
 if(p.operation!=='register')amount(p.amount);
 if(p.operation==='deposit')need(p.actor===PRIVATE_TEST_POLICY.owner,'Private test funding wallet must match.');
}
export function privateTestRequest(action,input,policy=PRIVATE_TEST_POLICY){
 if(isWalletTest(policy)){
  need(input&&Object.getPrototypeOf(input)===Object.prototype,'Exact object request required.');
  if(['readiness','snapshot','fast-readiness','fast-snapshot'].includes(action))return;
  if(action.startsWith('fast-')){
   if(['fast-prepare','fast-submit'].includes(action)){validateIntent(input.intent);privateTestConfig(fastConfig(input.intent),policy);walletAmount(input.intent.amount);if(action==='fast-submit')privateTestOperation(fastConfig(input.intent),input.proposal,policy);}
   else need(['fast-reconcile','fast-retry'].includes(action)&&typeof input.operationId==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}:fast-send:[a-f0-9]{64}$/.test(input.operationId),'Exact saved fast-send operation required.');return;
  }
  if(action==='prepare'){
   need(['register','deposit','donate','transfer','release'].includes(input.operation),'Unsupported wallet test operation.');
   if(['deposit','donate'].includes(input.operation)){walletKey(input.actor);moneroOwner(input.recipient);walletAmount(input.amount);}
   else {privateTestEnvelope(input.envelope,policy);need(input.envelope.record.op===({register:'link',transfer:'transfer',release:'burn'})[input.operation],'Operation and native proof differ.');}
  }else if(action==='authorize-registration'){privateTestEnvelope(input.envelope,policy);need(input.envelope.record.op==='link','Only registration can be preauthorized.');}
  else if(action==='submit'){privateTestOperation(input.config,input.proposal,policy);privateTestEnvelope(input.envelope,policy);}
  else if(action==='publish')privateTestEnvelope(input.envelope,policy);
  else if(['reconcile','retry','progress'].includes(action))need(typeof input.operationId==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}:(register|deposit|donate|transfer|release):[a-f0-9]{64}$/.test(input.operationId),'Exact saved operation required.');
  else throw Error('Wallet testing route unavailable.');return;
 }
 const p=PRIVATE_TEST_POLICY;
 if(['readiness','snapshot'].includes(action))return;
 if(action==='prepare'){
  if(input.operation==='deposit'){need(input.actor===p.owner&&input.recipient===p.moneroOwner,'Private test funding and recipient wallets must match.');amount(input.amount);}
  else{need(['register','release'].includes(input.operation),'Private test supports self deposit and return only.');privateTestEnvelope(input.envelope);}
 }else if(action==='authorize-registration'){need(input.envelope?.record?.op==='link','Only registration can be preauthorized.');privateTestEnvelope(input.envelope);}
 else if(action==='submit'){privateTestOperation(input.config,input.proposal);privateTestEnvelope(input.envelope);}
 else if(action==='publish')privateTestEnvelope(input.envelope);
 else if(['reconcile','retry','progress'].includes(action)){
  const position=addresses({abi:3,network:'mainnet-beta',program:p.program,mint:p.mint,verifier:'G3SQSCg3UiQpyFz23jRT4LZG87kkzjYGpBikG2xa2qkc',owner:p.owner,binding:digest(p.moneroOwner)}).position.toBase58();
  need(typeof input.operationId==='string'&&new RegExp('^'+position+':(register|deposit|release):[a-f0-9]{64}$').test(input.operationId),'Private test recovery must use the authorized position.');
 }else throw Error('Private test route unavailable.');
}
export function privateTestBudget(state,c,proposal,policy=PRIVATE_TEST_POLICY){
 if(isWalletTest(policy)){privateTestOperation(c,proposal,policy);return;}
 privateTestOperation(c,proposal);if(proposal.operation!=='deposit')return;
 const key=addresses(c).position.toBase58()+':deposit:'+proposal.nonce;let used=0n;
 for(const [id,job] of Object.entries(state.operations)){
  privateTestOperation(job.config,job.proposal);
  need(['submission-unknown','finalized','failed','expired'].includes(job.phase),'Reconcile the private test funding journal.');
  if(id!==key&&job.proposal.operation==='deposit'&&['submission-unknown','finalized'].includes(job.phase))used+=BigInt(job.proposal.amount);
 }
 need(used+BigInt(proposal.amount)<=1000000n,'The private test has already reserved its 1 XMR20 funding allowance.');
}
