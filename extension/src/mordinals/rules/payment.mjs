// Payments. A buy record names, for each payee, one output of one transaction and a proof that the payer's transaction
// key made that output. The key itself stays in the payer's wallet: whoever holds a transaction key can make a second
// transaction with the same output keys.
//   shared secret  D = r·V               V = the payee's view public key (a subaddress's own C), r = the transaction key, or
//                                        the "additional" key of output i when the transaction carries one key per output
//   proof          wallet2 "OutProofV2" (crypto::generate_tx_proof) for that one key:
//                  prefix = keccak256(txid ‖ message)      message = "mordinals-payment:" domain ":" listing id (both in hex)
//                  X = k·Base, Y = k·V                      Base = G for a main address, the payee's spend key B for a subaddress
//                  c = Hs(prefix ‖ D ‖ X ‖ Y ‖ keccak256("TXPROOF_V2") ‖ R ‖ V ‖ (B for a subaddress, else 32 zero bytes))
//                  s = k − c·r                              R = r·Base, the public key the transaction carries for that key
//                  (the output number and, for a main address, B are not part of c, as in wallet2; the output key
//                  check below binds both)
//                  check: X = c·R + s·Base and Y = c·D + s·V give the same c
//   derivation     8·D
//   output i       Hs(8D‖varint i)·G + B   B = the payee's spend public key; equal to the output key → the output pays this address
//   amount         ecdh 8 bytes XOR keccak("amount"‖Hs(8D‖i))[0..8]
//   commitment     Hs("commitment_mask"‖Hs(8D‖i))·G + amount·H must equal the output's commitment (outPk), so a forged amount is refused
// An output only counts when the payee's own wallet can find and spend it like any other payment:
//   - the transaction has no lock time;
//   - the transaction's extra field carries a transaction public key that is a point of the main group (a wallet
//     skips a transaction without one, and wallets differ in what they do with a broken one);
//   - the proof is made for a public key the transaction carries where wallets look for it: the first public key (main
//     key), or entry i of the additional keys, which must number one per output;
//   - the output's view tag, when it has one, is the one this derivation gives.
// With D public, anyone can read the output's amount and copy its key into another transaction that repeats R. Nobody
// but the payer can make a proof for that other transaction, so a copy never counts as a payment.
// Input: the transaction as monerod's get_transactions decode_as_json gives it (RingCT types 4–6, the only ones mined today).
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {decodeAddress,usableSpendKey,hex,unhex,concat,le,leBytes,Hs} from './monero.mjs';
import {viewTag} from './claim.mjs';
import {formatXmr} from './records.mjs';
const P=ed25519.ExtendedPoint,L=ed25519.CURVE.n,G=P.BASE,enc=new TextEncoder(),HEX32=/^[0-9a-f]{64}$/;
const H=P.fromHex('8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94'),SEP=keccak_256(enc.encode('TXPROOF_V2'));
const varint=n=>{const out=[];do{let b=n&127;n=Math.floor(n/128);if(n)b|=128;out.push(b);}while(n);return Uint8Array.of(...out);};
const mul=(point,scalar)=>{const s=scalar%L;return s===0n?P.ZERO:point.multiply(s);};
const raw=b=>typeof b==='string'?unhex(b):b;
// "Tx key" as wallets show it: the main key, then any additional keys, 64 hex characters each.
export function parseTxKey(text){
 const t=String(text||'').trim().toLowerCase();
 if(!/^([0-9a-f]{64})+$/.test(t))throw Error('A transaction key is 64 hexadecimal characters (or several of them joined).');
 const keys=t.match(/.{64}/g).map(k=>le(unhex(k)));if(keys.length>17)throw Error('Too many transaction keys.');
 if(keys.some(k=>k===0n||k>=L))throw Error('This is not a valid transaction key.');
 return {main:keys[0],additional:keys.slice(1)};}
export function outputsOf(tx){
 const rct=tx.rct_signatures;if(tx.version!==2||!rct||![4,5,6].includes(rct.type))throw Error('Only current RingCT transactions can be checked.');
 if(tx.unlock_time!==0)throw Error('A payment with a lock time does not count.');
 const vout=tx.vout||[];if(!vout.length||vout.length!==rct.ecdhInfo?.length||vout.length!==rct.outPk?.length)throw Error('Transaction outputs are incomplete.');
 return vout.map((o,i)=>({index:i,key:o.target?.tagged_key?.key||o.target?.key,tag:o.target?.tagged_key?o.target.tagged_key.view_tag:null,ecdh:rct.ecdhInfo[i].amount,commitment:rct.outPk[i]}));}
// The public keys in a transaction's extra field (a list of byte values), read no further than a wallet reads them:
// the first transaction public key and the first list of additional keys. Reading stops at padding and at any field
// that is not a public key, a nonce or additional keys. A length that is not written the shortest way (a last byte of
// zero after other bytes) also ends the reading, because Monero's reader refuses it.
export function extraKeys(extra){
 const b=Array.isArray(extra)?extra:[];if(!b.every(v=>Number.isInteger(v)&&v>=0&&v<=255))throw Error('Transaction extra is not a list of bytes.');
 let at=0,main=null,additional=null;
 const count=()=>{let n=0,scale=1;for(let i=0;i<4;i++){if(at>=b.length)return -1;const v=b[at++];if(i&&!v)return -1;n+=(v&127)*scale;scale*=128;if(!(v&128))return n;}return -1;};
 while(at<b.length){const tag=b[at++];
  if(tag===1){if(at+32>b.length)break;if(main===null)main=hex(b.slice(at,at+32));at+=32;}
  else if(tag===2){const n=count();if(n<0||n>255||at+n>b.length)break;at+=n;}
  else if(tag===4){const n=count();if(n<0||at+32*n>b.length)break;if(additional===null){additional=[];for(let i=0;i<n;i++)additional.push(hex(b.slice(at+32*i,at+32*i+32)));}at+=32*n;}
  else break;}
 return {main,additional:additional||[]};}
// The public keys a wallet would try for output i: the main key, then additional key i when there is one per output.
// A main key that is not a point of the main group counts as no key at all: wallets differ in what they do with one.
const mainUsable=carried=>carried.main!==null&&usableSpendKey(carried.main)!==null;
const carriedFor=(carried,count,i)=>!mainUsable(carried)?[]:[carried.main,...(carried.additional.length===count?[carried.additional[i]]:[])];
// What output o holds for the wallet with this derivation and spend key B, or null when its key is another wallet's.
// found() runs once the key fits, before the view tag and the amount are read.
function openOutput(o,derivation,B,found){
 const s=Hs(concat(derivation,varint(o.index))),sb=leBytes(s);
 if(hex(mul(G,s).add(B).toRawBytes())!==o.key)return null;
 if(found)found();
 if(o.tag!==null&&o.tag!==viewTag(derivation,o.index).toString(16).padStart(2,'0'))throw Error(`Output ${o.index} pays this address, but its view tag is wrong, so its wallet would not find it and it does not count.`);
 const pad=keccak_256(concat(enc.encode('amount'),sb)).subarray(0,8),field=unhex(o.ecdh);if(field.length!==8)throw Error('Unexpected amount field');
 const amount=le(Uint8Array.from(field,(x,j)=>x^pad[j]));
 const mask=Hs(concat(enc.encode('commitment_mask'),sb));
 const C=mul(G,mask).add(amount?H.multiply(amount):P.ZERO);
 if(hex(C.toRawBytes())!==o.commitment)throw Error(`Output ${o.index} pays this address but its amount does not match its commitment.`);
 return amount;}

// --- The payer's side: needs the transaction key. ---
// Every output of `tx` that pays `address` according to `txKey`, with the key that made it.
function scan({tx,txKey,address,network='mainnet'}){
 const a=decodeAddress(address,network),V=P.fromHex(a.view),B=P.fromHex(a.spend),{main,additional}=parseTxKey(Array.isArray(txKey)?txKey.join(''):txKey);
 const outs=outputsOf(tx),carried=extraKeys(tx.extra),paid=[];
 const usable=mainUsable(carried);
 const candidates=i=>[{r:main,pub:usable?carried.main:null},...(additional[i]!==undefined?[{r:additional[i],pub:usable&&carried.additional.length===outs.length?carried.additional[i]:null}]:[])];
 for(const o of outs){
  for(const {r,pub} of candidates(o.index)){
   const amount=openOutput(o,mul(mul(V,r),8n).toRawBytes(),B,()=>{
    if(pub!==hex(mul(a.kind==='sub'?B:G,r).toRawBytes()))throw Error(`Output ${o.index} pays this address, but the transaction does not carry the public key its wallet needs to find it, so it does not count.`);});
   if(amount===null)continue;
   paid.push({index:o.index,amount,key:o.key,secret:r,address:a});break;}}
 return paid;}
// How much `tx` pays `address` according to `txKey`. received = 0n when the key fits no output (wrong key or wrong address).
// outputs: every output that counts, with its one-time key. An output that pays the address but that its wallet could
// not find (see the top of this file) is an error, not a smaller amount.
export function checkPayment(o){
 const outputs=scan(o).map(({index,amount,key})=>({index,amount,key}));return {received:outputs.reduce((s,p)=>s+p.amount,0n),outputs};}
// The text a payment proof is made for: one ledger, one listing.
export function paymentMessage(domain,lot){
 if(!HEX32.test(domain||'')||!HEX32.test(lot||''))throw Error('Ledger domain and listing id required');return `mordinals-payment:${domain}:${lot}`;}
const challenge=({txid,message,D,X,Y,R,address})=>Hs(concat(keccak_256(concat(unhex(txid),enc.encode(message))),D,X,Y,SEP,R,address.view,address.kind==='sub'?address.spend:new Uint8Array(32)));
// The proof for one transaction key (a number) and one payee. address: {spend, view, kind} as decodeAddress gives it.
// The one-time number k comes from fresh random bytes hashed together with the key and everything the proof is
// about, so a weak or repeated random source never gives two different proofs the same k.
export function makeOutProof({txid,secret,address,message,random=n=>crypto.getRandomValues(new Uint8Array(n))}){
 if(typeof secret!=='bigint'||secret<=0n||secret>=L)throw Error('This is not a valid transaction key.');
 const V=P.fromHex(address.view),base=address.kind==='sub'?P.fromHex(address.spend):G,D=V.multiply(secret).toRawBytes(),R=base.multiply(secret).toRawBytes();
 let k=0n;while(k===0n)k=Hs(concat(enc.encode('mordinals-payment-nonce'),random(64),leBytes(secret),unhex(txid),enc.encode(message),D,R,address.view));
 const c=challenge({txid,message,D,X:base.multiply(k).toRawBytes(),Y:V.multiply(k).toRawBytes(),R,address});
 return {D,c:leBytes(c),s:leBytes(((k-c*secret)%L+L)%L),txPub:hex(R)};}
// The entries of a buy record, one per payee in the reservation's order.
// lines: [{to, amount, what}] as the reservation asks; payments: [{txid, tx, txKey}] with the transactions as a node gives them.
// A transaction may come from anyone: the public key it carries is checked against the transaction key here.
export function provePayments({lines,payments,domain,lot,network='mainnet',random}){
 for(const p of payments)if(!HEX32.test(p.txid||''))throw Error('A transaction ID is 64 hexadecimal characters.');
 const message=paymentMessage(domain,lot),found=payments.map(p=>lines.map(l=>scan({tx:p.tx,txKey:p.txKey,address:l.to,network})));
 payments.forEach((p,i)=>{if(!found[i].some(x=>x.length))throw Error(`Payment ${p.txid.slice(0,8)}… pays nobody in this reservation with the key given. Check the transaction ID and its key.`);});
 return lines.map((l,j)=>{const all=payments.flatMap((p,i)=>found[i][j].map(o=>({p,o}))),fit=all.find(x=>x.o.amount===BigInt(l.amount));
  if(!all.length)throw Error(`The ${l.what} payment is missing; this reservation needs exactly ${formatXmr(l.amount)} XMR for it.`);
  if(!fit)throw Error(`The ${l.what} payment is ${formatXmr(all.reduce((s,x)=>s+x.o.amount,0n))} XMR${all.length>1?' in several parts':''}; this reservation needs exactly ${formatXmr(l.amount)} XMR in one piece.`);
  const p=makeOutProof({txid:fit.p.txid,secret:fit.o.secret,address:fit.o.address,message,...(random?{random}:{})});
  return {txid:fit.p.txid,out:fit.o.index,D:hex(p.D),c:hex(p.c),s:hex(p.s)};});}

// --- Everybody's side: needs no key. ---
// address: {spend, view, kind}. D, the carried key and the payee's own keys must be points of the main group, each
// written one way only. s is the proof's answer number (wallet2 calls it r; here r is always the transaction key).
export function verifyOutProof({txid,txPub,address,message,D,c,s}){
 try{const cs=le(raw(c)),rs=le(raw(s));if(cs>=L||rs>=L)return false;
  const R=usableSpendKey(raw(txPub)),Dp=usableSpendKey(raw(D));if(!R||!Dp)return false;
  const V=usableSpendKey(address.view),base=address.kind==='sub'?usableSpendKey(address.spend):G;if(!V||!base)return false;
  const X=mul(R,cs).add(mul(base,rs)),Y=mul(Dp,cs).add(mul(V,rs));
  return challenge({txid,message,D:raw(D),X:X.toRawBytes(),Y:Y.toRawBytes(),R:raw(txPub),address})===cs;}
 catch{return false;}}
// What one entry of a buy record shows: output `out` of `tx` pays `address` this amount, as a coin its wallet finds.
// what: the payee's name in error texts.
export function checkPaymentProof({tx,txid,out,D,c,s,address,message,network='mainnet',what='payee'}){
 const a=decodeAddress(address,network),outs=outputsOf(tx),carried=extraKeys(tx.extra),o=outs[out];
 if(!o)throw Error(`The ${what} payment names output ${out}, which its transaction does not have.`);
 if(!mainUsable(carried))throw Error(`The ${what} payment does not carry the public key its wallet needs to find it, so it does not count.`);
 if(!carriedFor(carried,outs.length,out).some(txPub=>verifyOutProof({txid,txPub,address:a,message,D,c,s})))
  throw Error(`The proof for the ${what} payment does not fit this transaction, listing and address, so it does not count.`);
 const amount=openOutput(o,mul(P.fromHex(D),8n).toRawBytes(),P.fromHex(a.spend));
 if(amount===null)throw Error(`Output ${out} of the ${what} payment does not pay the ${what==='seller'?"seller's":what} address.`);
 return {index:out,amount,key:o.key};}
// Fetch a transaction and its block height from a Monero node (restricted nodes allow this).
export async function fetchTx(node,txid,{fetch:f=fetch}={}){
 if(!/^[0-9a-f]{64}$/.test(txid||''))throw Error('A transaction id is 64 hexadecimal characters.');
 const r=await f(node.replace(/\/$/,'')+'/get_transactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:[txid],decode_as_json:true}),signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error('The Monero node answered HTTP '+r.status);const v=await r.json();const t=(v.txs||[])[0];
 if(!t||t.tx_hash!==txid)throw Error('The Monero node does not know this transaction (yet).');
 return {txid,inPool:Boolean(t.in_pool),height:t.in_pool?null:t.block_height,tx:JSON.parse(t.as_json)};}
