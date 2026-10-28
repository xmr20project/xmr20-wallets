// Website host for the extension's Open/Private token module (wallet-extension/src/token-format.js), 28 Oct 2026, LOCAL ONLY.
// The module, its workers, the holder engine (wasm) and the parameter manifest are the extension's own (see
// operations/claude-website-private-wallet-20261028/build-private-assets.mjs), so both wallets behave the same. This file only
// supplies what the extension's popup supplies: a dialog to draw in, the account, storage and Solana signing, which here is the
// connected Phantom/Solflare wallet instead of a key held by the wallet. The extension's screens and token rows are drawn inside
// shadow roots that carry the extension's own stylesheet, so they look the same and the site's styles cannot reach them.
import {createPrivateFormat} from '../../engine/token/token-format.js';
import {createWorkerClient} from '../../engine/token/worker-client.js';
import {amount,units,importSol} from '../../engine/shared/core.js';
import {compactTokenBalance} from '../../engine/shared/token-display.js';
// The extension's popup stylesheet = its base styles + the token screens' styles (extension/build.mjs writes the same file).
import extensionBaseCss from '../../engine/shared/extension-style.css?raw';
import tokenScreenCss from '../../engine/token/private-format.css?raw';
const extensionCss=extensionBaseCss+tokenScreenCss;
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {loadTokenImages} from './wallet-token-images.js';
import {moneroWalletVault} from './monero-wallet-vault.js';
import {nativeRestoreHeight} from '../../engine/monero/native-wallet-client.js';

const BASE=(import.meta.env?.BASE_URL||'/')+'xmr20-private/';
// The popup's page-level rules (:root variables, body) apply to each shadow host instead.
export const PRIVATE_WALLET_CSS=extensionCss.replace(/:root\b/g,':host').replace(/(^|})\s*body\s*\{/g,'$1:host{')+`
:host{all:initial;display:block;color-scheme:dark;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f8f5f1}
dialog.xmr20-pf-modal{width:min(420px,calc(100vw - 32px));max-height:min(760px,calc(100vh - 32px))}
dialog.xmr20-pf-modal::backdrop{background:rgba(0,0,0,.6)}
/* 28 Oct 2026 (owner): bridge forms (To Monero and To Solana): a slightly smaller amount, slightly larger details; errors can be\n   scrolled and copied in full. */
.pf-amount{font-size:19px}
.pf-avail{font-size:12px}
.pf-facts p{font-size:12.5px;margin:10px 0}
.modal-foot .error,#error{max-height:200px;overflow:auto;user-select:text;-webkit-user-select:text;white-space:pre-wrap;overflow-wrap:anywhere}
.asset{position:relative;isolation:isolate}
/* 28 Oct 2026 (owner: "all the boxes should be consistently sized, as the monero box"): on the website the token rows take the
   wallet's own row look and size (Monero, SOL): 38px coin, 12/13px padding, 15px corners, two lines on each side. "Price
   unavailable" is left out, as on the SOL tab. */
.asset.pf-asset{margin:0 0 8px;padding:12px 13px;gap:11px;border-radius:15px;background:#1a1918;border:1px solid #221f1c}
.pf-asset .coin-wrap .coin,.pf-asset .coin .token-image{width:38px;height:38px}
.pf-asset .chain-badge{width:17px;height:17px;right:-3px;bottom:-3px;font-size:9px}
.pf-asset .asset-info strong{font-size:14px;font-weight:600;line-height:1.3}
.pf-asset .asset-info small{display:block;margin-top:2px;font-size:11.5px;line-height:1.3;color:#8c8985}
.pf-asset .asset-value{font-size:14px;font-weight:650;line-height:1.3;color:#fff}
.pf-asset .asset-value small{display:block;margin-top:2px;font-size:11px;font-weight:400;line-height:1.3;color:#8c8985}
.pf-asset .asset-value small.asset-usd{color:#edc5a5}
.pf-asset .asset-value small.asset-usd.none{display:none}
.asset::after{content:'';position:absolute;z-index:-1;inset:0;border-radius:inherit;background:radial-gradient(240px circle at var(--ux-x,50%) var(--ux-y,0),rgba(242,147,92,.12),transparent 55%);opacity:0;transition:opacity .35s ease;pointer-events:none}
@media (hover:hover) and (pointer:fine){.asset:hover::after{opacity:1}}`;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Saved pending operations and the journal are per site (localStorage), like the extension's are per install.
const store={async get(k){try{return JSON.parse(localStorage.getItem(k)||'null');}catch{return null;}},async set(k,v){localStorage.setItem(k,JSON.stringify(v));}};
const journalSecret=seed=>bytesToHex(sha256(new TextEncoder().encode('XMR20-website-private-journal-v1\n'+seed.trim().split(/\s+/).join(' '))));
// 28 Oct 2026 ("Enable private transfers"): the Monero row registers its unlocked Monero wallet here, so the token screen's
// split can use it (the token module itself never holds that wallet).
let nativeWallet=null;
export function setWebsiteNativeWallet(value){nativeWallet=value&&value.client&&value.address?value:null;}
export const clearWebsiteNativeWallet=client=>{if(nativeWallet?.client===client)nativeWallet=null;};
const nativeFor=address=>{const n=nativeWallet;if(!n||n.address!==address||!n.client.alive)throw Error('Unlock your Monero wallet first: press Sync on the Monero row, then try again.');return n;};
export const websiteAccountId=(owner,address)=>'web-'+bytesToHex(sha256(new TextEncoder().encode(owner+'|'+address))).slice(0,24);

// account: {id, sol, xmr, xmrSeed, height}; signSol(tx) -> the signed Transaction (Phantom/Solflare signTransaction).
// onChange() -> the website redraws whatever shows the token rows.
export function createWebsitePrivateWallet({account:fixed,signSol,onChange=()=>{},onActivity=()=>{},usdOf=()=>null,tokenIcon=()=>null,solBalance=()=>null}){
 const host=document.createElement('div');host.className='xmr20-pf-host';const shadow=host.attachShadow({mode:'open'});
 shadow.innerHTML=`<style>${PRIVATE_WALLET_CSS}</style><dialog id="modal" class="xmr20-pf-modal modal" aria-labelledby="modal-title"></dialog><div id="toast" class="toast" role="status"></div>`;
 document.body.append(host);
 const modal=shadow.querySelector('dialog'),toastEl=shadow.querySelector('#toast'),roots=new Set([shadow]);
 let busy=false,epoch=0,runSequence=0,toastTimer,closed=false;
 // Element lookups search the dialog first, then every attached row container (each its own shadow root).
 const $=selector=>{for(const root of roots){const el=root.querySelector(selector);if(el)return el;}return null;};
 const $$=selector=>{const found=[];for(const root of roots)found.push(...root.querySelectorAll(selector));return found;};
 const on=(id,fn)=>{const el=$('#'+id);if(el)el.onclick=fn;};
 const account=()=>closed?null:fixed;
 const same=e=>{if(e!==epoch||!account())throw Error('Wallet changed or locked.');};
 function toast(text){toastEl.textContent=text;toastEl.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toastEl.classList.remove('visible'),3200);}
 function close(){modal.close();modal.innerHTML='';}
 function show(title,body){modal.innerHTML=`<div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button id="close" aria-label="Close">×</button></div><div class="modal-body">${body}</div><div class="modal-foot"><p class="error" id="error" role="alert"></p></div>`;
  layoutModal();if(!modal.open)modal.showModal();on('close',()=>{if(!busy){close();onChange();}});}
 // 28 Oct 2026 (owner: "when I click the private tab … it doesn't do anything … I can't click submit"): as the extension's popup
 // does (app.js layoutModal), the body scrolls while progress, the trailing action buttons and errors stay in view; on a
 // laptop-height window Review, Back and the progress line were below the fold. Elements keep their ids and handlers.
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
 async function run(fn){if(busy)return;busy=true;const e=epoch,task=++runSequence;const buttons=[...modal.querySelectorAll('button:not([data-keep]),input,textarea,select')];buttons.forEach(b=>b.disabled=true);if($('#error'))$('#error').textContent='';
  try{await fn(e);}catch(error){if(e===epoch){if($('#progress'))$('#progress').textContent='';if($('#error'))$('#error').textContent=error.message||'Could not complete. Try again.';else toast(error.message);}}
  finally{if(task===runSequence){busy=false;buttons.forEach(b=>b.disabled=b.dataset.disabled==='true');}}}
 const workerClient=(file,hooks={})=>createWorkerClient(file,{...hooks,spawn:name=>new Worker(BASE+name)});
 const oneShot=(file,action,args)=>{const c=workerClient(file);return c.call(action,args).finally(()=>c.close());};
 // The journal is encrypted at rest with a key from the account's Monero phrase (the extension uses its vault password).
 const secret=()=>{const a=account();if(!a?.xmrSeed)throw Error('Unlock the Monero wallet first.');return journalSecret(a.xmrSeed);};
 // On xmr20.org the browser calls the private-bridge gateway directly (it allows https://xmr20.org; its rate limits are per
 // visitor). The local preview forwards the same paths through its dev server instead.
 const api=location.origin==='https://xmr20.org'?'https://api.xmr20.org':location.origin;
 const pf=createPrivateFormat({endpoint:api+'/api/private-bridge',node:api+'/api/private-node',
  signSol:async tx=>{const signed=await signSol(tx);if(!signed?.signatures?.some(s=>s.signature&&s.publicKey.toBase58()===account()?.sol))throw Error('The wallet did not sign with the connected account. Nothing was sent.');return signed;},
  account,oneShot,workerClient,store,secret,show,on,run,toast,esc,amount,units,compactTokenBalance,importSol,same,$,
  render:()=>onChange(),onActivity,close,tokenIcon,usdOf,solBalance,$$,
  splitXmr:{prepare:async()=>{const n=nativeFor(account().xmr);await n.syncNow();return n.client.prepareSplit({node:n.node,carrierLookup:'local'});},
   checkCoins:async()=>{const n=nativeFor(account().xmr);return n.client.checkCarriers({node:n.node,carrierLookup:'node'});},
   relay:async review=>{const n=nativeFor(account().xmr);const sent=await n.client.relay({reviewId:review.id,node:n.node});void n.syncNow().catch(()=>{});return sent;}}});
 return {
  pf,account,
  // A container that shows the token rows: its shadow root gets the extension's styles and is searched by the module.
  attach(root){roots.add(root);return()=>roots.delete(root);},
  rowsHTML:()=>pf.rowsHTML(),bind:()=>pf.bind(),refresh:()=>pf.refresh(),syncStatus:()=>pf.syncStatus(),receiveInfo:()=>pf.receiveInfo(),
  openBridge:(...a)=>pf.openBridge(...a),openSend:(...a)=>pf.openSend(...a),heldTokens:()=>pf.heldTokens(),portfolioRows:()=>pf.portfolioRows(),
  // Lock or disconnect: ends running tasks, closes the dialog, stops the workers and forgets the phrase.
  dispose(){closed=true;epoch++;busy=false;close();pf.reset();host.remove();fixed={...fixed,xmrSeed:''};}
 };
}

// One open token wallet per page: opened by the website's "Sync XMR wallet" unlock with the same phrase, closed by its Lock.
let current=null,images=new Map(),solLamports=null;const listeners=new Set();
// The connected Solana wallet's SOL (lamports), so the bridge can say "Add SOL" before anything is signed (set by wallet-menu.jsx).
export function setWebsiteSolBalance(value){solLamports=/^\d{1,20}$/.test(String(value??''))?String(value):null;}
export const websiteSolBalance=()=>solLamports;
const notify=()=>{for(const l of listeners)l(current);};
export function openWebsitePrivateWallet({owner,address,seed,height,provider}){
 // Already open for this wallet: keep it (and its running scan); pressing Sync or Bridge again never starts over.
 const open=current?.account();if(open&&open.sol===owner&&open.xmr===address)return current;
 closeWebsitePrivateWallet();
 const account={id:websiteAccountId(owner,address),sol:owner,xmr:address,xmrSeed:seed,height:Number(height)||0};
 // Token artwork from the site's checked catalog images, as the extension's token list shows it.
 void loadTokenImages().then(map=>{images=map;notify();});
 current=createWebsitePrivateWallet({account,onChange:notify,onActivity:()=>window.dispatchEvent(new Event('xmr20-holdings-refresh')),solBalance:()=>solLamports,tokenIcon:mint=>images.get(mint)||null,signSol:async tx=>{provider.assertCurrent?.();return provider.signTransaction(tx);}});
 notify();void current.refresh().finally(notify);return current;
}
// The open token wallet for this Solana + Monero pair, opening it with one approval from the connected wallet when needed
// (the Monero phrase saved encrypted on this device when the wallet was created or imported with it).
export async function ensureWebsitePrivateWallet({owner,address,provider}){
 const open=current?.account();if(open&&open.sol===owner&&open.xmr===address)return current;
 const context={owner,network:'mainnet',address};
 if(!provider?.signMessage||!moneroWalletVault().has(context))throw Error('Sync this Monero wallet once on the Monero tab, or import it with your Solana wallet connected. Bridged tokens arrive there.');
 const seed=await moneroWalletVault().load(context,provider);
 return openWebsitePrivateWallet({owner,address,seed,height:nativeRestoreHeight(address),provider});
}
export function closeWebsitePrivateWallet(){if(!current)return;const c=current;current=null;c.dispose();notify();}
export const currentWebsitePrivateWallet=()=>current;
export function subscribeWebsitePrivateWallet(fn){listeners.add(fn);return()=>listeners.delete(fn);}
