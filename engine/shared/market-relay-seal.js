// MONERO MARKET candidate (30 Oct 2026): sealed trade messages for the order book's relay (review finding W7: the relay was a
// public log of pre-broadcast material — drafts with key images, rings, signatures). Used by the extension's market host
// and the lab wallet process (Node and browsers: WebCrypto AES-GCM + @noble x25519/HKDF).
//
//   relay key   one X25519 key pair per wallet, kept in the wallet's journal (not derived from the seed: losing it only
//               affects trades in flight).
//   attestation the seller binds its relay key to ONE listing with its Monero spend key (SigV2) over
//               "XMR20-MARKET-RELAY-KEY-V1\n" + sha256(canonical({v,listing,key})); buyers check it against the listing's
//               payout/owner address, so the order book cannot substitute its own key.
//   seal        eph = fresh X25519 key; ikm = DH(eph, R) || DH(S_sender, R) (sender-authenticated, Noise-K style) or
//               DH(eph, R) alone for the first message, whose plaintext carries the buyer's own relay key;
//               key = HKDF-SHA256(ikm, salt = eph || R, info = "XMR20-MARKET-RELAY-SEAL-V1"); AES-256-GCM, 12-byte nonce,
//               AAD = canonical({to, from, type, tradeId, mode}) so ciphertext cannot be replayed into another trade or step.
// The order book still sees who talks to whom, when, the message type and its size; never the content.
import {x25519} from '@noble/curves/ed25519';
import {hkdf} from '@noble/hashes/hkdf';
import {sha256} from '@noble/hashes/sha2';
export const RELAY_KEY_DOMAIN='XMR20-MARKET-RELAY-KEY-V1\n';
const INFO=new TextEncoder().encode('XMR20-MARKET-RELAY-SEAL-V1');
const enc=new TextEncoder(),dec=new TextDecoder();
const hexOf=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const bytesOf=h=>{if(typeof h!=='string'||!/^([0-9a-f]{2})*$/.test(h))throw Error('hex required');return Uint8Array.from(h.match(/../g)||[],x=>parseInt(x,16));};
const cat=(...p)=>{const o=new Uint8Array(p.reduce((n,x)=>n+x.length,0));let a=0;for(const x of p){o.set(x,a);a+=x.length;}return o;};
function canonical(x){
 if(x===null||typeof x==='boolean'||typeof x==='string')return JSON.stringify(x);
 if(typeof x==='number'){if(!Number.isSafeInteger(x))throw Error('Unsafe number');return String(x);}
 if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
 return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
}
export function newRelayKey(){const priv=x25519.utils.randomPrivateKey();return {priv:hexOf(priv),pub:hexOf(x25519.getPublicKey(priv))};}
export const isRelayKey=k=>typeof k==='string'&&/^[0-9a-f]{64}$/.test(k);
export const relayKeyMessage=(listing,key)=>RELAY_KEY_DOMAIN+hexOf(sha256(enc.encode(canonical({v:1,listing,key}))));
const aad=h=>enc.encode(canonical({to:h.to,from:h.from,type:h.type,tradeId:h.tradeId,mode:h.mode}));
async function aes(key,usage){return crypto.subtle.importKey('raw',key,{name:'AES-GCM'},false,[usage]);}
function derive(ikm,eph,R){return hkdf(sha256,ikm,cat(eph,R),INFO,32);}
/** Seal `plain` (any JSON value) for recipient public key R. With `sender` (our key pair) the message proves our static key. */
export async function seal(plain,{to,from,type,tradeId},R,sender=null){
 const Rb=bytesOf(R);const e=x25519.utils.randomPrivateKey(),E=x25519.getPublicKey(e);
 const mode=sender?'auth':'anon';
 const ikm=sender?cat(x25519.getSharedSecret(e,Rb),x25519.getSharedSecret(bytesOf(sender.priv),Rb)):x25519.getSharedSecret(e,Rb);
 const nonce=crypto.getRandomValues(new Uint8Array(12));
 const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:aad({to,from,type,tradeId,mode})},await aes(derive(ikm,E,Rb),'encrypt'),enc.encode(JSON.stringify(plain))));
 return {sealed:1,mode,eph:hexOf(E),nonce:hexOf(nonce),ct:hexOf(ct)};
}
/** Open a sealed body with our key pair. For mode 'auth', `senderPub` must be the counterparty key we expect. */
export async function open(body,{to,from,type,tradeId},me,senderPub=null){
 if(!body||body.sealed!==1||!['auth','anon'].includes(body.mode))throw Error('Not a sealed relay message');
 if(body.mode==='auth'&&!isRelayKey(senderPub))throw Error('Sender key unknown for an authenticated message');
 if(typeof body.ct!=='string'||body.ct.length>96000)throw Error('Sealed message too large');
 const E=bytesOf(body.eph),priv=bytesOf(me.priv),R=bytesOf(me.pub);if(E.length!==32)throw Error('eph');
 const ikm=body.mode==='auth'?cat(x25519.getSharedSecret(priv,E),x25519.getSharedSecret(priv,bytesOf(senderPub))):x25519.getSharedSecret(priv,E);
 const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytesOf(body.nonce),additionalData:aad({to,from,type,tradeId,mode:body.mode})},await aes(derive(ikm,E,R),'decrypt'),bytesOf(body.ct)).catch(()=>{throw Error('Sealed message does not open (wrong key, tampered, or moved)');});
 return JSON.parse(dec.decode(new Uint8Array(pt)));
}
