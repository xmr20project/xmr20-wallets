import {checkMoneroAddress} from '../shared/xmr20/address.js';
const key=owner=>'xmr20-imported-wallets-v1:'+owner;
export function walletLibrary(owner,storage=globalThis.localStorage){
 if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner||''))throw Error('Sign in before importing a wallet.');
 function read(){const value=JSON.parse(storage.getItem(key(owner))||'[]');if(!Array.isArray(value)||value.length>30)throw Error('Saved wallet list is unavailable.');return value.filter(r=>r.network==='mainnet'&&['imported','watch'].includes(r.kind)&&checkMoneroAddress(r.address,'mainnet').kind==='standard').map(({address,network,kind,addedAt})=>({address,network,kind,addedAt}));}
 return {read,add({address,kind}){const check=checkMoneroAddress(address,'mainnet');if(!check.valid||check.kind!=='standard'||!['imported','watch'].includes(kind))throw Error('Use a primary Monero mainnet wallet.');const all=read(),existing=all.find(r=>r.address===address);if(existing){if(kind==='imported')existing.kind=kind;}else{if(all.length>=30)throw Error('This device already has 30 saved wallets.');all.push({address,network:'mainnet',kind,addedAt:Date.now()});}const encoded=JSON.stringify(all);storage.setItem(key(owner),encoded);if(storage.getItem(key(owner))!==encoded)throw Error('Could not save this wallet on your device.');return all;}};
}
