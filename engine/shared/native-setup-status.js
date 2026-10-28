// Display-only: decides whether to offer the "Finish Monero setup" shortcut.
// A saved credit is finished only when the service reports it confirmed with
// tokens allocated. Unknown, unreadable or unsigned state keeps the shortcut.
// The local mark never authorizes, signs or selects anything; it only skips a
// repeated status read for a setup already seen as finished on this device.
const PREFIX='xmr20-native-setup-finished-v1:';
// Journal preparation ids are '<scope hash>:preparation:<operation id>'.
const id=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,256}$/.test(value);
const manifestId=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const defaultStore=()=>globalThis.chrome?.storage?.local;
const key=(manifest,preparationId)=>PREFIX+manifest+':'+preparationId;

export async function finishedSetups({manifest,rows,store=defaultStore()}){
 const keys=rows.filter(row=>id(row?.preparationId)).map(row=>key(manifest,row.preparationId));
 if(!store||!manifestId(manifest)||!keys.length)return new Set();
 try{const values=await store.get(keys);return new Set(rows.filter(row=>values?.[key(manifest,row.preparationId)]===true).map(row=>row.preparationId));}
 catch{return new Set();}
}
export async function markSetupFinished({manifest,preparationId,store=defaultStore()}){
 if(!store||!manifestId(manifest)||!id(preparationId))return;
 try{await store.set({[key(manifest,preparationId)]:true});}catch{}
}
// Sequential on purpose: the private wallet client is single-flight.
export async function hasUnfinishedSetup({client,status,manifest,store=defaultStore()}){
 try{
  await client.unlock();
  const rows=(await client.operatorCreditPreparations()).filter(row=>!row.completion);
  const done=await finishedSetups({manifest,rows,store});
  for(const row of rows){
   if(done.has(row.preparationId))continue;
   const carrier=await client.recoverPreparedCarrier({preparationId:row.preparationId,kind:'issuance'});
   if(carrier?.state!=='signed'||typeof carrier.txid!=='string')return true;
   const value=await status({txid:carrier.txid});
   if(value?.confirmed!==true||value.tokenAllocated!==true)return true;
   await markSetupFinished({manifest,preparationId:row.preparationId,store});
  }
  return false;
 }catch{return true;}
}
