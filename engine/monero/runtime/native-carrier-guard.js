/* Ordinary-send guard for native XMR20 token carriers. Pure structural
 * inspection of Monero tx_extra: no consensus validation, no network, no keys.
 * Loaded by native.worker.js before wallet2 selects inputs for an ordinary XMR
 * send or sweep, so every output that an XN1 native token operation may have
 * allocated tokens to is frozen first.
 *
 * Policy (fail closed; mirrors the market worker's conservative classification):
 * - an owned output whose creating transaction carries no XN1 payload is ordinary;
 * - a transaction carrying an XN1 payload protects every owned output of that
 *   transaction unless the caller has verified output-index semantics
 *   (trustVout), in which case a decodable CREDIT/MOVE/BURN protects exactly
 *   the allocated outputs and an undecodable payload still protects all;
 * - an output whose tx_extra is unavailable is reported as `unknown`; the
 *   caller must refuse to send until it can be inspected.
 */
'use strict';
(function(){
const MARKER=[0x7f,0x58,0x4e,0x31],MAGIC=[0x58,0x4e,0x31],OPS={1:'CREDIT',2:'MOVE',3:'BURN'},RECORD_MAX=960;
class Reader{
 constructor(data){this.data=data;this.at=0;}
 take(n){if(!Number.isSafeInteger(n)||n<0||this.at+n>this.data.length)throw Error('Truncated extra');const out=this.data.subarray(this.at,this.at+n);this.at+=n;return out;}
 u(width){let n=0n;const b=this.take(width);for(let i=width-1;i>=0;i--)n=(n<<8n)|BigInt(b[i]);return width===8?n:Number(n);}
 varint(limit=(1n<<64n)-1n){let n=0n;for(let i=0;i<10;i++){const b=this.u(1);n|=BigInt(b&127)<<BigInt(i*7);if(!(b&128)){if(n>limit||(i&&b===0))throw Error('Noncanonical varint');return n;}}throw Error('Excessive varint');}
 done(){if(this.at!==this.data.length)throw Error('Trailing bytes');}
}
const startsWith=(bytes,prefix)=>prefix.every((v,i)=>bytes[i]===v);
// null when no XN1 fragments exist; the payload when well framed; throws when
// extra or framing is malformed (callers treat throws as protected).
function extractNativePayload(extra){
 if(!(extra instanceof Uint8Array))throw Error('Extra bytes required');
 if(extra.length>1060)throw Error('Extra exceeds relay limit');
 const r=new Reader(extra),chunks=[];
 while(r.at<r.data.length){
  const tag=r.u(1);
  if(tag===0){if(!r.take(r.data.length-r.at).every(x=>x===0))throw Error('Invalid padding');}
  else if(tag===1)r.take(32);
  else if(tag===4)r.take(32*Number(r.varint(16n)));
  else if(tag===2){const length=Number(r.varint(255n)),content=r.take(length);if(startsWith(content,MAGIC))throw Error('Raw XN1 framing');if(startsWith(content,MARKER))chunks.push(content);
   else if(content[0]===0x7f||content[0]===0x58||content.some((b,i)=>b===0x58&&content[i+1]===0x4e))throw Error('Unknown or truncated native token framing');}
  else if(tag===3)r.take(Number(r.varint(1060n)));
  else throw Error('Unknown extra tag');
 }
 if(!chunks.length)return null;
 const count=chunks[0][5];
 if(!(count>=1&&count<=4&&chunks.length===count))throw Error('Invalid XN1 fragment count');
 chunks.forEach((c,i)=>{if(!(c.length>6&&c.length<=246&&c[4]===i&&c[5]===count&&(i===count-1||c.length===246)))throw Error('Invalid XN1 fragment');});
 const total=chunks.reduce((n,c)=>n+c.length-6,0),payload=new Uint8Array(total);
 let at=0;for(const c of chunks){payload.set(c.subarray(6),at);at+=c.length-6;}
 return payload;
}
// Structural decode of the allocation targets of an XN1 record. Proofs and
// signatures are not verified here; only output indices are extracted.
function nativeAllocationVouts(payload){
 const r=new Reader(payload);
 if(payload.length>RECORD_MAX||!startsWith(r.take(3),MAGIC)||r.u(1)!==2)throw Error('Unknown record');
 const op=OPS[r.u(1)];if(!op)throw Error('Unsupported operation');
 const size=r.u(2);if(payload.length!==39+size)throw Error('Wrong record length');
 r.take(32);
 const vouts=new Set();
 if(op==='CREDIT'){
  r.take(32);r.take(32);r.u(4);vouts.add(r.u(2));r.u(8);r.take(32);r.take(32);r.take(32);
  const n=r.u(1);if(n<1||n>8)throw Error('Invalid signature count');
  for(let i=0;i<n;i++){r.u(1);r.take(64);}
 }else{
  const claims=r.u(1);if(claims<1||claims>8)throw Error('Invalid claim count');
  for(let i=0;i<claims;i++){r.u(2);r.u(1);r.take(32);r.u(4);r.take(32);r.take(32);}
  if(op==='BURN'){r.u(8);r.take(32);r.take(32);}
  const allocations=r.u(1);if(allocations>16||(op==='MOVE'&&allocations<1))throw Error('Invalid allocation count');
  for(let i=0;i<allocations;i++){vouts.add(r.u(2));r.u(8);r.take(32);r.take(32);r.take(32);}
 }
 r.done();
 return {op,vouts};
}
// Website wallet, 28 Oct 2026: an XMR20-TKD1 record carrier (XP1/XC1/XR1/XS1/XU1/XMA/XMB) binds no tokens to Monero outputs,
// so its outputs, including the holder's change, are ordinary XMR. Recognised only when framed exactly as the TKD1 carrier
// builder frames it: one tx pubkey, at most one encrypted payment id, 0x7F-marked nonce chunks of 254 bytes (the last 1..254)
// whose concatenation (at most 1,011 bytes) starts with a known TKD1 magic. Anything else keeps the XN1 rules.
const TKD1_MAGICS=['XP1','XC1','XR1','XS1','XU1','XMA','XMB'].map(m=>[...m].map(c=>c.charCodeAt(0)).concat(0xfe));
function isTkd1Carrier(extra){
 try{
  if(!(extra instanceof Uint8Array)||extra.length>1060)return false;
  let at=0,pubkeys=0,paymentIds=0;const chunks=[];
  while(at<extra.length){
   const tag=extra[at++];
   if(tag===1){pubkeys++;if(pubkeys!==1||at+32>extra.length)return false;at+=32;}
   else if(tag===2){
    let len=0,shift=0;for(;;){if(at>=extra.length||shift>7)return false;const n=extra[at++];len|=(n&127)<<shift;if(n<128){if(shift!==0&&n===0)return false;break;}shift+=7;}
    if(!(len>0&&len<=255&&at+len<=extra.length))return false;const d=extra.subarray(at,at+len);at+=len;
    if(d[0]===127)chunks.push(d.subarray(1));else{paymentIds++;if(paymentIds!==1||d[0]!==1||d.length!==9)return false;}
   }else return false;
  }
  if(pubkeys!==1||!chunks.length)return false;
  const total=chunks.reduce((n,c)=>n+c.length,0);if(total<4||total>1011)return false;
  if(chunks.some((c,i)=>i<chunks.length-1?c.length!==254:!(c.length>=1&&c.length<=254)))return false;
  return TKD1_MAGICS.some(m=>m.every((v,i)=>chunks[0][i]===v));
 }catch{return false;}
}
// outputs: [{keyImage, txHash, vout, extra: Uint8Array|null}]
// Returns {protected:[keyImage], unknown:[txHash], details:Map<txHash,reason>}.
function classifyOwnedOutputs(outputs,{trustVout=false}={}){
 if(!Array.isArray(outputs))throw Error('Output list required');
 const byTx=new Map();
 for(const o of outputs){
  if(typeof o?.keyImage!=='string'||!/^[a-f0-9]{64}$/.test(o.keyImage)||typeof o.txHash!=='string'||!/^[a-f0-9]{64}$/.test(o.txHash))throw Error('Canonical output identity required');
  if(!byTx.has(o.txHash))byTx.set(o.txHash,[]);
  byTx.get(o.txHash).push(o);
 }
 const protect=new Set(),unknown=[],details=new Map();
 for(const [txHash,owned] of byTx){
  const extras=owned.map(o=>o.extra).filter(e=>e instanceof Uint8Array);
  if(extras.length!==owned.length){unknown.push(txHash);details.set(txHash,'extra-unavailable');continue;}
  if(extras.some(e=>e.length!==extras[0].length||e.some((b,i)=>b!==extras[0][i]))){owned.forEach(o=>protect.add(o.keyImage));details.set(txHash,'extra-inconsistent');continue;}
  let payload;
  try{payload=extractNativePayload(extras[0]);}catch{if(isTkd1Carrier(extras[0])){details.set(txHash,'xmr20-tkd1-record');continue;}owned.forEach(o=>protect.add(o.keyImage));details.set(txHash,'extra-malformed');continue;}
  if(payload===null){details.set(txHash,'ordinary');continue;}
  let decoded;
  try{decoded=nativeAllocationVouts(payload);}catch{owned.forEach(o=>protect.add(o.keyImage));details.set(txHash,'native-undecodable');continue;}
  if(!trustVout){owned.forEach(o=>protect.add(o.keyImage));details.set(txHash,'native-'+decoded.op+'-all');continue;}
  for(const o of owned){
   if(!Number.isSafeInteger(o.vout)||o.vout<0){protect.add(o.keyImage);details.set(txHash,'native-'+decoded.op+'-vout-unknown');continue;}
   if(decoded.vouts.has(o.vout))protect.add(o.keyImage);
  }
  if(!details.has(txHash))details.set(txHash,'native-'+decoded.op);
 }
 return {protected:[...protect],unknown,details};
}
// Parse the `extra` byte array of a daemon /get_transactions as_json entry.
function extraFromDaemonJson(json){
 const parsed=typeof json==='string'?JSON.parse(json):json,extra=parsed?.extra;
 if(!Array.isArray(extra)||!extra.every(b=>Number.isInteger(b)&&b>=0&&b<=255))throw Error('Daemon extra unavailable');
 return Uint8Array.from(extra);
}
self.XMR20CarrierGuard=Object.freeze({extractNativePayload,nativeAllocationVouts,classifyOwnedOutputs,extraFromDaemonJson,isTkd1Carrier});
})();
