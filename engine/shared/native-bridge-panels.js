import {bridgeTokenPanels,bridgeDisplayAmount} from './joint-bridge-view.js';

// Presentation only: the native bridge forms keep exact atomic amounts, quotes
// and approvals. These panels show compact values and never request anything.
const esc=value=>String(value).replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
const imageOk=image=>typeof image==='string'&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)&&image.length<=700000;

export function nativeBridgePanels({symbol,image,source,destination,destinationNote,value='',canSwitch=false}){
 return bridgeTokenPanels({esc,asset:{symbol,mint:''},image:imageOk(image)?image:undefined,source,destination,destinationNote,value,
  editable:true,picker:false,swapDisabled:!canSwitch});
}
// Wire the panel controls to the page's existing hooks. Max keeps data-max so
// the page's handler and tests use the same control as before.
export function bindNativeBridgePanels(content,{onSwitch}={}){
 const max=content.querySelector('#j3-amount-max');if(max)max.dataset.max='';
 const available=content.querySelector('.bridge-token-panel:first-of-type .bridge-panel-foot>span:first-child');
 if(available){available.dataset.balance='';available.setAttribute('role','status');}
 // Switching direction only closes this screen and opens the other one, like
 // Back, so it stays available during a sync; it never submits work.
 const swap=content.querySelector('#j3-swap');if(swap&&typeof onSwitch==='function'){swap.dataset.switch='';swap.disabled=false;swap.onclick=onSwitch;}
}
export function setPanelAvailable(content,raw){
 const node=content.querySelector('[data-balance]');if(node)node.textContent='Available: '+bridgeDisplayAmount(raw);
}
// raw may be undefined while no matched quote exists: the panel shows a dash.
export function setPanelReceive(content,raw,title=''){
 const node=content.querySelector('.bridge-token-panel:last-of-type .bridge-amount');if(!node)return;
 node.textContent=bridgeDisplayAmount(raw===undefined?raw:String(raw));node.title=title;
 node.classList.toggle('bridge-amount-compact',node.textContent.length>13);
}
// The receive panel's corner shows the matched quote's token fee, or the generic note.
export function setPanelFee(content,label,title=''){
 const node=content.querySelector('.bridge-token-panel:last-of-type .bridge-panel-foot>span:last-child:not(:first-child)');if(!node)return;
 node.textContent=label??'After token fee';node.title=title;
}
export function setPanelImage(content,image){
 if(!imageOk(image))return;
 for(const art of content.querySelectorAll('.bridge-token-art')){
  const first=art.firstElementChild;if(!first||first.tagName==='IMG')continue;
  const img=document.createElement('img');img.src=image;img.alt='';img.width=32;img.height=32;first.replaceWith(img);
 }
}
// SOL <-> XMR coins through ChangeNOW reuse the panels. The page keeps each
// coin's own decimals; these panels never format coin amounts as tokens.
export function nativeCoinPanels({direction,destinationNote,value=''}){
 const [from,to]=direction==='sol-xmr'?[['SOL','Solana'],['XMR','Monero']]:[['XMR','Monero'],['SOL','Solana']];
 return bridgeTokenPanels({esc,asset:{symbol:from[0],mint:'',coin:true},destinationAsset:{symbol:to[0],coin:true},source:from[1],destination:to[1],
  destinationNote,value,editable:true,picker:false,swapDisabled:false});
}
// Bridge window tabs: tokens through the XMR20 bridge, or SOL/XMR coins through ChangeNOW.
export function bridgeTabs({active,onTokens,onCoins}){
 const tabs=document.createElement('div');tabs.className='bridge-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Bridge type');
 for(const [id,label,open] of [['tokens','Tokens',onTokens],['coins','SOL ↔ XMR',onCoins]]){
  const tab=document.createElement('button');tab.type='button';tab.setAttribute('role','tab');tab.dataset.tab=id;tab.textContent=label;
  const selected=id===active;tab.setAttribute('aria-selected',String(selected));
  if(!selected&&typeof open==='function')tab.onclick=open;else tab.tabIndex=selected?0:-1;
  tabs.append(tab);
 }
 return tabs;
}
