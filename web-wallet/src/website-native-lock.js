// The private engine holds one exclusive Web Lock per Monero wallet, shared by every
// xmr20.org tab and window (scan-persistence.mjs holdLock). Checking it in the page
// first gives a clear message before any wallet prompt, and lets a closing worker in
// this tab finish releasing its lock before a new one starts.
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export const OTHER_WINDOW_MESSAGE='This Monero wallet is open in another xmr20.org tab or window. Close the bridge there (or that tab), then try again.';
export async function nativeWalletLockName({genesis,address},{crypto=globalThis.crypto}={}){
 if(typeof genesis!=='string'||!/^[0-9a-f]{64}$/.test(genesis)||typeof address!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{95}$/.test(address))throw Error('Canonical wallet identity required');
 const identity=JSON.stringify(['xmr20-native-wallet-v1',genesis,address]);
 return 'xmr20-native-wallet:'+hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity))));
}
// true when the lock is still held after a short grace period. Browsers without
// Web Locks report false; the engine then reports its own fixed M21 message.
export async function nativeWalletHeldElsewhere(name,{locks=globalThis.navigator?.locks,attempts=6,delayMs=400,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 if(!locks||typeof locks.query!=='function')return false;
 for(let i=0;i<attempts;i++){
  let held;try{held=(await locks.query()).held?.some(lock=>lock.name===name);}catch{return false;}
  if(!held)return false;
  if(i+1<attempts)await wait(delayMs);
 }
 return true;
}
