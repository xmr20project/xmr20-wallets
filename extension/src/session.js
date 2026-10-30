import {normalizePreferences} from '../../engine/shared/preferences.js';
export const SESSION_KEY='xmr20-unlocked-session';
const sameBox=(a,b)=>!!a&&!!b&&['version','kdf','iterations','salt','iv','ciphertext'].every(k=>a[k]===b[k]);
// The adapter is chrome.storage.session (RAM only), never local/sync storage.
export function createSessionController({local,session,alarms,now=Date.now,uuid=()=>crypto.randomUUID()}){
 async function clear(signal=true){await session.remove(SESSION_KEY);await alarms.clear('wallet-idle');if(signal)await local.set({'xmr20-lock-signal':uuid()});}
 async function read(){
  const s=(await session.get(SESSION_KEY))[SESSION_KEY];if(!s)return null;
  const localState=await local.get(['xmr20-preferences','xmr20-lock-signal']);
  if((s.lockSignal??null)!==(localState['xmr20-lock-signal']??null)){await clear(false);return null;}
  const p=normalizePreferences(localState['xmr20-preferences']);
  if(!Number.isSafeInteger(s.lastActive)||s.lastActive>now()+1000||now()-s.lastActive>=p.autoLockMinutes*60000){await clear();return null;}
  await alarms.create('wallet-idle',{when:s.lastActive+p.autoLockMinutes*60000});return s;
 }
 async function handle(m){
  if(m.action==='lock'){await clear();return null;}
  if(m.action==='open'){
   const data=await local.get(['xmr20-vault','xmr20-lock-signal']);
   if(typeof m.password!=='string'||m.password.length<8||!sameBox(m.box,data['xmr20-vault'])||(m.lockSignal??null)!==(data['xmr20-lock-signal']??null))throw Error('Wallet changed or locked. Unlock again.');
   const s={id:uuid(),password:m.password,lastActive:now(),lockSignal:m.lockSignal??null,activeId:m.activeId,snapshots:{}};
   await session.set({[SESSION_KEY]:s});await read();return s;
  }
  const s=await read();if(!s)return null;
  if(m.action==='resume')return s;
  if(m.id!==s.id)return null;
  if(m.action==='touch')s.lastActive=now();
  else if(m.action==='remember'){
   if(typeof m.activeId==='string')s.activeId=m.activeId;
   const b=m.snapshot;
   if(b&&typeof b.address==='string'&&b.address.length===95&&b.network==='mainnet'&&b.synced===true&&/^\d{1,22}$/.test(b.balanceRaw)&&/^\d{1,22}$/.test(b.unlockedRaw)&&Number.isSafeInteger(b.updatedAt)&&b.updatedAt<=now()+1000){s.snapshots[b.address]={address:b.address,balanceRaw:b.balanceRaw,unlockedRaw:b.unlockedRaw,updatedAt:b.updatedAt,network:'mainnet',synced:true};}
  }else if(m.action==='forget'){delete s.snapshots[m.address];}else if(m.action!=='check')throw Error('Unsupported session request.');
  await session.set({[SESSION_KEY]:s});await read();return {id:s.id,lastActive:s.lastActive};
 }
 return {handle,read,clear};
}
