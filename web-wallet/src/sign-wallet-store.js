// Feather / Cake Wallet in the website wallet (2 Nov 2026; owner: "let people view their token holdings by entering their cake/feather
// wallet"): the Monero address this browser watches. No keys and no signature are kept: what an address holds is public ledger
// state; moving or trading needs a message signed in the wallet each time (sign-wallet.jsx). Saved in localStorage for this site.
import {useSyncExternalStore} from 'react';
const KEY='xmr20-sign-wallet',ADDR=/^[1-9A-HJ-NP-Za-km-z]{95}$/,subs=new Set();
export const WALLET_NAMES={feather:'Feather Wallet',cake:'Cake Wallet'};
let raw=null,snap=null;
export function savedSignWallet(){
 let s=null;try{s=localStorage.getItem(KEY);}catch{}
 if(s!==raw){raw=s;snap=null;try{const v=JSON.parse(s||'null');if(v&&ADDR.test(v.address||''))snap={kind:WALLET_NAMES[v.kind]?v.kind:'feather',address:v.address};}catch{}}
 return snap;
}
export function saveSignWallet(v){try{v?localStorage.setItem(KEY,JSON.stringify({kind:v.kind,address:v.address})):localStorage.removeItem(KEY);}catch{}for(const f of subs)f();}
export function subscribeSignWallet(f){subs.add(f);const on=e=>{if(e.key===KEY)f();};addEventListener('storage',on);return()=>{subs.delete(f);removeEventListener('storage',on);};}
export const useSignWallet=()=>useSyncExternalStore(subscribeSignWallet,savedSignWallet,()=>null);
