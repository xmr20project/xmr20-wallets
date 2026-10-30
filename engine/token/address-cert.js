// XMR20 open-owner certificates (28 Oct 2026; owner: "open transfers will be sent to xmr addresses, and private will use a
// second address"). Each wallet account publishes which OPEN owner key belongs to its ordinary (primary) Monero address on one
// token ledger, signed with that address's private spend key. A sender's wallet looks the certificate up by the recipient's
// Monero address and verifies it against the public spend key inside that address, so the directory that stores certificates
// cannot redirect tokens. The PRIVATE receiving address is never part of a certificate: it stays separate and unpublished.
// Used by the wallet (signing in the holder worker, verifying before a send) and by the bridge (refusing invalid certificates).
// Signature: Schnorr on ed25519 with Monero's hash-to-scalar (keccak-256, little-endian, mod l), with its own domain string:
//   m = keccak256("XMR20-OPEN-OWNER-v1" 0x00 monero 0x00 ownerKey(hex) 0x00 ledgerDomain(hex)), R = kG, c = Hs(m || B || R), s = k - c*b,
//   valid iff c = Hs(m || B || sG + cB), where B is the public spend key in the Monero address and b its private spend key.
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
const L=ed25519.CURVE.n,G=ed25519.ExtendedPoint.BASE,ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',BLOCK={2:1,3:2,5:3,6:4,7:5,9:6,10:7,11:8};
const PREFIX={mainnet:18,stagenet:24};const enc=new TextEncoder();
const le=b=>{let n=0n;for(let i=b.length-1;i>=0;i--)n=(n<<8n)|BigInt(b[i]);return n;};
const leBytes=n=>{const out=new Uint8Array(32);for(let i=0;i<32;i++){out[i]=Number(n&255n);n>>=8n;}return out;};
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const unhex=h=>{if(typeof h!=='string'||!/^[0-9a-f]{64}$/.test(h))throw Error('Malformed certificate field');return Uint8Array.from(h.match(/../g),x=>parseInt(x,16));};
const concat=(...parts)=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
const Hs=b=>le(keccak_256(b))%L;
// The public spend key of a standard (primary) Monero address on the given network; throws for anything else.
export function moneroSpendKey(address,network='mainnet'){
 if(typeof address!=='string'||address.length!==95)throw Error('Use the recipient’s main Monero address (95 characters).');
 const bytes=[];for(let i=0;i<address.length;i+=11){const block=address.slice(i,i+11),size=BLOCK[block.length];if(!size)throw Error('Not a Monero address.');let n=0n;for(const ch of block){const k=ALPHABET.indexOf(ch);if(k<0)throw Error('Not a Monero address.');n=n*58n+BigInt(k);}if(n>=1n<<BigInt(8*size))throw Error('Not a Monero address.');const part=new Array(size);for(let j=size-1;j>=0;j--){part[j]=Number(n&255n);n>>=8n;}bytes.push(...part);}
 const b=Uint8Array.from(bytes);if(b.length!==69||b[0]!==PREFIX[network])throw Error(`Use a main ${network} Monero address (starting with ${network==='mainnet'?'4':'5'}).`);
 const sum=keccak_256(b.slice(0,65));if(b.slice(65).some((x,i)=>x!==sum[i]))throw Error('Monero address checksum is wrong.');
 return b.slice(1,33);
}
export const isMoneroAddress=(s,network='mainnet')=>{try{moneroSpendKey(s,network);return true;}catch{return false;}};
const HEX32=/^[0-9a-f]{64}$/;
const message=(monero,ownerKey,domain)=>keccak_256(concat(enc.encode('XMR20-OPEN-OWNER-v1'),Uint8Array.of(0),enc.encode(monero),Uint8Array.of(0),enc.encode(ownerKey),Uint8Array.of(0),enc.encode(domain)));
// spendKey: the account's 32-byte private spend key (the holder worker's root), used once and not kept.
// ownerKey: the account's open owner key (hex32); domain: the token ledger domain (hex32) from the shipped parameter manifest.
export function signCertificate({monero,ownerKey,domain,spendKey,network='mainnet',random=n=>crypto.getRandomValues(new Uint8Array(n))}){
 if(!HEX32.test(ownerKey||'')||!HEX32.test(domain||''))throw Error('Owner key and ledger domain required');
 const Bbytes=moneroSpendKey(monero,network),b=le(spendKey)%L;if(b===0n)throw Error('Invalid spend key');
 if(hex(G.multiply(b).toRawBytes())!==hex(Bbytes))throw Error('This spend key does not belong to the Monero address.');
 let k=0n;while(k===0n)k=le(random(64))%L;const R=G.multiply(k).toRawBytes();
 const c=Hs(concat(message(monero,ownerKey,domain),Bbytes,R));const s=((k-c*b)%L+L)%L;
 return {v:1,monero,ownerKey,domain,c:hex(leBytes(c)),s:hex(leBytes(s))};
}
// Valid only for the given network AND token ledger domain; a certificate from another ledger does not verify here.
export function verifyCertificate(cert,{network='mainnet',domain}={}){
 try{if(cert?.v!==1||typeof cert.monero!=='string'||!HEX32.test(cert.ownerKey||'')||!HEX32.test(cert.domain||'')||!HEX32.test(domain||'')||cert.domain!==domain)return false;
  const Bbytes=moneroSpendKey(cert.monero,network),B=ed25519.ExtendedPoint.fromHex(Bbytes),c=le(unhex(cert.c)),s=le(unhex(cert.s));
  if(c===0n||c>=L||s>=L)return false;const R=(s===0n?ed25519.ExtendedPoint.ZERO:G.multiply(s)).add(B.multiply(c)).toRawBytes();
  return Hs(concat(message(cert.monero,cert.ownerKey,cert.domain),Bbytes,R))===c;}
 catch{return false;}
}
