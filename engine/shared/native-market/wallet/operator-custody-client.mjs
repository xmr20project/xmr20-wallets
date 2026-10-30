import {need,hex} from '../xn1/bytes.mjs';
import {validateOperatorCreditPlan} from './operator-credit-preparation.mjs';
import {validateCustodyRefundPlan} from '../operator-refund-plan.mjs';
import {canonical} from '../../protocol/xmr20-protocol.js';

// Requests carry only the fixed preparation or its exact holder approval.
// The private worker/background independently verifies custody before signing.
export function createOperatorCustodyClient({configuration,fetchImpl=fetch,assertCurrent=()=>{}}){
 let csrf=null;
 async function read(path,options={}){
  assertCurrent();const response=await fetchImpl('/api/native-market/'+path,{...options,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(60000)});
  assertCurrent();need(response.body,'Bridge service unavailable');const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;need(size<=32768,'Bridge reply exceeds limit');chunks.push(chunk);}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));assertCurrent();
  need(response.ok&&!value.error,value.error||'Bridge service unavailable');return value;
 }
 async function post(path,value){
  if(!csrf){const session=await read('session');hex(session.csrf);csrf=session.csrf;}
  return read(path,{method:'POST',headers:{'content-type':'application/json','x-native-market-token':csrf},body:JSON.stringify(value)});
 }
 function planCheck(plan){return validateOperatorCreditPlan(configuration,plan.record?.owner,plan);}
 function state(plan,value){
  planCheck(plan);
  need(value.id===plan.id&&value.binding===plan.binding&&['prepared','submitted','submission-unknown','confirming','finalized','failed','expired'].includes(value.status),'Custody status differs');
  need((typeof value.receipt==='string'?value.receipt:value.receipt?.receipt)===plan.receipt,'Custody receipt differs');
  if(value.status==='finalized')need(value.receipt?.finalized===true&&value.receipt.binding===plan.binding&&value.receipt.amount===plan.record.amount,'Finalized custody differs');
  return value;
 }
 function refundState(plan,value){
  validateCustodyRefundPlan(configuration,plan);
  need(value.id===plan.id&&value.binding===plan.binding&&
   ['prepared','submitted','submission-unknown','confirming','finalized','failed','expired'].includes(value.status),'Refund status differs');
  need((typeof value.receipt==='string'?value.receipt:value.receipt?.receipt)===plan.receipt,'Refund receipt differs');
  if(value.status==='finalized')need(value.receipt?.finalized===true&&value.receipt.destination===plan.request.owner&&
   value.receipt.amount===plan.record.amount&&BigInt(value.receipt.net)+BigInt(value.receipt.fee)===BigInt(plan.record.amount),'Finalized refund differs');
  return value;
 }
 return Object.freeze({
  async refundQuote(source){
   planCheck(source);const value=await post('operator-refund/quote',{source});
   validateCustodyRefundPlan(configuration,value.plan);
   need(canonical(value.plan.source)===canonical(source)&&
    value.net===String(BigInt(source.record.amount)-BigInt(value.plan.fee)),'Refund quote changed');
   return value;
  },
  async prepareRefund(plan){validateCustodyRefundPlan(configuration,plan);return refundState(plan,await post('operator-refund/prepare',{plan}));},
  async approveRefund(plan,transaction){validateCustodyRefundPlan(configuration,plan);return refundState(plan,await post('operator-refund/approve',{id:plan.id,transaction}));},
  async refundStatus(plan){return refundState(plan,await post('operator-refund/status',{id:plan.id}));},
  async retryRefund(plan){return refundState(plan,await post('operator-refund/retry',{id:plan.id}));},
  async quote(request){
   const value=await post('operator-custody/quote',request);
   need(value.kind===request.kind&&value.owner===request.owner&&value.amount===request.amount&&value.manifest===configuration.manifestId&&value.policy===configuration.backing.policy,'Custody quote changed');
   need(typeof value.fee==='string'&&/^(0|[1-9][0-9]*)$/.test(value.fee)&&BigInt(value.fee)<BigInt(request.amount)&&value.net===String(BigInt(request.amount)-BigInt(value.fee))&&(request.kind!=='migrate-output'||value.fee==='0'),'Custody fee changed');
   return value;
  },
  async prepare(plan){planCheck(plan);return state(plan,await post('operator-custody/prepare',{plan}));},
  async approve(plan,transaction){planCheck(plan);return state(plan,await post('operator-custody/approve',{id:plan.id,transaction}));},
  async status(plan){planCheck(plan);return state(plan,await post('operator-custody/status',{id:plan.id}));},
  async retry(plan){planCheck(plan);return state(plan,await post('operator-custody/retry',{id:plan.id}));},
  async issue(plan){
   planCheck(plan);const value=await post('operator-credit/issue',{transaction:plan.recipientCarrier});
   need(value.intent?.lock===plan.id&&value.intent?.binding===plan.binding&&value.intent?.receipt===plan.receipt,'Issuer response differs from saved custody');hex(value.signature,64);
   return {signature:value.signature};
  }
 });
}
