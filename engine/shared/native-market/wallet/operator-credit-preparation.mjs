// Private-worker bridge boundary. Ordinary native sends/trades never call this.
// Reserve a complete native CREDIT before the holder authorizes Solana custody.
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {creditMessage} from '../xn1/proofs.mjs';
import {operatorPolicy,OPERATOR_CUSTODY} from '../operator-policy.mjs';
import {EXPIRING_CREDIT_PROFILE,offlineRecipients,validCreditEpoch,encodeRecord} from '../xn1/records.mjs';
import {framePayload,extractPayload,inspectCarrier,decodeCarrier} from '../xn1/carrier.mjs';
import {exact,hex,need} from '../xn1/bytes.mjs';
import {bridgeInstruction,bridgePolicy} from '../../bridge-sdk/core-monero-send/bridge-sdk.mjs';
import {marketReceiptIdentity,marketCreditBinding} from '../../bridge-sdk/core-monero-send/market-custody.mjs';
import {canonical} from '../../protocol/xmr20-protocol.js';
import {nativeFeeFunding} from './native-fee-funding.mjs';
const zero='00'.repeat(32),json=v=>JSON.stringify(v,(_,n)=>typeof n==='bigint'?String(n):n);
const amount=(v,allowZero=false)=>{
 need(typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v),'Exact bridge amount required');
 const n=BigInt(v);need(n<=0xffffffffffffffffn&&(allowZero||n>0n),'Bridge amount outside bounds');return n;
};
const point=o=>({txid:o.source.txid,vout:String(o.source.vout)});
const fragments=record=>extractPayload(framePayload(encodeRecord(record))).chunks.map(c=>c.content.toString('hex'));
export function operatorCustodyTerms(configuration,request){
 const p=operatorPolicy(configuration);
 need(offlineRecipients(p.manifest.profile),'Offline Monero receiving profile required');
 exact(request,['kind','owner','amount','fee','nonce','carrierPiconero','maximumFeePiconero']);
 need(['deposit','migrate-output'].includes(request.kind),'Explicit deposit or linked-claim conversion required');
 const owner=new PublicKey(request.owner).toBase58();need(owner===request.owner&&owner!==configuration.backing.verifier,'Distinct custody holder required');
 const gross=amount(request.amount),fee=amount(request.fee,true);
 need(gross<=50000000000000n&&gross>fee&&(request.kind!=='migrate-output'||fee===0n),'Exact custody amount and one fee required');
 amount(request.carrierPiconero);amount(request.maximumFeePiconero);hex(request.nonce);need(request.nonce!==zero,'Unique custody nonce required');
 const config={...configuration.backing,owner,abi:3,network:'mainnet-beta',nativeCustodyMode:OPERATOR_CUSTODY};
 const options={manifest:p.id,mode:OPERATOR_CUSTODY,signers:[config.verifier]},a=bridgePolicy(config,options);
 const from=request.kind==='migrate-output'?a.position:a.policy;
 const receipt=PublicKey.findProgramAddressSync([Buffer.from('joint-v3-receipt'),from.toBuffer(),hex(request.nonce)],a.program)[0].toBase58();
 return {config,options,receipt,net:(gross-fee).toString(),...marketReceiptIdentity(config,p.manifest,receipt)};
}
function planFor(configuration,address,request,transaction){
 const t=operatorCustodyTerms(configuration,request),manifest=operatorPolicy(configuration).manifest;
 const tx=inspectCarrier(Buffer.from(transaction,'hex')),record=decodeCarrier(tx)?.record;
 need(record?.op==='CREDIT'&&record.manifest===configuration.manifestId&&validCreditEpoch(manifest,record.epoch)&&record.vout===0&&
  record.lock===t.lock&&record.issuance===t.issuance&&record.amount===BigInt(t.net)&&
  record.image===zero&&record.c===zero&&record.s===zero&&record.signatures.length===1&&record.signatures[0].signer===0&&
  record.signatures[0].signature===zero+zero,'Exact unsigned offline native credit required');
 need(tx.fee<=amount(request.maximumFeePiconero),'Native fee exceeds approval');
 const binding=marketCreditBinding({config:t.config,manifest,transaction:Buffer.from(transaction,'hex')});
 return {schema:'xmr20-operator-credit-preparation-v1',id:t.lock,
  record:{owner:address,lock:t.lock,amount:t.net},request:structuredClone(request),receipt:t.receipt,binding,
  recipientCarrier:transaction,carrierPiconero:request.carrierPiconero,creditFeePiconero:request.maximumFeePiconero};
}
export function validateOperatorCreditPlan(configuration,address,plan){
 need(plan&&plan.schema==='xmr20-operator-credit-preparation-v1','Operator credit preparation required');
 const expected=planFor(configuration,address,plan.request,plan.recipientCarrier);
 need(canonical(plan)===canonical(expected),'Exact prepared operator credit required');return expected;
}
// The page can supply only an issuer signature. It cannot substitute native
// inputs, outputs, amount, fee, or receipt while completing a saved preparation.
export function constructOperatorIssuedCredit({configuration,address,plan,signature,wallet}){
 const checked=validateOperatorCreditPlan(configuration,address,plan),p=operatorPolicy(configuration);
 const original=inspectCarrier(Buffer.from(checked.recipientCarrier,'hex')),decoded=decodeCarrier(original);
 const message=creditMessage(decoded.record,decoded.context,original.outputs[decoded.record.vout].key);
 need(ed25519.verify(hex(signature,64),message,hex(p.manifest.issuers[0]),{zip215:false}),'Invalid operator credit signature');
 const record={...decoded.record,signatures:[{signer:0,signature}]};
 const transaction=wallet.replaceCarrierNonces(Buffer.from(checked.recipientCarrier,'hex'),json({kind:'issuance',nonces:fragments(record)}));
 const terms=operatorCustodyTerms(configuration,checked.request);
 need(typeof transaction==='string'&&marketCreditBinding({config:terms.config,manifest:p.manifest,transaction:Buffer.from(transaction,'hex')})===checked.binding,
  'Issuer signature changed the prepared credit');
 return transaction;
}
export function operatorCustodyInstruction(configuration,plan){
 const t=operatorCustodyTerms(configuration,plan.request);
 const result=bridgeInstruction(t.config,t.options,{...plan.request,binding:plan.binding});
 need(result.receipt.toBase58()===plan.receipt,'Custody receipt changed');
 return {programId:result.instruction.programId.toBase58(),keys:result.instruction.keys.map(k=>({
  pubkey:k.pubkey.toBase58(),isSigner:k.isSigner,isWritable:k.isWritable})),data:result.instruction.data.toString('hex')};
}
export async function prepareOperatorCredit({configuration,request,address,session,wallet,journal,reader,assertCurrent,onStage=()=>{}}){
 onStage('network-fee');
 const terms=operatorCustodyTerms(configuration,request),checkpoint=session.checkpoint(),fees=await reader.feeQuote();assertCurrent();
 exact(fees,['feePerWeight','feeMask']);amount(fees.feePerWeight);amount(fees.feeMask);
 onStage('funding-protection');
 const [locks,recipients]=await Promise.all([journal.lockedInputs(),journal.protectedRecipients()]);assertCurrent();
 onStage('funding-classification');
 const required=amount(request.carrierPiconero)+amount(request.maximumFeePiconero);
 const {selected,summary}=nativeFeeFunding({outputs:JSON.parse(wallet.publicOutputs()),locks,recipients,height:checkpoint.height,requiredRaw:String(required)});
 need(summary.ready,'Add spendable XMR for the Monero network fee before bridging');
 const credit={op:'CREDIT',manifest:configuration.manifestId,lock:terms.lock,issuance:terms.issuance,epoch:configuration.manifest.profile===EXPIRING_CREDIT_PROFILE?Number(checkpoint.height)+720:0,vout:0,
  amount:BigInt(terms.net),image:zero,c:zero,s:zero,signatures:[{signer:0,signature:zero+zero}]};
 const nativeRequest={kind:'issuance',carrier:request.carrierPiconero,maximumFee:request.maximumFeePiconero,inputs:selected.map(point)};
 onStage('transaction-build');
 const built=JSON.parse(await wallet.constructCarrier(json({...nativeRequest,...fees,nonces:fragments(credit)})));assertCurrent();
 onStage('transaction-review');
 const plan=planFor(configuration,address,request,built.transaction);
 const own=JSON.parse(wallet.proposedRecipient(Buffer.from(built.transaction,'hex'),0));
 need(own.outputKey===inspectCarrier(Buffer.from(built.transaction,'hex')).outputs[0].key,'Credit is not addressed to this private wallet');
 const native=JSON.parse(wallet.inspectCarrierFunding(Buffer.from(built.transaction,'hex'),json(nativeRequest)));
 need(native.tokenAuthorized===false&&native.signatureHash===inspectCarrier(Buffer.from(built.transaction,'hex')).signatureHash,'Private native funding inspection changed');
 const payload={plan,nativeRequest,native,fees};
 onStage('funding-history');
 await session.hooks.assertFresh(wallet.checkpoint());assertCurrent();
 onStage('preparation-save');
 const encoded=new TextEncoder().encode(json(payload));
 try{
  const saved=await journal.prepareFunding({operationId:plan.id,purpose:{kind:'operator-credit',manifest:configuration.manifestId},
   checkpoint:{height:Number(checkpoint.height),hash:checkpoint.blockHash},
   funding:[{role:'issuance',keyImages:selected.map(o=>o.keyImage)}],payload:encoded});assertCurrent();
  return {preparationId:saved.preparationId,operationId:plan.id,receipt:plan.receipt,binding:plan.binding,
   instruction:operatorCustodyInstruction(configuration,plan),quote:{kind:request.kind,gross:request.amount,fee:request.fee,net:terms.net,
    nativeFee:native.fee,maximumNativeFee:request.maximumFeePiconero,bridgeTrust:OPERATOR_CUSTODY},custodySigned:false};
 }finally{encoded.fill(0);}
}
export function validateOperatorCreditPreparation(saved,{configuration,address}){
 need(saved?.binding?.purpose?.kind==='operator-credit'&&saved.binding.purpose.manifest===configuration.manifestId&&
  saved.binding.scope.address===address&&saved.binding.scope.genesis===configuration.chainGenesis&&saved.payload instanceof Uint8Array,'Operator preparation scope differs');
 const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(saved.payload));exact(value,['plan','nativeRequest','native','fees']);
 const plan=planFor(configuration,address,value.plan.request,value.plan.recipientCarrier);
 need(canonical(plan)===canonical(value.plan)&&saved.binding.operationId===plan.id,'Prepared custody terms changed');
 const tx=inspectCarrier(Buffer.from(plan.recipientCarrier,'hex')),request=value.nativeRequest;
 exact(request,['kind','carrier','maximumFee','inputs']);
 need(request.kind==='issuance'&&request.carrier===plan.carrierPiconero&&request.maximumFee===plan.creditFeePiconero&&
  value.native.signatureHash===tx.signatureHash&&value.native.fee===String(tx.fee),'Prepared native credit changed');
 const reserved=saved.binding.funding;need(reserved.length===1&&reserved[0].role==='issuance'&&
  canonical(reserved[0].keyImages)===canonical(tx.inputs.map(i=>i.keyImage).sort()),'Prepared native funding changed');
 need(Array.isArray(request.inputs)&&request.inputs.length===tx.inputs.length,'Prepared native source count differs');
 for(const input of request.inputs){exact(input,['txid','vout']);hex(input.txid);amount(input.vout,true);}
 return value;
}
