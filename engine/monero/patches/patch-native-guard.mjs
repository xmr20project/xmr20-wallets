// Website copies of the installed extension's native worker: two narrow patches (28 Oct 2026, owner: "it just said i had over
// 0.02 XMR available for sends. now its not working?").
// Cause: the carrier guard (written for the older XN1 format) cannot read an XMR20-TKD1 carrier's tx_extra (0x7F-marked
// records that are not XN1), treats it as malformed and freezes every output of that transaction, including the holder's
// change from an XMR20 operation. The worker never thaws, so that XMR stays unspendable (and frozen coins leave the balance).
// TKD1 tokens belong to the XMR20 owner key / shielded notes and the format forbids native output references
// (research/token-format-unshielded-fix-20261026 DESIGN.txt §3), so those outputs are ordinary XMR.
//  1. native-carrier-guard.js: an extra framed EXACTLY as the TKD1 carrier builder frames it (transport.rs unframe + parts) is
//     ordinary ('xmr20-tkd1-record'); everything else keeps the XN1 rules (unreadable still protects).
//  2. native.worker.js: before freezing, coins the classifier finds ordinary are thawed if an earlier guard froze them; inputs
//     reserved by the spend guard are frozen again by its freeze() right after, as before.
// Run by build-private-assets.mjs after copying the installed files; fails unless each anchor appears exactly once.
import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import assert from 'node:assert/strict';
export async function patchNativeGuard(dir){
 // Already patched (extension 0.1.115+ ships these bytes): both markers present -> nothing to do.
 const g=await readFile(join(dir,'native-carrier-guard.js'),'utf8'),w=await readFile(join(dir,'native.worker.js'),'utf8');
 if(g.includes('function isTkd1Carrier(')&&w.includes('Could not release an ordinary coin'))return 'already';
 const edit=async(file,pairs)=>{let s=await readFile(join(dir,file),'utf8');for(const [old,neu] of pairs){assert.equal(s.split(old).length,2,file+': anchor not found exactly once');s=s.replace(old,neu);}await writeFile(join(dir,file),s);};
 await edit('native-carrier-guard.js',[
  ["// outputs: [{keyImage, txHash, vout, extra: Uint8Array|null}]\n",
`// Website wallet, 28 Oct 2026: an XMR20-TKD1 record carrier (XP1/XC1/XR1/XS1/XU1/XMA/XMB) binds no tokens to Monero outputs,
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
`],
  ["try{payload=extractNativePayload(extras[0]);}catch{owned.forEach(o=>protect.add(o.keyImage));details.set(txHash,'extra-malformed');continue;}",
   "try{payload=extractNativePayload(extras[0]);}catch{if(isTkd1Carrier(extras[0])){details.set(txHash,'xmr20-tkd1-record');continue;}owned.forEach(o=>protect.add(o.keyImage));details.set(txHash,'extra-malformed');continue;}"],
  ["self.XMR20CarrierGuard=Object.freeze({extractNativePayload,nativeAllocationVouts,classifyOwnedOutputs,extraFromDaemonJson});",
   "self.XMR20CarrierGuard=Object.freeze({extractNativePayload,nativeAllocationVouts,classifyOwnedOutputs,extraFromDaemonJson,isTkd1Carrier});"]]);
 await edit('native.worker.js',[
  [" for(const image of result.protected){await wallet.freezeOutput(image);",
   " // Website wallet, 28 Oct 2026: coins the classifier finds ordinary are released if an earlier guard froze them (XMR20-TKD1\n"+
   " // carrier change); inputs reserved by the spend guard are frozen again by spendGuard.freeze below.\n"+
   " {const keep=new Set(result.protected);for(const o of outputs){const image=o.getKeyImage()?.getHex();if(typeof image==='string'&&!keep.has(image)&&await wallet.isOutputFrozen(image)){await wallet.thawOutput(image);if(await wallet.isOutputFrozen(image))throw Error('Could not release an ordinary coin');}}}\n"+
   " for(const image of result.protected){await wallet.freezeOutput(image);"]]);
}
