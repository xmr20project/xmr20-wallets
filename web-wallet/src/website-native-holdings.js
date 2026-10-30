// Display-only records for the website wallet's Monero tab: the last private-scan balance
// summary (the extension's xmr20-native-token-display-v1 schema) and this browser's bridges
// to Monero still on their way, plus bridges to Solana (to:'solana') and token sends
// (to:'address') until their Monero transaction confirms. Nothing here selects inputs or authorizes anything;
// the private engine always rescans before any transfer.
import {nativeHoldingsKey,nativeHoldingRow,summarizeNativeHoldings} from '../../engine/shared/native-token-holdings.js';
import {NATIVE_MARKET_CONFIGURATION} from '../../engine/shared/website/native-market-config.js';

export const NATIVE_HOLDINGS_EVENT='xmr20-native-holdings';
const PENDING_PREFIX='xmr20-native-pending-bridges-v1:',DAY=86400000,KEEP=3*DAY;
const STAGES=['solana','building','sending','confirming','confirmed','rejected'];
const address=v=>typeof v==='string'&&/^[1-9A-HJ-NP-Za-km-z]{95}$/.test(v);
const raw=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v);
const read=(key,storage)=>{try{const v=storage.getItem(key);return v===null?null:JSON.parse(v);}catch{return null;}};
const write=(key,value,storage)=>{try{storage.setItem(key,JSON.stringify(value));globalThis.dispatchEvent?.(new CustomEvent(NATIVE_HOLDINGS_EVENT));return true;}catch{return false;}};
const storageOf=storage=>storage??globalThis.localStorage;

// Saved after a completed private sync (ready checkpoint + inventory), like the extension.
export function saveNativeDisplay({address:owner,inventory,checkpoint,configuration=NATIVE_MARKET_CONFIGURATION,storage,now=Date.now()}){
 const value=summarizeNativeHoldings({address:owner,inventory,checkpoint,configuration,now}),key=nativeHoldingsKey(owner,configuration);
 if(!key||!nativeHoldingRow(value,owner,{configuration,now}))return null;
 return write(key,value,storageOf(storage))?value:null;
}
export function nativeDisplay(owner,{configuration=NATIVE_MARKET_CONFIGURATION,storage,now=Date.now()}={}){
 const key=nativeHoldingsKey(owner,configuration);if(!key)return null;
 return nativeHoldingRow(read(key,storageOf(storage)),owner,{configuration,now});
}

function pendingKey(owner,configuration){return configuration?.manifestId&&address(owner)?PENDING_PREFIX+configuration.manifestId+':'+owner:null;}
function validEntry(e){
 return e&&typeof e.preparationId==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(e.preparationId)&&raw(e.amountRaw)&&STAGES.includes(e.stage)&&
  (e.txid===undefined||/^[a-f0-9]{64}$/.test(e.txid))&&Number.isSafeInteger(e.startedAt)&&Number.isSafeInteger(e.updatedAt)&&
  (e.confirmations===undefined||Number.isSafeInteger(e.confirmations)&&e.confirmations>=0)&&(e.required===undefined||Number.isSafeInteger(e.required)&&e.required>0&&e.required<=1000)&&
  (e.to===undefined||['solana','address'].includes(e.to)&&['sending','confirming','confirmed','rejected'].includes(e.stage));
}
function entries(owner,configuration,storage){const key=pendingKey(owner,configuration),list=key?read(key,storage):null;return Array.isArray(list)?list.filter(validEntry):[];}

// One record per saved preparation; later stages never move it backwards.
export function recordNativeBridge(owner,update,{configuration=NATIVE_MARKET_CONFIGURATION,storage,now=Date.now()}={}){
 storage=storageOf(storage);const key=pendingKey(owner,configuration);if(!key)return false;
 const list=entries(owner,configuration,storage).filter(e=>now-e.updatedAt<KEEP),old=list.find(e=>e.preparationId===update?.preparationId);
 const next={...old,preparationId:update?.preparationId,amountRaw:update?.amountRaw,stage:update?.stage,startedAt:old?.startedAt??now,updatedAt:now,
  ...(update?.txid?{txid:update.txid}:{}),...(['solana','address'].includes(update?.to)?{to:update.to}:{}),...(Number.isSafeInteger(update?.confirmations)?{confirmations:update.confirmations,required:update.required}:{})};
 if(old&&STAGES.indexOf(old.stage)>STAGES.indexOf(next.stage)&&old.stage!=='rejected')next.stage=old.stage;
 if(old?.amountRaw&&old.amountRaw!==next.amountRaw)return false;
 if(!validEntry(next))return false;
 return write(key,[...list.filter(e=>e!==old),next].slice(-20),storage);
}
// Bridges still worth showing: in flight, or arrived/sent after the last saved balance.
export function pendingNativeBridges(owner,{configuration=NATIVE_MARKET_CONFIGURATION,storage,now=Date.now()}={}){
 storage=storageOf(storage);const display=nativeDisplay(owner,{configuration,storage,now});
 return entries(owner,configuration,storage).filter(e=>now-e.updatedAt<KEEP&&!(e.stage==='confirmed'&&display&&display.checkedAt>e.updatedAt))
  .sort((a,b)=>b.startedAt-a.startedAt);
}
