// MONERO MARKET candidate (30 Oct 2026): the wallet's OWN XMR20-NFT-V2 ledger in the extension (browser-safe port of
// research/monero-market-20261029/nft/market.mjs with the shared reader's validators). LAB READER RULES, not a deployed
// reader: nft_anchor, nft_sale and the anchor-consumption rule. Every ownership, last-event and anchor fact that a market
// signature or payment depends on comes from here (the wallet's own node), never from the order book.
// Carriers are decompressed by the wallet engine (op nftDecode: whole input consumed, ≤16,384 bytes, UTF-8), so the
// result does not depend on how a browser's DecompressionStream treats trailing bytes.
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
const DOMAIN='XMR20-NFT-V2\n',LIMIT=984,MAGIC=[0x58,0x4d,0x52,0x32,0x30,0x54,0x32];// "XMR20T2"
const enc=new TextEncoder();
const hexOf=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const bytesOf=h=>Uint8Array.from(h.match(/../g)||[],x=>parseInt(x,16));
export const sha256hex=async s=>hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof s==='string'?enc.encode(s):s)));
const check=(x,m)=>{if(!x)throw Error(m);};
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const keys=(x,list)=>check(obj(x)&&Object.keys(x).sort().join('|')===[...list].sort().join('|'),'Unexpected fields');
const hex=(x,n)=>typeof x==='string'&&new RegExp('^[0-9a-f]{'+n+'}$').test(x);
const text=(x,max,empty=false)=>typeof x==='string'&&x.length<=max&&x.length>=(empty?0:1)&&/^[\x20-\x7e]*$/.test(x);
const address=x=>typeof x==='string'&&/^4[1-9A-HJ-NP-Za-km-z]{94}$/.test(x);
const common=['p','v','net','op','owner','nonce'];
// ---- validators: the shared reader's (operations/nft-image-webp-20261030/build/protocol.mjs) plus the market operations
export function validateRecord(r){
 check(obj(r),'Record required');check(r.p==='xmr20'&&r.v===2&&r.net==='mainnet','Wrong NFT network/version');
 check(address(r.owner)&&hex(r.nonce,32),'Invalid signer/nonce');
 if(r.op==='nft_deploy'){keys(r,[...common,'name','max','meta']);check(text(r.name,80)&&Number.isSafeInteger(r.max)&&r.max>0&&r.max<=10000&&hex(r.meta,64),'Invalid collection');}
 else if(r.op==='nft_mint'){
  keys(r,[...common,'collection_id','edition','to','name','collection','description','attributes','image']);
  check(hex(r.collection_id,64)&&Number.isSafeInteger(r.edition)&&r.edition>0&&r.edition<=10000&&address(r.to),'Invalid mint identity');
  check(text(r.name,160)&&text(r.collection,80)&&text(r.description,500,true),'Invalid artwork text');
  check(obj(r.attributes)&&Object.keys(r.attributes).length<=24,'Invalid attributes');
  for(const [k,v] of Object.entries(r.attributes))check(text(k,32)&&text(v,240,true),'Invalid attribute');
  check(typeof r.attributes.editions==='string','Missing edition label');
  const i=r.image;check(obj(i)&&Number.isInteger(i.width)&&Number.isInteger(i.height)&&i.width>0&&i.height>0&&i.width<=128&&i.height<=192&&i.width*i.height<=24576,'Image dimensions exceed bound');
  if(i.codec==='json-text-1'){keys(i,['codec','width','height','palette','encoding','data']);check(i.encoding==='range-base64'&&Array.isArray(i.palette)&&[2,4,8,16].includes(i.palette.length)&&i.palette.every(c=>hex(c,6)),'Invalid palette');}
  else if(['json-text-webp-1','image-webp-1'].includes(i.codec)){keys(i,['codec','width','height','encoding','data']);check(i.encoding==='base64','Invalid image encoding');}
  else throw Error('Unsupported renderer');
  check(typeof i.data==='string'&&i.data.length<=12000&&i.data.length>0,'Invalid image data');
  check(btoa(atob(i.data))===i.data,'Noncanonical base64');
 }else if(r.op==='nft_transfer'){keys(r,[...common,'token','prev','to']);check(hex(r.token,64)&&hex(r.prev,64)&&address(r.to)&&r.to!==r.owner,'Invalid NFT transfer');}
 else if(r.op==='nft_anchor'){keys(r,[...common,'token','prev','anchor']);check(hex(r.token,64)&&hex(r.prev,64)&&hex(r.anchor,64),'Invalid NFT anchor');}
 else if(r.op==='nft_sale'){keys(r,[...common,'token','prev','to','anchor','offer','terms']);check(hex(r.token,64)&&hex(r.prev,64)&&address(r.to)&&r.to!==r.owner&&hex(r.anchor,64)&&hex(r.offer,64)&&hex(r.terms,64),'Invalid NFT sale');}
 else throw Error('Unsupported NFT operation');
 return r;
}
export function validateEnvelope(e){keys(e,['record','signature']);validateRecord(e.record);check(typeof e.signature==='string'&&/^SigV2[1-9A-HJ-NP-Za-km-z]{88}$/.test(e.signature),'Invalid signature format');return e;}
// ---- tx_extra framing: "XM2" nonces (the reader's extractCarrier)
export function extractCarrier(extra){
 if(!(extra instanceof Uint8Array)||extra.length>1060)return null;let p=0;const fragments=[];
 const take=n=>{if(n<0||p+n>extra.length)throw Error('Truncated tx_extra');const r=extra.subarray(p,p+n);p+=n;return r;};
 function vi(max){let n=0;for(let k=0;k<3;k++){const b=take(1)[0];n+=(b&127)*2**(7*k);if(!(b&128)){if(k>0&&b===0)throw Error('Overlong varint');if(n>max)throw Error('Too large');return n;}}throw Error('Invalid varint');}
 try{
  while(p<extra.length){const tag=take(1)[0];if(tag===0){let n=1;while(p<extra.length&&extra[p]===0){p++;n++;}if(n>255)throw Error('pad');}else if(tag===1)take(32);else if(tag===2){const b=take(vi(255));if(b[0]===0x58&&b[1]===0x4d&&b[2]===0x32)fragments.push(b);}else throw Error('Unsupported tx_extra field');}
  if(!fragments.length)return null;if(fragments.length>5)throw Error('Too many fragments');
  for(let i=0;i<fragments.length;i++){const b=fragments[i];if(!(b.length>5&&b[3]===i&&b[4]===fragments.length))throw Error('Fragment order');if(i<fragments.length-1&&b.length!==fragments[0].length)throw Error('Fragment size');}
  const out=new Uint8Array(fragments.reduce((n,b)=>n+b.length-5,0));let at=0;for(const b of fragments){out.set(b.subarray(5),at);at+=b.length-5;}return out;
 }catch{return null;}
}
// ---- SigV2 verification (nft/sigv2.mjs verify, browser-safe)
const L=ed25519.CURVE.n,G=ed25519.ExtendedPoint.BASE;
const le=b=>{let n=0n;for(let i=b.length-1;i>=0;i--)n=(n<<8n)|BigInt(b[i]);return n;};
const cat=(...parts)=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',BLOCK_LENGTHS=[0,2,3,5,6,7,9,10,11];
function b58decode(t){const parts=[];for(let s=0;s<t.length;s+=11){const block=t.slice(s,s+11),size=BLOCK_LENGTHS.indexOf(block.length);if(size<=0)throw Error('base58');let n=0n;for(const ch of block){const d=ALPHABET.indexOf(ch);if(d<0)throw Error('base58');n=n*58n+BigInt(d);}const b=new Uint8Array(size);for(let i=size-1;i>=0;i--){b[i]=Number(n&255n);n>>=8n;}if(n!==0n)throw Error('base58 overflow');parts.push(b);}return cat(...parts);}
// prefix: 0x12 mainnet format (NFTs always; also the regtest fakechain), 0x18 stagenet (token-lot relay keys on the stagenet test).
function decodeAddress(a,prefix=0x12){
 if(typeof a!=='string'||a.length!==95)throw Error('address');const raw=b58decode(a);if(raw.length!==69||raw[0]!==prefix)throw Error('address prefix');
 const sum=keccak_256(raw.subarray(0,65)).subarray(0,4);for(let i=0;i<4;i++)if(sum[i]!==raw[65+i])throw Error('Address checksum');
 const spendPub=raw.subarray(1,33),viewPub=raw.subarray(33,65);
 for(const k of [spendPub,viewPub]){const p=ed25519.ExtendedPoint.fromHex(hexOf(k));if(p.isSmallOrder()||!p.isTorsionFree())throw Error('Invalid public key');}
 return {spendPub,viewPub};
}
export const isAddress=a=>{try{decodeAddress(a);return true;}catch{return false;}};
const varint=n=>{const out=[];while(n>=128){out.push((n&127)|128);n=Math.floor(n/128);}out.push(n);return Uint8Array.from(out);};
export function verifySigV2(data,addr,signature,prefix=0x12){
 try{
  if(typeof signature!=='string'||!/^SigV2[1-9A-HJ-NP-Za-km-z]{88}$/.test(signature))return false;
  const {spendPub,viewPub}=decodeAddress(addr,prefix);const sig=b58decode(signature.slice(5));if(sig.length!==64)return false;
  const c=le(sig.subarray(0,32)),r=le(sig.subarray(32));if(c>=L||r>=L)return false;
  const d=enc.encode(data);const m=keccak_256(cat(enc.encode('MoneroMessageSignature\0'),spendPub,viewPub,new Uint8Array([0]),varint(d.length),d));
  const pub=ed25519.ExtendedPoint.fromHex(hexOf(spendPub));const comm=G.multiply(r).add(pub.multiply(c)).toRawBytes();
  return le(keccak_256(cat(m,spendPub,comm)))%L===c;
 }catch{return false;}
}
const signingMessage=async r=>DOMAIN+await sha256hex(JSON.stringify(r));
// ---- artwork check as the live verifier does it (palette map must decode and re-encode to the same bytes)
function artworkValid(r,mapcodec){
 try{const i=r.image;const b=Uint8Array.from(atob(i.data),c=>c.charCodeAt(0));
  if(['json-text-webp-1','image-webp-1'].includes(i.codec))return b[0]===0x52&&b[1]===0x49&&b[2]===0x46&&b[3]===0x46;
  if(i.codec!=='json-text-1'||b.length<5)return false;
  const {idx}=mapcodec.decodeMap(b,0,i.width,i.height,i.palette.length);const again=mapcodec.encodeMap(idx,i.width,i.height,i.palette.length);
  return again.length===b.length&&again.every((x,k)=>x===b[k]);
 }catch{return false;}
}
// decode(): `open` returns the engine's exact envelope string for carrier bytes (or throws).
async function decodeCarrier(carrier,open){
 check(carrier.length<=LIMIT&&MAGIC.every((x,i)=>carrier[i]===x),'Invalid carrier');
 const s=await open(hexOf(carrier));const e=JSON.parse(s);check(JSON.stringify(e)===s,'Noncanonical JSON or duplicate keys');return validateEnvelope(e);
}
// The market reducer over {txid,height,extra(Uint8Array),keyImages} in chain order (nft/market.mjs reduceMarket).
export async function reduceMarket(txs,{tip,confirmations,open,mapcodec}){
 const collections=new Map(),tokens=new Map(),nonces=new Set(),events=[];
 for(const tx of txs){
  const event={txid:tx.txid,height:tx.height};let e,r;
  const carrier=extractCarrier(tx.extra);if(!carrier)continue;
  try{e=await decodeCarrier(carrier,open);r=e.record;}catch(error){events.push({...event,status:'rejected',reason:error.message});continue;}
  if(tip-tx.height+1<confirmations){events.push({...event,status:'pending',record:r});continue;}
  const addresses=[r.owner,...(r.to?[r.to]:[])];
  if(!addresses.every(isAddress)||!verifySigV2(await signingMessage(r),r.owner,e.signature)){events.push({...event,status:'rejected',reason:'Invalid address or spend-key signature'});continue;}
  const spends=new Set(tx.keyImages||[]);
  try{
   const nonce=r.owner+':'+r.nonce;if(nonces.has(nonce))throw Error('Nonce already used');
   if(r.op==='nft_deploy')collections.set(tx.txid,{id:tx.txid,authority:r.owner,name:r.name,max:r.max,meta:r.meta,editions:[]});
   else if(r.op==='nft_mint'){
    const c=collections.get(r.collection_id);if(!c)throw Error('Unknown collection');if(r.owner!==c.authority)throw Error('Only collection authority may mint');if(r.collection!==c.name)throw Error('Collection name mismatch');
    if(!(r.edition<=c.max&&!c.editions.includes(r.edition)))throw Error('Edition out of range or already minted');if(r.attributes.editions!==`${r.edition}/${c.max}`)throw Error('Artwork edition mismatch');if(!artworkValid(r,mapcodec))throw Error('Invalid artwork data');
    c.editions.push(r.edition);tokens.set(tx.txid,{id:tx.txid,collection:c.id,edition:r.edition,owner:r.to,last:tx.txid,anchor:null,anchorHeight:null,name:r.name,collectionName:c.name,history:[{...event,op:'nft_mint',owner:r.to}]});
   }else{
    const t=tokens.get(r.token);if(!t)throw Error('Unknown token');if(r.owner!==t.owner)throw Error('Signer is not current owner');if(r.prev!==t.last)throw Error('Stale ownership reference');
    if(t.anchor&&!spends.has(t.anchor))throw Error('Anchored NFT: the carrier does not spend its anchor key image');
    if(r.op==='nft_transfer'){t.owner=r.to;t.anchor=null;t.anchorHeight=null;t.history.push({...event,op:'nft_transfer',owner:r.to});}
    else if(r.op==='nft_anchor'){t.anchor=r.anchor;t.anchorHeight=tx.height;t.history.push({...event,op:'nft_anchor',owner:t.owner});}
    else if(r.op==='nft_sale'){check(t.anchor,'NFT is not anchored: a sale needs an anchored NFT');t.owner=r.to;t.anchor=r.anchor;t.anchorHeight=tx.height;t.history.push({...event,op:'nft_sale',owner:r.to,offer:r.offer});}
    else throw Error('Unsupported NFT operation');
    t.last=tx.txid;
   }
   nonces.add(nonce);events.push({...event,status:'accepted',operation:r.op});
  }catch(error){events.push({...event,status:'rejected',reason:error.message});}
 }
 return {profile:'xmr20-nft-v2+market-anchors',tip,confirmations,collections:[...collections.values()],tokens:[...tokens.values()],events};
}
// Incremental, reorg-aware index over the wallet's own node (block hashes remembered; rewinds to the fork point).
export function createNftLedger({json,other,confirmations,open,mapcodec,startHeight=0}){
 let txs=[],hashes=[],scanned=startHeight-1,last=null,running=null;
 const chainTx=(tx,height)=>{const j=JSON.parse(tx.as_json);return {txid:tx.tx_hash,height,extra:Uint8Array.from(j.extra),keyImages:(j.vin||[]).map(i=>i.key?.k_image).filter(Boolean).map(k=>String(k).toLowerCase())};};
 async function run(){
  const tip=(await json('get_info')).height-1;
  while(scanned>=startHeight){const h=(await json('get_block_header_by_height',{height:scanned})).block_header.hash;if(h===hashes[scanned-startHeight])break;scanned--;}
  hashes.length=Math.max(0,scanned-startHeight+1);txs=txs.filter(t=>t.height<=scanned);
  for(let height=scanned+1;height<=tip;height++){
   const b=await json('get_block',{height});hashes[height-startHeight]=b.block_header.hash;const ids=b.tx_hashes||[];
   if(ids.length){const t=await other('/get_transactions',{txs_hashes:ids,decode_as_json:true});for(const tx of t.txs||[]){try{const x=chainTx(tx,height);if(extractCarrier(x.extra))txs.push(x);}catch{}}}
   scanned=height;
  }
  last=await reduceMarket(txs,{tip,confirmations,open,mapcodec});return last;
 }
 return {sync(){running??=run().finally(()=>{running=null;});return running;},state:()=>last};
}
export {bytesOf};
