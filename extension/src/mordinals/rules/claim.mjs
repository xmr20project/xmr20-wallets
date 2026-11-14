// The two proofs that a Mordinal's owner coin is controlled, without spending it (RULES.md, "Claim").
//
// Owner coin: output 0 of the owner transaction, one-time key P, transaction public key R.
//   derivation  Dv = 8·a·R                       a = the holder's private view key
//   P           = Hs(Dv ‖ varint 0)·G + B        B = the spend public key of the address (a subaddress's own key)
//   secret      x = Hs(Dv ‖ varint 0) + b (+ m)  b = private spend key, m = the subaddress scalar; P = x·G
//
// Proof 0, one-time key. A plain Schnorr signature under P (the form of crypto::generate_signature):
//   h = keccak256("MORDINALS-CLAIM-KEY-v1\0" ‖ domain32 ‖ claim body);  R' = k·G;  c = Hs(h ‖ P ‖ R');  r = k − c·x
//   It shows nothing but P, which the owner list already holds. No address, no key image.
//
// Proof 1, payment proof + message. wallet2 "InProofV2" for the owner transaction and the holder's address:
//   D = a·R;  prefix = keccak256(txid ‖ message);  X = c·V + r·(G, or B for a subaddress);  Y = c·D + r·R
//   c = Hs(prefix ‖ D ‖ X ‖ Y ‖ keccak256("TXPROOF_V2") ‖ V ‖ R ‖ (B for a subaddress, else 32 zero bytes))
//   V = the address's view public key. The proof text is "InProofV2" + base58(D) + base58(c ‖ r).
//   Then P must equal Hs(8·D ‖ varint 0)·G + B. A payment proof needs only the view key, so the claim also needs a spend-key
//   message signature from the same address (monero.mjs).
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {base58Decode,base58Encode,usableSpendKey,hex,unhex,concat,le,leBytes,Hs,decodeAddress,encodeAddress,subaddressSecret} from './monero.mjs';
const Pt=ed25519.ExtendedPoint,L=ed25519.CURVE.n,G=Pt.BASE,enc=new TextEncoder();
const KEY_TAG=concat(enc.encode('MORDINALS-CLAIM-KEY-v1'),Uint8Array.of(0)),SEP=keccak_256(enc.encode('TXPROOF_V2')),VIEW_TAG=enc.encode('view_tag');
const varint=n=>{const out=[];do{let b=n&127;n=Math.floor(n/128);if(n)b|=128;out.push(b);}while(n);return Uint8Array.from(out);};
const mul=(point,scalar)=>{const s=((scalar%L)+L)%L;return s===0n?Pt.ZERO:point.multiply(s);};
const times8=p=>p.double().double().double();
const point=b=>Pt.fromHex(typeof b==='string'?b:hex(b));
const bytes=b=>typeof b==='string'?unhex(b):b;

export const claimKeyHash=(domain,bodyBytes)=>keccak_256(concat(KEY_TAG,unhex(domain),bodyBytes));
const outputScalar=(derivation,index)=>Hs(concat(derivation,varint(index)));
// 8·a·R as bytes: the key derivation wallets use.
export const derivation=(viewSecret,txPub)=>times8(mul(point(txPub),le(bytes(viewSecret)))).toRawBytes();
export const viewTag=(deriv,index=0)=>keccak_256(concat(VIEW_TAG,deriv,varint(index)))[0];

// The one-time secret key of the owner coin. subScalar is 0 for the main address.
export function outputSecret({viewSecret,spendSecret,txPub,index=0,subScalar=0n}){
 return (outputScalar(derivation(viewSecret,txPub),index)+le(bytes(spendSecret))+subScalar)%L;}
export function signWithOutputKey(hash,x,random=n=>crypto.getRandomValues(new Uint8Array(n))){
 if(x<=0n||x>=L)throw Error('Invalid key');const P=G.multiply(x).toRawBytes();let k=0n;while(k===0n)k=Hs(concat(enc.encode('mordinals-claim-nonce'),random(64),leBytes(x),hash,P));
 const c=Hs(concat(hash,P,G.multiply(k).toRawBytes())),r=((k-c*x)%L+L)%L;return {c:leBytes(c),r:leBytes(r),key:hex(P)};}
export function verifyOutputKeySignature(hash,outputKey,c,r){
 try{const P=usableSpendKey(bytes(outputKey));if(!P)return false;const cs=le(c),rs=le(r);if(cs===0n||cs>=L||rs>=L)return false;
  return Hs(concat(hash,bytes(outputKey),mul(G,rs).add(P.multiply(cs)).toRawBytes()))===cs;}
 catch{return false;}}

// Which entries of the owner list belong to a wallet. Runs locally: the list is public, the keys never leave.
// spends: Map of spend public key (hex) -> anything (the wallet's main address and its subaddresses).
export function findMine(owners,{viewSecret,spends}){
 const a=le(bytes(viewSecret))%L,mine=[];
 for(const o of owners){
  const d=times8(mul(point(o.ownerTxPubKeys[0]),a)).toRawBytes();
  if(o.ownerViewTag!=null&&viewTag(d)!==parseInt(o.ownerViewTag,16))continue;
  const B=hex(point(o.ownerOutputKey).subtract(mul(G,outputScalar(d,0))).toRawBytes());
  if(spends.has(B))mine.push({entry:o,spend:B,at:spends.get(B)});}
 return mine;}

// A wallet2 payment proof for one transaction public key.
export function parseInProof(text){
 if(typeof text!=='string'||!text.trim())throw Error('Paste the payment proof.');text=text.trim();
 if(text.startsWith('OutProof'))throw Error('This is an OutProof (made by the sender). Make the proof for your own receiving address.');
 if(text.startsWith('InProofV1'))throw Error('This is an old InProofV1; make the proof again with a current wallet.');
 if(text.startsWith('SpendProof')||text.startsWith('ReserveProof'))throw Error('Spend proofs and reserve proofs are never accepted. Make an InProof.');
 if(!text.startsWith('InProofV2'))throw Error('A payment proof starts with InProofV2.');
 const rest=text.slice(9);if(rest.length!==132)throw Error('The payment proof is damaged or covers more than one transaction key; copy it again.');
 let D,s;try{D=base58Decode(rest.slice(0,44));s=base58Decode(rest.slice(44));}catch{throw Error('The payment proof is damaged; copy it again.');}
 if(D.length!==32||s.length!==64)throw Error('The payment proof is damaged; copy it again.');
 return {D,c:s.slice(0,32),r:s.slice(32)};}
export const formatInProof=({D,c,r})=>'InProofV2'+base58Encode(D)+base58Encode(concat(c,r));
// address: {spend, view, kind} as decodeAddress gives it. message: the text given to the wallet with the proof ('' here).
export function verifyInProof({txid,txPub,address,message='',D,c,r}){
 try{const cs=le(c),rs=le(r);if(cs>=L||rs>=L)return false;
  const V=point(address.view),R=point(txPub),Dp=point(D),sub=address.kind==='sub',B=sub?point(address.spend):G;
  const X=mul(V,cs).add(mul(B,rs)),Y=mul(Dp,cs).add(mul(R,rs));
  const prefix=keccak_256(concat(unhex(txid),enc.encode(message)));
  return Hs(concat(prefix,bytes(D),X.toRawBytes(),Y.toRawBytes(),SEP,address.view,bytes(txPub),sub?address.spend:new Uint8Array(32)))===cs;}
 catch{return false;}}
// True when output `index` of the transaction, with shared secret D = a·R, pays the address with this spend key.
export function ownsOutput({D,spend,outputKey,index=0}){
 try{const d=times8(point(D)).toRawBytes();return hex(mul(G,outputScalar(d,index)).add(point(spend)).toRawBytes())===(typeof outputKey==='string'?outputKey:hex(outputKey));}
 catch{return false;}}

// Proof 1 for wallets that sign messages but do not make the payment proof themselves (Cake Wallet; Feather for a transaction the
// wallet sent). The proof needs only the private view key, which those wallets show, so it can be made outside the wallet. It is the
// same InProofV2 that wallet2 get_tx_proof makes, and the claim still needs the message signed in the wallet with the spend key.
// Runs locally: the view key is used here and goes nowhere. address: {spend, view, kind} as decodeAddress gives it.
export function inProofFromViewKey({txid,txPub,address,viewSecret,message='',random=n=>crypto.getRandomValues(new Uint8Array(n))}){
 const a=le(bytes(viewSecret))%L,sub=address.kind==='sub',B=sub?point(address.spend):G;
 if(a===0n||hex(B.multiply(a).toRawBytes())!==hex(bytes(address.view)))throw Error('This private view key does not belong to this address.');
 const R=point(txPub),D=R.multiply(a).toRawBytes();let k=0n;while(k===0n)k=Hs(concat(enc.encode('mordinals-inproof-nonce'),random(64),leBytes(a),unhex(txid),enc.encode(message),bytes(txPub)));
 const prefix=keccak_256(concat(unhex(txid),enc.encode(message)));
 const c=Hs(concat(prefix,D,B.multiply(k).toRawBytes(),R.multiply(k).toRawBytes(),SEP,bytes(address.view),bytes(txPub),sub?bytes(address.spend):new Uint8Array(32)));
 return formatInProof({D,c:leBytes(c),r:leBytes(((k-c*a)%L+L)%L)});}
// "Find my Mordinals" with the main address and the private view key only. Checks the main address and its first subaddresses
// against the public owner list and makes the payment proof for each coin found. holder is the address that must sign the claim.
export function findWithViewKey(owners,{address,viewSecret,network='mainnet',accounts=1,subaddresses=50}){
 const main=decodeAddress(address,network);if(main.kind!=='main')throw Error('Give the main address of the wallet, not a subaddress.');
 const a=le(bytes(viewSecret))%L;if(a===0n||hex(G.multiply(a).toRawBytes())!==hex(main.view))throw Error('This private view key does not belong to this address.');
 const spends=new Map([[hex(main.spend),{holder:main.address,key:main,account:0,index:0}]]);
 for(let account=0;account<accounts;account++)for(let index=account?0:1;index<subaddresses;index++){
  const S=point(main.spend).add(G.multiply(subaddressSecret(bytes(viewSecret),account,index))),key={kind:'sub',spend:S.toRawBytes(),view:S.multiply(a).toRawBytes()};
  spends.set(hex(key.spend),{holder:encodeAddress({...key,network}),key,account,index});}
 return findMine(owners,{viewSecret,spends}).map(({entry,at})=>({entry,holder:at.holder,account:at.account,index:at.index,
  proof:inProofFromViewKey({txid:entry.ownerTx,txPub:entry.ownerTxPubKeys[0],address:at.key,viewSecret})}));}
