import {canonical} from './bridge-sdk/core-transferable/records.mjs';
import {addresses,receiptAddress} from './bridge-sdk/core-transferable/sdk.mjs';

const need=(value,message)=>{if(!value)throw Error(message);};
// One explicit click authorizes only this return, in this unlocked UI session.
// Nothing secret or reusable is persisted. Closing/locking revokes continuation.
export function createJointReturnFlow({config,moneroOwner,amount,fee,nonce,client,load,snapshot,assertCurrent,approve,now=Date.now}){
 need(/^[1-9][0-9]*$/.test(amount)&&/^[0-9]+$/.test(fee)&&BigInt(fee)<BigInt(amount)&&/^[a-f0-9]{64}$/.test(nonce),'Exact return terms required.');
 const pinned=structuredClone(config),position=addresses(pinned).position.toBase58(),expires=now()+60*60*1000;
 const expected={p:'xmr20-joint',v:3,net:'mainnet',op:'burn',owner:moneroOwner,mint:pinned.mint,program:pinned.program,nonce,amount,to:pinned.owner,from:position};
 let phase='waiting',closed=false,running=false,started=false,error='',renewed=false;
 const renewable=Object.values(load()?.operations||{}).some(j=>j.proposal.operation==='release'&&j.proposal.nonce===nonce&&j.phase==='approval-expired');
 function assertActive(){need(!closed&&phase!=='paused'&&phase!=='complete','Automatic return is paused. Resume this saved return.');need(now()<expires,'Return approval expired. Resume with fresh fees.');assertCurrent();}
 function proof(){const p=load()?.proofs?.[nonce];need(p&&canonical(p.envelope.record)===canonical(expected),'Saved return differs from the amount or destination you approved.');return p;}
 function job(){return Object.entries(load()?.operations||{}).find(([,j])=>j.proposal.operation==='release'&&j.proposal.nonce===nonce);}
 async function guarded(fn){need(!running,'This return is already processing.');running=true;try{assertActive();await fn();}catch(e){if(!closed){phase='paused';error=e.message;}throw e;}finally{running=false;}}
 return Object.freeze({
  get state(){return {phase,error,nonce,amount,fee};},
  get active(){return !closed&&!['paused','complete'].includes(phase);},
  assertActive,
  close(){closed=true;},
  pause(){phase='paused';},
  async start(){return guarded(async()=>{need(!started,'Continue the saved return.');started=true;if(!load()?.proofs?.[nonce]){phase='publishing';await client.publishMove({amount,nonce});}assertActive();proof();phase='waiting';});},
  async advance(){return guarded(async()=>{
   need(started,'Start this return before continuing.');
   const p=proof(),saved=job();
   if(saved&&!(renewable&&!renewed&&saved[1].phase==='approval-expired')){
    const [id,j]=saved;
    need(canonical(j.config)===canonical(pinned)&&canonical(j.envelope)===canonical(p.envelope)&&j.proposal.amount===amount&&j.proposal.expectedFee===fee,'Saved Solana return differs from the approved terms.');
    need(j.phase!=='approval-expired','The saved Solana approval expired. Resume this return.');
    phase='submitted';const result=await client.check(id);assertActive();
    need(!result.retryApprovalRequired,'The saved Solana approval expired. Resume this return.');
    if(result.confirmed)phase='complete';
    return;
   }
   const report=await snapshot();assertActive();
   need(report?.complete===true,'Complete verified bridge history is required.');
   const confirmed=report.accepted?.some(e=>canonical(e.envelope)===canonical(p.envelope))||report.pending?.some(e=>e.operation==='burn'&&e.receipt===receiptAddress(pinned,nonce).toBase58());
   if(!confirmed){phase='waiting';return;}
   phase='preparing';const review=await client.reviewMove(nonce);assertActive();
   need(canonical(review.config)===canonical(pinned)&&review.proposal.operation==='release'&&review.proposal.nonce===nonce&&review.proposal.amount===amount&&review.proposal.expectedFee===fee&&canonical(review.envelope)===canonical(p.envelope),'Return amount, destination or fee changed. Resume to review the new terms.');
   phase='approving';renewed=true;await approve(review);assertActive();
   // The owner controller journals before sending. Never create a replacement
   // signature automatically after an unknown relay response or expiry.
   need(job(),'Saved Solana approval is missing. Keep the recovery receipt.');phase='submitted';
  });}
 });
}
