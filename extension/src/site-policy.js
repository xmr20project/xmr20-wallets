import bs58 from 'bs58';
import {checkMoneroAddress} from '../../engine/shared/address.js';
import {supportedMint} from '../../engine/shared/bridge-sdk/core-next/mint-policy.mjs';
import {MARKET_ORIGIN} from './market-policy.js';
export const SITE_ORIGIN='https://xmr20.org';
export const LOCAL_ORIGIN='http://127.0.0.1:8893';
export const MARKET_READ_ORIGIN='http://127.0.0.1:8897';
// MONERO MARKET candidate (29 Oct 2026): the pinned market page origin, compiled in (offline lab builds only; null elsewhere).
// Offline lab: a loopback page origin. Stagenet test build (29 Oct): the site itself, https://xmr20.org, where the hidden test page lives.
export const MONERO_MARKET_ORIGIN=typeof __XMR20_MONERO_MARKET__==='string'&&(/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(__XMR20_MONERO_MARKET__)||__XMR20_MONERO_MARKET__==='https://xmr20.org')?__XMR20_MONERO_MARKET__:null;
const allowedOrigins=new Set([SITE_ORIGIN,LOCAL_ORIGIN]);
export function siteSender(sender,{jointBridge=false,nativeMarket=false,moneroMarket=false}={}){
 if(sender?.id||sender?.frameId!==0||!Number.isInteger(sender?.tab?.id)||typeof sender.documentId!=='string')throw Error('Website connection not allowed.');
 const origin=new URL(sender.url).origin;
 if((!allowedOrigins.has(origin)&&origin!==MARKET_READ_ORIGIN&&!(nativeMarket&&origin===MARKET_ORIGIN)&&!(moneroMarket&&MONERO_MARKET_ORIGIN&&origin===MONERO_MARKET_ORIGIN)&&!(jointBridge&&origin==='http://127.0.0.1:8925'))||sender.origin!==origin)throw Error('Website connection not allowed.');
 return {origin,tabId:sender.tab.id,documentId:sender.documentId};
}
export function signInMessage(message,wallet,now=Date.now(),origin=SITE_ORIGIN){
 if(!allowedOrigins.has(origin))throw Error('Website connection not allowed.');
 if(typeof message!=='string'||message.length>1024)throw Error('Only XMR20 website sign-in is supported.');
 const lines=message.split('\n');
 if(lines.length!==7||lines[0]!=='Sign in to XMR20'||lines[1]!=='Website: '+origin||lines[2]!=='Wallet: '+wallet||!/^Nonce: [0-9a-f-]{36}$/.test(lines[3])||lines[6]!=='This signature proves wallet ownership. It does not authorize a transaction.')throw Error('Only XMR20 website sign-in is supported.');
 const issued=Date.parse(lines[4].slice(8)),expires=Date.parse(lines[5].slice(9));
 if(!lines[4].startsWith('Issued: ')||!lines[5].startsWith('Expires: ')||!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now+30000||expires<=now||expires-issued!==300000||now-issued>300000)throw Error('Sign-in expired. Connect again.');
 return message;
}
export const publicAccount=a=>({id:a.id,name:a.name,solana:a.sol||null,monero:a.xmr||null,canSign:!!a.solSecret&&!a.watch});
// A native-market grant shares no Solana address and cannot be reused for
// website Solana sign-in, bridge approval, or vault-unlock signatures.
export const publicMoneroAccount=a=>({id:a.id,name:a.name,solana:null,monero:a.xmr||null,canSign:false,canSignMonero:!!a.xmrSeed&&!a.watch});
export function bridgeLaunch(input){
 if(!input||Object.keys(input).sort().join(',')!=='amountRaw,direction,mint'||!supportedMint(input.mint)||!['sol-to-xmr','xmr-to-sol'].includes(input.direction)||typeof input.amountRaw!=='string'||! /^[1-9][0-9]{0,13}$/.test(input.amountRaw)||BigInt(input.amountRaw)>50000000000000n)throw Error('Only an exact supported-token bridge request is supported.');
 return {mint:input.mint,direction:input.direction,amountRaw:input.amountRaw};
}

// This is a key-unlock authorization, never a generic message or transaction signer.
export function vaultUnlockMessage(message,account,origin=SITE_ORIGIN){
 const fail=()=>{throw Error('Only the exact connected wallet unlock request is supported.');};
 if(!allowedOrigins.has(origin)||typeof message!=='string'||message.length>1200)fail();
 const lines=message.split('\n');
 if(lines.length!==9||lines[0]!=='XMR20: unlock my saved Monero wallet'||lines[1]!==''||lines[2]!=='This approval unlocks Monero signing keys stored on this device. Only approve on '+origin+'. Never share this signature.'||lines[3]!==''||lines[4]!=='Wallet: '+account.solana||lines[5]!=='Monero address: '+account.monero||lines[8]!=='Version: 1')fail();
 try{const key=bs58.decode(account.solana);if(key.length!==32||bs58.encode(key)!==account.solana)fail();}catch{fail();}
 const network=lines[6].slice(9),address=checkMoneroAddress(account.monero,network);
 if(lines[6]!=='Network: '+network||!address.valid||address.kind!=='standard')fail();
 const salt=lines[7].slice(11);
 if(lines[7]!=='Backup ID: '+salt||!/^[A-Za-z0-9+/]{43}=$/.test(salt))fail();
 try{if(atob(salt).length!==32||btoa(atob(salt))!==salt)fail();}catch{fail();}
 return {message,network,address:account.monero,backupId:salt};
}
export function siteSigningRequest(message,account,now=Date.now(),origin=SITE_ORIGIN){
 if(typeof message==='string'&&message.startsWith('XMR20: unlock my saved Monero wallet'))return {kind:'vaultUnlock',...vaultUnlockMessage(message,account,origin)};
 return {kind:'signIn',message:signInMessage(message,account.solana,now,origin)};
}
