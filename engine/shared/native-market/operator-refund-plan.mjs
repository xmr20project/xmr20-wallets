// S5 recovery applies only to a never-created CREDIT after its inclusive native
// deadline is behind the confirmed index. Existing native tokens never expire.
import {PublicKey} from '@solana/web3.js';
import {operatorPolicy,operatorNativeState} from './operator-policy.mjs';
import {EXPIRING_CREDIT_PROFILE} from './xn1/records.mjs';
import {inspectCarrier,decodeCarrier} from './xn1/carrier.mjs';
import {exact,hash,hex,domain,need} from './xn1/bytes.mjs';
import {validateOperatorCreditPlan} from './wallet/operator-credit-preparation.mjs';
import {bridgeInstruction} from '../bridge-sdk/core-monero-send/bridge-sdk.mjs';
import {canonical} from '../protocol/xmr20-protocol.js';

export function custodyRefundPlan(configuration,source,fee){
 const p=operatorPolicy(configuration);need(p.manifest.profile===EXPIRING_CREDIT_PROFILE,'This custody profile has no expiring-entry refund');
 validateOperatorCreditPlan(configuration,source.record?.owner,source);
 need(typeof fee==='string'&&/^(0|[1-9][0-9]{0,13})$/.test(fee)&&BigInt(fee)<BigInt(source.record.amount),'Exact refund token fee required');
 const record=decodeCarrier(inspectCarrier(Buffer.from(source.recipientCarrier,'hex'))).record;
 const nonce=hash(domain('XN1-OPERATOR-UNISSUED-REFUND-V1'),hex(source.id)).toString('hex');
 const intent={kind:'redeem',amount:source.record.amount,fee,nonce,destination:source.request.owner,signers:[configuration.backing.verifier]};
 const config={...configuration.backing,abi:3,network:'mainnet-beta',owner:source.request.owner,nativeCustodyMode:configuration.backing.mode};
 const built=bridgeInstruction(config,{manifest:p.id,mode:config.nativeCustodyMode,signers:[config.verifier]},intent);
 // Fee revisions require a new holder review but share ONE on-chain receipt.
 const id=hash(domain('XN1-OPERATOR-REFUND-REVIEW-V1'),hex(source.id),Buffer.from(fee)).toString('hex');
 return {schema:'xmr20-operator-unissued-refund-v1',id,source:structuredClone(source),deadline:record.epoch,fee,
  receipt:built.receipt.toBase58(),binding:new PublicKey(intent.destination).toBuffer().toString('hex'),
  intent,record:{owner:source.request.owner,amount:source.record.amount},request:{kind:'refund',owner:source.request.owner}};
}
export function validateCustodyRefundPlan(configuration,plan){
 exact(plan,['schema','id','source','deadline','fee','receipt','binding','intent','record','request']);
 const expected=custodyRefundPlan(configuration,plan.source,plan.fee);
 need(canonical(expected)===canonical(plan),'Refund must return the exact unissued claim to its custody holder');
 return expected;
}
export function assertCustodyRefundable(configuration,source,state,{now=Date.now()}={}){
 const p=operatorPolicy(configuration);need(p.manifest.profile===EXPIRING_CREDIT_PROFILE,'Expiring native entry required');
 validateOperatorCreditPlan(configuration,source.record?.owner,source);
 need(Number.isSafeInteger(state.checkedAt)&&state.checkedAt<=now&&now-state.checkedAt<=30000,'Fresh confirmed native history required for refund');
 operatorNativeState({configuration,index:state.index,readChainTip:()=>state.checkpoint});
 const record=decodeCarrier(inspectCarrier(Buffer.from(source.recipientCarrier,'hex'))).record;
 need(state.checkpoint.height>=BigInt(record.epoch),'Wait until the native creation deadline is confirmed before refunding');
 const native=state.index.snapshot();
 need(!native.issuances.has(record.issuance)&&![...native.issuances.values()].some(r=>r.lock===record.lock),
  'Tokens were created on Monero; use a normal bridge-out instead of a refund');
 return {deadline:record.epoch,height:String(state.checkpoint.height),blockHash:state.checkpoint.blockHash};
}
