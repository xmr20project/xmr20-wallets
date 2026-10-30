// Encrypted pending-operation journal for the private-holder test build.
//
// What it holds (per token address): pending sends/redemptions with the note
// commitments they reserve, the finished record (wire) once proved, the relay
// txid once published, and in-flight legacy claims. It never holds keys, seeds
// or decrypted notes; balances are not cached here (they come from local replay).
//
// Storage: one AES-GCM box in chrome.storage.local (localStorage in tests). The
// key is derived once per unlock from the wallet password (PBKDF2-SHA256,
// 600 000 iterations, like the vault) with a per-install random salt stored
// beside the box. After lock() the derived key is dropped; the box stays
// readable only with the password. JavaScript cannot guarantee erasure of the
// password string or CryptoKey material from memory (see RESULTS.txt).
//
// Concurrency: several popups may write. Each write re-reads the box, applies the
// mutator to the latest content and writes with a fresh token; if the token read
// back is not ours, another window wrote in between and the mutation is retried
// on the newer content. Reservations are therefore checked AGAINST the latest
// shared content before proving starts (see private-format.js), which keeps two
// windows from building conflicting spends in the common case. This is a local
// wallet convenience; the protocol's nullifier set is what actually prevents a
// double spend.
const enc=new TextEncoder(),dec=new TextDecoder();
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))),un64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
export const JOURNAL_KEY='xmr20-private-journal',SALT_KEY='xmr20-private-journal-salt',AAD='XMR20-private-journal-v1';
// FIX (review M2): writes run under a GENUINE cross-context exclusive primitive. In the extension that is the Web Locks API
// (navigator.locks: popups, options pages and the service worker share the extension origin, so one lock name covers every
// context); the complete read-modify-write, including reservation conflict checks, runs inside the lock. Where Web Locks are
// unavailable (plain Node without an injected `locks`), the old lease is used and reported as 'lease-fallback' — it is NOT a
// proof of exclusion and tests must inject a lock implementation.
// Without a lock implementation (plain Node, no `locks` injected) writes are REFUSED unless the caller opts into the lease with
// allowLeaseFallback:true (tests of the legacy path only).
export function createPrivateJournal({store,subtle=crypto.subtle,random=b=>crypto.getRandomValues(b),locks=globalThis.navigator?.locks??null,lockName=JOURNAL_KEY+'-lock',allowLeaseFallback=false}){
 let key=null;const exclusionMode=locks?'web-locks':allowLeaseFallback?'lease-fallback':'refused';
 const exclusive=fn=>{if(locks)return locks.request(lockName,{mode:'exclusive'},()=>fn());if(!allowLeaseFallback)return Promise.reject(Error('Journal writes refused: no cross-context exclusive lock is available in this context (navigator.locks missing and no lock implementation injected).'));return fn();};
 async function unlock(password){let salt=await store.get(SALT_KEY);if(!salt){salt=b64(random(new Uint8Array(32)));await store.set(SALT_KEY,salt);}
  const material=await subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveKey']);key=await subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',iterations:600000,salt:un64(salt)},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}
 function lock(){key=null;}
 const empty=()=>({version:1,token:'',accounts:{}});
 async function read(){if(!key)throw Error('Journal locked');const box=await store.get(JOURNAL_KEY);if(!box)return empty();
  try{const plain=await subtle.decrypt({name:'AES-GCM',iv:un64(box.iv),additionalData:enc.encode(AAD)},key,un64(box.ciphertext));const d=JSON.parse(dec.decode(plain));if(d.version!==1||typeof d.accounts!=='object')throw Error();d.token=box.token;return d;}
  catch{throw Error('Saved private-operation journal could not be read with this password.');}}
 // Writes are serialized within this window (a heartbeat write must never race the
 // 'built' write of the same operation) and guarded across windows by a short
 // lease key with read-back: the lease is taken before the read-modify-write and
 // released after it, so another window's write cannot be lost in between.
 let chain=Promise.resolve();const LOCK=JOURNAL_KEY+'-lease';
 function write(mutate){const p=chain.then(()=>exclusive(()=>writeNow(mutate)));chain=p.catch(()=>{});return p;}
 async function lease(){const me=b64(random(new Uint8Array(8)));for(let i=0;i<60;i++){const cur=await store.get(LOCK);if(!cur||cur.until<Date.now()){await store.set(LOCK,{owner:me,until:Date.now()+3000});const back=await store.get(LOCK);if(back?.owner===me)return me;}await new Promise(r=>setTimeout(r,50));}throw Error('Another wallet window is writing; try again.');}
 async function writeNow(mutate){if(!key)throw Error('Journal locked');const me=locks?null:await lease();try{
  for(let attempt=0;attempt<6;attempt++){const current=await read();const next=JSON.parse(JSON.stringify(current));const result=await mutate(next)??next;const token=b64(random(new Uint8Array(12)));const iv=random(new Uint8Array(12));
   const body={version:1,accounts:next.accounts};const ciphertext=b64(await subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(AAD)},key,enc.encode(JSON.stringify(body))));
   await store.set(JOURNAL_KEY,{version:1,token,iv:b64(iv),ciphertext,previous:current.token||''});
   const check=await store.get(JOURNAL_KEY);if(check?.token===token)return result;}
  throw Error('Another wallet window is writing; try again.');}finally{if(me){const cur=await store.get(LOCK);if(cur?.owner===me)await store.set(LOCK,null);}}}
 const account=(j,addr)=>(j.accounts[addr]??={pending:{},claims:{},history:[]});
 return {unlock,lock,read,write,account,exclusionMode,get unlocked(){return Boolean(key);}};
}
// Note commitments currently reserved by live operations (any window).
export function reservedCommitments(acc,except=null){const out=new Set();for(const [id,p] of Object.entries(acc.pending||{})){if(id===except)continue;if(['selected','quoted','built','signed','broadcasting','uncertain','published','mined','missing','conflicted','refused'].includes(p.status))for(const c of p.reserved||[])out.add(c);}return out;}
// Native (XMR) inputs held by pending carriers: a quoted or signed carrier owns its input until the record is confirmed or the carrier is known to conflict.
export function reservedKeyImages(acc,except=null){const out=new Set();for(const [id,p] of Object.entries(acc.pending||{})){if(id===except)continue;if(['quoted','signed','broadcasting','uncertain','published','mined','missing'].includes(p.status)){const k=p.carrier?.keyImage||p.nativeInput;if(k)out.add(k);}}return out;}
