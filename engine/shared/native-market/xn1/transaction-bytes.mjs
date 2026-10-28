// Authenticate complete historical bytes and a peer's pruned representation.
// This is transaction-hash verification, NOT signature/consensus validation.
// NativeWallet independently parses full signing transactions and may parse
// hash-authenticated pruned history before activation; validating peers provide
// the agreed block ancestry. Layout: Monero v0.18.4.2 rctTypes.h and
// cryptonote_format_utils.cpp; also pinned monero-oxide 0.1.0 RctBase::read.
import {Buffer} from 'buffer';
import {keccak_256} from '@noble/hashes/sha3';
import {Reader,need} from './bytes.mjs';
const canonical=value=>typeof value==='string'&&/^(?:[a-f0-9]{2})+$/.test(value)&&value.length<=4_000_000;
const digest=bytes=>Buffer.from(keccak_256(bytes));

export const inspectTransactionBytes=value=>inspect(value,null);
// A known transaction ID can authenticate its extra even if native proof data
// has been pruned. This never supplies complete transaction/signing evidence.
export function inspectPrunedTransactionBytes(value,prunableHash){
 need(typeof prunableHash==='string'&&/^[a-f0-9]{64}$/.test(prunableHash),'Canonical native proof commitment required');
 return inspect(value,prunableHash);
}
function inspect(value,prunableHash){
 need(canonical(value),'Complete canonical native transaction required');
 const data=Buffer.from(value,'hex'),r=new Reader(data),version=r.varint();
 need(version===1n||version===2n,'Unsupported historical transaction version');r.varint();
 const inputs=Number(r.varint(4096n));need(inputs>0,'Native transaction inputs missing');let signatures=0,miner=false;
 for(let i=0;i<inputs;i++){
  const tag=r.u(1);
  if(tag===255){need(inputs===1,'Invalid miner input');r.varint();miner=true;}
  else{need(tag===2,'Unsupported native input');r.varint();const ring=Number(r.varint(4096n));need(ring>0,'Empty native ring');for(let j=0;j<ring;j++)r.varint();r.take(32);signatures+=ring;}
 }
 const outputs=Number(r.varint(4096n));need(outputs>0,'Native transaction outputs missing');
 for(let i=0;i<outputs;i++){r.varint();const tag=r.u(1);need(tag===2||tag===3,'Unsupported native output');r.take(tag===3?33:32);}
 const extra=Buffer.from(r.take(Number(r.varint(2_000_000n)))),prefixEnd=r.at;
 if(version===1n){need(prunableHash===null,'V1 native transactions cannot be pruned');r.take(signatures*64);r.done();return {txid:digest(data).toString('hex'),extra,version:1,ringCtOutputs:0,prunedHex:null,prunableHash:null};}
 const type=r.u(1);need(type<=6,'Unsupported historical RingCT format');
 let proofHash;
 if(type===0){need(miner,'Null RingCT requires miner input');r.done();proofHash=Buffer.alloc(32);need(prunableHash===null||prunableHash===proofHash.toString('hex'),'Null native proof commitment changed');}
 else{
  need(!miner,'Unexpected miner RingCT proof');r.varint();if(type===2)r.take(inputs*32);
  r.take(outputs*(type<=3?64:8));r.take(outputs*32);
  if(prunableHash!==null){r.done();proofHash=Buffer.from(prunableHash,'hex');}
  else{need(r.at<data.length,'Native prunable proofs missing');proofHash=digest(data.subarray(r.at));}
 }
 const baseEnd=r.at,txid=digest(Buffer.concat([digest(data.subarray(0,prefixEnd)),digest(data.subarray(prefixEnd,baseEnd)),proofHash])).toString('hex');
 return {txid,extra,version:2,ringCtOutputs:outputs,prunedHex:data.subarray(0,baseEnd).toString('hex'),prunableHash:proofHash.toString('hex')};
}

// Both representations must refer to the same transaction already named in
// the peers' agreed block. At least one peer must provide COMPLETE native bytes.
// No provider substitution, unauthenticated hash hint or reconstructed proof.
export function matchTransactionBytes(rows,txid){
 need(Array.isArray(rows)&&rows.length===2&&typeof txid==='string'&&/^[a-f0-9]{64}$/.test(txid),'Two native transaction representations required');
 const complete=row=>row?.as_hex||(row?.pruned_as_hex&&row?.prunable_as_hex?row.pruned_as_hex+row.prunable_as_hex:null);
 const full=rows.map(complete),candidate=full.find(Boolean);need(candidate,'Complete native proof data unavailable from both peers');
 const parsed=inspectTransactionBytes(candidate);need(parsed.txid===txid,'Native transaction hash mismatch');
 rows.forEach((row,i)=>{
  need(row?.tx_hash===txid,'Wrong native transaction identity');
  if(full[i])need(full[i]===candidate,'Native transaction bytes disagree');
  else need(parsed.version===2&&canonical(row.pruned_as_hex)&&row.pruned_as_hex===parsed.prunedHex&&row.prunable_hash===parsed.prunableHash,'Pruned native bytes or proof commitment disagree');
 });
 return {hex:candidate,parsed};
}

// Historical wallet scanning may use hash-authenticated v2 prefix/base bytes.
// Both peers must agree, and the independently recomputed ID must be in their
// agreed block. This is never a substitute for full token/transaction review.
export function matchHistoricalScanBytes(rows,txid){
 need(Array.isArray(rows)&&rows.length===2,'Two historical peers required');
 const checked=rows.map(row=>{
  need(row?.tx_hash===txid,'Wrong historical transaction identity');
  const full=row.as_hex||(row.pruned_as_hex&&row.prunable_as_hex?row.pruned_as_hex+row.prunable_as_hex:null);
  let parsed;
  if(full)parsed=inspectTransactionBytes(full);
  else if(row.pruned_as_hex?.startsWith('01'))parsed=inspectTransactionBytes(row.pruned_as_hex);
  else parsed=inspectPrunedTransactionBytes(row.pruned_as_hex,row.prunable_hash);
  need(parsed.txid===txid,'Historical transaction hash mismatch');
  return parsed.version===1?{hex:full||row.pruned_as_hex,prunableHash:null}:
   {hex:parsed.prunedHex,prunableHash:parsed.prunableHash};
 });
 need(checked[0].hex===checked[1].hex&&checked[0].prunableHash===checked[1].prunableHash,'Historical transaction commitments disagree');
 return checked[0];
}
