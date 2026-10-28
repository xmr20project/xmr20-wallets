// Structural observations of current RingCT/Bulletproof+ transactions, including
// transactions that are not XN1 carriers. Native signatures/proofs and canonical
// placement MUST already be validated by the configured chain reader. This does
// not make arbitrary caller JSON authoritative. Unknown formats or work limits
// abort the scan; they must never be interpreted as an absent token operation.
import {Buffer} from 'buffer';
import {keccak_256} from '@noble/hashes/sha3';
import {bytes,join,need,Reader,uint} from './bytes.mjs';
export function inspectNativeObservation(blob) {
 const data=bytes(blob);need(data.length>0&&data.length<=2_000_000,'Native observation exceeds supported work bound');
 const r=new Reader(data);need(r.varint()===2n,'Only native v2 transactions are supported');const unlockTime=r.varint();
 const count=Number(r.varint(4096n));need(count>0,'Native inputs missing');
 const inputs=Array.from({length:count},()=>{
  need(r.u(1)===2,'Unsupported native input format');
  // A current v2 transaction can spend an older, explicit-amount output.
  // Track its native key image too. inspectCarrier still requires amount zero
  // for every token-carrying input; this does not widen token authorization.
  r.varint();
  need(r.varint(16n)===16n,'Unsupported native input format');let index=0n;
  const offsets=Array.from({length:16},(_,j)=>{const delta=r.varint();need(j===0||delta>0n,'Repeated native ring member');index+=delta;uint(index,8);return index;});
  return {offsets,keyImage:r.hex()};
 });
 const outputCount=Number(r.varint(4096n));need(outputCount>=2,'Native outputs missing');
 const outputs=Array.from({length:outputCount},()=>{need(r.varint()===0n,'Unsupported clear native output');const tag=r.u(1);need(tag===2||tag===3,'Unsupported native output');return {key:r.hex(),viewTag:tag===3?r.u(1):null};});
 const extraStartLength=Number(r.varint(2_000_000n)),extraStart=r.at,extra=Buffer.from(r.take(extraStartLength)),prefixEnd=r.at;
 need(r.u(1)===6,'Unsupported native RingCT format');const fee=r.varint();r.take(outputCount*8);outputs.forEach(o=>{o.commitment=r.hex();});const baseEnd=r.at;
 need(baseEnd<data.length,'Native prunable proofs missing');
 // Full prunable bytes are authenticated by the transaction hash and checked
 // by validating peers; the token decoder still applies its stricter profile.
 const txid=Buffer.from(keccak_256(join(keccak_256(data.subarray(0,prefixEnd)),keccak_256(data.subarray(prefixEnd,baseEnd)),keccak_256(data.subarray(baseEnd))))).toString('hex');
 return {txid,inputs,outputs,unlockTime,fee,extra,data,extraStart,prefixEnd,baseEnd};
}
