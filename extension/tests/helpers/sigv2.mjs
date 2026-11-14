// Monero wallet message signatures ("SigV2", spend-key type) and standard-address derivation in JavaScript, for the
// offline lab's SYNTHETIC keys. Follows monero's wallet2::sign / verify (v2) and crypto::generate_signature:
//   m   = keccak( "MoneroMessageSignature\0" || spend_pub || view_pub || mode || varint(len(data)) || data )   mode 0 = spend
//   k   = random scalar;  c = Hs( m || pub || k·G );  r = k − c·sec        signature = c || r (64 bytes)
//   verify: c == Hs( m || pub || r·G + c·pub )
//   text = "SigV2" + monero-base58(c || r)
// Hs = keccak256 reduced mod the ed25519 group order. Cross-checked against monero-wallet-rpc when it was written.
// Test helper only: the wallets sign inside their engine and never hold such a key in JavaScript.
import {randomBytes} from 'node:crypto';
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
const L=ed25519.CURVE.n,G=ed25519.ExtendedPoint.BASE;
const le=b=>{let n=0n;for(let i=b.length-1;i>=0;i--)n=(n<<8n)|BigInt(b[i]);return n;};
const toLe=(n,len=32)=>{const b=new Uint8Array(len);for(let i=0;i<len;i++){b[i]=Number(n&255n);n>>=8n;}return b;};
export const keccak=b=>keccak_256(b);
export const hashToScalar=b=>le(keccak_256(b))%L;
const cat=(...parts)=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
// ---- Monero base58 (8-byte blocks → 11 chars; last block shorter)
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BLOCK_LENGTHS=[0,2,3,5,6,7,9,10,11];
export function b58encode(bytes){
 let out='';
 for(let start=0;start<bytes.length;start+=8){const block=bytes.subarray(start,start+8);let n=0n;for(const x of block)n=(n<<8n)|BigInt(x);const size=BLOCK_LENGTHS[block.length];let s='';for(let i=0;i<size;i++){s=ALPHABET[Number(n%58n)]+s;n/=58n;}out+=s;}
 return out;
}
export function b58decode(text){
 const parts=[];
 for(let start=0;start<text.length;start+=11){const block=text.slice(start,start+11),size=BLOCK_LENGTHS.indexOf(block.length);if(size<=0)throw Error('Invalid Monero base58 block');let n=0n;for(const ch of block){const d=ALPHABET.indexOf(ch);if(d<0)throw Error('Invalid Monero base58 character');n=n*58n+BigInt(d);}const b=new Uint8Array(size);for(let i=size-1;i>=0;i--){b[i]=Number(n&255n);n>>=8n;}if(n!==0n)throw Error('Monero base58 overflow');parts.push(b);}
 return cat(...parts);
}
// ---- keys and the standard mainnet-format address (the regtest fakechain uses the mainnet prefix 0x12)
export function keysFromRoot(rootHex){
 const root=Uint8Array.from(Buffer.from(rootHex,'hex'));if(root.length!==32)throw Error('32-byte root required');
 const spend=le(root)%L;// a wallet spend key is already reduced; reducing again is the identity for it
 const view=le(keccak_256(root))%L;
 const spendPub=G.multiply(spend).toRawBytes(),viewPub=G.multiply(view).toRawBytes();
 return {spend,view,spendPub,viewPub,address:encodeAddress(spendPub,viewPub)};
}
export function encodeAddress(spendPub,viewPub,prefix=0x12){
 const body=cat(new Uint8Array([prefix]),spendPub,viewPub);const sum=keccak_256(body).subarray(0,4);
 return b58encode(cat(body,sum));
}
// prefix: 0x12 mainnet format (also the regtest fakechain), 0x18 stagenet (30 Oct 2026: token-lot relay keys on the stagenet test).
export function decodeAddress(address,prefix=0x12){
 if(typeof address!=='string'||address.length!==95)throw Error('Standard 95-character address required');
 const raw=b58decode(address);if(raw.length!==69||raw[0]!==prefix)throw Error(`Standard (prefix ${prefix}) address required`);
 const sum=keccak_256(raw.subarray(0,65)).subarray(0,4);if(Buffer.compare(Buffer.from(sum),Buffer.from(raw.subarray(65)))!==0)throw Error('Address checksum');
 const spendPub=raw.subarray(1,33),viewPub=raw.subarray(33,65);
 for(const k of [spendPub,viewPub]){const p=ed25519.ExtendedPoint.fromHex(Buffer.from(k).toString('hex'));if(p.isSmallOrder()||!p.isTorsionFree())throw Error('Invalid public key');}
 return {spendPub,viewPub};
}
const HASH_KEY_MESSAGE_SIGNING=Buffer.from('MoneroMessageSignature\0','latin1');
const varint=n=>{const out=[];while(n>=128){out.push((n&127)|128);n=Math.floor(n/128);}out.push(n);return Uint8Array.from(out);};
function message(data,spendPub,viewPub,mode=0){
 const d=Buffer.from(data,'utf8');
 return keccak_256(cat(HASH_KEY_MESSAGE_SIGNING,spendPub,viewPub,new Uint8Array([mode]),varint(d.length),d));
}
export function sign(data,keys){
 const m=message(data,keys.spendPub,keys.viewPub,0);
 const k=le(randomBytes(64))%L;const kG=G.multiply(k).toRawBytes();
 const c=hashToScalar(cat(m,keys.spendPub,kG));
 const r=(((k-c*keys.spend)%L)+L)%L;
 return 'SigV2'+b58encode(cat(toLe(c),toLe(r)));
}
export function verify(data,address,signature,prefix=0x12){
 try{
  if(typeof signature!=='string'||!/^SigV2[1-9A-HJ-NP-Za-km-z]{88}$/.test(signature))return false;
  const {spendPub,viewPub}=decodeAddress(address,prefix);
  const sig=b58decode(signature.slice(5));if(sig.length!==64)return false;
  const c=le(sig.subarray(0,32)),r=le(sig.subarray(32));if(c>=L||r>=L)return false;
  const m=message(data,spendPub,viewPub,0);
  const pub=ed25519.ExtendedPoint.fromHex(Buffer.from(spendPub).toString('hex'));
  const comm=G.multiply(r).add(pub.multiply(c)).toRawBytes();
  return hashToScalar(cat(m,spendPub,comm))===c;
 }catch{return false;}
}
export const isAddress=a=>{try{decodeAddress(a);return true;}catch{return false;}};
