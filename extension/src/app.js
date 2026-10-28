import {createJointCreditPreview} from '../../engine/shared/joint-credit-preview.js';
import {fastSendEnabled} from '../../engine/shared/joint-deployment.js';
import {createNativePopupFlow} from './native-popup-flow.js';
import {createNativeSwapPage} from '../../engine/shared/native-swap-page.js';
import {nativeTokenMetadata,nativeHoldingsKey,nativeHoldingRow} from '../../engine/shared/native-token-holdings.js';
import {createPublicBalanceReader,cachedSolBalance,saveSolBalance} from '../../engine/shared/public-balance.js';
import {createRefreshLanes} from './refresh-lanes.js';
import {cachedPortfolio,savePortfolio,portfolioDisplay} from './portfolio-cache.js';
import {cachedWalletHoldings,cacheWalletHoldings} from '../../engine/shared/holdings.js';
import {loadSolanaHoldings,solanaDisplayRows} from './solana-holdings.js';
import {maxControl,fillMaximum,maximumRaw,TOKEN_TRANSFER_LIMIT} from '../../engine/token/max-amount.js';
import {solanaMaximum,solanaTokenMaximum} from '../../engine/shared/solana-max.js';
import {createBridgeUI} from './bridge-ui.js';
import {isBridgeHolding} from '../../engine/shared/joint-wallet-assets.js';
import {legacyBridgeRecoveries,legacyRecoveryHTML} from './legacy-bridge-recovery.js';
import {createJointHoldings,isJointHolding,replaceHoldingSource,jointIncomingStatus,jointIncomingHelp} from '../../engine/shared/joint-holdings.js';
import {pendingDebits,cancellationConfirmed,balanceRejection} from './pending-debits.js';
import {tokenImage,tokenGroups,createTokenImageClient,compactTokenBalance} from '../../engine/shared/token-display.js';
import {sendFieldState} from './send-fields.js';
import {createNativePriceClient,nativeUsd,walletPortfolio,walletPortfolioEstimate} from './native-prices.js';
import {checkTransferAmount,validateTransferQuote} from './transfer-quote.js';
import {createPriceClient,tokenUsd,tokenPortfolio,usd,currentQuote} from '../../engine/shared/prices.js';
import {normalizePreferences,idleExpired,AUTO_LOCK_OPTIONS,timeoutLabel} from '../../engine/shared/preferences.js';
import {createWorkerClient} from '../../engine/token/worker-client.js';
import {createNativeScanCache,nativeScanKey} from '../../engine/token/native-scan-cache.js';
import {MONERO_NODES,preferredMoneroNode,moneroNodeLabel,moneroNodeHost,scanProgress,scanEtaLabel} from '../../engine/monero/monero-node.js';
import {resolveWalletRestoreHeight,XMR20_MONERO_START} from './monero-birthday.js';
import {matchingOrdinaryReceipt} from './ordinary-payment-status.js';
import {createScanLane} from './shared-wallet-scan.js';
import {loadPending,pendingGroups} from '../../engine/shared/pending.js';
import {prepareSolanaTokenSend} from './sol-token-send.js';
import {Keypair,PublicKey,bs58,checkMoneroAddress,solAddress,importSol,amount,units,encryptVault,decryptVault,loadWalletHoldings,connection,prepareSolSend,signSolSend,sendSolSigned,jsonFetch,login,walletRequest,validateTransfer,linkSolanaKey} from '../../engine/shared/core.js';
const jointHoldings=typeof __XMR20_JOINT_TRANSFERABLE_REVIEW__!=='undefined'&&__XMR20_JOINT_TRANSFERABLE_REVIEW__?createJointHoldings():null;
const privateBridgeTest=typeof __XMR20_JOINT_PRIVATE_TEST__!=='undefined'&&__XMR20_JOINT_PRIVATE_TEST__&&!(typeof __XMR20_JOINT_WALLET_TEST__!=='undefined'&&__XMR20_JOINT_WALLET_TEST__);
// XMR20 Open/Private tokens + private bridge (27 Oct 2026). Inert unless the build defines __XMR20_PRIVATE_FORMAT_TEST__.
import {createPrivateFormat} from '../../engine/token/token-format.js';
const privateFormatTest=typeof __XMR20_PRIVATE_FORMAT_TEST__!=='undefined'&&__XMR20_PRIVATE_FORMAT_TEST__;
let privateFormat=null;const pf=()=>privateFormatTest?(privateFormat??=createPrivateFormat({account,oneShot,workerClient:createWorkerClient,store,secret:()=>password,show,on,run,toast,esc,amount,units,compactTokenBalance,importSol,same,$,render:()=>{if(vault&&screen==='home')render();},close:()=>{modal.close();modal.innerHTML='';},tokenIcon:mint=>tokenImage(mint),solBalance:()=>(/^\d+$/.test(String(cache.sol??''))?cache.sol:null),usdOf:(mint,amountRaw)=>{const v=tokenUsd({mint,amountRaw},currentQuote(cache.prices,mint));return v===null?null:usd(v);},
 // 0.1.116 (owner: "Enable private transfers"): the token screen's split uses this account's Monero wallet (native worker
 // prepareSplit: one transaction to itself leaving 3 coins, behind the XMR20 coin guard; relay sends only that review).
 splitXmr:{prepare:async()=>{const e=epoch;const client=await nativeOpen(e);await nativeSync(e,client);same(e);return client.call('prepareSplit',{node:nodeFor(),carrierLookup:'local'},150000);},
  checkCoins:async()=>{const e=epoch;const client=await nativeOpen(e);same(e);return client.call('checkCarriers',{node:nodeFor(),carrierLookup:'node'},150000);},
  relay:async review=>{const a=account(),client=native;if(!client?.alive||nativeId!==a?.id)throw Error('The Monero wallet was closed before approval. Review again; nothing was sent.');const sent=await client.call('relay',{reviewId:review.id},180000);cache.xmr=null;delete sessionSnapshots[a.xmr];void autoCatchUp();return sent;}}})):null;
const tokenImages=createTokenImageClient();
const nativeTokenSends=typeof __XMR20_NATIVE_MARKET__!=='undefined'&&__XMR20_NATIVE_MARKET__;
const nativeSpendRecovery=typeof __XMR20_NATIVE_SPEND_PROTECTION__!=='undefined'&&__XMR20_NATIVE_SPEND_PROTECTION__;
const priceClient=createPriceClient({ttl:15000,onMetadata:rows=>void tokenImages.load(rows).then(()=>paintBalances())}),nativePriceClient=createNativePriceClient({ttl:15000}),readSolBalance=createPublicBalanceReader(),balanceReads=createRefreshLanes();
const $=s=>document.querySelector(s),app=$('#app'),modal=$('#modal');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={send:'M21 3 9 15m12-12-7 19-5-7-7-5 19-7',swap:'M3 7h16l-4-4m6 14H5l4 4M19 7l-4 4M5 17l4-4',receive:'M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h2v2h-2zM20 15v6h-5',home:'m3 10 9-7 9 7v11h-6v-7H9v7H3z',clock:'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',search:'m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',settings:'M4 7h16M4 17h16M8 4v6M16 14v6',expand:'M15 3h6v6M21 3l-8 8M9 21H3v-6M3 21l8-8',refresh:'M20 7a9 9 0 1 0 1 9M20 2v5h-5',lock:'M6 10V7a6 6 0 0 1 12 0v3M4 10h16v12H4zM12 14v4',info:'M12 10v6M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',sol:'M5 6h14l-3 3H2zM5 11h14l3 3H8zM5 16h14l-3 3H2z',copy:'M8 8h13v13H8zM16 8V3H3v13h5'};
const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.info}"/></svg>`;
const store={async get(k){if(globalThis.chrome?.storage)return (await chrome.storage.local.get(k))[k];return JSON.parse(localStorage.getItem(k)||'null');},async set(k,v){if(globalThis.chrome?.storage)await chrome.storage.local.set({[k]:v});else localStorage.setItem(k,JSON.stringify(v));}};
let vault=null,password='',box=null,activeId='',screen='home',epoch=0,runSequence=0,busy=false,priceRefreshId=0,lastActive=Date.now(),native=null,nativeId='',refreshId=0,cache={sol:null,xmr:null,rows:[],complete:false,loading:false,note:''},clients=new Set();
const scanCache=createNativeScanCache();let scan={startedAt:0,start:null,node:''};
const nativeOpenLane=createScanLane(),nativeSyncLane=createScanLane(),nativeProgressListeners=new Set();
// A scan is bounded by inactivity, not total time: progress messages renew it.
const SYNC_IDLE_MS=3*60000;
const nodeFor=()=>preferredMoneroNode(preferences);
const bridgeUI=createBridgeUI({notifyReturn:message=>{if(globalThis.chrome?.runtime?.id)void chrome.runtime.sendMessage({channel:'xmr20-return-watch',...message}).catch(()=>{});},tokenImage,account:()=>account(),rows:()=>cache.displayScope===account()?.sol+':'+account()?.xmr?cache.rows:[],refreshHoldings:()=>refresh({forceHoldings:true}),vault:()=>vault,same,show,on,run,record,persist,oneShot,esc,modal,isBusy:()=>busy,settings:()=>{modal.close();screen='settings';render();}});
let ownLockSignal=null,lastLockSignal=null,sessionId=null,sessionSnapshots={},preferences=normalizePreferences(null),nativePopup=null,sendPreview=null,setupRead=null;
async function session(action,data={}){if(!globalThis.chrome?.runtime?.id)return null;const response=await chrome.runtime.sendMessage({channel:'wallet-session',action,id:sessionId,...data});if(response?.error)throw Error(response.error);return response?.value??null;}
async function establishSession(generation,signal=lastLockSignal){if(generation!==epoch)throw Error('Wallet locked.');const result=await session('open',{password,box,activeId,lockSignal:signal});if(generation!==epoch)throw Error('Wallet locked.');sessionId=result?.id||null;lastActive=result?.lastActive||Date.now();sessionSnapshots=result?.snapshots||{};}
function rememberSession(){if(!sessionId)return;if(cache.xmr)sessionSnapshots[cache.xmr.address]=cache.xmr;void session('remember',{activeId,snapshot:cache.xmr}).catch(()=>{});}
async function resumeSession(){const generation=epoch,result=await session('resume');if(!result||!box)return;const unlocked=await decryptVault(box,result.password);if(generation!==epoch)return;sessionId=result.id;const still=await session('check');if(!still||generation!==epoch){sessionId=null;return;}vault=unlocked;password=result.password;activeId=result.activeId;lastActive=still.lastActive;sessionSnapshots=result.snapshots||{};cache.xmr=sessionSnapshots[account()?.xmr]||null;epoch++;applyDefaultRestoreHeights();}

const activityChannel=new BroadcastChannel('xmr20-wallet-activity');let lastActivityBroadcast=0;
activityChannel.onmessage=({data})=>{if(data?.type==='activity'&&Number.isSafeInteger(data.at)&&data.at<=Date.now()+1000&&data.at>=Date.now()-5000)lastActive=Math.max(lastActive,data.at);};
const sameBox=(a,b)=>!a&&!b||!!a&&!!b&&['version','kdf','iterations','salt','iv','ciphertext'].every(k=>a[k]===b[k]);
const account=()=>vault?.accounts.find(a=>a.id===activeId)||vault?.accounts[0];
let toastTimer;function toast(text){$('#toast').textContent=text;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3200);}
function on(id,fn){const el=$('#'+id);if(el)el.onclick=fn;}
function endWorkers(){setupRead?.abort(Error('Wallet setup closed.'));setupRead=null;sendPreview?.close();sendPreview=null;nativePopup?.close();nativePopup=null;balanceReads.clear();jointHoldings?.clear();bridgeUI.clear();for(const c of clients)c.close();clients.clear();native=null;nativeId='';}
function lock(propagate=true){privateFormat?.reset();if(propagate){ownLockSignal=crypto.randomUUID();void store.set('xmr20-lock-signal',ownLockSignal).catch(()=>{});}epoch++;runSequence++;refreshId++;endWorkers();vault=null;password='';sessionId=null;sessionSnapshots={};cache={sol:null,xmr:null,rows:[],complete:false,loading:false,note:''};modal.close();modal.innerHTML='';busy=false;render();}
function checkIdle(){if((vault||modal.open)&&idleExpired(lastActive,Date.now(),preferences.autoLockMinutes)){lock();return true;}return false;}
function userActivity(event){if(!event.isTrusted||checkIdle())return;lastActive=Date.now();if(lastActive-lastActivityBroadcast>=1000){activityChannel.postMessage({type:'activity',at:lastActive});lastActivityBroadcast=lastActive;if(sessionId){const generation=epoch;void session('touch').then(value=>{if(!value&&generation===epoch)lock(false);}).catch(()=>{if(generation===epoch)lock();});}}}
for(const type of ['pointerdown','pointermove','keydown','wheel','touchstart'])document.addEventListener(type,userActivity,{passive:true,capture:true});
setInterval(checkIdle,1000);
function wakeRefresh(){if(!document.hidden&&!checkIdle()&&vault)void refresh({forcePrices:true});}
window.addEventListener('focus',wakeRefresh);document.addEventListener('visibilitychange',wakeRefresh);
setInterval(()=>{if(vault&&!document.hidden&&!checkIdle()){if(!modal.open&&!busy&&['home','explore'].includes(screen))void refresh({forcePrices:true});else void refreshPrices({force:true});}},15000);
window.addEventListener('pagehide',()=>lock(false));
function storageChanged(changes,area){if(area!=='local')return;if(changes['xmr20-preferences']){preferences=normalizePreferences(changes['xmr20-preferences'].newValue);if(!checkIdle()&&vault&&screen==='settings')render();}if(changes['xmr20-vault']&&!sameBox(changes['xmr20-vault'].newValue,box)){box=changes['xmr20-vault'].newValue||null;lock(false);}if(changes['xmr20-lock-signal']){lastLockSignal=changes['xmr20-lock-signal'].newValue;if(lastLockSignal!==ownLockSignal)lock(false);}}
if(globalThis.chrome?.storage){chrome.storage.onChanged.addListener(storageChanged);void chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});}else window.addEventListener('storage',event=>{if(['xmr20-vault','xmr20-lock-signal','xmr20-preferences'].includes(event.key))storageChanged({[event.key]:{newValue:event.newValue?JSON.parse(event.newValue):null}},'local');});
async function writeBox(next,{replace=false,generation=epoch}={}){
 return navigator.locks.request('xmr20-vault-write',async()=>{
  const current=await store.get('xmr20-vault');if(generation!==epoch)throw Error('Wallet locked.');
  if(!replace&&!sameBox(current,box)){box=current||null;lock(false);toast('Wallet changed in another window. Unlock again.');throw Error('Wallet changed.');}
  const previous=box;box=next;try{await store.set('xmr20-vault',next);}catch(error){box=previous;throw error;}
 });
}
async function persist(){const generation=epoch,data=vault,pw=password;const next=await encryptVault(data,pw);if(generation!==epoch)throw Error('Wallet locked.');await writeBox(next,{generation});}
function show(title,body){setupRead?.abort(Error('Wallet setup closed.'));setupRead=null;sendPreview?.close();sendPreview=null;modal.innerHTML=`<div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button id="close" aria-label="Close">×</button></div><div class="modal-body">${body}</div><div class="modal-foot"><p class="error" id="error" role="alert"></p></div>`;layoutModal();if(!modal.open)modal.showModal();on('close',()=>{if(!busy){modal.close();modal.innerHTML='';paintBalances();}});}
// The body scrolls while progress, the trailing action buttons and errors stay
// in view at short popup heights. Elements keep their ids and handlers.
function layoutModal(){
 const body=modal.querySelector(':scope > .modal-body'),foot=modal.querySelector(':scope > .modal-foot');if(!body||!foot)return;
 const moved=[];let seenButton=false;
 for(let el=body.lastElementChild;el;el=el.previousElementSibling){
  const button=el.matches('button.wide,button.text-btn,button.primary,button.secondary'),status=el.matches('p#progress,p.busy'),note=el.matches('p.subtle,p.notice')&&seenButton;
  if(!button&&!status&&!note)break;
  if(button)seenButton=true;moved.unshift(el);
 }
 if(!seenButton)return;
 foot.prepend(...moved);foot.classList.add('has-actions');
}
modal.addEventListener('cancel',event=>{if(busy)event.preventDefault();else{bridgeUI.clear();modal.innerHTML='';}});
modal.addEventListener('close',()=>{if(modal.open)return;setupRead?.abort(Error('Wallet setup closed.'));setupRead=null;bridgeUI.clear();nativePopup?.close();nativePopup=null;});
async function run(fn){if(busy)return;busy=true;const e=epoch,task=++runSequence;const buttons=[...modal.querySelectorAll('button:not([data-keep]),input,textarea,select')];buttons.forEach(b=>b.disabled=true);if($('#error'))$('#error').textContent='';try{await fn(e);}catch(error){if(e===epoch){if($('#progress'))$('#progress').textContent='';if($('#error'))$('#error').textContent=error.message||'Could not complete. Try again.';else toast(error.message);}}finally{if(task===runSequence){busy=false;buttons.forEach(b=>b.disabled=b.dataset.disabled==='true');}}}
function same(e){if(e!==epoch||!vault)throw Error('Wallet changed or locked.');}
// 26 Oct 2026: wallets imported before the XMR20-start default have restore height 0 and would scan the whole chain.
// Move them (once) to the XMR20 start; a height the owner chose explicitly, including 0, is kept. Their old block-0
// scan checkpoint is removed because saved progress is keyed by restore height.
// 26 Oct 2026: incoming XMR that is not spendable yet, from the last sync (scanner summary v1): still in the transaction
// pool, or in a block with fewer than 10 confirmations. Change from this wallet's own sends is not included.
function receivingXmr(x=cache.xmr){
 const i=x?.incoming;if(!i||!(i.count>0))return null;let pending=0n,confirming=0n;
 try{pending=BigInt(i.pendingRaw||'0');confirming=BigInt(i.confirmingRaw||'0');}catch{return null;}
 const total=pending+confirming;if(total<=0n)return null;
 const n=Number.isSafeInteger(i.minConfirmations)?Math.max(0,Math.min(i.minConfirmations,9)):0;
 const status=pending>0n?'Waiting for its first confirmation, usually about 2 minutes.':n+' of 10 confirmations · spendable in about '+((10-n)*2)+' min.';
 return {total,amount:'+'+compactTokenBalance(total.toString(),12)+' XMR',status};
}
// A catch-up sync when the wallet opens, unlocks or switches account, and on Refresh, so XMR shows without pressing Sync
// (owner, 28 Oct 2026: Monero and XMR20 on Monero sync together, from the last sync). For a wallet with saved scan progress
// (it resumes there) or one that starts at or after the XMR20 start (a short first scan); not more than once a minute, and
// never while another task runs.
async function autoCatchUp(){
 const a=account(),e=epoch;if(!a?.xmrSeed||busy||modal.open)return;
 if(cache.xmr?.address===a.xmr&&Number.isSafeInteger(cache.xmr.updatedAt)&&Date.now()-cache.xmr.updatedAt<60000)return;
 const key=nativeScanKey(a),saved=key?await scanCache.load(key):null;
 if(!saved&&!(a.height>=XMR20_MONERO_START))return;
 xmrSyncing++;xmrRowNote('Syncing…');
 try{const result=await nativeSync(e,await nativeOpen(e));if(e===epoch&&account()?.id===a.id&&result&&screen==='home')render();}catch{/* the manual Sync button reports problems */}
 finally{xmrSyncing--;if(!xmrSyncing)xmrRowNote(xmrNote());}
}
function applyDefaultRestoreHeights(){
 let changed=false;
 for(const a of vault?.accounts||[]){
  if(!a.xmrSeed||a.height!==0||a.heightChosen)continue;
  const oldKey=nativeScanKey(a);a.height=XMR20_MONERO_START;changed=true;if(oldKey)void scanCache.clear(oldKey);
 }
 if(changed)void persist().catch(()=>{});
 return changed;
}
function short(a){return a?a.slice(0,6)+'…'+a.slice(-5):'Not connected';}
// A terminated worker (deadline, load failure, lock) removes itself from the
// live set and from `native`, so the next click opens a fresh worker instead of
// posting to a dead one.
function workerClient(file,hooks={}){const client=createWorkerClient(file,{onProgress:renderScanProgress,...hooks,onDead:()=>{clients.delete(client);if(native===client){native=null;nativeId='';}hooks.onDead?.();}});clients.add(client);return client;}
function renderScanProgress(p){
 for(const listener of nativeProgressListeners)listener(p);
 const el=$('#progress');if(!el||!p||typeof p!=='object')return;
 if(p.node)scan.node=p.node;
 if(p.phase==='opening'){el.textContent='Connecting to another Monero node…';return;}
 if(p.phase==='retrying'){el.textContent=`Connection interrupted at block ${(p.height||0).toLocaleString()}. Retrying with ${moneroNodeLabel(p.node)} in ${Math.max(1,Math.round((p.wait||0)/1000))} s (retry ${p.retry})… Progress is saved.`;return;}
 if(!Number.isSafeInteger(p.height)||!Number.isSafeInteger(p.target)){el.textContent='Scanning Monero'+(scan.node?' with '+moneroNodeLabel(scan.node):'')+'. Keep this window open.';return;}
 if(!scan.startedAt||scan.start!==p.start)scan={...scan,startedAt:Date.now(),start:p.start};
 const s=scanProgress({height:p.height,target:p.target,start:p.start,startedAt:scan.startedAt});if(!s)return;
 el.textContent=`Scanning Monero · ${s.percent}% · ${s.left.toLocaleString()} blocks left${s.eta!==null?' · '+scanEtaLabel(s.eta):''}${scan.node?' · '+moneroNodeLabel(scan.node):''}`;
 const bar=$('#sync-bar');if(bar){bar.style.width=s.percent+'%';bar.parentElement?.setAttribute('aria-valuenow',String(s.percent));}
}
// Scan with the preferred node, failing over automatically. The result records
// which node finished so review and relay stay on the same chain view.
async function nativeSync(e,client=null){const c=client||await nativeOpen(e);return nativeSyncLane.run(c,async()=>{same(e);scan={startedAt:0,start:null,node:''};xmrSyncing++;xmrRowNote('Syncing…');try{let result=await c.call('sync',{node:c.opened?.node||nodeFor(),failover:true},SYNC_IDLE_MS,{idle:true});if(c.checkpointSaved)await c.checkpointSaved;same(e);
 // 0.1.115: once per opened Monero wallet, the worker's local coin check (no transaction lookups at the node) releases XMR20
 // carrier change that 0.1.114's guard froze as unreadable (and keeps XN1 carriers frozen); the balance is then re-read.
 if(!c.carriersChecked){c.carriersChecked=true;try{await c.call('checkCarriers',{node:result.node||nodeFor(),carrierLookup:'local'},120000);same(e);result=await c.call('sync',{node:result.node||nodeFor(),failover:true},SYNC_IDLE_MS,{idle:true});if(c.checkpointSaved)await c.checkpointSaved;same(e);}catch(error){if(/^Wallet changed/.test(error?.message||''))throw error;}}
 c.opened={...c.opened,node:result.node,height:result.height};cache.xmr=result;rememberSession();return result;}finally{xmrSyncing--;if(!xmrSyncing)xmrRowNote(xmrNote());}});}
// While XMR syncs, the home Monero row says so; the XMR20 token scan's own "Syncing · N%" on that row is left as it is.
let xmrSyncing=0;
function xmrNote(){const a=account();return cache.xmr==null?(a?.xmrSeed?(xmrSyncing?'Syncing…':'Tap to sync'):'Private balance'):xmrSyncing?'Syncing…':receivingXmr()?'Receiving '+receivingXmr().amount:'Last synced '+new Date(cache.xmr.updatedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
function xmrRowNote(text){const note=app.querySelector('#asset-xmr .asset-value small:last-child');if(note&&!note.querySelector('.coin-syncing'))note.textContent=text;}
function xmrRowProgress(p){if(!xmrSyncing||!p||!Number.isSafeInteger(p.height)||!Number.isSafeInteger(p.target))return;const s=scanProgress({height:p.height,target:p.target,start:p.start,startedAt:scan.startedAt||Date.now()});if(s)xmrRowNote('Syncing · '+s.percent+'%');}
function oneShot(file,action,args){const c=workerClient(file);return c.call(action,args).finally(()=>c.close());}
function header(){const a=account();return `<header class="top"><div class="brand">xm</div><button class="account" id="accounts"><span class="eyebrow">XMR20 WALLET</span><strong>${esc(a?.name||'Your keys. Your wallet.')} <span>⌄</span></strong></button><button class="icon-btn" id="expand" aria-label="Open full wallet">${icon('expand')}</button>${vault?`<button class="icon-btn" id="lock" aria-label="Lock wallet">${icon('lock')}</button>`:''}</header>`;}
function footer(){return `<nav class="bottom" aria-label="Main navigation">${[['home','home','Wallet'],['activity','clock','Activity'],['explore','search','Explore'],['settings','settings','Settings']].map(([id,i,label])=>`<button class="nav ${screen===id?'active':''}" id="nav-${id}">${icon(i)}<span>${label}</span></button>`).join('')}</nav>`;}
// 28 Oct 2026 (owner): XMR20 held on Monero (open and private) is a row in the Monero section of the token list, next to
// the other Monero rows; with no Monero section yet one is created ahead of Solana (replacing the empty-list note).
function placeMoneroTokens(){
 const host=app.querySelector('#token-sections'),rows=host?pf().rowsHTML():'';
 if(host&&rows){let sec=host.querySelector('section.token-section[data-network="monero"],section.token-section[aria-label="Monero tokens"]');
  if(!sec){host.querySelectorAll(':scope > .section-label,:scope > .empty').forEach(n=>n.remove());host.insertAdjacentHTML('afterbegin','<section class="token-section" aria-label="Monero tokens" data-network="monero"><div class="section-label"><span>MONERO</span><span></span></div></section>');sec=host.querySelector('section.token-section[data-network="monero"]');}
  const label=sec.querySelector('.section-label');label.insertAdjacentHTML('afterend',rows);const n=sec.querySelectorAll(':scope > .asset').length,count=label.children[1];if(count)count.textContent=n+' '+(n===1?'asset':'assets');}
 // Owner, 28 Oct: while Monero is being scanned for tokens, the Monero row says so (not a separate token row).
 const st=pf().syncStatus(),xmr=app.querySelector('#asset-xmr');
 if(st.syncing){const empty=app.querySelector('#token-sections > .empty');if(empty)empty.innerHTML='<strong>Looking for your tokens…</strong>Monero is syncing. Your tokens appear here when it finishes.';}
 if(st.syncing&&xmr){const note=xmr.querySelector('.asset-value small:last-child');if(note)note.innerHTML=`<span class="coin-syncing"><span class="pf-spin" aria-hidden="true"></span>Syncing · <span id="pf-pct">${st.pct??0}%</span></span>`;xmr.querySelector('.asset-info')?.insertAdjacentHTML('beforeend',`<span class="pf-bar coin-sync" role="progressbar" aria-label="Monero sync"><i id="pf-bar" style="width:${st.pct??3}%"></i></span>`);}
 pf().bind();
}
// 28 Oct 2026 (owner: "fix all of this, so that its just premium wallet UI, everything is intuitive and it all works for the new
// open/private token format"): Send, Bridge and Receive list every asset by chain and open the right flow for it.
const positiveRaw=v=>{try{return BigInt(v||'0')>0n;}catch{return false;}};
function hubRow(id,coin,name,sub,value,note=''){return `<button class="asset hub-row" id="${id}">${coin}<span class="asset-info"><strong>${esc(name)}</strong><small>${esc(sub)}</small></span><span class="asset-value">${esc(value)}${note?`<small>${esc(note)}</small>`:''}</span></button>`;}
const hubHead=(title,toMonero)=>`<span class="pf-screen" hidden></span><div class="pf-seg hub-seg" role="group" aria-label="${title}"><button class="${toMonero?'on':''}" id="hub-to-monero" aria-pressed="${toMonero}">To Monero<small>from Solana</small></button><button class="${toMonero?'':'on'}" id="hub-to-solana" aria-pressed="${!toMonero}">To Solana<small>from Monero</small></button></div>`;
function openBridgeHub(dir=null){
 const a=account();if(!a)return;const p=pf(),st=p.syncStatus(),solRows=cache.rows.map((r,i)=>({r,i})).filter(({r})=>r.network==='solana'&&!isJointHolding(r)&&positiveRaw(r.amountRaw)),held=p.heldTokens(),monRows=cache.rows.filter(r=>r.network==='monero'&&positiveRaw(r.amountRaw));
 const toMonero=dir?dir==='to-monero':solRows.length>0||!(held.length||monRows.length);const items=[];
 if(toMonero){for(const {r} of solRows)items.push({html:c=>hubRow(c,tokenCoin(r),r.name||r.ticker,'Arrives as open '+r.ticker+' on Monero',compactTokenBalance(r.amountRaw)+' '+r.ticker,'On Solana'),go:()=>void run(()=>p.openBridge(r.mint,'deposit',()=>openBridgeHub('to-monero'),{symbol:r.ticker,name:r.name,solanaBalance:r.amountRaw}))});}
 else{for(const t of held)items.push({html:c=>hubRow(c,tokenCoin({mint:t.mint,ticker:t.symbol,network:'monero'}),t.name,positiveRaw(t.private)?compactTokenBalance(t.open)+' open · '+compactTokenBalance(t.private)+' private':t.label,compactTokenBalance(t.open)+' '+t.symbol,'Open balance'),go:()=>void run(()=>p.openBridge(t.mint,'redeem',()=>openBridgeHub('to-solana')))});
  for(const r of monRows)items.push({html:c=>hubRow(c,tokenCoin(r),r.name||r.ticker,isJointHolding(r)?'Previously bridged tokens':'Inscription',compactTokenBalance(r.amountRaw)+' '+r.ticker,'On Monero'),go:()=>void bridgeUI.open({mint:r.mint,direction:'xmr-to-sol'})});}
 const syncing=!toMonero&&st.syncing?`<div class="asset hub-row hub-wait" role="status"><span class="coin xmr">M</span><span class="asset-info"><strong>Monero tokens</strong><small>Syncing · ${st.pct??0}%</small></span></div>`:'';
 show('Bridge',`${hubHead('Bridge direction',toMonero)}<div class="hub-list">${syncing}${items.map((x,i)=>x.html('hub-row-'+i)).join('')||(syncing?'':`<div class="empty">${toMonero?'No tokens on Solana to bridge yet.':'No tokens on Monero to bridge yet.'}</div>`)}</div><p id="progress" class="busy" role="status"></p><p id="error" class="error" role="alert"></p><p class="hub-note">${toMonero?'Tokens arrive on Monero as open tokens in about 20 minutes. Make them private there whenever you like.':'Open tokens return to this account’s Solana address in about 20 minutes. Make private tokens open first.'}</p>`);
 on('hub-to-monero',()=>openBridgeHub('to-monero'));on('hub-to-solana',()=>openBridgeHub('to-solana'));items.forEach((x,i)=>on('hub-row-'+i,x.go));
}
function openSendHub(){
 const a=account();if(!a)return;const p=pf(),st=p.syncStatus(),items=[];
 if(a.sol)items.push({html:c=>hubRow(c,`<span class="coin sol">${icon('sol')}</span>`,'Solana','SOL',cache.sol==null?'— SOL':compactTokenBalance(cache.sol,9)+' SOL'),go:()=>chooseSend('sol')});
 if(a.xmr)items.push({html:c=>hubRow(c,'<span class="coin xmr">M</span>','Monero','XMR',cache.xmr==null?'— XMR':compactTokenBalance(cache.xmr.balanceRaw,12)+' XMR'),go:()=>chooseSend('xmr')});
 for(const t of p.heldTokens())items.push({html:c=>hubRow(c,tokenCoin({mint:t.mint,ticker:t.symbol,network:'monero'}),t.name,t.label+' · open or private',compactTokenBalance(t.total)+' '+t.symbol),go:()=>void run(()=>p.openSend(t.mint,openSendHub))});
 if(sendChoices().some(x=>x.id==='native')&&positiveRaw(cache.nativeRow?.amountRaw)){const n=nativeTokenMetadata();items.push({html:c=>hubRow(c,`<span class="coin"><span class="coin-fallback">${esc(n.symbol.slice(0,2))}</span></span>`,n.name,'On Monero',cache.nativeRow?compactTokenBalance(cache.nativeRow.amountRaw)+' '+n.symbol:n.symbol),go:()=>chooseSend('native')});}
 cache.rows.forEach((r,i)=>{if(!positiveRaw(r.amountRaw))return;if(r.network==='solana'&&!isJointHolding(r))items.push({html:c=>hubRow(c,tokenCoin(r),r.name||r.ticker,'On Solana',compactTokenBalance(r.amountRaw)+' '+r.ticker),go:()=>chooseSend('token-'+i)});
  else if(r.network==='monero')items.push({html:c=>hubRow(c,tokenCoin(r),r.name||r.ticker,isJointHolding(r)?'Previously bridged tokens':'Inscription on Monero',compactTokenBalance(r.amountRaw)+' '+r.ticker),go:()=>sendAsset('token',r)});});
 const syncing=st.syncing?`<div class="asset hub-row hub-wait" role="status"><span class="coin xmr">M</span><span class="asset-info"><strong>Monero tokens</strong><small>Syncing · ${st.pct??0}%</small></span></div>`:'';
 show('Send',`<span class="pf-screen" hidden></span><div class="hub-list">${items.map((x,i)=>x.html('hub-row-'+i)).join('')}${syncing}</div><p id="progress" class="busy" role="status"></p><p id="error" class="error" role="alert"></p>`);
 items.forEach((x,i)=>on('hub-row-'+i,x.go));
}
function bindShell(){on('expand',()=>{const url=globalThis.chrome?.runtime?chrome.runtime.getURL('popup.html'):location.href;if(globalThis.chrome?.tabs)chrome.tabs.create({url});else window.open(url,'_blank','noopener');});on('lock',lock);on('accounts',accounts);for(const id of ['home','activity','explore','settings'])on('nav-'+id,()=>{screen=id;render();});}
function render(){
 if(!vault){app.innerHTML=`<div class="shell">${header()}<section class="welcome"><div class="brand">xm</div><span class="eyebrow">MONERO · SOLANA · INSCRIPTIONS</span><h1>${box?'Welcome back.':'A home for your<br>inscriptions.'}</h1><p>${box?'Unlock your wallet to see your balances.<br>Your keys stay on this device.':'Your SOL, XMR and XMR20.<br>One simple wallet. Yours to control.'}</p>${box?'<label for="unlock-password">Wallet password</label><input id="unlock-password" type="password" autocomplete="current-password"><button class="primary wide" id="unlock">Unlock wallet</button><p id="unlock-error" class="error" role="alert"></p>':'<button class="primary wide" id="start-create">Create a wallet</button><button class="secondary wide" id="start-import">Import a wallet</button><button class="text-btn" id="start-watch">Watch a public address</button>'}<button class="text-btn" id="restore-backup">Restore encrypted backup</button><p class="subtle">Preview release · Mainnet<br>Local encryption. No account signup.</p></section></div>`;bindShell();on('start-create',()=>setup('create'));on('start-import',()=>setup('import'));on('start-watch',()=>setup('watch'));on('restore-backup',restoreBackup);on('unlock',async()=>{const button=$('#unlock');button.disabled=true;try{const pw=$('#unlock-password').value,unlockEpoch=epoch,signal=lastLockSignal;const unlocked=await decryptVault(box,pw);if(unlockEpoch!==epoch)return;vault=unlocked;password=pw;activeId=vault.accounts[0]?.id;await establishSession(unlockEpoch,signal);epoch++;applyDefaultRestoreHeights();render();void refresh();void autoCatchUp();}catch(e){vault=null;password='';sessionId=null;if($('#unlock-error'))$('#unlock-error').textContent=e.message;button.disabled=false;}});$('#unlock-password')?.addEventListener('keydown',e=>{if(e.key==='Enter')$('#unlock').click();});return;}
 const a=account(),displayRows=[...cache.rows,...(cache.nativeRow?[cache.nativeRow]:[]),...(pf()?.portfolioRows()||[])],currentPortfolio=walletPortfolioEstimate({...cache,rows:displayRows},a),coverage=currentPortfolio.coverage,portfolio=portfolioDisplay(currentPortfolio,cache.portfolioDisplay,coverage,cache.complete&&!cache.nativeRow);let body='';
 if(a&&currentPortfolio.value!==null&&(cache.complete||!cache.portfolioDisplay||coverage>=cache.portfolioDisplay.coverage)){savePortfolio(a,currentPortfolio,coverage,cache.sol);cache.portfolioDisplay=cachedPortfolio(a);}
 if(screen==='home'){
 body=`<section class="hero"><div class="network"><span class="dot"></span><span>MAINNET</span></div><span class="portfolio-label">Total balance</span><h1 class="portfolio-total">${usd(portfolio.value)}</h1><p>${portfolio.lastKnown?(cache.loading||cache.priceLoading?'Last known estimate · Updating…':'Last known estimate · Some balances are delayed'):portfolio.value===null?'Prices unavailable':portfolio.partial?'Partial estimate · Some balances or prices unavailable':'Estimated USD value'}</p><span class="portfolio-scope">SOL + synced XMR + XMR20 · Pending inscriptions excluded</span><span class="price-status" role="status">${priceStatus()}</span></section><section class="actions"><button class="action" id="send">${icon('send')}Send</button><button class="action" id="bridge">${icon('swap')}Bridge</button><button class="action" id="receive">${icon('receive')}Receive</button></section><section class="content"><div class="tabs"><button class="tab active" id="tokens">Tokens</button><button class="tab" id="collectibles">Collectibles</button><button class="icon-btn" id="refresh" aria-label="Refresh balances">${icon('refresh')}</button></div>${asset('sol','Solana',a?.sol?short(a.sol):'Add a Solana account',cache.sol==null?'— SOL':compactTokenBalance(cache.sol,9)+' SOL',cache.sol==null?(a?.sol?'Balance unavailable':'Not connected'):cache.solStale?'Last known balance':'Native balance',null,null,null,nativeUsd(cache.sol,9,cache.nativePrices?.sol))}${asset('xmr','Monero',a?.xmr?short(a.xmr):'Add a Monero account',cache.xmr==null?'— XMR':compactTokenBalance(cache.xmr.balanceRaw,12)+' XMR',xmrNote(),null,null,null,nativeUsd(cache.xmr?.balanceRaw,12,cache.nativePrices?.xmr))}${legacyRecoveryHTML(vault.receipts,a,{esc,amount})}<div id="token-sections">${cache.jointLoading?'<p class="subtle joint-busy" data-loading="true" role="status">Checking new bridge balance…</p>':''}${tokenSections()}</div>${pendingHTML()}<div class="status">${icon('info')}<span>${esc(cache.loading?'Refreshing balances…':cache.note||'Balances are read from the XMR20 index and network nodes.')}</span></div></section>`;
 }else if(screen==='activity'){body=`<section class="content"><h1 class="page-title">Activity</h1><p class="subtle">Transfers made from this extension.</p><button class="secondary wide" id="check-receipts">Check transfer status</button><button class="secondary wide" id="activity-bridges">Finish Monero setup</button>${(vault.receipts||[]).filter(r=>r.accountId===a?.id).slice().reverse().map(receiptHTML).join('')||'<div class="empty">No transfers yet.</div>'}</section>`;}
 else if(screen==='explore'){body=`<section class="content"><h1 class="page-title">Inscriptions</h1><p class="subtle">Search your indexed holdings by name, ticker or mint.</p><input class="search" id="search" placeholder="Search inscriptions" aria-label="Search inscriptions"><div id="search-results"></div><a class="secondary wide explorer-link" href="https://xmr20.org/" target="_blank" rel="noopener noreferrer">Explore the XMR20 index ↗</a></section>`;}
 else{body=`<section class="content"><h1 class="page-title">Your wallet</h1><p class="subtle">XMR20 Wallet · ${esc(globalThis.chrome?.runtime?.getManifest?.()?.version?"Version "+chrome.runtime.getManifest().version:"Local preview")}</p><button class="secondary wide" id="backup">Download encrypted backup</button><button class="secondary wide" id="recovery">Show recovery keys</button>${canLinkSolana(a)?'<button class="secondary wide" id="link-solana">Link Solana account</button>':''}<button class="secondary wide" id="new-account">Add account</button><button class="secondary wide" id="native-settings">Sync Monero balance</button><label class="setting-field" for="auto-lock">Auto-lock after inactivity<select id="auto-lock">${AUTO_LOCK_OPTIONS.map(minutes=>`<option value="${minutes}" ${preferences.autoLockMinutes===minutes?'selected':''}>${timeoutLabel(minutes)}</option>`).join('')}</select></label><label class="setting-field" for="monero-node">Monero node<select id="monero-node">${MONERO_NODES.map(n=>`<option value="${esc(n.url)}" ${preferences.moneroNode===n.url?'selected':''}>${esc(n.label)} · ${esc(moneroNodeHost(n.url))}</option>`).join('')}</select></label><p class="subtle">Monero scans and XMR sends start with this node and switch to the other listed node automatically if it stops responding. Scan progress is saved on this device in encrypted form so later syncs continue where they stopped.</p><button class="secondary wide" id="clear-scan-cache">Clear saved Monero scan progress</button><div class="notice">Locks after ${timeoutLabel(preferences.autoLockMinutes)} without activity even when the popup is closed. Restarting Chrome or clicking Lock ends the session. Open the full wallet for long Monero scans.</div><p class="subtle">USD estimates use CoinGecko for SOL/XMR and Raydium LaunchLab or graduated-market prices for XMR20. Token mints are sent to Raydium and coin names to CoinGecko; wallet addresses and keys are not sent to price providers. Prices are checked every 15 seconds while this wallet is visible. Refresh requests fresh prices, with a five-second limit on repeated requests. The total includes SOL, last-synced XMR and confirmed XMR20. Pending inscriptions are excluded.</p><p class="subtle">XMR20 inscriptions are public records. Native XMR balances are scanned locally. XMR20 sends verify available balances with the transfer service before review.</p><a href="https://xmr20.org/docs/" target="_blank" rel="noopener noreferrer">Read the protocol docs ↗</a></section>`;}
 app.innerHTML=`<div class="shell">${header()}${body}${footer()}</div>`;bindShell();if(screen==='home'&&pf())placeMoneroTokens();legacyBridgeRecoveries(vault.receipts,a).forEach((receipt,index)=>on('resume-legacy-'+index,()=>void bridgeUI.open({legacyReceiptId:receipt.intent})));app.querySelectorAll('.token-image').forEach(img=>img.addEventListener('error',()=>img.remove(),{once:true}));on('bridge',()=>pf()?openBridgeHub():openBridgeMenu());on('collectibles',()=>toast('Coming soon'));on('refresh',()=>void refresh({forcePrices:true,forceHoldings:true}));$('#refresh')?.addEventListener('click',()=>void autoCatchUp());on('send',()=>pf()?openSendHub():sendMenu());on('receive',receive);on('asset-sol',()=>sendAsset('sol'));on('asset-xmr',()=>nativePanel());cache.rows.forEach((r,i)=>on('asset-token-'+i,()=>detail(r)));on('check-receipts',()=>void checkReceipts());on('activity-bridges',()=>nativeTokenSends?void run(()=>openNativeTokens('convert',{savedOnly:true})):void bridgeUI.open());on('backup',()=>void run(backup));on('recovery',recovery);on('new-account',accounts);on('link-solana',()=>linkSolana());on('native-settings',nativePanel);if($('#auto-lock'))$('#auto-lock').onchange=async event=>{const next=normalizePreferences({...preferences,autoLockMinutes:Number(event.target.value)});try{await store.set('xmr20-preferences',next);preferences=next;toast('Auto-lock set to '+timeoutLabel(next.autoLockMinutes));}catch{toast('Could not save timeout. Try again.');render();}};if($('#monero-node'))$('#monero-node').onchange=async event=>{const next=normalizePreferences({...preferences,moneroNode:event.target.value});try{await store.set('xmr20-preferences',next);preferences=next;native?.close();if(cache.xmr)cache.xmr={...cache.xmr,node:next.moneroNode};const scanKey=nativeScanKey(account()),savedScan=await scanCache.load(scanKey);if(savedScan)await scanCache.save(scanKey,savedScan.cache,{...savedScan,node:next.moneroNode});toast('Monero node set to '+moneroNodeLabel(next.moneroNode));}catch{toast('Could not save node choice. Try again.');render();}};on('clear-scan-cache',()=>void run(async()=>{native?.close();await scanCache.clear();toast('Saved Monero scan progress cleared. The next sync starts from the restore height.');}));if(screen==='explore'){const search=()=>{const query=$('#search').value.toLowerCase(),matches=cache.rows.filter(r=>(r.name+' '+r.ticker+' '+r.mint).toLowerCase().includes(query));$('#search-results').innerHTML=matches.map(inscriptionCard).join('')+pendingHTML(query)||'<div class="empty">No matching holdings.</div>';};$('#search').oninput=search;search();}
 mountNativeRecovery();
}
function mountNativeRecovery(){
 if(!nativeSpendRecovery||screen!=='settings'||!account()?.xmrSeed)return;
 const before=$('#native-settings');if(!before)return;
 const button=document.createElement('button');button.id='native-recovery-entry';button.type='button';button.className='secondary wide';button.textContent='Monero payments & recovery';
 button.onclick=()=>void run(nativeRecoveryPanel);before.after(button);
}
function tokenSections(){
 const native=nativeTokenSection();
 const groups=tokenGroups(cache.rows);
 if(native){
  // Native output balances have a separate identity from old linked claims.
  // Do not merge them into the legacy index or its send/bridge routing.
  return native+(groups.length?legacyTokenSections():'');
 }
 return legacyTokenSections();
}
function legacyTokenSections(){
 const groups=tokenGroups(cache.rows);
 if(!groups.length&&legacyBridgeRecoveries(vault?.receipts,account()).length)return '';
 if(!groups.length&&(cache.jointPending?.length))return '';
 if(!groups.length)return `<div class="section-label"><span>XMR20 & Solana tokens</span></div><div class="empty"><strong>${cache.loading?'Checking your inscriptions…':cache.complete?'No inscriptions yet':'Your inscriptions live here'}</strong>${cache.loading?'Reading the XMR20 index.':cache.complete?'Receive an XMR20 token to get started.':'Refresh to check the index for your addresses.'}</div>`;
 return groups.map(group=>`<section class="token-section" aria-label="${group.title}" data-network="${group.network}"><div class="section-label"><span>${group.title}</span><span>${group.items.length} ${group.items.length===1?'asset':'assets'}</span></div>${group.items.map(({row:r,index:i})=>asset('token-'+i,r.name||r.ticker,isJointHolding(r)?(r.settlement==='solana'?'Solana-settled · linked wallet':'On Monero · new bridge'):r.network==='monero'?'Inscribed on Monero':'On Solana',amount(r.amountRaw)+' '+r.ticker,r.stale?'Last known balance':isJointHolding(r)?'Confirmed bridge balance':r.balanceSource==='solana-finalized'?'Confirmed Solana balance':'Indexed balance',r.ticker,currentQuote(cache.prices,r.mint),r)).join('')}</section>`).join('');
}
function nativeTokenSection(){
 if(!nativeTokenSends||!nativeTokenMetadata()||!account()?.xmr)return '';
 const row=cache.nativeRow;
 if(!row||BigInt(row.amountRaw)<=0n)return '';
 return `<section class="token-section" aria-label="Monero tokens"><div class="section-label"><span>MONERO</span></div>${
  asset('native-token',row.name,'On Monero',amount(row.amountRaw)+' '+row.ticker,'Last synced '+new Date(row.checkedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),row.ticker,currentQuote(cache.prices,row.mint),row)}</section>`;
}
function sendChoices(){
 const token=nativeTokenMetadata(),choices=[];
 if(nativeTokenSends&&token&&account()?.xmr)choices.push({id:'native',label:token.symbol+' · Monero'});
 if(account()?.sol)choices.push({id:'sol',label:'SOL · Solana'});
 if(account()?.xmr)choices.push({id:'xmr',label:'XMR · Monero'});
 cache.rows.forEach((row,index)=>{if(row.network==='solana'&&!isJointHolding(row)&&BigInt(row.amountRaw||'0')>0n)choices.push({id:'token-'+index,label:row.ticker+' · Solana'});});
 return choices;
}
function chooseSend(id){
 if(id==='native'){
  const legacy=cache.rows.find(row=>isJointHolding(row)&&row.mint===nativeTokenMetadata()?.mint&&BigInt(row.amountRaw)>0n);
  return void run(()=>openNativeTokens(legacy&&!BigInt(cache.nativeRow?.amountRaw||'0')?'convert':'send',{setup:!!legacy&&!BigInt(cache.nativeRow?.amountRaw||'0')}));
 }
 nativePopup?.close();nativePopup=null;
 if(id.startsWith('token-'))return sendAsset('token',cache.rows[Number(id.slice(6))]);
 return sendAsset(id);
}
async function openNativeTokens(view='send',options={}){
 nativePopup?.close();nativePopup=null;bridgeUI.clear();
 const generation=epoch,a=account(),token=nativeTokenMetadata();
 if(view==='convert'&&canLinkSolana(a)){linkSolana(()=>void run(()=>openNativeTokens(view,options)));return;}
 if(a.watch||!a.xmrSeed){show('Open your Monero wallet','<p>Import this wallet’s recovery phrase to send or bridge tokens. A public address can only show balances.</p><button class="primary wide" id="native-setup-import">Import wallet</button>');on('native-setup-import',()=>setup('import'));return;}
 const pageOptions={...options,...(options.setup?{onComplete:()=>void run(()=>openNativeTokens('send'))}:{})};
 const plain=options.setup||options.savedOnly,bridging=!plain&&view!=='send';
 const navigation=plain||bridging?undefined:{label:'Asset',items:sendChoices(),selected:'native',choose:chooseSend};
 // Bridge direction is the panels' swap button. Earlier bridge balances keep their own route when present.
 const legacy=bridging&&cache.rows.some(row=>isJointHolding(row)&&row.mint===token?.mint&&BigInt(row.amountRaw)>0n);
 const coinSwaps=bridging&&typeof __XMR20_NATIVE_COIN_SWAPS__!=='undefined'&&__XMR20_NATIVE_COIN_SWAPS__;
 nativePopup=createNativePopupFlow({modal,accountId:a.id,onCoins:coinSwaps?()=>openNativeSwap():undefined,bridgeSwitch:bridging?id=>void run(()=>openNativeTokens(id)):undefined,bridgeLinks:legacy?[{label:'Previously bridged tokens',open:openLegacyBridge}]:[],onSavedSetup:options.savedOnly||view==='send'?undefined:()=>void run(()=>openNativeTokens('convert',{savedOnly:true})),assertWallet:()=>{same(generation);if(account()?.id!==a.id)throw Error('Wallet changed.');},pageOptions,navigation,
  syncBalance:async notify=>{
   const progress=p=>{if(generation!==epoch||account()?.id!==a.id)return;if(Number.isSafeInteger(p.height)&&Number.isSafeInteger(p.target))notify('Syncing XMR balance · block '+p.height+' of '+p.target);};
   nativeProgressListeners.add(progress);try{return await nativeSync(generation);}finally{nativeProgressListeners.delete(progress);}
  },
  token:token??undefined,image:token&&tokenImage(token.mint),onBack:()=>{
   nativePopup?.close();nativePopup=null;modal.close();modal.innerHTML='';screen='home';render();void refresh();
  }});
 void nativePopup.open(view);
}
function openLegacyBridge(){nativePopup?.close();nativePopup=null;void bridgeUI.open({mint:nativeTokenMetadata()?.mint,direction:'xmr-to-sol'});}
// Open the actual bridge form. Direction is an inline choice, never another menu.
// 26 Oct 2026: the new native bridge is build-pinned to one token. Open it only when this wallet holds that token and
// no other bridgeable token; otherwise open the main bridge, which starts on a token the wallet holds (e.g. XMR20).
function openBridgeMenu(){
 const native=nativeTokenSends?nativeTokenMetadata():null;if(!native)return void bridgeUI.open();
 const positive=v=>{try{return BigInt(v||'0')>0n;}catch{return false;}},a=account();
 const rows=cache.displayScope===a?.sol+':'+a?.xmr?cache.rows:[];
 const holdsNative=positive(cache.nativeRow?.amountRaw)||rows.some(r=>r.mint===native.mint&&r.network==='solana'&&positive(r.amountRaw));
 if(!holdsNative||rows.some(r=>r.mint!==native.mint&&isBridgeHolding(r)))return void bridgeUI.open();
 return void run(()=>openNativeTokens(positive(cache.nativeRow?.amountRaw)?'redeem':'convert'));
}
function openNativeSwap(){
 if(typeof __XMR20_NATIVE_COIN_SWAPS__==='undefined'||!__XMR20_NATIVE_COIN_SWAPS__)return;
 nativePopup?.close();bridgeUI.clear();
 const a=account(),generation=epoch,current=()=>{same(generation);if(account()?.id!==a.id)throw Error('Wallet changed.');};
 const href=chrome.runtime.getURL('market-entry.css');
 if(!document.querySelector('link[data-native-popup-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.dataset.nativePopupStyle='';document.head.append(link);}
 const shell=document.createElement('div'),shadow=shell.attachShadow({mode:'open'}),style=document.createElement('link'),container=document.createElement('div');
 style.rel='stylesheet';style.href=href;container.className='native-popup-root native-send-window';shadow.append(style,container);
 modal.classList.add('native-popup-dialog');modal.replaceChildren(shell);if(!modal.open)modal.showModal();
 const page=createNativeSwapPage({container,account:{solana:a.sol,monero:a.xmr},assertCurrent:current,
  onClose:()=>{nativePopup?.close();nativePopup=null;modal.close();modal.innerHTML='';screen='home';render();void refresh();},
  onTokens:()=>{nativePopup?.close();nativePopup=null;openBridgeMenu();},
  loadOrders:()=>(vault.nativeSwaps||[]).filter(r=>r.accountId===a.id),
  saveOrder:async order=>{current();const rows=vault.nativeSwaps||[];vault.nativeSwaps=[...rows.filter(r=>r.requestId!==order.requestId||r.accountId!==a.id),{...order,accountId:a.id}];await persist();current();},
  maximum:async direction=>{
   current();if(direction==='sol-xmr'){if(!a.sol)throw Error('Add a Solana account to pay with SOL.');const raw=await solanaMaximum(a.sol,PublicKey.default.toBase58());current();return raw;}
   const balance=await nativeSync(generation);current();
   const available=BigInt(balance.unlockedRaw),reserve=100000000n;return String(available>reserve?available-reserve:0n);
  },
  onPay:order=>{current();nativePopup?.close();nativePopup=null;sendAsset(order.direction==='sol-xmr'?'sol':'xmr',null,{to:order.payin,amount:order.amount});}
 });
 nativePopup={close(){page.close();modal.classList.remove('native-popup-dialog');}};page.open();
}
function nativeConversionAction(row){
 if(!nativeTokenSends||row.mint!==nativeTokenMetadata()?.mint)return;
 const button=document.createElement('button');button.className='pf-act';button.type='button';
 button.innerHTML=icon('swap')+'<span>Move to Monero</span>';button.onclick=()=>void run(()=>openNativeTokens('convert'));
 $('#send-token')?.after(button);const tiles=button.parentElement;if(tiles?.classList.contains('pf-actions'))tiles.className='pf-actions '+(['one','two','three'][tiles.children.length-1]||'');
}
app.addEventListener('click',event=>{
 if(!nativeTokenSends)return;
 if(event.target.closest('#asset-native-token')){
  const row=cache.nativeRow;if(!row)return;
  show(row.name,tokenSheet({row:{...row,network:'monero'},actions:[['native-detail-send','send','Send'],['native-detail-redeem','swap','Bridge to Solana']],card:null,details:`<label>Token mint</label><div class="address pf-addr small">${esc(row.mint)}</div>`}));
  on('native-detail-send',()=>void run(()=>openNativeTokens()));on('native-detail-redeem',()=>void run(()=>openNativeTokens('redeem')));
 }
});
if(nativeTokenSends&&globalThis.chrome?.storage)chrome.storage.onChanged.addListener((changes,area)=>{
 const address=account()?.xmr,key=nativeHoldingsKey(address);if(area!=='local'||!key||!changes[key])return;
 cache.nativeRow=nativeHoldingRow(changes[key].newValue,address);paintBalances();void refreshPrices();
});
function tokenCoin(row,big=false){const img=tokenImage(row?.mint);return `<span class="coin-wrap${big?' big':''}"><span class="coin"><span class="coin-fallback">${esc(row?.ticker?.slice(0,2)||'x')}</span>${img?`<img class="token-image" src="${img}" alt="" width="52" height="52" decoding="async">`:''}</span>${row?.network==='solana'?`<i class="chain-badge sol" title="On Solana" aria-hidden="true">${icon('sol')}</i>`:row?.network==='monero'?'<i class="chain-badge xmr" title="On Monero" aria-hidden="true">M</i>':''}</span>`;}
function asset(id,name,subtitle,value,note,ticker,quote,row,nativeValue=null){const display=row?compactTokenBalance(row.amountRaw)+' '+ticker:value;const estimate=row?tokenUsd(row,quote):null;const market=row?`<small class="asset-usd">${estimate===null?'Price unavailable':usd(estimate)+(quote.stale||row.stale?' · Last known':'')}</small>`:(['sol','xmr'].includes(id)?`<small class="asset-usd">${nativeValue===null?'Value unavailable':usd(nativeValue)}</small>`:'');return `<button class="asset" id="asset-${id}">${row?.network?tokenCoin(row):`<span class="coin ${id}">${id==='sol'?icon('sol'):id==='xmr'?'M':`<span class="coin-fallback">${esc(ticker?.slice(0,2)||'x')}</span>${tokenImage(row?.mint)?`<img class="token-image" src="${tokenImage(row.mint)}" alt="" width="44" height="44" decoding="async">`:''}`}</span>`}<span class="asset-info"><strong>${esc(name)}</strong><small>${esc(subtitle)}</small></span><span class="asset-value" title="${esc(value)}">${esc(display)}${market}<small>${esc(note)}</small></span></button>`;}
// Several balance lanes finish within the same second. One repaint per frame
// keeps the popup responsive while slow sources trickle in.
let paintQueued=false;
function paintBalances(){
 if(paintQueued)return;paintQueued=true;
 const run=()=>{paintQueued=false;paintNow();};
 if(typeof requestAnimationFrame==='function'&&!document.hidden)requestAnimationFrame(run);else setTimeout(run,0);
}
function paintNow(){
 if(!vault||!['home','explore'].includes(screen)||modal.open||busy||document.activeElement?.tagName==='INPUT')return;
 const searchValue=$('#search')?.value||'',scrollY=window.scrollY;render();
 if($('#search')){$('#search').value=searchValue;$('#search').dispatchEvent(new Event('input'));}window.scrollTo(0,scrollY);
}
function priceStatus(){
 if(cache.priceLoading)return 'Updating prices…';
 const quotes=[...Object.values(cache.nativePrices||{}),...cache.rows.map(r=>currentQuote(cache.prices,r.mint))];
 const times=quotes.filter(q=>q&&!q.stale&&Number.isSafeInteger(q.checkedAt)).map(q=>q.checkedAt);
 return times.length?'Prices checked '+new Date(Math.max(...times)).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})+' · Every 15s':'Waiting for current prices';
}
let priceTask=null;
async function refreshPrices({force=false}={}){
 if(!account())return;if(priceTask)return priceTask;
 const e=epoch,id=++priceRefreshId;cache.priceLoading=true;paintBalances();
 const current=()=>e===epoch&&id===priceRefreshId;
 priceTask=Promise.allSettled([
  nativePriceClient.load({force}).then(prices=>{if(current()){cache.nativePrices=prices;paintBalances();}}),
  priceClient.load([...new Set([...cache.rows,...(cache.nativeRow?[cache.nativeRow]:[]),...(pf()?.portfolioRows()||[])].map(r=>r.mint))],{force}).then(prices=>{if(current()){cache.prices={...cache.prices,...prices};paintBalances();}})
 ]).finally(()=>{priceTask=null;});
 await priceTask;
 if(current()){cache.priceLoading=false;paintBalances();}
}
async function refresh({forcePrices=false,forceHoldings=false}={}){if(typeof pf==='function')void pf()?.refresh();
 if(!account())return;
 const a=account(),e=epoch,scope=a.sol+':'+a.xmr;
 const current=()=>e===epoch&&account()?.sol===a.sol&&account()?.xmr===a.xmr;
 if(nativeTokenSends){
  const nativeKey=nativeHoldingsKey(a.xmr);
  if(nativeKey){const value=await store.get(nativeKey);if(!current())return;cache.nativeRow=nativeHoldingRow(value,a.xmr);}
 }
 if(cache.displayScope!==scope){
  cache.displayScope=scope;cache.portfolioDisplay=cachedPortfolio(a);
  for(const network of ['solana','monero']){const address=network==='solana'?a.sol:a.xmr;if(!address)continue;const saved=cachedWalletHoldings(address,{network});if(saved)cache.rows=replaceHoldingSource(cache.rows,saved.rows.map(r=>({...r,network})),{network});}
  const savedSol=cachedSolBalance(a.sol)?.raw||cache.portfolioDisplay?.solRaw;
  if(cache.sol===null&&/^\d{1,20}$/.test(savedSol||'')){cache.sol=savedSol;cache.solStale=true;}
  if(jointHoldings&&!cache.rows.some(isJointHolding))cache.rows=[...cache.rows,...jointHoldings.cached({sol:a.sol,xmr:a.xmr},cache.rows)];
  cache.jointPending=jointHoldings?.cachedPending({sol:a.sol,xmr:a.xmr},cache.rows)??[];
  void bridgeUI.refreshAssets?.();
  paintBalances();
 }
 void refreshPrices({force:forcePrices});
 const networks=['monero','solana'].filter(n=>n==='monero'?a.xmr:a.sol),jobs=[];
 function paint(){if(current()){cache.complete=networks.every(n=>cache.indexComplete?.[n]===true)&&(!jointHoldings||cache.jointComplete===true);paintBalances();}}
 function read(source,load){return balanceReads.run(scope+':'+source,async signal=>{
  if(!current())return;cache.loading=true;paint();
  try{await load(signal);if(current()&&cache.sourceWarnings)delete cache.sourceWarnings[source];}
  catch{if(current()){cache.sourceWarnings={...cache.sourceWarnings,[source]:source==='SOL'?'SOL unavailable':source+' delayed'};}}
  finally{if(current()){const warnings=Object.values(cache.sourceWarnings||{});cache.note=warnings.length?warnings.join(' · ')+'. Saved balances remain available.':'Updated '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});paint();}}
 });}
 if(jointHoldings)jobs.push(read('New bridge balances',async()=>{
  cache.jointLoading=true;paint();
  try{const result=await jointHoldings.load({sol:a.sol,xmr:a.xmr},cache.rows,{force:forceHoldings,onResult:r=>{if(current()){cache.rows=replaceHoldingSource(cache.rows,r.rows,{bridge:r.mint});cache.jointPending=[...(cache.jointPending??[]).filter(v=>v.mint!==r.mint),...(r.pending??[])];void bridgeUI.refreshAssets?.();paint();void refreshPrices();}}});
   if(current()){cache.jointComplete=result.complete;if(!result.complete)throw Error('Bridge balance delayed');}
  }finally{if(current())cache.jointLoading=false;}
 }));
 if(a.sol)jobs.push(read('SOL',async()=>{
  try{const raw=await readSolBalance(a.sol);if(current()){cache.sol=raw;cache.solStale=false;saveSolBalance(a.sol,raw);}}
  catch(error){if(current())cache.solStale=true;throw error;}
 }));
 if(a.xmr)jobs.push(read('Incoming transfers',async signal=>{
  try{const result=await loadPending(a.xmr,{signal});if(current()){cache.pending=result.available?result.rows:[];cache.pendingStatus=result.available?(result.complete?'ready':'delayed'):'unsupported';}}
  catch(error){if(current()){cache.pending=(cache.pending||[]).map(r=>({...r,stale:true}));cache.pendingStatus='delayed';}throw error;}
 }));
 for(const network of networks){const address=network==='monero'?a.xmr:a.sol;jobs.push(read(network==='solana'?'Solana tokens':network+' index',async signal=>{
  try{const result=network==='solana'?await loadSolanaHoldings(address,{signal}):await loadWalletHoldings(address,{network,signal});if(current()){const rows=network==='solana'?solanaDisplayRows(cache.rows,result):result.rows;cacheWalletHoldings(address,{...result,rows},{network});cache.rows=replaceHoldingSource(cache.rows,rows.map(r=>({...r,network})),{network});cache.indexComplete={...cache.indexComplete,[network]:result.complete};if(!result.complete)throw Error('Index delayed');}}
  catch(error){if(current()){cache.rows=cache.rows.map(r=>r.network===network&&!isJointHolding(r)?{...r,stale:true}:r);cache.indexComplete={...cache.indexComplete,[network]:false};}throw error;}
  finally{if(current()){void bridgeUI.refreshAssets?.();void refreshPrices();}}
 }));}
 await Promise.allSettled(jobs);if(!current())return;
 cache.loading=balanceReads.size>0;paint();
}
function inscriptionCard(r){const quote=currentQuote(cache.prices,r.mint),value=tokenUsd(r,quote);return `<article class="inscription-card"><div class="inscription-heading"><strong>${esc(r.name)}</strong><span class="pill">${esc(r.ticker)}</span></div><div class="inscription-balance">${esc(amount(r.amountRaw))} <span>${esc(r.network==='monero'?'Monero':'Solana')}</span></div><div class="inscription-usd">${value===null?'Price unavailable':usd(value)+' estimated'+(quote.stale||r.stale?' · Last known':'')}</div><a class="proof-link" href="${isJointHolding(r)?esc(r.receipt.url):'https://xmr20.org/#inscription/'+encodeURIComponent(r.id)}" target="_blank" rel="noopener noreferrer">View inscription <span aria-hidden="true">↗</span></a><div class="mint-field"><span>Solana mint</span><code>${esc(r.mint)}</code></div></article>`;}
function jointPendingHTML(query=''){
 const rows=(cache.jointPending??[]).filter(r=>(r.name+' '+r.ticker+' '+r.mint).toLowerCase().includes(query));
 if(!rows.length)return '';
 return `<section class="pending-section" aria-label="Incoming bridge transfers"><h3>Incoming · not spendable</h3>${rows.map(r=>`<article class="pending-card"><strong>+${esc(amount(r.amountRaw))} ${esc(r.ticker)}</strong><p role="status">${esc(jointIncomingStatus(r))}</p><p class="subtle">${esc(jointIncomingHelp(r))}</p><a class="proof-link" href="https://xmrchain.net/tx/${esc(r.txid)}" target="_blank" rel="noopener noreferrer">View Monero transaction ↗</a></article>`).join('')}</section>`;
}
function pendingHTML(query=''){return jointPendingHTML(query)+legacyPendingHTML(query);}
function legacyPendingHTML(query=''){
 const groups=pendingGroups(cache.pending||[],cache.rows).filter(r=>(r.name+' '+r.ticker+' '+r.mint).toLowerCase().includes(query));
 if(groups.length)return `<section class="pending-section" aria-label="Pending incoming inscriptions"><div class="section-label"><span>Pending balance</span><span>Incoming · not spendable</span></div>${groups.map(r=>`<article class="pending-card"><div class="inscription-heading"><strong>${esc(r.name)}</strong><span class="tag">Pending</span></div><div class="pending-amount">+${esc(amount(r.amountRaw))} ${esc(r.ticker)}</div>${r.transfers.map(t=>`<div class="pending-transfer"><span>${t.stale?'Last seen · status delayed':t.confirmations>=10?'Validating inscription':t.confirmations+'/10 confirmations'}</span><a class="proof-link" href="https://xmrchain.net/tx/${esc(t.txid)}" target="_blank" rel="noopener noreferrer">Transaction ↗</a></div>`).join('')}</article>`).join('')}</section>`;
 if(query||!account()?.xmr)return '';
 const status=cache.pendingStatus||'loading';if(status==='ready')return '';
 return `<p class="pending-status subtle">${status==='unsupported'?'Pending balances need the indexer update.':status==='delayed'?'Pending status is temporarily unavailable.':status==='none'?'':'Checking incoming inscriptions…'}</p>`;
}
function canLinkSolana(a=account()){return !!a?.xmrSeed&&!a.solSecret;}
function importAccount(){
 if(!canLinkSolana()){setup('import');return;}
 show('Import a wallet',`<p class="subtle">You are using ${esc(account().name)}. Add your Solana key to this Monero account, or import a separate account.</p><button class="primary wide" id="import-link-sol">Link Solana to this account</button><button class="secondary wide" id="import-separate">Import a separate account</button>`);
 on('import-link-sol',()=>linkSolana());on('import-separate',()=>setup('import'));
}
function linkSolana(after){
 const target=account(),generation=epoch;if(!canLinkSolana(target))return;
 const candidates=vault.accounts.filter(a=>a.id!==target.id&&a.solSecret&&(!target.sol||a.sol===target.sol));
 show('Add a Solana wallet',`<p>Add a Solana wallet for this bridge step. This saves it on this device; no funds move and Monero sends do not need it.</p><label for="link-source">Solana wallet</label><select id="link-source">${candidates.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${esc(short(a.sol))}</option>`).join('')}<option value="paste">Import a Solana key</option></select><label id="link-paste-label">Solana private key<textarea id="link-secret" autocomplete="off" spellcheck="false" placeholder="Enter only inside this wallet"></textarea></label><div class="address" id="link-existing"></div><button class="primary wide" id="save-link">Add wallet</button>`);
 const source=()=>{const selected=candidates.find(a=>a.id===$('#link-source').value);$('#link-paste-label').hidden=!!selected;$('#link-secret').value='';$('#link-existing').textContent=selected?.sol||'Your public Solana address will appear here.';};
 $('#link-source').onchange=source;source();
 $('#link-secret').oninput=()=>{try{const key=importSol($('#link-secret').value);$('#link-existing').textContent=key.publicKey.toBase58();key.secretKey.fill(0);}catch{$('#link-existing').textContent='Enter a complete Solana key.';}};
 on('save-link',()=>run(async e=>{
  same(generation);const selected=candidates.find(a=>a.id===$('#link-source').value),secret=selected?.solSecret||$('#link-secret').value;
  const next=linkSolanaKey(vault,target.id,secret),encrypted=await encryptVault(next,password);same(e);
  await writeBox(encrypted,{generation:e});same(e);vault=next;epoch++;refreshId++;endWorkers();
  cache={...cache,sol:null,rows:cache.rows.filter(r=>r.network==='monero'&&!isJointHolding(r)),jointComplete:false,loading:false,complete:false};
  rememberSession();modal.close();modal.innerHTML='';render();void refresh();toast('Solana wallet added');if(after)setTimeout(after,0);
 }));
}

function accounts(){if(!vault)return;show('Accounts',vault.accounts.map(a=>`<button class="account-item" data-account="${esc(a.id)}">${esc(a.name)} ${a.id===account()?.id?'✓':''}<small>${a.watch?'Watch only':'Local keys'} · ${esc(short(a.sol||a.xmr))}</small></button>`).join('')+(canLinkSolana()?'<button class="primary wide" id="account-link-sol">Link Solana to this account</button>':'')+'<button class="primary wide" id="add-create">Create wallet</button><button class="secondary wide" id="add-import">Import wallet</button><button class="text-btn" id="add-watch">Watch address</button>');modal.querySelectorAll('[data-account]').forEach(b=>b.onclick=()=>{epoch++;endWorkers();activeId=b.dataset.account;cache={sol:null,xmr:sessionSnapshots[account()?.xmr]||null,rows:[],complete:false,loading:false,note:''};rememberSession();modal.close();render();void refresh();void autoCatchUp();});on('add-create',()=>setup('create'));on('account-link-sol',()=>linkSolana());on('add-import',importAccount);on('add-watch',()=>setup('watch'));}
async function creationHeight(e,form){
 const accountId=account()?.id,controller=new AbortController(),close=$('#close'),priorClose=close.onclick,priorDisabled=close.disabled;
 const current=()=>e===epoch&&account()?.id===accountId&&modal.open&&form.isConnected;
 const assertCurrent=()=>{if(!current())throw Error('Wallet setup closed.');};
 const cancel=event=>{event?.preventDefault();controller.abort(Error('Wallet setup closed.'));modal.close();modal.innerHTML='';paintBalances();};
 setupRead=controller;close.disabled=false;close.onclick=cancel;modal.addEventListener('cancel',cancel);
 $('#progress').textContent='Checking the Monero network…';
 try{return await resolveWalletRestoreHeight({mode:'create',signal:controller.signal,assertCurrent});}
 catch(error){if(!current())return null;throw error;}
 finally{modal.removeEventListener('cancel',cancel);if(setupRead===controller)setupRead=null;if(close.isConnected){close.onclick=priorClose;close.disabled=priorDisabled;}}
}
function setup(mode){
 show(mode==='create'?'Create your wallet':mode==='import'?'Import your wallet':'Watch an address',`<p class="subtle">${mode==='create'?'Creates a Solana key and a separate 25-word Monero wallet.':mode==='import'?'Import either network, or both. Recovery keys are encrypted on this device.':'Read public SOL and XMR20 balances. Watch-only accounts cannot send or scan private XMR balances.'}</p><label>Account name<input id="name" maxlength="40" value="Account ${(vault?.accounts.length||0)+1}"></label>${mode==='import'?'<label>Solana private key (optional)<textarea id="sol-secret" autocomplete="off" spellcheck="false" placeholder="Base58 private key or JSON keypair"></textarea></label><label>Monero recovery phrase (optional)<textarea id="xmr-seed" autocomplete="off" spellcheck="false" placeholder="25 words"></textarea></label><label>Monero restore height<input id="height" type="number" min="0" step="1" value="'+XMR20_MONERO_START+'"></label><p class="subtle">'+XMR20_MONERO_START.toLocaleString()+' is the XMR20 start (28 September 2026). Use an earlier block, or 0 for all history, only if this wallet received XMR before then.</p>':mode==='watch'?'<label>Solana public address<input id="sol-address" autocomplete="off" spellcheck="false"></label><label>Monero primary public address<input id="xmr-address" autocomplete="off" spellcheck="false"></label>':''}${!vault?'<label>New password<input id="password" type="password" minlength="8" autocomplete="new-password" placeholder="At least 8 characters"></label><label>Confirm password<input id="password-confirm" type="password" autocomplete="new-password"></label>':''}<p id="progress" class="busy"></p><button class="primary wide" id="continue">${mode==='watch'?'Add watch-only account':'Continue'}</button>`);
 on('continue',()=>run(async e=>{
 const setupSignal=lastLockSignal;const name=$('#name').value.trim()||'Account';const pw=vault?password:$('#password').value;if(pw.length<8)throw Error('Use a password with at least 8 characters.');if(!vault&&pw!==$('#password-confirm').value)throw Error('Passwords do not match.');
 const form=$('#continue'),setupAccount=account()?.id;const setupCurrent=()=>e===epoch&&account()?.id===setupAccount&&modal.open&&form.isConnected;
 const birthday=mode==='create'?await creationHeight(e,form):0;if(birthday===null||!setupCurrent())return;
 let a={id:crypto.randomUUID(),name,watch:mode==='watch',sol:'',xmr:'',solSecret:'',xmrSeed:'',height:0,...(mode==='import'?{heightChosen:true}:{})};
 if(mode==='watch'){a.sol=$('#sol-address').value.trim();a.xmr=$('#xmr-address').value.trim();if(!a.sol&&!a.xmr)throw Error('Enter at least one public address.');if(a.sol&&!solAddress(a.sol))throw Error('Invalid Solana address.');if(a.xmr){const c=checkMoneroAddress(a.xmr,'mainnet');if(!c.valid||(kind!=='xmr'&&c.kind!=='standard'))throw Error(kind==='xmr'?'Enter a valid Monero mainnet address.':'Enter a primary Monero mainnet address.');}}
 else{const solInput=mode==='import'?$('#sol-secret').value.trim():'',xmrInput=mode==='import'?$('#xmr-seed').value.trim().toLowerCase().replace(/\s+/g,' '):'';if(mode==='import'&&!solInput&&!xmrInput)throw Error('Enter at least one recovery key.');if(mode==='create'||solInput){const key=mode==='create'?Keypair.generate():importSol(solInput);a.sol=key.publicKey.toBase58();a.solSecret=bs58.encode(key.secretKey);key.secretKey.fill(0);}if(mode==='create'||xmrInput){if(xmrInput&&xmrInput.split(' ').length!==25)throw Error('Monero recovery phrases contain 25 words.');$('#progress').textContent='Preparing Monero keys locally…';a.height=mode==='create'?birthday:await resolveWalletRestoreHeight({mode:'import',restoreHeight:$('#height').value.trim()===''?XMR20_MONERO_START:Number($('#height').value)});if(!setupCurrent())return;const keys=await oneShot('keys.worker.js',mode==='create'?'create':'restore',{seed:xmrInput});a.xmr=keys.address;a.xmrSeed=keys.seed;}}
 if(!setupCurrent())return;
 async function finish(){if(e!==epoch)throw Error('Wallet changed.');const prev=vault;password=pw;vault={accounts:[...(vault?.accounts||[]),a],receipts:vault?.receipts||[]};try{await persist();}catch(err){if(e===epoch)vault=prev;throw err;}activeId=a.id;await establishSession(e,setupSignal);epoch++;cache={sol:null,xmr:null,rows:[],complete:false,loading:false,note:''};modal.close();modal.innerHTML='';render();void refresh();}
 if(mode==='watch'){await finish();return;}
 show('Save your recovery keys',`<p class="subtle">These are two separate wallets. Keep both keys offline. Your password only unlocks this extension.</p>${a.xmrSeed?`<label>Monero · 25-word phrase</label><div class="secrets">${esc(a.xmrSeed)}</div><p class="subtle">Restore height: ${a.height}</p>`:''}${a.solSecret?`<label>Solana · private key</label><div class="secrets">${esc(a.solSecret)}</div>`:''}<label class="seed-check"><input id="backed-up" type="checkbox"> I saved these recovery keys somewhere safe.</label><button class="primary wide" id="finish">Open my wallet</button>`);on('finish',()=>run(async()=>{if(!$('#backed-up').checked)throw Error('Save your keys and confirm before continuing.');await finish();}));
 }));
}
function receive(){const a=account();show('Receive',`<p class="subtle">Use the address for the correct network.</p>${a.sol?`<label>Solana · SOL & Solana tokens</label><div class="address">${esc(a.sol)}</div><button class="text-btn" id="copy-sol">Copy Solana address</button>`:''}${a.xmr?`<label>Monero · XMR & XMR20 inscriptions</label><div class="address">${esc(a.xmr)}</div><button class="text-btn" id="copy-xmr">Copy Monero address</button><p class="subtle">XMR20 must be sent using an XMR20 transfer. A native XMR payment does not transfer inscriptions.</p>`:''}${a.watch?'<div class="notice">Watch-only address. Make sure you control its recovery keys before receiving funds.</div>':''}`);on('copy-sol',()=>copy(a.sol));on('copy-xmr',()=>copy(a.xmr));}
async function copy(value){try{await navigator.clipboard.writeText(value);toast('Address copied');}catch{toast('Select the address and copy it manually.');}}
// 28 Oct 2026 (owner: "the UI should be consistent for xmr20 tokens"): every token screen has the same layout and the same two
// actions. On Solana: Send + Bridge to Monero (the open/private bridge, which carries every launched token). Inscribed on Monero:
// Send + Bridge to Solana (inscriptions move through the earlier bridge; from Solana they come back as open/private tokens).
const tokenSheet=({row,actions,card,details})=>{const quote=currentQuote(cache.prices,row.mint),value=tokenUsd(row,quote);return `<span class="pf-screen" hidden></span><div class="token-sheet"><div class="pf-hero">${tokenCoin(row,true)}<div class="pf-total" title="${esc(amount(row.amountRaw))} ${esc(row.ticker)}">${esc(compactTokenBalance(row.amountRaw))}<span> ${esc(row.ticker)}</span></div>${value===null?'':`<p class="pf-usd">${usd(value)}${quote?.stale||row.stale?' · last known':''}</p>`}</div>
<div class="pf-actions ${actions.length===1?'one':actions.length===3?'three':'two'}">${actions.map(([id,ic,label])=>`<button class="pf-act" id="${id}">${icon(ic)}<span>${label}</span></button>`).join('')}</div><p id="progress" class="busy" role="status"></p><p id="error" class="error" role="alert"></p>
${card?`<div class="pf-card"><div class="pf-card-head"><span>${card.title}</span></div><small>${card.text}</small>${card.link||''}</div>`:''}
<div class="pf-card"><div class="pf-card-head"><span>Market price</span>${quote?`<span>${esc(quote.source)}</span>`:''}</div>${quote?`<div class="pf-inline"><span>Per token</span><strong>${usd(quote.priceUsd,{unit:true})}</strong></div><small>Checked ${new Date(quote.checkedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}. Reference value before fees and price impact.</small>`:'<small>No current Raydium price is available for this mint.</small>'}</div>
<details class="pf-more"><summary>Details</summary>${details}</details></div>`;};
function detail(row){if(isJointHolding(row))return jointDetail(row);const onSolana=row.network==='solana',privateFormat=Boolean(pf());
 const carried=privateFormat&&pf().state?.backend?.assets?.some(x=>x.mint===row.mint);
 const card=!privateFormat?null:onSolana?{title:'Bridge to Monero',text:`Arrives as open ${esc(row.ticker)} on Monero in about 20 minutes. There you can send it, make it private, or bridge it back to Solana.${carried?'':' The first bridge of a token adds it to the bridge (about a minute).'}`}:{title:'Inscribed on Monero',text:`Bridge it to Solana; from there it can come back to Monero as open or private ${esc(row.ticker)}.`};
 show(row.name||row.ticker,tokenSheet({row,actions:[['send-token','send','Send'],...(privateFormat?[['token-bridge','swap',onSolana?'Bridge to Monero':'Bridge to Solana']]:[])],card,
  details:`<label>Solana mint</label><div class="address pf-addr small">${esc(row.mint)}</div><label>Monero deployment</label><div class="address pf-addr small">${esc(row.deployment)}</div><a class="pf-link" href="https://xmrchain.net/tx/${esc(row.deployment)}" target="_blank" rel="noopener noreferrer">View proof ↗</a>`}));
 on('send-token',()=>sendAsset('token',row));
 if(privateFormat)on('token-bridge',()=>onSolana?void run(()=>pf().openBridge(row.mint,'deposit',()=>detail(cache.rows.find(r=>r.mint===row.mint&&r.network==='solana')||row),{symbol:row.ticker,name:row.name,solanaBalance:row.amountRaw})):void bridgeUI.open({mint:row.mint,amountRaw:row.amountRaw,direction:'xmr-to-sol'}));
 if(onSolana)nativeConversionAction(row);}
function jointDetail(row){
 const a=account();if(row.solanaOwner!==a.sol||row.moneroOwner!==a.xmr)return;
 show(row.name||row.ticker,tokenSheet({row:{...row,network:'monero'},actions:[...(privateBridgeTest?[]:[['joint-holding-send','send','Send']]),['joint-holding-return','swap','Bridge to Solana']],
  card:{title:'Previously bridged tokens',text:`These ${esc(row.ticker)} came through the earlier bridge. Bridge them to Solana; from there they can come back to Monero as open or private tokens.`,link:`<a class="pf-link" href="${esc(row.receipt.url)}" target="_blank" rel="noopener noreferrer">${esc(row.receipt.label||'View Monero record')} ↗</a>`},
  details:`<label>Monero wallet</label><div class="address pf-addr small">${esc(a.xmr)}</div><label>Token mint</label><div class="address pf-addr small">${esc(row.mint)}</div>`}));
 on('joint-holding-return',()=>void bridgeUI.open({mint:row.mint,amountRaw:row.amountRaw,direction:'xmr-to-sol'}));
 if(nativeTokenSends&&row.mint===nativeTokenMetadata()?.mint)on('joint-holding-send',()=>void run(()=>openNativeTokens('convert',{setup:true})));
 else on('joint-holding-send',()=>void bridgeUI.open({mint:row.mint,direction:'xmr-to-xmr'}));
}

function sendMenu(){
 const choices=sendChoices();
 const hasNative=BigInt(cache.nativeRow?.amountRaw||'0')>0n||cache.rows.some(row=>isJointHolding(row)&&row.mint===nativeTokenMetadata()?.mint&&BigInt(row.amountRaw)>0n);
 chooseSend(hasNative?'native':choices.find(item=>item.id==='sol'||item.id==='xmr')?.id||'native');
}
function sendTokenNetworks(){
 show('XMR20 tokens',`<p class="subtle">Choose the chain your tokens are on.</p><button class="secondary wide" id="choose-tokens-monero">XMR20 tokens on XMR</button><button class="secondary wide" id="choose-tokens-solana">XMR20 tokens on Solana</button><button class="text-btn wide" id="send-back">Back</button>`);
 on('choose-tokens-monero',()=>nativeTokenSends?run(()=>openNativeTokens()):sendTokenHoldings('monero'));on('choose-tokens-solana',()=>sendTokenHoldings('solana'));on('send-back',sendMenu);
}
function sendTokenHoldings(network){
 const a=account(),chain=network==='monero'?'XMR':'Solana',connected=network==='monero'?a.xmr:a.sol;
 const rows=cache.rows.filter(row=>row.network===network&&/^\d+$/.test(row.amountRaw)&&BigInt(row.amountRaw)>0n);
 const empty=!connected?`Connect a ${network==='monero'?'Monero':'Solana'} account to see your tokens.`:cache.loading?'Checking your holdings. Go back and try again shortly.':cache.indexComplete?.[network]?`No XMR20 tokens held on ${chain}.`:'Holdings are unavailable. Close this window and refresh your wallet.';
 show('XMR20 tokens on '+chain,`<p class="subtle">Choose a token to send.</p>${rows.length?rows.map((row,i)=>`<button class="secondary wide send-token-choice" id="choose-token-${i}"><span><strong>${esc(row.ticker)}</strong><small>${esc(row.name||row.ticker)}</small></span><span class="send-token-balance">${esc(amount(row.amountRaw))}<small>${row.stale?'Last known balance':'Balance'}</small></span></button>`).join(''):`<div class="empty">${esc(empty)}</div>`}<button class="text-btn wide" id="send-back">Back</button>`);
 rows.forEach((row,i)=>on('choose-token-'+i,()=>sendAsset('token',row)));on('send-back',sendTokenNetworks);
}
function receiptHTML(r){const url=r.chain==='solana'&&/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(r.hash||'')?'https://solscan.io/tx/'+r.hash:r.chain==='monero'&&/^[a-f0-9]{64}$/.test(r.hash||'')?'https://xmrchain.net/tx/'+r.hash:null;return `<div class="receipt"><strong>${esc(r.amount)} ${esc(r.symbol)}</strong> → ${esc(short(r.to))}<br><small>${esc(r.status)} · ${new Date(r.created).toLocaleString()}</small>${url?`<br><a href="${url}" target="_blank" rel="noopener noreferrer">View transaction ↗</a>`:''}${r.intent?`<br><small>Transfer ID: ${esc(r.intent)}</small>`:''}</div>`;}
async function record(data){const r={id:crypto.randomUUID(),accountId:account().id,created:Date.now(),...data};vault.receipts=[...(vault.receipts||[]),r];await persist();return r;}
// Opens the private worker once per account. A saved scan checkpoint for the
// same account, address and restore height is handed to the worker so the scan
// continues from it; the worker reports a rejected checkpoint and it is dropped.
async function nativeOpen(e){
 const a=account();if(!a.xmrSeed)throw Error('Import this Monero wallet’s recovery phrase to scan or send XMR.');
 return nativeOpenLane.run(e+':'+a.id,async()=>{
 same(e);if(account()?.id!==a.id)throw Error('Wallet changed.');
 if(native&&nativeId===a.id&&native.alive)return native;
 native?.close();
 const key=nativeScanKey(a),saved=await scanCache.load(key);same(e);
 if($('#progress'))$('#progress').textContent=saved?'Opening saved Monero progress'+(Number.isSafeInteger(saved.height)?' at block '+saved.height.toLocaleString():'')+'…':'Opening your Monero wallet…';
 const client=workerClient('native.worker.js',{onProgress:p=>{renderScanProgress(p);xmrRowProgress(p);},onCheckpoint:cp=>{if(key&&cp?.address===a.xmr&&cp.cache instanceof Uint8Array)client.checkpointSaved=scanCache.save(key,cp.cache,{height:cp.height,address:cp.address,node:cp.node});}});
 native=client;nativeId=a.id;
 try{
  const opened=await client.call('open',{seed:a.xmrSeed,address:a.xmr,restoreHeight:a.height,node:nodeFor(),cache:saved?.cache||null},120000,{transfer:saved?[saved.cache.buffer]:[]});
  same(e);if(opened.cacheRejected&&key)void scanCache.clear(key);
  client.opened=opened;return client;
 }catch(err){client.close();throw err;}
 });
}
function nativePanel(){const a=account();const last=cache.xmr?.updatedAt?new Date(cache.xmr.updatedAt).toLocaleString([],{hour:'2-digit',minute:'2-digit',month:'short',day:'numeric'}):null;show('Monero balance',`<p class="subtle">Native XMR is private. This wallet scans Monero locally using your recovery keys. The first scan of an older wallet takes a while; progress is saved on this device so later syncs continue where they stopped.</p>${a.xmrSeed?`<div class="review-line"><span>Restore height</span><strong>${a.height.toLocaleString()} <button class="text-btn" id="restore-height">Change</button></strong></div>${a.height===XMR20_MONERO_START?'<p class="subtle">Starts at the XMR20 start, 28 September 2026. Use Change if this wallet received XMR before then.</p>':''}<div class="review-line"><span>Node</span><strong>${esc(moneroNodeLabel(preferences.moneroNode))} · automatic failover</strong></div>${cache.xmr?`<div class="review-line"><span>Last synced balance</span><strong>${esc(amount(cache.xmr.balanceRaw,12))} XMR</strong></div><div class="review-line"><span>Unlocked</span><strong>${esc(amount(cache.xmr.unlockedRaw,12))} XMR</strong></div>${receivingXmr()?`<div class="review-line"><span>Receiving</span><strong>${esc(receivingXmr().amount)}</strong></div><p class="subtle">${esc(receivingXmr().status)}</p>`:''}${last?`<div class="review-line"><span>Last synced</span><strong>${esc(last)}</strong></div>`:''}`:'<p class="subtle">No synced balance yet in this session.</p>'}<div class="sync-track" role="progressbar" aria-label="Monero scan progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="sync-bar"></div></div><p id="progress" class="busy"></p><button class="primary wide" id="sync">Sync balance</button><button class="secondary wide" id="stop-sync" data-keep hidden>Pause scan</button><button class="secondary wide" id="send-native">Send XMR</button>`:'<div class="notice">A public Monero address shows XMR20 inscriptions only. Import the Monero recovery phrase to see native XMR and send.</div>'}`);
 on('sync',()=>run(async e=>{
  const stop=$('#stop-sync');try{
   void pf()?.refresh();const client=await nativeOpen(e);
   if(stop){stop.hidden=false;stop.disabled=false;}
   const result=await nativeSync(e,client);
   if($('#sync-bar'))$('#sync-bar').style.width='100%';
   cache.nativePrices=await nativePriceClient.load();same(e);
   const incoming=receivingXmr(result);$('#progress').textContent=amount(result.balanceRaw,12)+' XMR · '+amount(result.unlockedRaw,12)+' XMR unlocked · synced to block '+result.height.toLocaleString()+(incoming?' · receiving '+incoming.amount+'. '+incoming.status:'');
   render();
  }finally{if(stop){stop.hidden=true;}}
 }));
 on('stop-sync',()=>{const stop=$('#stop-sync');if(stop)stop.disabled=true;if($('#progress'))$('#progress').textContent='Pausing after the current block batch… Progress is saved.';native?.notify('stop');});
 on('send-native',()=>sendAsset('xmr'));
 const changeHeight=$('#restore-height');if(changeHeight){changeHeight.style.padding='0';changeHeight.style.marginLeft='10px';}
 on('restore-height',()=>{if(!busy)restoreHeightPanel();});}
// 26 Oct 2026: an imported wallet scans from block 0 unless a height was typed at import, and a birthday is
// never inferred. The owner may choose a later block for an existing account here. Saved scan progress is keyed
// by restore height, so a new height starts a fresh scan record and the old record is removed.
function restoreHeightPanel(){
 const a=account();if(!a?.xmrSeed)return;
 show('Restore height',`<p class="subtle">This wallet scans Monero from the block below. XMR received before it will not appear in your balance until you choose an earlier block.</p><label>Restore height<input id="restore-height-value" inputmode="numeric" autocomplete="off" spellcheck="false" value="${a.height}"></label><button class="secondary wide" id="restore-height-xmr20">Use XMR20 start · block ${XMR20_MONERO_START.toLocaleString()}</button><p class="subtle">XMR20 tokens did not exist on Monero before block ${XMR20_MONERO_START.toLocaleString()} (28 September 2026). Choose an earlier block if this wallet received XMR before then.</p><p id="progress" class="busy"></p><button class="primary wide" id="restore-height-save">Save and start a new scan</button><button class="text-btn wide" id="restore-height-back">Back</button>`);
 on('restore-height-xmr20',()=>{const input=$('#restore-height-value');if(input)input.value=String(XMR20_MONERO_START);});
 on('restore-height-back',()=>{if(!busy)nativePanel();});
 on('restore-height-save',()=>run(async e=>{
  const text=$('#restore-height-value').value.trim().replaceAll(',','');
  if(!/^\d{1,8}$/.test(text))throw Error('Enter a block number, for example '+XMR20_MONERO_START+'.');
  const height=Number(text);if(height===a.height){nativePanel();return;}
  if(height>0){
   let tip;try{tip=await creationHeight(e,$('#restore-height-save'));}catch{throw Error('Could not check the current Monero height. Try again.');}
   if(tip===null)return;if(height>tip)throw Error('That block has not been mined yet. Choose a block below '+tip.toLocaleString()+'.');
  }
  same(e);if(account()?.id!==a.id)throw Error('Wallet changed.');
  const previous=a.height,oldKey=nativeScanKey(a);
  if(nativeId===a.id){native?.close();native=null;nativeId='';}
  const previousChosen=a.heightChosen;a.height=height;a.heightChosen=true;
  try{await persist();}catch(error){a.height=previous;a.heightChosen=previousChosen;throw error;}
  same(e);if(oldKey)void scanCache.clear(oldKey);
  cache.xmr=null;delete sessionSnapshots[a.xmr];void session('forget',{address:a.xmr});
  toast('Restore height saved');nativePanel();
 }));
}
// Ordinary XMR sends freeze XMR20 token carriers first. When a coin's
// transaction data is not available locally, the user may allow a node lookup
// that reveals this wallet's transaction ids to the node; never silently.
async function nativeRecoveryPanel(e=epoch){
 const a=account();show('Monero payments & recovery','<p class="subtle">Opening this wallet’s saved receipts…</p>');
 const client=await nativeOpen(e),status=await client.call('paymentRecoveryStatus');same(e);
 if(!modal.open)return;
 show('Monero payments & recovery',`<p class="subtle">Saved payments keep their exact transaction. Checking or reopening this screen does not send anything.</p>${status.recoveryOnly?'<p class="notice">This restored journal permits recovery of saved operations. New spending stays locked until reconciliation.</p>':''}<div id="native-saved-payments">${status.payments.map((row,i)=>`<button class="secondary wide" id="native-payment-${i}">${esc(compactTokenBalance(row.amountRaw,12))} XMR → ${esc(short(row.to))}</button>`).join('')||'<p class="subtle">No saved XMR payments.</p>'}</div><button class="secondary wide" id="native-export-recovery">Download encrypted transaction recovery</button><label for="native-import-recovery">Restore encrypted transaction recovery</label><input type="file" id="native-import-recovery" accept=".xmr20-recovery,application/octet-stream"><p class="subtle">Keep this file with your wallet backup. It preserves native token, market and payment approvals; a recovery phrase alone cannot restore unpublished approvals. Restore into the same Monero wallet.</p>`);
 status.payments.forEach((row,i)=>on('native-payment-'+i,()=>void run(async generation=>{
  let receipt=(vault.receipts||[]).find(r=>r.accountId===a.id&&r.chain==='monero'&&r.symbol==='XMR'&&r.hash===row.txid);
  if(!receipt)receipt=await record({chain:'monero',hash:row.txid,to:row.to,amount:amount(row.amountRaw,12).replaceAll(',',''),symbol:'XMR',status:'Submission uncertain · check receipt'});
  same(generation);nativePaymentScreen(receipt);
 })));
 on('native-export-recovery',()=>void run(async generation=>{
  const result=await client.call('exportPaymentRecovery');same(generation);
  const blob=new Blob([result.packageBytes],{type:'application/octet-stream'}),url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download='xmr20-transactions-'+a.id+'.xmr20-recovery';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);toast('Encrypted transaction recovery downloaded');
 }));
 $('#native-import-recovery').onchange=event=>void run(async generation=>{
  const file=event.target.files?.[0];if(!file)return;if(file.size>16*1024*1024+64)throw Error('Recovery file is too large.');
  const packageBytes=new Uint8Array(await file.arrayBuffer());same(generation);
  try{await client.call('importPaymentRecovery',{packageBytes},120000);same(generation);}finally{packageBytes.fill(0);}
  await nativeRecoveryPanel(generation);
 });
}
function nativePaymentScreen(receipt,back=()=>void run(nativeRecoveryPanel)){
 const a=account(),generation=epoch,current=()=>{same(generation);if(account()?.id!==a.id)throw Error('Wallet changed.');};
 let submitted=false;
 const draw=(text,action='check',feeRaw=null)=>{
  current();show('XMR payment',receiptHTML(receipt)+(feeRaw?`<div class="review-line"><span>Saved network fee</span><strong>${esc(amount(feeRaw,12))} XMR</strong></div>`:'')+`<p class="subtle">${esc(text)}</p><p class="busy" id="progress"></p><button class="primary wide" id="native-payment-action">${action==='retry'?'Submit saved payment':'Check payment'}</button><button class="text-btn wide" id="native-payment-back">${submitted?'Done':'Back'}</button>`);
  on('native-payment-back',()=>{current();if(submitted){modal.close();modal.innerHTML='';screen='activity';render();}else back();});
  on('native-payment-action',()=>void run(async e=>{
   current();const client=await nativeOpen(e);current();
   if(action==='retry'){
    const scanning=nativeSyncLane.pending(client);if(scanning){$('#progress').textContent='Saving scan progress before submitting the saved payment…';client.notify('stop');await scanning.catch(error=>{if(error.code!=='sync-paused')throw error;});current();}
    const review=await client.call('prepareRecovery',{txid:receipt.hash,node:nodeFor()});current();
    if(review.hash!==receipt.hash||review.to!==receipt.to||review.amountRaw!==String(units(receipt.amount,12)))throw Error('Saved payment details changed. Nothing was submitted.');
    receipt.status='Submitting · check receipt';await persist();current();
    try{await client.call('relay',{reviewId:review.id},120000);current();receipt.status='Submitted · awaiting confirmation';await persist();cache.xmr=null;delete sessionSnapshots[a.xmr];await session('forget',{address:a.xmr});current();submitted=true;draw('The same saved payment was submitted. Check its confirmations before sending again.');}
    catch(error){current();receipt.status='Submission uncertain · check receipt';await persist();draw('The submission response was not confirmed. Check this payment before retrying.');}
    return;
   }
   $('#progress').textContent='Checking the saved transaction with your Monero node…';
   const result=await client.call('checkPayment',{txid:receipt.hash,node:nodeFor()},120000);current();
   if(result.hash!==receipt.hash)throw Error('Payment status did not match this receipt.');
   if(result.state==='confirmed'||result.state==='pending'){
    receipt.status=result.state==='confirmed'?'Confirmed · '+result.confirmations+' confirmations':'Submitted · awaiting confirmation';await persist();cache.xmr=null;delete sessionSnapshots[a.xmr];await session('forget',{address:a.xmr});current();submitted=true;
    draw(result.state==='confirmed'?'Your payment is confirmed on Monero.':'Your payment is in the Monero transaction pool, awaiting confirmation. No second payment is needed.');return;
   }
   if(result.state!=='not-found')throw Error('Payment status is unavailable. Your saved payment is kept.');
   if(result.saved){
    const saved=result.payment;if(!saved||saved.to!==receipt.to||saved.amountRaw!==String(units(receipt.amount,12)))throw Error('Saved payment differs from this receipt. Nothing was submitted.');
    draw('Your node has not found this payment yet. You can submit its exact saved transaction; this cannot create a second payment.', 'retry',saved.feeRaw);return;
   }
   if(['xmr-not-submitted','xmr-recovery-required'].includes(receipt.submitState)){
    receipt.status='Not submitted';await persist();current();
    show('Payment not sent',receiptHTML(receipt)+'<p class="subtle">Submission never started and no signed payment was saved. You can return to Send and try again.</p><button class="primary wide" id="native-payment-back">Back to Send</button>');on('native-payment-back',()=>sendAsset('xmr',null,{to:receipt.to,amount:receipt.amount}));return;
   }
   draw('Your node has not found this payment and its signed recovery is missing on this device. Keep this receipt; restore its encrypted transaction recovery before retrying.');
  }));
 };
 draw('Check whether this payment reached Monero. This shares only its transaction ID with your selected node and does not send funds.');
}
function sendAsset(kind,row,draft={}){if(kind==='token'&&isJointHolding(row)){if(nativeTokenSends&&row.mint===nativeTokenMetadata()?.mint)return void run(()=>openNativeTokens('convert',{setup:true}));if(privateBridgeTest)return jointDetail(row);return void bridgeUI.open({mint:row.mint,direction:'xmr-to-xmr'});}const a=account(),symbol=kind==='sol'?'SOL':kind==='xmr'?'XMR':row.ticker,chain=kind==='sol'?'solana':kind==='xmr'?'monero':row.network;if(canLinkSolana(a)&&(chain==='solana'||kind==='token'&&chain==='monero')){linkSolana(()=>sendAsset(kind,row));return;}if(a.watch||(chain==='solana'&&!a.solSecret)||(chain==='monero'&&!a.xmrSeed)){show('Watch-only account','<p class="notice">Import the recovery key for this wallet to send. Public addresses can only view balances.</p>');return;}
 show('Send '+symbol,`<label for="send-asset-choice">Asset</label><select id="send-asset-choice">${sendChoices().map(item=>`<option value="${esc(item.id)}" ${item.id===(kind==='token'?'token-'+cache.rows.indexOf(row):kind)?'selected':''}>${esc(item.label)}</option>`).join('')}</select><p class="subtle">${chain==='monero'?'Monero':'Solana'} mainnet · ${kind==='token'?'XMR20 inscription transfer':'Native '+symbol}</p><label for="to">Recipient’s ${chain==='monero'?'Monero':'Solana'} address</label><input id="to" aria-describedby="to-hint" autocomplete="off" spellcheck="false" placeholder="Paste the recipient’s public address"><p id="to-hint" class="field-hint" aria-live="polite"></p>${maxControl('send-amount','Amount ('+esc(symbol)+')')}<input id="send-amount" class="amount-input" aria-describedby="amount-hint" inputmode="decimal" placeholder="0" autocomplete="off"><p id="amount-hint" class="field-hint" aria-live="polite"></p><button class="secondary wide" id="swap-fields" hidden>Swap address and amount</button><div id="send-fee" class="subtle" aria-live="polite">${kind==='xmr'?'Network fee: up to 0.0001 XMR, in addition to the amount.':chain==='monero'?'The service pays the Monero network fee. No native XMR or SOL is spent.':'Enter the amount and recipient to check fees.'}</div><p id="progress" class="busy"></p><button class="primary wide" id="review">Send</button>${kind==='token'&&chain==='monero'?`<p class="subtle">Indexed balance: ${esc(amount(row.amountRaw))} ${esc(symbol)}. Pending outgoing requests may reduce what is available.</p><button class="text-btn wide" id="pending-sends">Check pending sends & bridges</button>`:''}`);
 $('#send-asset-choice').onchange=event=>chooseSend(event.target.value);
 const decimals=kind==='sol'?9:kind==='xmr'?12:6;
 const validAddress=value=>{if(chain==='solana')return solAddress(value);const c=checkMoneroAddress(value,'mainnet');return c.valid&&(kind==='xmr'||c.kind==='standard');};
 function fields(){return sendFieldState($('#to').value,$('#send-amount').value,{decimals,validAddress});}
 function hints(){const state=fields();$('#swap-fields').hidden=!state.swapped;$('#to-hint').textContent=state.swapped?'This looks like the token amount.':state.to&&!state.addressValid?'Paste the complete recipient address here.':'';$('#amount-hint').textContent=state.amountIsAddress?'This looks like a wallet address. Enter the number of tokens here.':state.amount&&!state.amountValid?`Enter an amount greater than zero, with up to ${decimals} decimal places.`:'';$('#to').setAttribute('aria-invalid',String(!!state.to&&!state.addressValid));$('#send-amount').setAttribute('aria-invalid',String(!!state.amount&&!state.amountValid));return state;}
 $('#to').value=draft.to||'';$('#send-amount').value=draft.amount||'';hints();
 let maxPrepared=null;
 const formInput=$('#send-amount'),toInput=$('#to'),sendButton=$('#review'),generation=epoch;
 const formCurrent=()=>generation===epoch&&account()?.id===a.id&&modal.open&&formInput.isConnected;
 let carrierPrompt=null;
 const clearCarrierPrompt=()=>{carrierPrompt=null;$('#carrier-node-check')?.remove();sendButton.hidden=false;};
 const invalidatePreparation=()=>{maxPrepared=null;if(carrierPrompt){clearCarrierPrompt();$('#error').textContent='';}};
 formInput.addEventListener('input',invalidatePreparation);toInput.addEventListener('input',invalidatePreparation);
 function carrierCheckError(error,e,retryMax=false){
  if(error?.code!=='carrier-check-unavailable'||e!==epoch||!formCurrent())return error;
  maxPrepared=null;clearCarrierPrompt();
  const bound={node:nodeFor(),to:toInput.value,amount:formInput.value},prompt={};
  const current=()=>carrierPrompt===prompt&&formCurrent()&&nodeFor()===bound.node&&toInput.value===bound.to&&formInput.value===bound.amount;
  carrierPrompt=prompt;sendButton.hidden=true;
  $('#error').insertAdjacentHTML('afterend',`<button class="primary wide" id="carrier-node-check">${retryMax?'Check coins for Max':'Check coins'}</button>`);
  const stillCurrent=()=>{if(current())return true;if(formCurrent()&&carrierPrompt===prompt){clearCarrierPrompt();$('#error').textContent='Send details changed. Try again.';}return false;};
  on('carrier-node-check',()=>{if(!stillCurrent())return;void run(async next=>{
   if(!stillCurrent())return;
   $('#progress').textContent='Checking which coins are safe to spend…';
   const client=await nativeOpen(next);if(!stillCurrent())return;
   // Permission applies only to this explicit read-only check. The worker keeps
   // hash-verified extras locally; subsequent preparations never inherit consent.
   await client.call('checkCarriers',{node:bound.node,carrierLookup:'node'},120000);same(next);
   if(!stillCurrent())return;
   clearCarrierPrompt();$('#error').textContent='';$('#progress').textContent='';
   if(retryMax)await fillSendMaximum(next);
   else $('#progress').textContent='Coins checked. Click Send to continue.';
  });});
  return Error('Check your coins before sending to protect any XMR20 tokens. This shares their transaction IDs with your selected Monero node; nothing is sent.');
 }
 const quoteTerms=()=>{const state=fields();return state.addressValid&&state.amountValid?{to:state.to,amount:state.amount}:null;};
 if(chain==='solana'){
  sendPreview=createJointCreditPreview({isCurrent:formCurrent,prepare:input=>kind==='sol'?prepareSolSend(a,input.to,input.amount):prepareSolanaTokenSend({row,owner:a.sol,...input}),changed:state=>{
   const ready=sendPreview?.matches(quoteTerms()),retry=state.status==='error';sendButton.dataset.disabled=String(!ready&&!retry);sendButton.disabled=busy||!ready&&!retry;sendButton.textContent=retry?'Retry fee check':'Send';
   const p=state.value;$('#send-fee').innerHTML=ready?`<div class="review-line"><span>Network fee</span><strong>${esc(amount(p.feeRaw,9))} SOL</strong></div>${p.netRaw?`<div class="review-line"><span>Recipient receives</span><strong>${esc(amount(p.netRaw))} ${esc(symbol)}</strong></div><small>Token fee: ${esc(amount(String(p.fee)))} ${esc(symbol)} · Account cost: ${esc(amount(p.rentRaw,9))} SOL</small>`:''}`:esc(state.status==='loading'?'Checking fees…':state.error||'Enter the amount and recipient to check fees.');
  }});
  const requestQuote=()=>sendPreview?.request(quoteTerms());formInput.addEventListener('input',requestQuote);toInput.addEventListener('input',requestQuote);requestQuote();
 }
 async function fillSendMaximum(e){
  maxPrepared=null;
  const input=$('#send-amount'),recipient=$('#to'),to=recipient.value.trim();
  if((kind==='xmr'||kind==='sol'||chain==='monero')&&!validAddress(to))throw Error('Enter the recipient address first so Max can check the available amount and fee.');
  const current=()=>{same(e);return modal.open&&input.isConnected&&recipient.value.trim()===to&&account()?.id===a.id;};
  $('#progress').textContent='Checking maximum available amount…';
  await fillMaximum(input,async()=>{
   if(kind==='sol')return solanaMaximum(a.sol,to);
   if(kind==='token'&&chain==='solana')return solanaTokenMaximum(a.sol,row.mint);
   if(kind==='xmr'){
    const client=await nativeOpen(e);await nativeSync(e,client);
    $('#progress').textContent='Calculating the maximum after the network fee…';
    try{const node=nodeFor(),review=await client.call('prepareMax',{to,node,carrierLookup:'local'},120000);if(!current())return review.amountRaw;maxPrepared={...review,node,client};}catch(error){throw carrierCheckError(error,e,true);}return maxPrepared.amountRaw;
   }
   const token=await login(a);same(e);const q=await walletRequest(token,'moneroTransferQuote',{launchId:row.id,from:a.xmr,to,amountRaw:'1'});same(e);validateTransferQuote(q,a,row,to,'1');
   return maximumRaw(q.availableRaw,{limit:TOKEN_TRANSFER_LIMIT});
  },{decimals,isCurrent:current,onFill:()=>{hints();sendPreview?.request(quoteTerms());$('#amount-hint').textContent=kind==='xmr'||kind==='sol'?'Maximum after the network fee.':'Maximum available for this transfer. Token fees, if any, are deducted once when sent.';}});
  if(current())$('#progress').textContent='';
 }
 on('send-amount-max',()=>run(fillSendMaximum));
 on('pending-sends',()=>{const saved={to:$('#to').value,amount:$('#send-amount').value};void run(e=>showPendingDebits(row,()=>sendAsset(kind,row,saved),e));});
 $('#to').addEventListener('input',hints);$('#send-amount').addEventListener('input',hints);
 on('swap-fields',()=>{if(busy)return;const state=fields();if(!state.swapped)return;$('#to').value=state.amount;$('#send-amount').value=state.to;$('#error').textContent='';hints();sendPreview?.request(quoteTerms());$('#review').focus();});
 on('review',()=>run(async e=>{
 if(carrierPrompt)return;
 if(sendPreview?.state.status==='error'){sendPreview.retry();return;}
 const state=hints();if(state.swapped)throw Error('The address and amount are reversed. Click “Swap address and amount”, then review again.');
 if(!state.addressValid)throw Error(chain==='monero'?'Enter a primary Monero mainnet address in the recipient field.':'Enter a valid Solana address in the recipient field.');
 const to=state.to,value=state.amount,raw=String(units(value,decimals));
 if(chain==='solana'&&!solAddress(to))throw Error('Enter a valid Solana address.');if(chain==='monero'){const c=checkMoneroAddress(to,'mainnet');if(!c.valid||(kind!=='xmr'&&c.kind!=='standard'))throw Error(kind==='xmr'?'Enter a valid Monero mainnet address.':'Enter a primary Monero mainnet address.');}if(to===(chain==='solana'?a.sol:a.xmr))throw Error('Choose a different recipient.');
 if(kind==='xmr'&&nativeSpendRecovery){const prior=matchingOrdinaryReceipt(vault.receipts||[],{accountId:a.id,to,amountRaw:raw});if(prior){nativePaymentScreen(prior,()=>sendAsset(kind,row,{to,amount:value}));return;}}
 else if((vault.receipts||[]).some(r=>r.accountId===a.id&&r.symbol===symbol&&r.to===to&&r.amount===value&&['Submitting · check receipt','Submission uncertain · check receipt','Waiting for inscription','Submitted · awaiting confirmation'].includes(r.status)))throw Error('A matching transfer is already pending. Check Activity before sending again.');
 $('#progress').textContent=kind==='token'&&chain==='monero'?'Verifying available tokens… This can take up to two minutes.':'Checking balance and network fee…';let prepared,token;
 if(chain==='solana'){if(!sendPreview?.matches({to,amount:value}))throw Error('Wait for the amount and fee check.');prepared=sendPreview.state.value;if(Date.now()>=prepared.expires){sendPreview.retry();throw Error('Refreshing the expired fee. Check the updated amount before sending.');}}
 else if(kind==='xmr'){if(maxPrepared&&maxPrepared.client===native&&native?.alive&&maxPrepared.node===nodeFor()&&maxPrepared.to===to&&maxPrepared.amountRaw===raw&&Date.now()<maxPrepared.expires)prepared=maxPrepared;else{maxPrepared=null;const client=await nativeOpen(e);await nativeSync(e,client);$('#progress').textContent='Building the transaction for review…';try{prepared=await client.call('prepare',{to,amountRaw:raw,node:nodeFor(),carrierLookup:'local'},120000);}catch(error){throw carrierCheckError(error,e);}}}
 else{checkTransferAmount(raw);if(!a.solSecret)throw Error('Import a Solana key for XMR20 service authentication.');token=await login(a);same(e);try{const q=await walletRequest(token,'moneroTransferQuote',{launchId:row.id,from:a.xmr,to,amountRaw:raw});same(e);validateTransferQuote(q,a,row,to,raw);}catch(error){same(e);if(balanceRejection(error)){const verified=error.availableRaw?`The service reports ${amount(error.availableRaw)} ${symbol} available out of ${amount(error.balanceRaw)} indexed. `:'';throw Error(verified+'The service rejected this amount after checking pending sends and bridges. Check pending requests below; the indexed balance does not show these reservations. Nothing was sent by this review.');}throw error;}prepared={feeRaw:'0',expires:Date.now()+300000};}
 same(e);if(!formCurrent()||fields().to!==to||fields().amount!==value)throw Error('The send details changed. Nothing was sent.');
 if(kind==='xmr'&&BigInt(prepared.feeRaw)>100000000n)throw Error('The Monero fee exceeds 0.0001 XMR. Nothing was sent; try again later.');
 const e2=e;let receipt,authorizationStarted=false;$('#progress').textContent='Sending… Keep this wallet open.';
 try{if(chain==='solana'){const signed=signSolSend(prepared,a.solSecret);receipt=await record({chain,hash:signed.hash,to,amount:value,symbol,status:'Submitting · check receipt'});same(e2);await sendSolSigned(signed.bytes);receipt.status='Submitted · awaiting confirmation';}
 else if(kind==='xmr'){const client=native;if(!client?.alive||nativeId!==a.id)throw Error('The Monero wallet was closed before approval. Go back and review again; nothing was sent.');receipt=await record({chain,hash:prepared.hash,to,amount:value,symbol,status:'Submitting · check receipt'});same(e2);await client.call('relay',{reviewId:prepared.id},120000);receipt.status='Submitted · awaiting confirmation';cache.xmr=null;delete sessionSnapshots[a.xmr];await session('forget',{address:a.xmr});}
 else{const id=crypto.randomUUID();receipt=await record({chain,intent:id,to,amount:value,symbol,status:'Preparing inscription'});const transfer=await walletRequest(token,'moneroTransferIntent',{id,launchId:row.id,from:a.xmr,to,amountRaw:raw});same(e2);$('#progress').textContent='Signing the inscription locally…';const review=validateTransfer(transfer,a,row,to,raw);const signed=await oneShot('transfer.worker.js','signTransfer',{seed:a.xmrSeed,review});same(e2);receipt.status='Submitting · check receipt';await persist();same(e2);$('#progress').textContent='Submitting inscription… This can take up to two minutes. Keep this wallet open.';authorizationStarted=true;const result=await walletRequest(token,'authorizeMoneroTransfer',{id,signature:signed.signature});receipt.hash=result.txid||null;receipt.status='Waiting for inscription';}
 same(e2);await persist();show('Transfer submitted',receiptHTML(receipt)+'<p class="subtle">Submission is not confirmation. Check the transaction receipt before sending again.</p>');void refresh();
 }catch(error){if(receipt&&e2===epoch){receipt.status=kind==='token'&&chain==='monero'&&!authorizationStarted?'Unsigned request · check pending sends':'Submission uncertain · check receipt';if(kind==='xmr')receipt.submitState=['xmr-not-submitted','xmr-recovery-required','xmr-submission-unknown'].includes(error.code)?error.code:'unknown';await persist();if(kind==='xmr'&&nativeSpendRecovery){nativePaymentScreen(receipt,()=>sendAsset(kind,row,{to,amount:value}));return;}}throw error;}
 }));
}
async function showPendingDebits(row,back,e){
 const a=account();show('Pending sends & bridges','<p class="busy" id="progress">Checking saved requests for this account…</p>');
 const token=await login(a);same(e);const remote=await walletRequest(token,'account');same(e);const requests=pendingDebits(remote,a,row);
 show('Pending sends & bridges',`<p class="subtle">${esc(row.ticker)} · ${esc(short(a.xmr))}</p><p class="notice">These requests can reserve tokens even while the indexed total still shows them. Signed or submitted requests stay reserved until their outcome is confirmed.</p>${requests.length?requests.map((t,i)=>`<article class="receipt"><strong>${esc(amount(t.amountRaw))} ${esc(row.ticker)} · ${t.kind==='bridge'?'Bridge withdrawal':'Send'}</strong><p>${t.canCancel?'Unsigned request':esc(t.state==='pending'?'Signed request · awaiting confirmation':t.state)}</p>${t.to?`<small>To ${esc(short(t.to))}</small>`:''}<small>Request ${esc(t.id)}</small>${t.txid?`<a href="https://xmrchain.net/tx/${esc(t.txid)}" target="_blank" rel="noopener noreferrer">View transaction ↗</a>`:''}${t.canCancel?`<button class="secondary wide" id="cancel-request-${i}">Review cancellation</button>`:'<p class="subtle">Do not create another send for this request. Its outcome must be checked first.</p>'}</article>`).join(''):'<p class="notice">No pending outgoing requests were returned for this token and Solana sign-in account. This does not verify your available balance. If sending still fails, the service balance needs investigation.</p>'}<button class="secondary wide" id="refresh-pending">Refresh requests</button><button class="text-btn wide" id="pending-back">Back to send</button>`);
 on('pending-back',back);on('refresh-pending',()=>void run(next=>showPendingDebits(row,back,next)));
 requests.forEach((t,i)=>on('cancel-request-'+i,()=>{
  show('Cancel unsigned request?',`<p class="notice">Release the reservation for this unsigned request of ${esc(amount(t.amountRaw))} ${esc(row.ticker)}. This does not send tokens. The service will refuse cancellation if the request has already been signed or submitted.</p><div class="address">${esc(t.id)}</div><button class="primary wide" id="confirm-cancel-request">Cancel this unsigned request</button><button class="secondary wide" id="keep-request">Keep request</button>`);
  on('keep-request',()=>void run(next=>showPendingDebits(row,back,next)));
  on('confirm-cancel-request',()=>void run(async next=>{
   const response=await walletRequest(token,'cancelMoneroTransfer',{id:t.id});same(next);cancellationConfirmed(response,t);
   for(const receipt of vault.receipts||[])if(receipt.accountId===a.id&&receipt.intent===t.id)receipt.status='Cancelled';
   await persist();same(next);toast('Unsigned request cancelled. Review the send again.');await showPendingDebits(row,back,next);
  }));
 }));
}
async function backup(){if(!vault)return;const generation=epoch,current=await store.get('xmr20-vault');same(generation);if(!sameBox(current,box)){box=current;lock(false);throw Error('Wallet changed in another window. Unlock again.');}const blob=new Blob([JSON.stringify({format:'xmr20-extension-backup-v1',vault:box},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='xmr20-encrypted-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);toast('Encrypted backup downloaded');}
function recovery(){show('Unlock recovery keys','<p class="subtle">Re-enter your password to reveal this account’s keys.</p><label>Password<input id="recovery-password" type="password" autocomplete="current-password"></label><button class="primary wide" id="reveal">Reveal keys</button>');on('reveal',()=>run(async e=>{await decryptVault(box,$('#recovery-password').value);same(e);const a=account();show('Recovery keys',`${a.watch?'<p class="subtle">Watch-only accounts contain no recovery keys.</p>':''}${a.solSecret?'<label>Solana private key</label><div class="secrets">'+esc(a.solSecret)+'</div>':''}${a.xmrSeed?'<label>Monero recovery phrase</label><div class="secrets">'+esc(a.xmrSeed)+'</div><p class="subtle">Restore height: '+a.height+'</p>':''}`);}));}
function restoreBackup(){show('Restore encrypted backup','<p class="subtle">Restoring replaces the wallets saved in this extension. Save a backup of the current vault first.</p><label>Backup file<input type="file" accept="application/json,.json" id="backup-file"></label><label>Backup password<input type="password" id="backup-password" autocomplete="current-password"></label><label><input type="checkbox" id="replace"> Replace this extension’s saved vault</label><button class="primary wide" id="restore">Restore backup</button>');on('restore',()=>run(async generation=>{if(!$('#replace').checked)throw Error('Confirm replacement of this extension’s saved vault.');const f=$('#backup-file').files[0];if(!f||f.size>2000000)throw Error('Choose a valid backup file.');const signal=lastLockSignal,b=JSON.parse(await f.text()),pw=$('#backup-password').value;if(b.format!=='xmr20-extension-backup-v1')throw Error('Unsupported backup format.');const data=await decryptVault(b.vault,pw);await writeBox(b.vault,{replace:true,generation});if(generation!==epoch)throw Error('Wallet changed.');endWorkers();box=b.vault;vault=data;password=pw;activeId=data.accounts[0]?.id;await establishSession(generation,signal);epoch++;applyDefaultRestoreHeights();cache={sol:null,xmr:null,rows:[],complete:false,loading:false,note:''};modal.close();modal.innerHTML='';render();void refresh();}));}
[box,preferences,lastLockSignal]=await Promise.all([store.get('xmr20-vault'),store.get('xmr20-preferences').then(normalizePreferences),store.get('xmr20-lock-signal')]);try{globalThis.chrome?.action?.setBadgeText?.({text:''});}catch{}try{await resumeSession();}catch{vault=null;password='';sessionId=null;}render();if(vault){void refresh();void autoCatchUp();}
if(typeof __XMR20_JOINT_MAINNET_REVIEW__!=='undefined'&&__XMR20_JOINT_MAINNET_REVIEW__&&new URLSearchParams(location.search).has('request'))void openWebsiteBridge();
async function openWebsiteBridge(){
 const requestId=new URLSearchParams(location.search).get('request');
 async function request(action,data={}){const response=await chrome.runtime.sendMessage({channel:'xmr20-site-approval',requestId,action,...data});if(response?.error)throw Error(response.error);return response.value;}
 try{const v=await request('view');if(!vault)throw Error('Unlock and reconnect from the website before bridging.');
  show('Bridge from website',`<p class="notice">${esc(v.origin)} wants to open a token bridge. No transaction has been approved.</p><label>Connected account</label><div class="address">${esc(v.account.name)}<br>${esc(v.account.solana)}</div><button class="primary wide" id="website-bridge-open">Use this account and review bridge</button><button class="text-btn wide" id="website-bridge-cancel">Cancel</button>`);
  on('website-bridge-cancel',()=>void request('reject').finally(()=>window.close()));
  on('website-bridge-open',async()=>{const button=$('#website-bridge-open');button.disabled=true;try{await request('opened',{accountId:v.account.id});epoch++;endWorkers();activeId=v.account.id;if(cache.displayScope!==account()?.sol+':'+account()?.xmr)cache={sol:null,xmr:sessionSnapshots[account()?.xmr]||null,rows:[],complete:false,loading:false,note:''};rememberSession();render();void refresh();await bridgeUI.open({mint:v.bridge.mint,amountRaw:v.bridge.amountRaw,direction:v.bridge.direction,from:v.origin});}catch(e){if($('#error'))$('#error').textContent=e.message;button.disabled=false;}});
 }catch(e){show('Bridge connection',`<p>${esc(e.message)}</p><p class="subtle">Reconnect from the requesting website after unlocking. Private keys stay in this extension.</p>`);}
}

async function checkReceipts(){
 const a=account(),e=epoch;if(!a)return;toast('Checking transaction receipts…');
 try{let remote=null;const receipts=(vault.receipts||[]).filter(r=>r.accountId===a.id);
 for(const r of receipts){
 if(r.kind==='bridge')continue;
 if(r.chain==='solana'&&r.hash){const result=(await connection.getSignatureStatuses([r.hash],{searchTransactionHistory:true})).value[0];same(e);if(result?.err)r.status='Failed on chain';else if(result?.confirmationStatus==='finalized')r.status='Confirmed';else if(result)r.status='Submitted · awaiting confirmation';}
 else if(r.intent&&a.solSecret){if(!remote){const token=await login(a);remote=await walletRequest(token,'account');}same(e);const t=(remote.moneroTransfers||[]).find(t=>t.id===r.intent);if(t){r.hash=t.txid||r.hash;r.status=t.state==='complete'?'Confirmed':t.state==='cancelled'?'Cancelled':t.state==='halted'?'Review required':t.state==='reserved'?'Reserved · check pending sends':'Waiting for inscription';}}
 else if(r.chain==='monero'&&r.hash){const d=await jsonFetch(preferences.moneroNode+'/get_transactions',{txs_hashes:[r.hash],decode_as_json:false});same(e);const tx=d.txs?.find(t=>t.tx_hash===r.hash);if(tx)r.status=tx.in_pool?'Submitted · awaiting confirmation':'Confirmed';}
 }
 same(e);await persist();render();toast('Transaction status updated');
 }catch{toast('Status unavailable. Keep your receipts and retry.');}
}
