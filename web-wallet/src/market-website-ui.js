// MONERO MARKET candidate (30 Oct 2026): the website wallet's market dialog. The extension shows approvals in its own window;
// the website wallet shows them in a dialog of its own, drawn in its own shadow root with the extension window's styles and
// the same review text (extension/src/market-reviews.js). The market page talks only to market-website-bridge.js (bounded
// market.* views, and a request to show this dialog); decisions are made only with these buttons. NOTE: page and wallet share
// the xmr20.org origin, so this split is by code, not enforced by the browser as the extension's window is (INTEGRATION.md).
import {esc,review,KIND_TITLE,approveLabel,doneText} from '../../engine/shared/market-reviews.js';
import windowCss from '../../engine/shared/market-wallet.css?raw';

const CSS=windowCss.replace(/:root\b/g,':host').replace(/html,body\{height:100%;margin:0;/,':host{all:initial;display:block;')+`
dialog.wl-dialog{padding:0;border:1px solid rgba(255,255,255,.12);border-radius:18px;background:#090909;color:inherit;width:min(460px,calc(100vw - 32px));height:min(720px,calc(100vh - 32px));overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.6)}
dialog.wl-dialog::backdrop{background:rgba(0,0,0,.6)}
.wl{height:100%;max-width:none}
.wl-close{width:32px;height:32px;margin-left:8px;border-radius:10px;border:1px solid var(--line2);background:#1c1c1c;color:#f5f3f0;cursor:pointer;font-size:18px;line-height:1}
.wl-head-right{display:flex;align-items:center}
.wl-mark{display:flex;align-items:center;justify-content:center}`;

export function createMarketDialog({market,where='website'}){
 const host=document.createElement('div');host.className='xmr20-market-dialog-host';
 const root=host.attachShadow({mode:'open'});
 // A constructed stylesheet: applies under a strict style-src (some xmr20.org routes do not allow inline <style>).
 const sheet=new CSSStyleSheet();sheet.replaceSync(CSS);root.adoptedStyleSheets=[sheet];
 root.innerHTML=`<dialog class="wl-dialog" aria-labelledby="wl-heading"><div class="wl">
  <header class="wl-head"><div class="wl-brand"><div class="wl-mark">x<span>m</span></div><div><strong id="wl-heading">XMR20 Wallet</strong><small id="wl-label">Monero Market</small></div></div><div class="wl-head-right"><span class="wl-chip" id="wl-chip">OFFLINE LAB</span><button type="button" class="wl-close" id="wl-close" aria-label="Close">×</button></div></header>
  <main class="wl-body" id="wl-body"></main>
  <p class="sr-only" id="wl-live" aria-live="polite"></p>
  <footer class="wl-foot" id="wl-foot" hidden><p class="wl-error" id="wl-error" hidden></p><div class="wl-actions"><button type="button" class="wl-secondary" id="wl-decline">Decline</button><button type="button" class="wl-primary" id="wl-approve">Approve</button></div></footer>
 </div></dialog>`;
 document.body.append(host);
 const $=s=>root.querySelector(s),dialog=$('dialog');
 let current=null,done=null,busy=false,error=null,dismissed=new Set(),removed=false,doneTimer=null;
 const setHTML=(sel,html)=>{const el=$(sel);if(el.__html!==html){el.innerHTML=html;el.__html=html;return true;}return false;};
 function close(){if(dialog.open)dialog.close();}
 function render(){
  if(removed)return;
  const st=market.status();$('#wl-chip').textContent=st.network==='mainnet'?'MAINNET · EXPERIMENTAL':st.network==='stagenet'?'STAGENET TEST':'OFFLINE LAB';
  const list=market.approvals();
  if(done){setHTML('#wl-body',`<div class="wl-done ${done.ok?'':'no'}">${esc(done.text)}</div>`);$('#wl-foot').hidden=true;return;}
  const open=list.filter(a=>!dismissed.has(a.id));
  const a=list.find(x=>x.id===current)||(open.length?open[0]:null);
  if(!a){current=null;$('#wl-foot').hidden=true;if(list.length)setHTML('#wl-body',`<h1 class="wl-title">Waiting for you</h1><div class="wl-list">${list.map(x=>`<button type="button" data-id="${esc(x.id)}"><span>${esc(KIND_TITLE[x.kind]||x.kind)}</span><span>›</span></button>`).join('')}</div>`);else close();return;}
  const fresh=a.id!==current;current=a.id;
  if(setHTML('#wl-body',review(a,where))||fresh){$('#wl-live').textContent=$('.wl-title')?.textContent||'Review';}
  $('#wl-foot').hidden=false;$('#wl-error').hidden=!error;$('#wl-error').textContent=error||'';
  $('#wl-approve').disabled=busy;$('#wl-decline').disabled=busy;$('#wl-approve').textContent=busy?'Working…':approveLabel(a);
  // A new approval opens the dialog by itself (each one comes from something this person just asked for on the page).
  if(!dialog.open&&!dismissed.has(a.id)){dialog.showModal();if(!busy)$('#wl-approve').focus();}
 }
 async function decide(decision){
  const a=market.approvals().find(x=>x.id===current);if(!a||busy)return;busy=true;error=null;render();
  try{const res=await market.decide(a.id,a.nonce,decision);done={ok:decision==='approve',text:doneText(a,decision,res?.result)};current=null;
   clearTimeout(doneTimer);doneTimer=setTimeout(()=>{done=null;render();},2500);}
  catch(e){error=e.message;}
  finally{busy=false;render();}
 }
 $('#wl-approve').addEventListener('click',()=>decide('approve'));
 $('#wl-decline').addEventListener('click',()=>decide('decline'));
 $('#wl-close').addEventListener('click',()=>{if(busy)return;if(current)dismissed.add(current);done=null;close();});
 dialog.addEventListener('cancel',e=>{if(busy){e.preventDefault();return;}if(current)dismissed.add(current);});
 $('#wl-body').addEventListener('click',e=>{const b=e.target.closest('[data-id]');if(b){current=b.dataset.id;render();}});
 return {
  render,
  // The page's "Approve in wallet" button: show what is waiting (also approvals closed earlier).
  show(){dismissed.clear();done=null;render();if(!dialog.open&&market.approvals().length)dialog.showModal();},
  remove(){removed=true;clearTimeout(doneTimer);close();host.remove();},
 };
}
