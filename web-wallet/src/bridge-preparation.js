// Memory-only unsigned reviews. Scope includes wallet, recipient, token and intent.
export function createBridgePreparation({request,now=()=>performance.now(),maxAgeMs=25000}){
 let entry=null,flight=null,generation=0;
 const keyFor=t=>JSON.stringify([t.owner,t.id,t.mint,t.moneroAddress,t.direction,t.amountRaw]);
 function peek(t){return entry?.key===keyFor(t)&&now()-entry.startedAt<maxAgeMs?entry.value:null;}
 function clear(){generation++;entry=null;flight=null;}
 function prepare(t){
  const cached=peek(t);if(cached)return Promise.resolve(cached);
  const key=keyFor(t);if(flight?.key===key)return flight.promise;
  entry=null;
  const revision=++generation,startedAt=now(),operation=t.direction==='sol-to-xmr'?'Deposit':'Withdrawal';
  const promise=request('prepare'+operation,{id:t.id}).then(value=>{
   if(revision!==generation)throw Error('Bridge details changed. Review again.');
   if(!value?.transaction||!value?.ticket||value.network!=='mainnet-beta'||value.simulationPassed!==true)throw Error('Bridge transaction verification is incomplete. Retry preparation.');
   const elapsed=now()-startedAt,wait=value.preparationWaitMs??0;
   // Deduct only service-measured time BEFORE the unsigned transaction exists.
   // Network transit, blockhash lookup, simulation and balance checks still age it.
   if(!Number.isSafeInteger(wait)||wait<0||wait>elapsed)throw Error('Bridge preparation timing could not be verified. Retry preparation.');
   const reviewStartedAt=startedAt+wait;
   if(elapsed-wait>=maxAgeMs)throw Error('Preparation took too long. Retry preparation for a fresh transaction.');
   entry={key,startedAt:reviewStartedAt,value};return value;
  }).finally(()=>{if(flight?.promise===promise)flight=null;});
  flight={key,promise};return promise;
 }
 // Background renewal must never invalidate a request that is still running.
 function clearIfIdle(){if(flight)return false;clear();return true;}
 // Renew successful reviews only; a failure stays visible until a manual retry.
 function renewIfDue(t,renewAfterMs=20000){
  if(flight||!entry||entry.key!==keyFor(t)||now()-entry.startedAt<renewAfterMs)return false;
  clear();return true;
 }
 return {peek,prepare,clear,clearIfIdle,renewIfDue};
}
export function bridgeAmounts(q){
 const amount=BigInt(q.amountRaw),fee=BigInt(q.transferTaxRaw??'0'),net=BigInt(q.netReceivedRaw??q.amountRaw);
 if(amount<=0n||fee<0n||net<0n||net+fee!==amount)throw Error('Bridge quote amounts do not match.');
 return {amount,fee,net,rate:Number(net)/Number(amount)};
}
