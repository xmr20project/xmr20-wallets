import {need,hex} from '../xn1/bytes.mjs';
import {inspectCarrier} from '../xn1/carrier.mjs';

// Fixed relative routes. A lost publish reply is never automatically retried.
// The wallet retains exact signed bytes before this client can see them.
export function createNativeSendClient({fetchImpl=fetch,assertCurrent=()=>{},operation='send'}={}){
 need(['send','burn','credit'].includes(operation),'Fixed native operation required');
 async function read(path,options={}){
  assertCurrent();const response=await fetchImpl('/api/native-market/'+path,{...options,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(120000)});assertCurrent();
  need(response.body,'Native send service unavailable');const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;need(size<=16384,'Native send response exceeds limit');chunks.push(chunk);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));assertCurrent();
  need(response.ok&&!value.error,value.error||'Native send service unavailable');return value;
 }
 async function post(action,body,txid){
  // A saved wallet page can outlive the service process. Obtain its current
  // transport token before each action; never retry an uncertain publication.
  const session=await read('session');hex(session.csrf);const csrf=session.csrf;
  const value=await read(operation+'/'+action,{method:'POST',headers:{'content-type':'application/json','x-native-market-token':csrf},body:JSON.stringify(body)});
  need(value.txid===txid&&['accepted','submission-unknown','mempool','confirming','confirmed','rejected','unavailable','not-found'].includes(value.status)&&typeof value.confirmed==='boolean','Native send response differs');
  need(!value.confirmed||value.status==='confirmed'&&value.tokenAllocated===true,'Native inclusion alone is not token settlement');
  need(Number.isInteger(value.requiredConfirmations)&&value.requiredConfirmations>=10&&value.requiredConfirmations<=1000,'Invalid native confirmation depth');
  need(value.confirmations===undefined||Number.isSafeInteger(value.confirmations)&&value.confirmations>=0,'Invalid native confirmation count');
  need(value.peersSeen===undefined||[0,1,2].includes(value.peersSeen),'Invalid native peer observation');
	  need(value.failureStage===undefined||/^(?:peer-admission|state-changed|validate-peer-[01]-(?:transport|rejected|double_spend|fee_too_low|invalid_input|invalid_output|low_mixin|not_rct|overspend|too_big|too_few_outputs|sanity_check_failed|tx_extra_too_big|nonzero_unlock_time)|relay-peer-0-(?:transport|rejected))$/.test(value.failureStage),'Invalid native publication stage');
  need(!value.confirmed||value.confirmations>=value.requiredConfirmations,'Native confirmation threshold not reached');return value;
 }
 return Object.freeze({
  publish({transaction,retry=false}){need(typeof transaction==='string'&&/^(?:[a-f0-9]{2})+$/.test(transaction)&&transaction.length<=400000&&typeof retry==='boolean','Bounded canonical signed transaction required');const tx=inspectCarrier(Uint8Array.from(transaction.match(/../g),x=>parseInt(x,16)));need(tx.data.toString('hex')===transaction,'Exact canonical signed transaction required');return post('publish',{transaction,retry},tx.txid);},
  status({txid}){hex(txid);return post('status',{txid},txid);}
 });
}
