import {siteSender,siteSigningRequest,publicAccount,publicMoneroAccount,bridgeLaunch,MARKET_READ_ORIGIN,MONERO_MARKET_ORIGIN} from './site-policy.js';
import {MARKET_ORIGIN,marketLaunch} from './market-policy.js';
import {isWalletPopup} from './native-popup-channel.js';
const SLOT='xmr20-site-connection';
// Requests and grants are RAM-only and scoped to one tab/document and unlock session.
// MONERO MARKET candidate (29 Oct 2026): `moneroMarket` enables the pinned market origin (site-policy MONERO_MARKET_ORIGIN), the
// packaged market window (market-wallet.html) and the forwarding of bounded market.* requests to it over `marketHosts`.
export function createSiteBroker({chrome,readSession,unlock,readVault,sign,signCustody=null,jointBridge=false,nativeMarket=false,moneroMarket=false,marketHosts=null,nativePopupAlive=()=>false,now=Date.now,uuid=()=>crypto.randomUUID()}){
 moneroMarket=Boolean(moneroMarket&&MONERO_MARKET_ORIGIN&&marketHosts);
 const MW=()=>chrome.runtime.getURL('market-wallet.html');
 const storage=chrome.storage.session;
 const load=async()=> (await storage.get(SLOT))[SLOT]||{grants:{},requests:{}};
 const save=state=>storage.set({[SLOT]:state});
 const key=s=>s.tabId+':'+s.documentId;
 const same=(a,b)=>a.origin===b.origin&&a.tabId===b.tabId&&a.documentId===b.documentId;
 const popupSender=sender=>isWalletPopup(sender,chrome.runtime);
 async function pruneMarkets(state,session){
  for(const [id,r]of Object.entries(state.markets||{})){
   if(r.sessionId!==session.id||!r.internal&&!state.grants[key(r)]){delete state.markets[id];continue;}
   if(r.inline){
    if(!nativePopupAlive(r.nativePopupId))delete state.markets[id];
   }else try{await chrome.windows.get(r.windowId);}catch{delete state.markets[id];}
  }
 }
 async function clean(state){for(const [id,r]of Object.entries(state.requests)){if(r.expires<=now()){delete state.requests[id];continue;}if(!r.result&&!r.error){try{await chrome.windows.get(r.windowId);}catch{r.error='Request cancelled.';}}}const s=await readSession();for(const [id,g]of Object.entries(state.grants))if(!s||g.sessionId!==s.id)delete state.grants[id];return s;}
 async function external(m,sender){
  const source=siteSender(sender,{jointBridge,nativeMarket,moneroMarket});if(m?.channel!=='xmr20-site')throw Error('Unsupported request.');
  const moneroMarketSource=moneroMarket&&source.origin===MONERO_MARKET_ORIGIN;
  // A dedicated lab origin may only use the market actions; when the market page lives on the site itself, the site's own actions stay available.
  if(moneroMarketSource&&MONERO_MARKET_ORIGIN!=='https://xmr20.org'&&!['ping','connectMonero','status','disconnect','result','openMoneroMarket','market'].includes(m.action))throw Error('Use XMR20 Wallet to review market operations.');
  if(source.origin===MARKET_READ_ORIGIN&&!['ping','connect','status','disconnect','result'].includes(m.action))throw Error('The local market may only connect and read the public account.');
  if(source.origin===MARKET_ORIGIN&&!['ping','connect','connectMonero','status','disconnect','result','openMarket',...(moneroMarket?['openMoneroMarket','market']:[])].includes(m.action))throw Error('Use XMR20 Wallet to review market operations.');
  if(m.action==='connectMonero'&&!(nativeMarket&&source.origin===MARKET_ORIGIN)&&!moneroMarketSource)throw Error('Monero connection is only available to the configured market.');
  if(m.action==='ping')return {name:'XMR20 Wallet',version:chrome.runtime.getManifest().version,jointBridge,nativeMarket,moneroMarket};
  const state=await load(),session=await clean(state),grant=state.grants[key(source)];await save(state);
  if(m.action==='disconnect'){delete state.grants[key(source)];for(const [id,r]of Object.entries(state.requests))if(same(r,source))delete state.requests[id];for(const [id,r]of Object.entries(state.markets||{}))if(same(r,source))delete state.markets[id];await save(state);return true;}
  if(m.action==='status')return grant?{account:grant.account}:null;
  if(m.action==='result'){
   const r=state.requests[m.requestId];if(!r||!same(r,source))throw Error('Connection request expired. Try again.');
   if(r.result||r.error){delete state.requests[m.requestId];await save(state);if(r.error)throw Error(r.error);if(!session||r.sessionId!==session.id)throw Error('Wallet locked. Connect again.');return {done:true,value:r.result};}
   try{await chrome.windows.get(r.windowId);}catch{delete state.requests[m.requestId];await save(state);throw Error('Request cancelled.');}
   return {done:false};
  }
  if(m.action==='openMoneroMarket'){
   if(!moneroMarketSource||!grant||!session||grant.sessionId!==session.id||!grant.account.monero||session.activeId!==grant.account.id)throw Error('Connect the selected XMR20 Wallet account to this market first.');
   state.markets??={};await pruneMarkets(state,session);
   const mine=Object.values(state.markets).find(r=>r.kind==='monero-market'&&same(r,source));
   if(mine)return {opened:true,account:grant.account,existing:true};
   if(Object.keys(state.markets).length)throw Error('Continue or close the existing XMR20 Wallet market window first.');
   const id=uuid(),window=await chrome.windows.create({url:MW()+'?request='+id,type:'popup',width:420,height:760});
   state.markets[id]={...source,id,kind:'monero-market',market:{view:'monero-market'},account:grant.account,moneroOnly:true,sessionId:session.id,windowId:window.id,approvalTabId:window.tabs[0].id};await save(state);
   return {opened:true,account:grant.account};
  }
  if(m.action==='market'){
   if(!moneroMarketSource||!grant||!session||grant.sessionId!==session.id||session.activeId!==grant.account.id)throw Error('Connect the selected XMR20 Wallet account to this market first.');
   state.markets??={};await pruneMarkets(state,session);await save(state);
   const r=Object.values(state.markets).find(r=>r.kind==='monero-market'&&same(r,source)&&r.sessionId===session.id&&r.account.id===grant.account.id);
   if(!r)throw Error('Open the market in XMR20 Wallet first.');
   if(typeof m.method!=='string'||!/^[a-zA-Z]{1,24}$/.test(m.method)||(m.id!==undefined&&!/^[A-Za-z0-9_-]{1,96}$/.test(String(m.id)))||(m.body!==undefined&&(typeof m.body!=='object'||m.body===null||JSON.stringify(m.body).length>4096)))throw Error('Malformed market request.');
   const reply=await marketHosts.request(r.id,{method:m.method,id:m.id,body:m.body},45000);
   if(reply.error)throw Object.assign(Error(reply.error),{status:reply.status});
   return reply.value;
  }
  if(m.action==='openMarket'){
   if(!nativeMarket||source.origin!==MARKET_ORIGIN||!grant||!session||grant.sessionId!==session.id||!grant.account.monero||session.activeId!==grant.account.id)throw Error('Connect the selected XMR20 Wallet account to this market first.');
   const market=marketLaunch(m.market);state.markets??={};
   await pruneMarkets(state,session);
   // One market host per unlocked wallet, across website tabs. Keep its private
   // worker and in-progress trade intact instead of starting a second signer.
   if(Object.keys(state.markets).length)throw Error('Continue or close the existing XMR20 Wallet market window first.');
   const id=uuid(),window=await chrome.windows.create({url:chrome.runtime.getURL('market.html')+'?request='+id,type:'popup',width:1100,height:850});
   state.markets[id]={...source,id,market,account:grant.account,moneroOnly:grant.moneroOnly===true,sessionId:session.id,windowId:window.id,approvalTabId:window.tabs[0].id};await save(state);
   return {opened:true,account:grant.account};
  }
  if(!['connect',...(nativeMarket||moneroMarket?['connectMonero']:[]),'signIn',...(jointBridge?['openBridge']:[])].includes(m.action))throw Error('Use the extension to send or approve transactions.');
  if(grant?.moneroOnly&&['signIn','openBridge'].includes(m.action))throw Error('This Monero connection does not authorize Solana operations.');
  if(Object.values(state.requests).some(r=>!r.result&&!r.error))throw Error('Finish or close the open wallet request first.');
  if(m.action==='signIn'){if(!grant)throw Error('Connect your wallet first.');siteSigningRequest(m.message,grant.account,now(),source.origin);}
  if(m.action==='openBridge'&&(!grant||!session||grant.sessionId!==session.id||!grant.account.monero))throw Error('Connect an account with linked Solana and Monero wallets first.');
  const id=uuid(),request={...source,id,action:m.action,expires:now()+300000,message:m.action==='signIn'?m.message:null,accountId:grant?.account.id,sessionId:session?.id};
  if(m.action==='openBridge')request.bridge=bridgeLaunch(m.bridge);
  const window=await chrome.windows.create({url:chrome.runtime.getURL(m.action==='openBridge'?'popup.html':'approval.html')+'?request='+id,type:'popup',width:420,height:740});
  request.windowId=window.id;request.approvalTabId=window.tabs[0].id;state.requests[id]=request;await save(state);return {requestId:id};
 }
 async function internal(m,sender){
  if(nativeMarket&&['openNativeSend','openNativeBridge','openNativeConvert'].includes(m.action)){
   // The background attaches this ID to messages from one live runtime port.
   if(!popupSender(sender)||!nativePopupAlive(sender.nativePopupId)||Object.keys(m).sort().join(',')!=='action,channel')throw Error('Open native sends from XMR20 Wallet.');
   const state=await load(),session=await clean(state);if(!session)throw Error('Unlock your Monero wallet first.');
   const vault=await readVault(session),a=vault.accounts.find(a=>a.id===session.activeId);
   if(!a?.xmrSeed||!a.xmr||a.watch)throw Error('Choose a Monero wallet with its recovery keys.');
   const conversion=m.action==='openNativeConvert';
   if(conversion&&(!a.solSecret||!a.sol))throw Error('Choose the Solana holder account for this one-time conversion.');
   const current=await readSession();if(!current||current.id!==session.id||current.activeId!==a.id)throw Error('Wallet changed or locked.');
   state.markets??={};
   await pruneMarkets(state,session);
   if(Object.keys(state.markets).length)throw Error('Continue or close the existing Monero wallet operation first.');
   const id=uuid();
   state.markets[id]={id,internal:true,inline:true,nativePopupId:sender.nativePopupId,approvalTabId:sender.tab?.id??null,market:{view:conversion?'convert':m.action==='openNativeBridge'?'redeem':'send'},account:conversion?publicAccount(a):publicMoneroAccount(a),moneroOnly:!conversion,sessionId:session.id};await save(state);
   return {opened:true,requestId:id,account:conversion?publicAccount(a):publicMoneroAccount(a)};
  }
  const marketWalletSender=moneroMarket&&sender.id===chrome.runtime.id&&sender.url?.split('?')[0]===MW()&&sender.frameId===0;
  if((nativeMarket||moneroMarket)&&sender.id===chrome.runtime.id&&(sender.url?.split('?')[0]===chrome.runtime.getURL('market.html')||marketWalletSender||popupSender(sender)&&['marketView','marketCheck','marketKeys','marketSignCustody','marketClose'].includes(m.action))){
   const state=await load(),session=await clean(state),r=state.markets?.[m.requestId],grant=r&&state.grants[key(r)];
   const alive=()=>!r?.inline||nativePopupAlive(r.nativePopupId);
   const bound=r?.kind==='monero-market'?marketWalletSender&&sender.tab?.id===r.approvalTabId:r?.inline?popupSender(sender)&&sender.nativePopupId===r.nativePopupId&&alive()&&(sender.tab?.id??null)===r.approvalTabId:sender.url?.split('?')[0]===chrome.runtime.getURL('market.html')&&sender.frameId===0&&sender.tab?.id===r?.approvalTabId;
   if(!r||!bound||!session||r.sessionId!==session.id||session.activeId!==r.account.id||!r.internal&&(grant?.sessionId!==session.id||grant.account.id!==r.account.id||grant.account.solana!==r.account.solana||grant.account.monero!==r.account.monero))throw Error('Market wallet changed or locked. Reopen from your wallet.');
   if(!r.internal){const tab=await chrome.tabs.get(r.tabId);if(new URL(tab.url).origin!==r.origin)throw Error('The requesting market has changed.');}
   if(m.action==='marketClose'){delete state.markets[m.requestId];await save(state);return true;}
   if(m.action==='marketView'){
    const vault=await readVault(session),a=vault.accounts.find(a=>a.id===r.account.id);
    if(!a||a.xmr!==r.account.monero||!Number.isSafeInteger(a.height??0)||(a.height??0)<0)throw Error('Wallet restore height unavailable.');
    const current=await readSession();if(!current||current.id!==session.id||current.activeId!==r.account.id)throw Error('Wallet changed or locked.');
    return {account:r.account,market:r.market,sessionId:session.id,restoreHeight:a.height??0};
   }
   if(m.action==='marketCheck')return {account:r.account,market:r.market,sessionId:session.id};
   if(m.action==='marketSignCustody'){
    if(!r.internal||r.market.view!=='convert'||typeof signCustody!=='function'||Object.keys(m).sort().join(',')!=='action,channel,plan,proposal,requestId')throw Error('Review custody in its bound wallet screen.');
    const vault=await readVault(session),a=vault.accounts.find(a=>a.id===r.account.id);
    if(!a?.solSecret||a.watch||a.sol!==r.account.solana||a.xmr!==r.account.monero)throw Error('Custody holder changed.');
    const checkCurrent=async()=>{const current=await readSession();if(!alive()||!current||current.id!==session.id||current.activeId!==a.id)throw Error('Custody wallet locked or changed.');};
    await checkCurrent();const result=await signCustody({account:a,plan:m.plan,proposal:m.proposal,checkCurrent});await checkCurrent();return result;
   }
   if(m.action!=='marketKeys')throw Error('Unsupported wallet market action.');
   const vault=await readVault(session),a=vault.accounts.find(a=>a.id===r.account.id);
   if(!a?.xmrSeed||a.watch||(!r.moneroOnly&&a.sol!==r.account.solana)||a.xmr!==r.account.monero)throw Error('Recover this account in XMR20 Wallet before trading.');
   const current=await readSession();if(!alive()||!current||current.id!==session.id||current.activeId!==r.account.id)throw Error('Wallet changed or locked.');
   // Bound packaged wallet document only. Never stored in requests/results and
   // never reachable from onMessageExternal or the website connection result.
   return {seed:a.xmrSeed,address:a.xmr};
  }
  if(sender.id!==chrome.runtime.id||![chrome.runtime.getURL('approval.html'),...(jointBridge?[chrome.runtime.getURL('popup.html')]:[])].includes(sender.url?.split('?')[0]))throw Error('Not an approval window.');
  const state=await load();await clean(state);const r=state.requests[m.requestId];
  if(!r||r.result||r.error||sender.tab?.id!==r.approvalTabId)throw Error('Request expired or already handled.');
  if(sender.url?.split('?')[0]!==chrome.runtime.getURL(r.action==='openBridge'?'popup.html':'approval.html'))throw Error('Not the bound approval surface.');
  if(m.action==='reject'){r.error='Request rejected.';await save(state);return true;}
  if(r.action==='openBridge'){
   const session=await readSession(),grant=state.grants[key(r)];
   if(!session||session.id!==r.sessionId||grant?.sessionId!==session.id||grant.account.id!==r.accountId)throw Error('Wallet connection changed. Connect again.');
   const tab=await chrome.tabs.get(r.tabId);if(new URL(tab.url).origin!==r.origin)throw Error('The requesting website has changed.');
   const vault=await readVault(session),a=vault.accounts.find(a=>a.id===r.accountId);
   if(!a?.solSecret||!a.xmrSeed||a.watch||a.sol!==grant.account.solana||a.xmr!==grant.account.monero)throw Error('Recover the linked keys in the extension before bridging.');
   const current=await readSession();if(!current||current.id!==session.id)throw Error('Wallet locked. Connect again.');
   if(m.action==='view')return {origin:r.origin,account:publicAccount(a),bridge:bridgeLaunch(r.bridge)};
   if(m.action!=='opened'||m.accountId!==r.accountId)throw Error('Choose the originally connected account.');
   r.result={opened:true,account:publicAccount(a)};await save(state);return true;
  }
  if(m.action==='unlock')await unlock(m.password);
  const session=await readSession();
  if(m.action==='view'||m.action==='unlock'){
   const vault=session?await readVault(session):null;
   const moneroOnly=r.action==='connectMonero';
   const accounts=vault?vault.accounts.filter(a=>!a.watch&&(moneroOnly?a.xmr&&a.xmrSeed:a.sol&&a.solSecret)).map(moneroOnly?publicMoneroAccount:publicAccount):[];
   // Connection defaults to the extension's current account; sign-in stays bound
   // to the account explicitly approved for this website, even if the popup changes.
   const preferred=r.action==='signIn'?r.accountId:(session?.activeId||vault?.accounts[0]?.id);
   const accountId=accounts.some(a=>a.id===preferred)?preferred:null;
   const signing=r.action==='signIn'&&state.grants[key(r)]?siteSigningRequest(r.message,state.grants[key(r)].account,now(),r.origin):null;
   return {origin:r.origin,action:r.action,message:r.message,signingKind:signing?.kind,unlock:signing?.kind==='vaultUnlock'?{network:signing.network,address:signing.address,backupId:signing.backupId}:null,accountId,locked:!session,accounts};
  }
  if(m.action!=='approve'||!session)throw Error('Unlock your wallet first.');
  const tab=await chrome.tabs.get(r.tabId);if(new URL(tab.url).origin!==r.origin)throw Error('The requesting website has changed.');
  const vault=await readVault(session),account=vault.accounts.find(a=>a.id===m.accountId);
  const moneroOnly=r.action==='connectMonero';
  if(!account||account.watch||(moneroOnly?!(account.xmrSeed&&account.xmr):!account.solSecret))throw Error(moneroOnly?'Choose a Monero wallet with its recovery keys.':'Choose an account with a Solana signing key.');
  let result;
  if(r.action==='connect'||moneroOnly)result={account:(moneroOnly?publicMoneroAccount:publicAccount)(account)};
  else{
   const grant=state.grants[key(r)];if(!grant||grant.sessionId!==session.id||r.sessionId!==session.id||r.accountId!==account.id||grant.account.solana!==account.sol)throw Error('Wallet connection changed. Connect again.');
   if(grant.account.monero!==account.xmr)throw Error('Linked Monero account changed. Connect again.');
   const signing=siteSigningRequest(r.message,publicAccount(account),now(),r.origin);
   result={signature:await sign(signing.message,account.solSecret),publicKey:account.sol};
  }
  // A manual lock or vault edit while decryption/signing was running invalidates approval.
  const current=await readSession();if(!current||current.id!==session.id)throw Error('Wallet locked. Connect again.');
  if(r.action==='connect'||moneroOnly)state.grants[key(r)]={origin:r.origin,tabId:r.tabId,documentId:r.documentId,account:result.account,moneroOnly,sessionId:session.id};
  r.result=result;r.sessionId=session.id;await save(state);return true;
 }
 async function revokeTab(tabId,{navigation=false}={}){
  const state=await load();
  for(const [id,r]of Object.entries(state.grants))if(r.tabId===tabId)delete state.grants[id];
  for(const [id,r]of Object.entries(state.requests))if(r.tabId===tabId)delete state.requests[id];
  for(const [id,r]of Object.entries(state.markets||{}))if(r.tabId===tabId||!navigation&&r.approvalTabId===tabId)delete state.markets[id];
  await save(state);
 }
 async function revokeNativePopup(id){
  const state=await load();for(const [key,r]of Object.entries(state.markets||{}))if(r.inline&&r.nativePopupId===id)delete state.markets[key];await save(state);
 }
 // The market window's runtime port is accepted only for the window the broker opened for that request (same tab).
 async function hostBound(requestId,sender){
  if(!moneroMarket||typeof requestId!=='string')return false;
  const state=await load(),session=await clean(state),r=state.markets?.[requestId];
  return Boolean(r&&r.kind==='monero-market'&&session&&r.sessionId===session.id&&sender?.url?.split('?')[0]===MW()&&sender.tab?.id===r.approvalTabId);
 }
 return {external,internal,revokeTab,revokeNativePopup,hostBound};
}
