import {isBridgeHolding} from '../../engine/shared/joint-wallet-assets.js';
import {supportedMint} from '../../engine/shared/bridge-sdk/core-next/mint-policy.mjs';

export function mergeWalletHoldings(result,previous){
 if(result.complete)return result;
 const ids=new Set(result.rows.map(row=>row.id));
 return {...result,rows:[...result.rows,...(previous?.rows||[]).filter(row=>!ids.has(row.id)).map(row=>({...row,stale:true}))]};
}

export function bridgeActionRow(action,rows,scope){
 if(!action||action.scope!==scope)return null;
 if(!action.row)return {id:'new-bridge'};
 return rows.find(row=>row.id===action.row.id)||{...action.row,stale:true};
}

// Display/discovery only. Old indexed Monero balances are a different custody
// source and must never become a new-bridge balance by relabelling their network.
export function websiteBridgeRows({owner,address,network,linkedAddress,currentRows,solana,joint}={}){
 const solRows=network==='solana'&&address===owner&&Array.isArray(currentRows)?currentRows:solana?.owner===owner?solana.rows:[];
 const jointRows=joint?.owner===owner&&joint?.address===linkedAddress?joint.rows:[];
 const rows=[...(solRows||[]).map(row=>({...row,network:'solana'})),...(jointRows||[]).filter(row=>row.bridge==='joint-v3'&&row.network==='monero'&&row.solanaOwner===owner&&row.moneroOwner===linkedAddress)];
 const seen=new Set();return rows.filter(row=>{
  const key=row.network+':'+row.mint;
  if(!owner||!supportedMint(row.mint)||!isBridgeHolding(row)||seen.has(key))return false;
  seen.add(key);return true;
 });
}

export function extensionBridgeRows(rows=[],network){
 const seen=new Set();return rows.filter(row=>{
  const key=row.network+':'+row.mint;
  if(network&&row.network!==network||!supportedMint(row.mint)||!isBridgeHolding(row)||seen.has(key))return false;
  seen.add(key);return true;
 });
}
