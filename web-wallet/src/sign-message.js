// Monero addresses and wallet message signatures, as Feather, Cake Wallet, the Monero GUI/CLI and monero-ts make them (all are
// wallet2: wallet2::sign / wallet2::verify, "SigV2"). Checks a pasted signature in the browser before it is sent (sign-wallet.jsx).
//   hash  = keccak256("MoneroMessageSignature\0" || B || A || mode || varint(len) || message)   B/A = spend/view public keys in the
//           address that signs (a subaddress's own keys for a subaddress), mode 0 = signed with the spend key, 1 = view key
//   sig   = (c, r): R = kG, c = Hs(hash || P || R), r = k - c*p                                  (crypto::generate_signature)
//   text  = "SigV2" + Monero base58(c || r)
// verifySpendSignature accepts ONLY mode 0 under the address's spend key: a view-key signature (which wallet2::verify also accepts)
// proves no spending authority, so it never moves tokens here.
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
const L=ed25519.CURVE.n,G=ed25519.ExtendedPoint.BASE,ZERO=ed25519.ExtendedPoint.ZERO;
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const FULL_BLOCK=8,FULL_ENCODED=11,ENCODED_SIZE=[0,2,3,5,6,7,9,10,11];
const enc=new TextEncoder();
export const NETWORKS={mainnet:{main:18,sub:42,integrated:19},stagenet:{main:24,sub:36,integrated:25},testnet:{main:53,sub:63,integrated:54}};
export const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
export const unhex=h=>{if(typeof h!=='string'||h.length%2||/[^0-9a-f]/.test(h))throw Error('Not hex');return Uint8Array.from(h.match(/../g)||[],x=>parseInt(x,16));};
export const concat=(...parts)=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
export const le=b=>{let n=0n;for(let i=b.length-1;i>=0;i--)n=(n<<8n)|BigInt(b[i]);return n;};
export const leBytes=(n,size=32)=>{const out=new Uint8Array(size);for(let i=0;i<size;i++){out[i]=Number(n&255n);n>>=8n;}return out;};
export const Hs=b=>le(keccak_256(b))%L;
const varint=n=>{const out=[];do{let b=n&127;n=Math.floor(n/128);if(n)b|=128;out.push(b);}while(n);return Uint8Array.from(out);};

// Monero base58: 8-byte blocks -> 11 characters, the last block shorter.
export function base58Encode(bytes){
 let out='';for(let i=0;i<bytes.length;i+=FULL_BLOCK){const block=bytes.subarray(i,i+FULL_BLOCK);let n=0n;for(const b of block)n=n*256n+BigInt(b);
  let s='';for(let j=0;j<ENCODED_SIZE[block.length];j++){s=ALPHABET[Number(n%58n)]+s;n/=58n;}out+=s;}
 return out;}
export function base58Decode(text){
 const out=[];for(let i=0;i<text.length;i+=FULL_ENCODED){const block=text.slice(i,i+FULL_ENCODED),size=ENCODED_SIZE.indexOf(block.length);if(size<1)throw Error('Bad base58 length');
  let n=0n;for(const ch of block){const k=ALPHABET.indexOf(ch);if(k<0)throw Error('Bad base58 character');n=n*58n+BigInt(k);}
  if(n>=1n<<BigInt(8*size))throw Error('Bad base58 block');const part=new Array(size);for(let j=size-1;j>=0;j--){part[j]=Number(n&255n);n>>=8n;}out.push(...part);}
 return Uint8Array.from(out);}

// A standard address or subaddress (integrated addresses are refused: use the address itself).
export function decodeAddress(address,network='mainnet'){
 const tags=NETWORKS[network];if(!tags)throw Error('Unknown network');
 if(typeof address!=='string')throw Error('Not a Monero address.');address=address.trim();
 if(address.length===106)throw Error('Use your main address or a subaddress, not an integrated address.');
 if(address.length!==95)throw Error('A Monero address has 95 characters.');
 let b;try{b=base58Decode(address);}catch{throw Error('Not a Monero address.');}
 if(b.length!==69)throw Error('Not a Monero address.');
 const sum=keccak_256(b.subarray(0,65));if(b.subarray(65).some((x,i)=>x!==sum[i]))throw Error('Monero address checksum is wrong.');
 const kind=b[0]===tags.main?'main':b[0]===tags.sub?'sub':null;
 if(!kind){const other=Object.entries(NETWORKS).find(([,t])=>Object.values(t).includes(b[0]));throw Error(other?`This is a ${other[0]} address; use a ${network} address.`:'Not a Monero address.');}
 return {network,kind,spend:b.slice(1,33),view:b.slice(33,65),address};}
export function encodeAddress({spend,view,kind='main',network='mainnet'}){
 const tag=NETWORKS[network][kind];const body=concat(Uint8Array.of(tag),spend,view);return base58Encode(concat(body,keccak_256(body).subarray(0,4)));}

const PREFIX=concat(enc.encode('MoneroMessageSignature'),Uint8Array.of(0));
export function messageHash(message,spend,view,mode=0){
 const data=typeof message==='string'?enc.encode(message):message;
 return keccak_256(concat(PREFIX,spend,view,Uint8Array.of(mode),varint(data.length),data));}
// A spend public key that can authorise anything: on the curve, in the prime-order group and not the identity.
export function usableSpendKey(spend){try{const P=ed25519.ExtendedPoint.fromHex(spend);return !P.equals(ZERO)&&P.isTorsionFree()?P:null;}catch{return null;}}
export function parseSignature(text){
 if(typeof text!=='string')throw Error('Paste the signature.');text=text.trim();
 if(text.startsWith('SigV1'))throw Error('This is an old SigV1 signature; sign again with a current wallet.');
 if(!text.startsWith('SigV2'))throw Error('A Monero message signature starts with SigV2.');
 let b;try{b=base58Decode(text.slice(5));}catch{throw Error('The signature is damaged; copy it again.');}
 if(b.length!==64)throw Error('The signature is damaged; copy it again.');
 return {c:b.slice(0,32),r:b.slice(32)};}
// True only when `signature` is a mode-0 (spend key) wallet2 signature of exactly `message` by `address`.
export function verifySpendSignature(message,address,signature,network='mainnet'){
 try{const a=typeof address==='string'?decodeAddress(address,network):address,{c,r}=typeof signature==='string'?parseSignature(signature):signature;
  const P=usableSpendKey(a.spend);if(!P)return false;const cs=le(c),rs=le(r);if(cs===0n||cs>=L||rs>=L)return false;
  const R=(rs===0n?ZERO:G.multiply(rs)).add(P.multiply(cs));const h=messageHash(message,a.spend,a.view,0);
  return Hs(concat(h,a.spend,R.toRawBytes()))===cs;}
 catch{return false;}}

// Signing with a secret spend key (the XMR20 wallet can sign for its own address; tests use throwaway keys).
export function signWithSpendKey(message,{spend,view},secret,random=n=>crypto.getRandomValues(new Uint8Array(n))){
 const p=le(secret)%L;if(p===0n)throw Error('Invalid secret key');if(hex(G.multiply(p).toRawBytes())!==hex(spend))throw Error('This key does not belong to the address.');
 const h=messageHash(message,spend,view,0);let k=0n;while(k===0n)k=le(random(64))%L;const R=G.multiply(k).toRawBytes();
 const c=Hs(concat(h,spend,R)),r=((k-c*p)%L+L)%L;return 'SigV2'+base58Encode(concat(leBytes(c),leBytes(r)));}
// Keys of subaddress (account, index) from the private view key and the public/secret spend key, as wallet2 derives them.
export function subaddressSecret(viewSecret,account,index){if(!account&&!index)return 0n;
 return Hs(concat(enc.encode('SubAddr'),Uint8Array.of(0),viewSecret,leBytes(BigInt(account),4),leBytes(BigInt(index),4)));}
export function subaddressKeys({spendSecret,viewSecret,account,index}){
 const d=(le(spendSecret)+subaddressSecret(viewSecret,account,index))%L,D=G.multiply(d),C=D.multiply(le(viewSecret)%L);
 return {secret:leBytes(d),spend:D.toRawBytes(),view:C.toRawBytes()};}
