// Data checks of the Mordinals screens that need no screen and no key: the pinned owner list, pictures, and the
// small lists the wallet keeps about records it sent. Runs in the popup, in the website wallet and in Node tests.
import {sha256} from '@noble/hashes/sha256';

const HEX64=/^[0-9a-f]{64}$/;
export const PREFIX=12,MAX_PICTURE=2097152;
const enc=new TextEncoder();
const toHex=b=>Array.from(b,v=>v.toString(16).padStart(2,'0')).join('');
const fromHex=s=>Uint8Array.from(s.match(/../g)||[],v=>parseInt(v,16));

// One line per entry, exactly as reader/lib/owners.mjs writes it. The SHA-256 over all lines pins the list.
export const ownerLine=o=>[o.number,o.registrationTx,o.ownerTx,o.ownerOutputKey,o.ownerViewTag,o.ownerTxPubKeys.join(','),o.bodySha256||'',o.bodySize||0].join(':')+'\n';
// Every field has one fixed spelling, so two different lists never give the same lines.
function plain(o,number){
 return o&&o.number===number&&HEX64.test(o.registrationTx)&&HEX64.test(o.ownerTx)&&HEX64.test(o.ownerOutputKey)&&/^[0-9a-f]{2}$/.test(o.ownerViewTag)
  &&Array.isArray(o.ownerTxPubKeys)&&o.ownerTxPubKeys.length>=1&&o.ownerTxPubKeys.length<=17&&o.ownerTxPubKeys.every(k=>HEX64.test(k))
  &&(o.bodySha256===undefined?o.bodySize===undefined:HEX64.test(o.bodySha256)&&Number.isSafeInteger(o.bodySize)&&o.bodySize>=0);}
// Feed the list in order, then finish(pin). finish() throws unless the whole list was fed and its hash is the pin;
// it returns the picture table: the first PREFIX bytes of every Mordinal's content hash, by number.
export function listCheck(total){
 if(!Number.isSafeInteger(total)||total<1||total>1000000)throw Error('The Mordinals list has an impossible length.');
 const h=sha256.create(),table=new Uint8Array(total*PREFIX);let next=0;
 return {
  get next(){return next;},
  add(entries){
   for(const o of entries){
    if(next>=total||!plain(o,next))throw Error('The Mordinals service sent a list entry this wallet cannot read. Nothing was saved.');
    h.update(enc.encode(ownerLine(o)));if(o.bodySha256)table.set(fromHex(o.bodySha256).subarray(0,PREFIX),next*PREFIX);next++;}},
  finish(pin){
   if(next!==total||toHex(h.digest())!==pin)throw Error('The Mordinals list from this service does not match the list this wallet was built with. Nothing was saved.');
   return table;}};}

// The picture type by its first bytes, or null. Only these four are ever shown.
const starts=(b,sig,at=0)=>sig.every((v,i)=>b[at+i]===v);
export function pictureType(b){
 if(b.length>=8&&starts(b,[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))return 'image/png';
 if(b.length>=3&&starts(b,[0xff,0xd8,0xff]))return 'image/jpeg';
 if(b.length>=6&&(starts(b,[0x47,0x49,0x46,0x38,0x37,0x61])||starts(b,[0x47,0x49,0x46,0x38,0x39,0x61])))return 'image/gif';
 if(b.length>=12&&starts(b,[0x52,0x49,0x46,0x46])&&starts(b,[0x57,0x45,0x42,0x50],8))return 'image/webp';
 return null;}
// The bytes are this Mordinal's inscription (by the pinned list) and a plain picture -> its type, else null.
export function checkPicture(table,number,bytes){
 if(!(table instanceof Uint8Array)||!Number.isInteger(number)||number<0||(number+1)*PREFIX>table.length)return null;
 if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>MAX_PICTURE)return null;
 const want=table.subarray(number*PREFIX,(number+1)*PREFIX);if(want.every(v=>v===0))return null;
 const got=sha256(bytes);for(let i=0;i<PREFIX;i++)if(got[i]!==want[i])return null;
 return pictureType(bytes);}

export function toBase64(bytes){let s='';for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(s);}
export function fromBase64(text){const s=atob(text),out=new Uint8Array(s.length);for(let i=0;i<s.length;i++)out[i]=s.charCodeAt(i);return out;}
// The saved table, if it is the one for this build's list.
export const packTable=(table,owners)=>({owners,prefix:PREFIX,count:table.length/PREFIX,table:toBase64(table)});
export function unpackTable(saved,owners,count){
 try{if(!saved||saved.owners!==owners||saved.prefix!==PREFIX||saved.count!==count||typeof saved.table!=='string')return null;
  const t=fromBase64(saved.table);return t.length===count*PREFIX?t:null;}catch{return null;}}

// What the wallet says about a record it handed to the relay, from the relay's answer.
//   waiting: not in a block yet · done · refused · lost: it did not reach a block and can be sent again
export function recordState(status,sentAt,now=Date.now()){
 const s=status?.state;
 if(s==='done')return 'done';if(s==='refused')return 'refused';if(s==='stuck')return 'lost';
 if(s==='unknown'||!s)return now-sentAt<20000?'waiting':'lost';
 return 'waiting';}
