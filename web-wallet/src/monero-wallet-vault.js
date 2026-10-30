import bs58 from 'bs58';
import {ed25519} from '@noble/curves/ed25519';
const enc=new TextEncoder(),dec=new TextDecoder();
const encode=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
const decode=s=>{if(typeof s!=='string'||s.length>6000)throw Error('Invalid saved wallet.');return Uint8Array.from(atob(s),c=>c.charCodeAt(0));};
function scope({owner,network,address},origin){if(bs58.decode(owner).length!==32||!['mainnet','stagenet'].includes(network)||typeof address!=='string'||address.length!==95||!/^https?:\/\//.test(origin))throw Error('Invalid wallet context.');return JSON.stringify(['xmr20-monero-vault-v1',origin,owner,network,address]);}
const validSeed=seed=>typeof seed==='string'&&seed.trim().split(/\s+/).length===25;
// 30 Oct 2026 (owner: 'could we possibly remove that requirement to sign with phantom everytime, just allow people to sync'): a load
// with {session:true} keeps the wallet's approval (the signature the key is derived from) in sessionStorage, so later unlocks in
// this tab's session derive the key again without asking the wallet. It goes when the tab is closed, on Lock (forget) and on
// disconnect (forgetAll). Spend-side loads (the legacy send approval) do not pass the flag and still ask every time.
export function moneroWalletVault({storage=globalThis.localStorage,session=globalThis.sessionStorage,crypto=globalThis.crypto,origin=globalThis.location?.origin,approvalTimeoutMs=45000}={}){
 const slot=c=>'xmr20:monero-vault:'+scope(c,origin);const SESSION='xmr20:monero-vault-session:';
 const sessionKeys=()=>{try{if(!session)return [];if(typeof session.key==='function'){const out=[];for(let i=0;i<session.length;i++)out.push(session.key(i));return out;}return Object.keys(session);}catch{return [];}};const sessionSlot=(c,salt)=>SESSION+scope(c,origin)+':'+encode(salt);
 const assertProvider=(c,provider)=>{provider?.assertCurrent?.();if(provider?.publicKey?.toBase58()!==c.owner||typeof provider.signMessage!=='function')throw Error('Connect the Solana wallet used to save this Monero wallet.');};
 // A verified receipt is kept only by this open setup panel. Re-linking can
 // reuse the encrypted backup without another signature, provided it is intact.
 const receipt=(c,saved)=>{return currentProvider=>{assertProvider(c,currentProvider);return !!saved&&storage.getItem(slot(c))===saved;};};
 function read(c){const value=storage.getItem(slot(c));if(!value||value.length>8000)throw Error('No saved Monero key on this device. Import this wallet once before sending.');const b=JSON.parse(value);if(b.v!==1||decode(b.salt).length!==32||decode(b.iv).length!==12)throw Error('Invalid saved wallet.');return b;}
 async function unlockKey(c,salt,provider,onProgress=()=>{},{session:remember=false}={}){
  const check=()=>assertProvider(c,provider);check();
  const context=scope(c,origin),message=enc.encode('XMR20: unlock my saved Monero wallet\n\nThis approval unlocks Monero signing keys stored on this device. Only approve on '+origin+'. Never share this signature.\n\nWallet: '+c.owner+'\nMonero address: '+c.address+'\nNetwork: '+c.network+'\nBackup ID: '+encode(salt)+'\nVersion: 1');
  const derive=async sig=>{try{if(sig.length!==64||!ed25519.verify(sig,message,bs58.decode(c.owner)))throw Error('Wallet approval could not be verified.');const material=await crypto.subtle.importKey('raw',sig,'HKDF',false,['deriveKey']);return await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt,info:enc.encode(context)},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}finally{sig.fill(0);}};
  if(remember){try{const kept=session?.getItem(sessionSlot(c,salt));if(kept){const key=await derive(decode(kept));onProgress('encrypting');return key;}}catch{try{session?.removeItem(sessionSlot(c,salt));}catch{}}}
  onProgress('approval');
  let timer,result;
  try{
   // Invoke signing directly from the click handler: no network wait before
   // opening the extension. A stalled extension must not strand the phrase UI.
   result=await Promise.race([provider.signMessage(message),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Wallet approval did not finish. Open Phantom or Solflare, dismiss any old request, then retry. Your recovery phrase is still here.')),approvalTimeoutMs);})]);
  }finally{clearTimeout(timer);}
  check();onProgress('encrypting');const sig=new Uint8Array(result.signature||result);
  if(remember&&sig.length===64){try{session?.setItem(sessionSlot(c,salt),encode(sig));}catch{}}
  return derive(sig);
 }
 return {
  has(c){try{return !!storage.getItem(slot(c));}catch{return false;}},
  // Forget this session's approval for one wallet (Lock) or for every wallet (disconnect).
  forget(c){const p=SESSION+scope(c,origin)+':';for(const k of sessionKeys())if(k.startsWith(p))session.removeItem(k);},
  forgetAll(){for(const k of sessionKeys())if(k.startsWith(SESSION))session.removeItem(k);},
  async save(c,seed,provider,{onProgress}={}){
   if(!validSeed(seed))throw Error('Invalid Monero wallet.');
   if(this.has(c)){const saved=storage.getItem(slot(c));if(await this.load(c,provider,{onProgress})===seed)return receipt(c,saved);throw Error('A different saved key already exists.');}
   const salt=crypto.getRandomValues(new Uint8Array(32)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await unlockKey(c,salt,provider,onProgress),plain=enc.encode(seed);
   try{const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(scope(c,origin))},key,plain);provider?.assertCurrent?.();const box=JSON.stringify({v:1,salt:encode(salt),iv:encode(iv),data:encode(data)});storage.setItem(slot(c),box);if(storage.getItem(slot(c))!==box)throw Error('The encrypted wallet could not be saved.');const saved=read(c),check=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(saved.iv),additionalData:enc.encode(scope(c,origin))},key,decode(saved.data));try{if(dec.decode(check)!==seed)throw Error('Saved wallet verification failed.');}finally{new Uint8Array(check).fill(0);}return receipt(c,box);}finally{plain.fill(0);}
  },
  async load(c,provider,{onProgress,session:remember=false}={}){const b=read(c),key=await unlockKey(c,decode(b.salt),provider,onProgress,{session:remember});let plain;try{plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(b.iv),additionalData:enc.encode(scope(c,origin))},key,decode(b.data));provider?.assertCurrent?.();const seed=dec.decode(plain);if(!validSeed(seed))throw Error();return seed;}catch{throw Error('Could not unlock the saved Monero wallet. Use the original wallet and browser, or import your backup.');}finally{if(plain)new Uint8Array(plain).fill(0);}}
 };
}
