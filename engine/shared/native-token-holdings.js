// Display cache only. These totals never authorize a transfer or select inputs.
// The private native worker always resynchronizes and reviews exact sources.
import {NATIVE_MARKET_CONFIGURATION} from './website/native-market-config.js';
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const raw=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=0xffffffffffffffffn;
export const NATIVE_HOLDINGS_PREFIX='xmr20-native-token-display-v1:';
export function nativeTokenMetadata(configuration=NATIVE_MARKET_CONFIGURATION){
 if(!configuration)return null;
 const metadata=configuration.display;
 if(!metadata||metadata.mint!==configuration.backing?.mint||typeof metadata.symbol!=='string'||
  !/^[A-Za-z0-9]{1,16}$/.test(metadata.symbol)||typeof metadata.name!=='string'||metadata.name.length>100)
  throw Error('Build-pinned native token display metadata required.');
 return {mint:metadata.mint,ticker:metadata.symbol,symbol:metadata.symbol,name:metadata.name,manifest:configuration.manifestId};
}
export function nativeHoldingsKey(address,configuration=NATIVE_MARKET_CONFIGURATION){
 if(!configuration||!hash(configuration.manifestId)||!hash(configuration.chainGenesis)||!/^[1-9A-HJ-NP-Za-km-z]{95}$/.test(address))return null;
 return NATIVE_HOLDINGS_PREFIX+configuration.manifestId+':'+address;
}
export function summarizeNativeHoldings({address,inventory,checkpoint,configuration=NATIVE_MARKET_CONFIGURATION,now=Date.now()}){
 const key=nativeHoldingsKey(address,configuration);if(!key)throw Error('Native display scope missing.');
 if(!Array.isArray(inventory)||inventory.length>10000||checkpoint?.ready!==true||!raw(checkpoint.height)||!hash(checkpoint.checkpoint))throw Error('Synced native inventory required.');
 const sources=new Set();let total=0n,held=0n;
 for(const row of inventory){
  const source=row.source,vout=typeof source?.vout==='string'&&raw(source.vout)?Number(source.vout):source?.vout;
  if(!hash(source?.txid)||!Number.isSafeInteger(vout)||vout<0||vout>0xffffffff||!raw(row.quantity)||typeof row.held!=='boolean')throw Error('Invalid native display output.');
  const id=source.txid+':'+vout;if(sources.has(id))throw Error('Duplicate native display output.');sources.add(id);
  total+=BigInt(row.quantity);if(row.held)held+=BigInt(row.quantity);
 }
 if(total>configuration.manifest.cap||!Number.isSafeInteger(now)||now<0)throw Error('Native display total outside manifest.');
 return {schema:'xmr20-native-token-display-v1',address,manifest:configuration.manifestId,genesis:configuration.chainGenesis,
  amountRaw:String(total),heldRaw:String(held),height:checkpoint.height,blockHash:checkpoint.checkpoint,checkedAt:now};
}
export function nativeHoldingRow(value,address,{configuration=NATIVE_MARKET_CONFIGURATION,now=Date.now()}={}){
 if(!configuration)return null;
 if(value?.schema!=='xmr20-native-token-display-v1'||value.address!==address||value.manifest!==configuration.manifestId||
  value.genesis!==configuration.chainGenesis||!raw(value.amountRaw)||!raw(value.heldRaw)||BigInt(value.heldRaw)>BigInt(value.amountRaw)||
  BigInt(value.amountRaw)>configuration.manifest.cap||!raw(value.height)||!hash(value.blockHash)||
  !Number.isSafeInteger(value.checkedAt)||value.checkedAt<0||value.checkedAt>now||now-value.checkedAt>30*86400000)return null;
 return {...nativeTokenMetadata(configuration),network:'monero',amountRaw:value.amountRaw,heldRaw:value.heldRaw,
  moneroOwner:address,stale:true,checkedAt:value.checkedAt,balanceSource:'private-native-scan'};
}
export async function saveNativeHoldings(value,{configuration=NATIVE_MARKET_CONFIGURATION,storage=globalThis.chrome?.storage?.local}={}){
 const key=nativeHoldingsKey(value.address,configuration);if(!key||!nativeHoldingRow(value,value.address,{configuration}))throw Error('Native display scope changed.');
 await storage.set({[key]:value});
}
