import {createExtensionMarketHost} from './market-wallet-host.js';
import {createMarketFetch} from './market-policy.js';
import {createNativeSendPage} from '../../engine/shared/native-send-page.js';
import {createNativeConversionPage} from '../../engine/shared/native-conversion-page.js';
import {createNativeRedemptionPage} from '../../engine/shared/native-redemption-page.js';
import {createNativeSendClient} from '../../engine/shared/native-market/wallet/native-send-client.mjs';
import {createOperatorCustodyClient} from '../../engine/shared/native-market/wallet/operator-custody-client.mjs';
import {createOperatorRedemptionClient} from '../../engine/shared/native-market/wallet/operator-redemption-client.mjs';
import {NATIVE_MARKET_CONFIGURATION} from '../../engine/shared/website/native-market-config.js';
import {createNativePopupChannel} from './native-popup-channel.js';
import {hasUnfinishedSetup} from '../../engine/shared/native-setup-status.js';
import {bridgeTabs} from '../../engine/shared/native-bridge-panels.js';

// Mount the existing review/recovery pages in the wallet's dialog. The shadow
// root keeps website styles out of the wallet and wallet styles out of the form.
export function createNativePopupFlow({modal,accountId,assertWallet,token,image,onBack,onSavedSetup,pageOptions={},navigation,syncBalance,
 setupStatus,setupStore,setupManifest=NATIVE_MARKET_CONFIGURATION?.manifestId,bridgeSwitch,bridgeLinks=[],onCoins,runtime=chrome.runtime,hostFactory=createExtensionMarketHost,
 pages={send:createNativeSendPage,convert:createNativeConversionPage,redeem:createNativeRedemptionPage}}){
 let closed=false,host,page,timer,requestId,offerSetup=null;
 const channel=createNativePopupChannel(runtime);
 const current=()=>{if(closed)throw Error('Monero screen closed.');assertWallet();};
 const stylesheet=runtime.getURL('market-entry.css');
 if(!document.querySelector('link[data-native-popup-style]')){
  const link=document.createElement('link');link.rel='stylesheet';link.href=stylesheet;link.dataset.nativePopupStyle='';document.head.append(link);
 }
 const shell=document.createElement('div'),shadow=shell.attachShadow({mode:'open'});
 const style=document.createElement('link');style.rel='stylesheet';style.href=stylesheet;
 const container=document.createElement('div');container.className='native-popup-root native-send-window';
 shadow.append(style,container);
 modal.classList.add('native-popup-dialog');modal.removeAttribute('aria-labelledby');modal.setAttribute('aria-label','Monero tokens');
 modal.replaceChildren(shell);if(!modal.open)modal.showModal();
 container.innerHTML='<main id="native-send"><div class="native-send-head"><h1>Monero tokens</h1><button type="button" data-close>Back</button></div><p class="native-send-message" role="status">Opening your Monero wallet…</p></main>';
 container.querySelector('[data-close]').onclick=onBack;
 // Recovery navigation stays outside the form's busy/failed balance state.
 // It opens saved records only; it never starts or approves a replacement.
 // Offered only while a saved setup is unfinished or its state is unknown.
 function savedSetupLink(){
  if(typeof onSavedSetup!=='function'||offerSetup===false||container.querySelector('[data-saved-setup]'))return;
  const actions=document.createElement('div');actions.className='native-send-actions';
  const button=document.createElement('button');button.type='button';button.className='native-secondary';
  button.dataset.savedSetup='';button.textContent='Finish Monero setup';
  button.onclick=()=>{current();onSavedSetup();};actions.append(button);
  container.querySelector('.native-send-head').after(actions);
 }
 // Secondary routes, such as previously bridged tokens, appear only when offered.
 function bridgeLinkButtons(){
  for(const link of bridgeLinks){
   if(typeof link?.open!=='function'||typeof link.label!=='string')continue;
   const actions=document.createElement('div');actions.className='native-send-actions';
   const button=document.createElement('button');button.type='button';button.className='native-secondary';button.textContent=link.label;
   button.onclick=()=>{current();link.open();};actions.append(button);container.querySelector('.native-send-head').after(actions);
  }
 }
 const release=()=>{
  if(host)return host.release();
  if(requestId)return channel.sendMessage({channel:'xmr20-site-approval',action:'marketClose',requestId}).catch(()=>{});
 };
 const error=message=>{
  if(closed)return;
  let notice=container.querySelector('.native-popup-error');
  if(!notice){notice=document.createElement('p');notice.className='native-send-error native-popup-error';notice.setAttribute('role','alert');(container.querySelector('#native-send')||container).append(notice);}
  notice.textContent=message;
 };
 return {
  async open(view){
   try{
    current();if(!Object.hasOwn(pages,view))throw Error('Unknown Monero screen.');
    const response=await channel.sendMessage({channel:'xmr20-site-approval',action:view==='convert'?'openNativeConvert':view==='redeem'?'openNativeBridge':'openNativeSend'});
    requestId=response?.value?.requestId;
    if(closed){await release();return;}
    current();if(response?.error)throw Error(response.error);
    if(!requestId||response.value.account.id!==accountId)throw Error('Wallet changed. Reopen this screen.');
    host=hostFactory({requestId,runtime:channel,syncBalance});
    const opened=await host.open();current();
    if(opened.account.id!==accountId||opened.market.view!==view)throw Error('Wallet operation changed. Reopen this screen.');
    const assertCurrent=()=>{current();opened.assertCurrent();};
    const capability=await opened.client.capabilities();assertCurrent();
    if(!capability.available)throw Error(capability.reason||'Monero wallet unavailable.');
    // Keep all native requests on the existing fixed transport without replacing
    // global fetch, which the rest of the wallet uses for other networks.
    const fetchImpl=createMarketFetch(),options={configuration:NATIVE_MARKET_CONFIGURATION,fetchImpl,assertCurrent};
    // Before the page starts its own wallet work: the private client is single-flight.
    if(typeof onSavedSetup==='function'){
     const status=setupStatus??createNativeSendClient({fetchImpl,assertCurrent,operation:'credit'}).status;
     offerSetup=await hasUnfinishedSetup({client:opened.client,status,manifest:setupManifest,store:setupStore});current();
    }
    const swapping=typeof bridgeSwitch==='function'&&(view==='convert'||view==='redeem');
    page=pages[view]({...opened,...pageOptions,assertCurrent,token,container,onClose:onBack,onReopen:onBack,
     ...(swapping?{onSwitch:()=>{current();bridgeSwitch(view==='convert'?'redeem':'convert');}}:{}),
     api:createNativeSendClient({fetchImpl,assertCurrent,operation:view==='convert'?'credit':view==='redeem'?'burn':'send'}),
     ...(view==='convert'?{bridge:createOperatorCustodyClient(options)}:view==='redeem'?{bridge:createOperatorRedemptionClient(options)}:{})});
    savedSetupLink();bridgeLinkButtons();
    // Tabs replace the visual title; the heading stays for assistive technology.
    if(typeof onCoins==='function'&&swapping)container.querySelector('.native-send-head h1')?.before(bridgeTabs({active:'tokens',onCoins:()=>{current();onCoins();}}));
    if(navigation){
     const label=document.createElement('label');label.className='native-route-label';label.textContent=navigation.label;
     const select=document.createElement('select');select.setAttribute('aria-label',navigation.label);
     for(const item of navigation.items){const option=document.createElement('option');option.value=item.id;option.textContent=item.label;select.append(option);}
     select.value=navigation.selected;select.onchange=()=>{current();navigation.choose(select.value);};label.append(select);container.querySelector('.native-send-head').after(label);
    }
    const back=container.querySelector('[data-close]');back.textContent='Back';back.setAttribute('aria-label','Back to wallet');
    if(image)page.setTokenImage(image);
    timer=setInterval(()=>{void host.check().catch(()=>{
     clearInterval(timer);page?.close();host.close();
     container.querySelectorAll('button,input,textarea,select').forEach(el=>{if(!el.matches('[data-close]'))el.disabled=true;});
     error('Your wallet was locked or changed. Go back and reopen this screen.');
    });},2000);
    await page.open();current();
   }catch(e){
    if(!closed){clearInterval(timer);page?.close();await release();error(e.message||'Could not open Monero tokens. Go back and try again.');savedSetupLink();}
   }
  },
  close(){
   if(closed)return;closed=true;clearInterval(timer);page?.close();void Promise.resolve(release()).finally(()=>channel.close());
   modal.classList.remove('native-popup-dialog');modal.removeAttribute('aria-label');modal.setAttribute('aria-labelledby','modal-title');
  }
 };
}
