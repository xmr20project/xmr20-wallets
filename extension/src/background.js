import {createSiteBroker} from './site-broker.js';
import {decryptVault,importSol,bs58} from '../../engine/shared/core.js';
import {ed25519} from '@noble/curves/ed25519';
import {createSessionController} from './session.js';
import {createNativeCustodySigner} from './native-custody-signer.js';
import {attachNativePopupPorts} from './native-popup-channel.js';
import {attachMarketHostPorts} from './market-host-channel.js';
import {attachMarketRunner} from './market-runner-control.js';
import './return-watch.js';
const ready=chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
const controller=createSessionController({local:chrome.storage.local,session:chrome.storage.session,alarms:chrome.alarms});
let queue=Promise.resolve();
function serial(fn){const task=queue.then(()=>ready).then(fn);queue=task.catch(()=>{});return task;}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(message?.channel!=='wallet-session'||sender.id!==chrome.runtime.id||sender.url?.split('?')[0]!==chrome.runtime.getURL('popup.html'))return;
 serial(()=>controller.handle(message)).then(value=>reply({value}),()=>reply({error:'Wallet session unavailable. Unlock again.'}));return true;
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='wallet-idle')void serial(()=>controller.read());});
chrome.storage.onChanged.addListener((changes,area)=>{
 if(area!=='local')return;
 if(changes['xmr20-lock-signal'])void serial(()=>controller.clear(false));
 else if(changes['xmr20-preferences'])void serial(()=>controller.read());
});
chrome.runtime.onStartup.addListener(()=>{void serial(()=>controller.clear());});

const nativePopups=typeof __XMR20_NATIVE_MARKET__!=='undefined'&&__XMR20_NATIVE_MARKET__?attachNativePopupPorts({chrome,dispatch:(message,sender)=>serial(()=>broker.internal(message,sender)),revoke:id=>serial(()=>broker.revokeNativePopup(id))}):null;
// MONERO MARKET candidate (29 Oct 2026): compiled in only for the offline lab build (market origin pinned at build time).
const MONERO_MARKET=typeof __XMR20_MONERO_MARKET__==='string'&&__XMR20_MONERO_MARKET__.length>0;
const marketHosts=MONERO_MARKET?attachMarketHostPorts({chrome,bind:(id,sender)=>serial(()=>broker.hostBound(id,sender))}):null;
const broker=createSiteBroker({chrome,moneroMarket:MONERO_MARKET,marketHosts,nativePopupAlive:id=>nativePopups?.has(id)===true,nativeMarket:typeof __XMR20_NATIVE_MARKET__!=='undefined'&&__XMR20_NATIVE_MARKET__,jointBridge:typeof __XMR20_JOINT_MAINNET_REVIEW__!=='undefined'&&__XMR20_JOINT_MAINNET_REVIEW__,readSession:()=>controller.read(),
 signCustody:typeof __XMR20_NATIVE_MARKET__!=='undefined'&&__XMR20_NATIVE_MARKET__?createNativeCustodySigner():null,
 readVault:async session=>{const data=await chrome.storage.local.get('xmr20-vault');return decryptVault(data['xmr20-vault'],session.password);},
 unlock:async password=>{const data=await chrome.storage.local.get(['xmr20-vault','xmr20-lock-signal']);const vault=await decryptVault(data['xmr20-vault'],password);return controller.handle({action:'open',password,box:data['xmr20-vault'],lockSignal:data['xmr20-lock-signal']??null,activeId:vault.accounts[0]?.id});},
 sign:async(message,secret)=>{const key=importSol(secret);try{return bs58.encode(ed25519.sign(new TextEncoder().encode(message),key.secretKey.slice(0,32)));}finally{key.secretKey.fill(0);}}
});
// Background market runner (30 Oct 2026): answers buyers and approves 'auto' listings' sales with every wallet window closed.
if(MONERO_MARKET)attachMarketRunner({chrome,controller,serial,readVault:async session=>{const data=await chrome.storage.local.get('xmr20-vault');return decryptVault(data['xmr20-vault'],session.password);}});
chrome.runtime.onMessageExternal.addListener((message,sender,reply)=>{
 serial(()=>broker.external(message,sender)).then(value=>reply({value}),e=>reply({error:e.message}));return true;
});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(message?.channel!=='xmr20-site-approval')return;
 serial(()=>broker.internal(message,sender)).then(value=>reply({value}),e=>reply({error:e.message}));return true;
});
if(typeof __XMR20_NATIVE_MARKET__!=='undefined'&&__XMR20_NATIVE_MARKET__){
 // New extension windows can emit loading before their URL is available.
 // Navigation invalidates website documents; only removal closes a bound
 // packaged host. Its exact internal sender/tab checks still apply on reload.
 chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==='loading')void serial(()=>broker.revokeTab(tabId,{navigation:true}));});
 chrome.tabs.onRemoved.addListener(tabId=>{void serial(()=>broker.revokeTab(tabId));});
}
