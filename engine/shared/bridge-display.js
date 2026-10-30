// Reuse a previous public snapshot for display, never as signing readiness.
import {canonical,digest} from './bridge-sdk/core-transferable/records.mjs';
export const bridgeDisplayKey=(account,mint,program)=>'xmr20-joint-holdings-v3:'+program+':'+mint+':'+account.sol+':'+digest(account.xmr);
export function readBridgeDisplay(account,manifest,policy,{storage=globalThis.localStorage,now=Date.now()}={}){
 try{const v=JSON.parse(storage.getItem(bridgeDisplayKey(account,manifest.mint,manifest.program))),r=v?.report;
  if(v.sol!==account.sol||v.xmr!==account.xmr||v.mint!==manifest.mint||!Number.isSafeInteger(v.savedAt)||v.savedAt>now||now-v.savedAt>86400000||r?.schema!=='joint-index-v3'||r.complete!==true||canonical(r.manifest)!==canonical(manifest)||canonical(r.privateTestPolicy??null)!==canonical(policy??null)||!Array.isArray(r.positions))return null;
  if(r.positions.some(p=>typeof p.available!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(p.available)))return null;
  return r;
 }catch{return null;}
}
export function saveBridgeDisplay(account,manifest,report,{storage=globalThis.localStorage,now=Date.now()}={}){
 try{storage.setItem(bridgeDisplayKey(account,manifest.mint,manifest.program),JSON.stringify({sol:account.sol,xmr:account.xmr,mint:manifest.mint,savedAt:now,report}));}catch{}
}
