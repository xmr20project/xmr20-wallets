// XMR20 profile (29 Oct 2026, owner: "users can create a profile"). Version 1 keeps the profile in this browser, per Solana wallet:
// a display name, a short bio and an accent. Nothing is published or sent anywhere; a public profile would need a server store.
const KEY='xmr20-profile-v1:';
export const ACCENTS=['ember','amber','rose','violet','teal'];
export const NAME_MAX=32,BIO_MAX=160;
export function loadProfile(owner){
 try{const v=JSON.parse(localStorage.getItem(KEY+owner)||'null');if(!v||typeof v!=='object')return null;
  return {name:typeof v.name==='string'?v.name.slice(0,NAME_MAX):'',bio:typeof v.bio==='string'?v.bio.slice(0,BIO_MAX):'',accent:ACCENTS.includes(v.accent)?v.accent:'ember',createdAt:Number.isSafeInteger(v.createdAt)?v.createdAt:Date.now()};}
 catch{return null;}
}
export function saveProfile(owner,{name,bio,accent}){
 const clean={name:String(name||'').trim().replace(/\s+/g,' ').slice(0,NAME_MAX),bio:String(bio||'').trim().slice(0,BIO_MAX),accent:ACCENTS.includes(accent)?accent:'ember',createdAt:loadProfile(owner)?.createdAt??Date.now()};
 try{localStorage.setItem(KEY+owner,JSON.stringify(clean));}catch{throw Error('This browser did not save the profile (storage is blocked or full).');}
 return clean;
}
// Bridge deposits (Solana -> Monero) sent from this browser, kept until the bridge's credit shows on Monero (profile Activity).
const DEPOSITS='xmr20-bridge-deposits-v1:';
export function recordBridgeDeposit(owner,d){
 if(!owner||!d||typeof d.symbol!=='string'||!/^\d{1,30}$/.test(String(d.amount)))return;
 try{const rows=loadBridgeDeposits(owner);rows.push({at:Number.isSafeInteger(d.at)?d.at:Date.now(),symbol:d.symbol.slice(0,16),mint:String(d.mint||''),decimals:Number.isInteger(d.decimals)?d.decimals:6,amount:String(d.amount),credit:/^[0-9a-f]{64}$/.test(d.credit||'')?d.credit:null});
  localStorage.setItem(DEPOSITS+owner,JSON.stringify(rows.slice(-20)));}catch{}
}
export function loadBridgeDeposits(owner){try{const v=JSON.parse(localStorage.getItem(DEPOSITS+owner)||'[]');return Array.isArray(v)?v.filter(r=>r&&typeof r.symbol==='string'&&/^\d+$/.test(r.amount)):[];}catch{return [];}}
// A stable accent for wallets without a profile yet, from the address.
export function defaultAccent(owner){let h=0;for(const c of String(owner||''))h=(h*31+c.charCodeAt(0))>>>0;return ACCENTS[h%ACCENTS.length];}
export function initials(name,owner){const n=String(name||'').trim();if(n){const p=n.split(/\s+/);return (p[0][0]+(p[1]?.[0]||'')).toUpperCase();}return String(owner||'?').slice(0,2).toUpperCase();}
