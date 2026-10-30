// Coalesce read-only wallet work in this unlocked popup. No signing operation
// uses this lane. Durable progress remains in the encrypted worker checkpoints.
export function createScanLane(){
 const pending=new Map();
 return {pending:key=>pending.get(key),run(key,operation){
  if(pending.has(key))return pending.get(key);
  const task=Promise.resolve().then(operation).finally(()=>{if(pending.get(key)===task)pending.delete(key);});
  pending.set(key,task);return task;
 }};
}

// Start native XMR scanning alongside the token ledger and wait for it only
// when that ledger reaches its tip. A balance-node interruption must not disable
// independent token transfers; the ordinary cache keeps its last checkpoint.
export function createCompanionScan(syncBalance,notify=()=>{}){
 let scan=null,finished=false,settled=false,closed=false,snapshot=null;
 return {
  start(){if(closed||!syncBalance||scan&&!settled)return;finished=false;settled=false;scan=Promise.resolve().then(()=>syncBalance(value=>{if(!closed)notify(value);})).then(value=>{snapshot=value;finished=true;settled=true;return true;},()=>{settled=true;return false;});},
  async finish(){if(!scan)return true;const ready=await scan;if(!closed&&!ready)notify('XMR balance scan paused. Open Monero balance to continue from saved progress.');return ready;},
  get finished(){return finished;},
  get snapshot(){return snapshot;},
  close(){closed=true;}
 };
}
