import {need,hex} from '../xn1/bytes.mjs';
import {validateRedemptionQuote} from '../operator-redemption-quote.mjs';

// A quote is verified under the installed operator identity before any burn.
// Status reads never request a signature, new burn, or Solana wallet.
export function createOperatorRedemptionClient({configuration,fetchImpl=fetch,assertCurrent=()=>{}}){
 let csrf=null;
 async function read(path,options={}){
  assertCurrent();
  const response=await fetchImpl('/api/native-market/'+path,{...options,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(30000)});
  assertCurrent();need(response.body,'Bridge service unavailable');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;need(size<=16384,'Bridge reply exceeds limit');chunks.push(chunk);}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));assertCurrent();
  need(response.ok&&!value.error,value.error||'Bridge service unavailable');return value;
 }
 async function post(action,value){
  if(!csrf){const session=await read('session');hex(session.csrf);csrf=session.csrf;}
  return read('operator-redemption/'+action,{method:'POST',headers:{'content-type':'application/json','x-native-market-token':csrf},body:JSON.stringify(value)});
 }
 return Object.freeze({
  async quote({amount,destination}){
   const quote=await post('quote',{amount,destination,maximumTokenFee:'current'});
   const terms=validateRedemptionQuote(quote,configuration,{fresh:true});
   need(terms.amount===amount&&terms.destination===destination&&terms.maximumTokenFee===terms.observedTokenFee,'Bridge quote changed requested terms');
   return quote;
  },
  async status(quote){
   const terms=validateRedemptionQuote(quote,configuration),value=await post('status',{redemption:quote.redemption});
   need(value.redemption===quote.redemption&&['not-started','prepared','submitted','submission-unknown','confirming','finalized','failed','expired','fee-limit-exceeded'].includes(value.status),'Bridge status differs');
   if(value.status!=='not-started'){
    need(value.amount===terms.amount&&value.destination===terms.destination&&typeof value.fee==='string'&&/^(0|[1-9][0-9]*)$/.test(value.fee)&&BigInt(value.fee)<=BigInt(terms.maximumTokenFee)&&value.net===String(BigInt(terms.amount)-BigInt(value.fee)),'Bridge payout differs from approval');
    if(value.signature!==undefined)need(typeof value.signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value.signature),'Invalid Solana transaction reference');
   }
   return value;
  }
 });
}
