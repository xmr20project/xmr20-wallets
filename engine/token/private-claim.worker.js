// One-shot worker for the private-format test build. The seed enters here, is
// used once, and is wiped; only PUBLIC keys and a signature leave.
//
// Investigated monero-ts path (vendor/monero-0.11.16.js, the build the shipping
// workers load): it exposes the account key schedule (create_full_wallet from a
// seed, get_address, get_private_view_key / get_private_spend_key) and
// sign_message, which signs with the ACCOUNT spend or view key. It exposes NO
// per-output secret derivation and NO plain generate_signature without a key
// image (reserve/spend proofs reveal key images). The migration claim must be
// signed under the legacy OUTPUT key P, so the per-output derivation
// x = Hs(8 a R || i) + b and Monero's generate_signature are implemented here
// with @noble/curves + @noble/hashes (already shipped in the extension), fed by
// the account keys monero-ts derives from the seed. No constant-time claim.
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {bytesToHex,hexToBytes} from '@noble/hashes/utils';
for(const name of ['log','info','warn','error','debug'])console[name]=()=>{};
const ORDER=ed25519.CURVE.n,G=ed25519.ExtendedPoint.BASE;
const le=bytes=>{let n=0n;for(let i=bytes.length-1;i>=0;i--)n=(n<<8n)|BigInt(bytes[i]);return n;};
const uint=(n,len)=>{const out=new Uint8Array(len);let x=BigInt(n);for(let i=0;i<len;i++){out[i]=Number(x&0xffn);x>>=8n;}return out;};
const cat=(...parts)=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
const varint=n=>{const out=[];let x=BigInt(n);while(x>=0x80n){out.push(Number(x&0x7fn)|0x80);x>>=7n;}out.push(Number(x));return Uint8Array.from(out);};
const Hs=b=>le(keccak_256(b))%ORDER;
const point=hex=>ed25519.ExtendedPoint.fromHex(hex,false);
const randomScalar=()=>{let k;do{const b=new Uint8Array(64);crypto.getRandomValues(b);k=le(b)%ORDER;}while(!k);return k;};
const loadNative=async()=>{importScripts('monero-0.11.16.js');return self.monero_ts({print:()=>{},printErr:()=>{}});};
// Monero generate_signature: comm = kG; c = Hs(prefix || P || comm); r = k - c x.
function generateSignature(messageHashHex,x){const P=G.multiply(x).toRawBytes();let c,r;do{const k=randomScalar();const R=G.multiply(k).toRawBytes();c=Hs(cat(hexToBytes(messageHashHex),P,R));r=((k-c*x)%ORDER+ORDER)%ORDER;}while(!c||!r);return bytesToHex(cat(uint(c,32),uint(r,32)));}
async function withAccountKeys(seed,owner,fn){if(typeof seed!=='string'||seed.trim().split(/\s+/).length!==25)throw Error('Saved Monero wallet is unavailable.');let m,p;
 try{m=await loadNative();p=await new Promise((resolve,reject)=>m.create_full_wallet(JSON.stringify({networkType:0,seed:seed.trim().toLowerCase().replace(/\s+/g,' '),seedOffset:'',path:'',password:'',restoreHeight:0}),'private-claim-offline',v=>typeof v==='number'&&v>0?resolve(v):reject(Error('Monero keys unavailable.'))));seed='';
  if(m.get_address(p,0,0)!==owner)throw Error('Saved Monero wallet does not match this account.');
  if(typeof m.get_private_view_key!=='function'||typeof m.get_private_spend_key!=='function')throw Error('BLOCKER: this monero-ts build exposes no private key accessors.');
  const a=BigInt('0x'+bytesToHex(hexToBytes(m.get_private_view_key(p)).reverse())),b=BigInt('0x'+bytesToHex(hexToBytes(m.get_private_spend_key(p)).reverse()));
  return await fn({a,b});
 }finally{seed='';if(m&&p)await new Promise(resolve=>m.close(p,false,0,resolve));}}
self.onmessage=async({data})=>{if(typeof data?.id!=='string')return;try{let result;
 if(data.action==='public-keys')result=await withAccountKeys(data.seed,data.owner,({a,b})=>({A:bytesToHex(G.multiply(a).toRawBytes()),B:bytesToHex(G.multiply(b).toRawBytes())}));
 else if(data.action==='sign-claim'){const r=data.review;if(!/^[0-9a-f]{64}$/.test(r?.messageHash)||!/^[0-9a-f]{64}$/.test(r?.P)||!/^[0-9a-f]{64}$/.test(r?.txPublicKey)||!Number.isInteger(r?.outputIndex))throw Error('Invalid claim review.');
  result=await withAccountKeys(data.seed,data.owner,({a,b})=>{const D=point(r.txPublicKey).multiply(8n).multiply(a).toRawBytes();const x=(Hs(cat(D,varint(r.outputIndex)))+b)%ORDER;
   if(bytesToHex(G.multiply(x).toRawBytes())!==r.P)throw Error('This legacy output does not belong to this wallet.');return {signature:generateSignature(r.messageHash,x),P:r.P};});}
 // ADDRESS-BASED CLAIM (cutover snapshot v2): the entitlement is this account's Monero ADDRESS; sign under its public spend key B
 // with the account's spend secret b. Nothing is derived per output, nothing is spent, no key image is produced.
 else if(data.action==='sign-address-claim'){const r=data.review;if(!/^[0-9a-f]{64}$/.test(r?.messageHash)||!/^[0-9a-f]{64}$/.test(r?.legacyOwner))throw Error('Invalid claim review.');
  result=await withAccountKeys(data.seed,data.owner,({b})=>{if(bytesToHex(G.multiply(b).toRawBytes())!==r.legacyOwner)throw Error('This legacy entitlement belongs to another Monero address.');return {signature:generateSignature(r.messageHash,b),P:r.legacyOwner};});}
 else throw Error('Unknown action');
 self.postMessage({id:data.id,result});
 }catch(e){self.postMessage({id:data.id,error:/BLOCKER|does not belong|does not match|Invalid/.test(e?.message||'')?e.message:'Monero claim signing failed. Reopen with the original saved wallet.'});}finally{if(data)data.seed='';self.close();}};
