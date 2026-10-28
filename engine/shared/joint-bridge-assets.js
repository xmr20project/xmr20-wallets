import {manifest} from './bridge-sdk/core-next/mainnet-config.mjs';
import {multiTokenManifest} from './bridge-sdk/core-next/multi-token-config.mjs';
import {XCAT_MINT,XMR20_MINT,supportedMint} from './bridge-sdk/core-next/mint-policy.mjs';
import {sharedCatalog} from './catalog-cache.js';
export {XCAT_MINT,XMR20_MINT};
export const jointAssets=Object.freeze([
 protocolAsset({mint:XMR20_MINT,symbol:'XMR20',name:'XMR20'}),
 protocolAsset({mint:XCAT_MINT,symbol:'XCAT',name:'XMR Cat'})
]);
export const previousXcatAsset=Object.freeze({key:'previous-xcat',mint:XCAT_MINT,symbol:'XCAT',name:'XMR Cat — previous joint bridge',manifest,endpoint:'/api/joint-mainnet',configured:true});
function protocolAsset(row){if(!supportedMint(row?.mint))throw Error('Choose a valid token mint.');return Object.freeze({key:row.mint,mint:row.mint,symbol:String(row.symbol||row.ticker||'Token').slice(0,64),name:String(row.name||row.symbol||row.ticker||'Token').slice(0,120),manifest:multiTokenManifest(row.mint),endpoint:'/api/joint-protocol/'+row.mint,configured:true});}
// A displayed catalog/holding is discovery only. Fresh service launch proofs
// and the exact immutable program must pass before any financial approval.
export function discoveredAssets(rows=[]){const result=[...jointAssets],seen=new Set(result.map(a=>a.mint));for(const row of rows){if(supportedMint(row?.mint)&&!seen.has(row.mint)){result.push(protocolAsset(row));seen.add(row.mint);}}return [...result,previousXcatAsset];}
export function jointAsset(key=XMR20_MINT,rows=[]){return discoveredAssets(rows).find(a=>a.key===key)||protocolAsset({mint:key});}
export function jointTokenLabel(asset,assets){if(asset.key==='previous-xcat')return 'XCAT — previous joint bridge';const duplicate=assets.filter(a=>a.key!=='previous-xcat'&&a.symbol===asset.symbol).length>1;return asset.symbol+(duplicate?' · '+asset.mint.slice(0,4)+'…'+asset.mint.slice(-4):'');}

// The catalog discovers choices only. Runtime launch proofs still decide whether
// the selected token may be registered, deposited, transferred or withdrawn.
export async function loadJointCatalog({fetcher=fetch,signal}={}){
 const value=await sharedCatalog(fetcher).load({signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
 return discoveredAssets(value.tokens).filter(a=>a.key!=='previous-xcat');
}
const seenKey='xmr20-joint-discovered-assets-v3';
export function savedJointAssets(storage=globalThis.localStorage){try{const v=JSON.parse(storage?.getItem(seenKey)||'[]');return Array.isArray(v)&&v.length<=10000?v.filter(r=>supportedMint(r?.mint)):[];}catch{return [];}}
export function rememberJointAsset(asset,storage=globalThis.localStorage){try{const rows=[...savedJointAssets(storage),asset],selected=new Set(rows.map(a=>a.mint));storage?.setItem(seenKey,JSON.stringify(discoveredAssets(rows).filter(a=>a.key!=='previous-xcat'&&selected.has(a.mint)).map(({mint,symbol,name})=>({mint,symbol,name}))));}catch{/* Discovery is optional and never authorizes spending. */}}
