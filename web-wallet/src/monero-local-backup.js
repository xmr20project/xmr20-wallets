const encoder=new TextEncoder(),decoder=new TextDecoder();
const iterations=600000;
const scope=({owner,network,address})=>{
 if(typeof owner!=='string'||!owner||!['mainnet','stagenet'].includes(network)||typeof address!=='string'||address.length!==95)throw Error('Invalid wallet backup context.');
 return JSON.stringify(['xmr20-preview-monero-backup-v1',owner,network,address]);
};
const slot=context=>'xmr20-preview:monero-backup:'+scope(context);
const encode=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
const decode=s=>{if(typeof s!=='string'||s.length>4096)throw Error('Invalid backup.');return Uint8Array.from(atob(s),c=>c.charCodeAt(0));};
async function key(password,salt,crypto){
 if(typeof password!=='string'||password.length<12||password.length>256)throw Error('Use a backup password with 12–256 characters.');
 const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
// Only encrypted ciphertext is persisted. Passwords and phrases are never sent
// to a server or saved in storage. AAD binds every backup to its wallet context.
export function localMoneroBackup({storage=globalThis.localStorage,crypto=globalThis.crypto}={}){
 return {
  has(context){try{return !!storage.getItem(slot(context));}catch{return false;}},
  async save(context,seed,password){
   if(typeof seed!=='string'||seed.trim().split(/\s+/).length!==25)throw Error('Invalid recovery phrase.');
   if(storage.getItem(slot(context))){if(await this.load(context,password)===seed)return;throw Error('A different backup already exists for this address.');}
   const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
   const secretKey=await key(password,salt,crypto);
   const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(scope(context))},secretKey,encoder.encode(seed));
   const box=JSON.stringify({v:1,salt:encode(salt),iv:encode(iv),data:encode(data)});
   storage.setItem(slot(context),box);
   if(storage.getItem(slot(context))!==box||await this.load(context,password)!==seed)throw Error('Could not verify the local backup. Keep your written copy.');
  },
  async load(context,password){
   try{
    const raw=storage.getItem(slot(context));if(!raw||raw.length>6000)throw Error();
    const box=JSON.parse(raw);if(box.v!==1)throw Error();
    const salt=decode(box.salt),iv=decode(box.iv);if(salt.length!==16||iv.length!==12)throw Error();
    const secretKey=await key(password,salt,crypto);
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode(scope(context))},secretKey,decode(box.data));
    const seed=decoder.decode(plain);if(seed.trim().split(/\s+/).length!==25)throw Error();return seed;
   }catch{throw Error('Could not unlock this local backup. Check the password and use the original browser/device.');}
  }
 };
}
