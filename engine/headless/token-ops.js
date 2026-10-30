// Headless operation layer over the token module (engine/token/token-format.js), for programs without screens such as the
// CLI. It runs in a browser page (the CLI's private headless Chromium). The module draws its usual screens into a hidden
// element; this layer fills the same fields a person would fill, presses the same buttons, and stops at every review so the
// program can ask its user first. No engine logic is repeated here: address checks, the owner-key lookup, fee checks, the
// encrypted journal, proving, signing, publishing and lost-reply recovery all run inside the module exactly as in the
// extension and on xmr20.org.
//
// Every operation returns one of
//   {stage:'review', review:{head,rows,notes,details,button}}   waiting: call approve() or cancel()
//   {stage:'check-coins', message}                               the Monero coin check is needed first: approve() runs it
//   {stage:'done', result:{title,rows,txids}, progress}
//   {stage:'error', error, code}
import {createPrivateFormat,shownPrivateAddress} from '../token/token-format.js';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const text=el=>(el?.textContent||'').replace(/\s+/g,' ').trim();

// options: the createPrivateFormat options a host supplies (account, oneShot, workerClient, store, secret, endpoint, node,
// signSol, splitXmr, solBalance, amount, units, compactTokenBalance, importSol, tokenIcon, usdOf). Screens, buttons and
// dialogs are supplied here. onProgress(text) receives the module's progress line and the scan percentage as they change.
export function createHeadlessTokens({onProgress=()=>{},...options}){
 const host=document.createElement('div');host.hidden=true;host.setAttribute('aria-hidden','true');host.className='xmr20-headless';
 host.innerHTML='<div id="modal" class="modal"></div><div id="pf-rows"></div>';document.body.append(host);
 const modal=host.querySelector('#modal'),rows=host.querySelector('#pf-rows');
 const $=selector=>host.querySelector(selector),$$=selector=>[...host.querySelectorAll(selector)];
 let epoch=0,running=null,screen=null;
 const show=(title,body)=>{screen=title;modal.innerHTML=`<div class="modal-body">${body}</div><div class="modal-foot"><p class="error" id="error" role="alert"></p></div>`;};
 const on=(id,fn)=>{const el=$('#'+id);if(el)el.onclick=fn;};
 const same=e=>{if(e!==epoch)throw Error('Wallet changed or locked.');};
 // The module starts each user action with run(fn); the last one is the task an operation waits for.
 function run(fn){const e=epoch;const task=(async()=>{try{await fn(e);return {ok:true};}catch(error){return {ok:false,error:error?.message||String(error),code:error?.code};}})();running=task;return task;}
 let shown='';const watch=setInterval(()=>{const status=pf.syncStatus(),line=text($('#progress'))||text($('#pf-status'))||(status.syncing&&status.pct!=null?`XMR20 scan: ${status.pct}%`:'');if(line&&line!==shown){shown=line;try{onProgress(line);}catch{}}},1000);
 const pf=createPrivateFormat({...options,show,on,run,same,$,$$,esc,toast:()=>{},render:()=>{},onActivity:()=>{},close:()=>{modal.innerHTML='';screen=null;}});

 function review(){const box=$('#pf-review');if(!box)return null;
  return {head:text(box.querySelector('.pf-receipt-head')),rows:[...box.querySelectorAll('.pf-row')].map(r=>[text(r.querySelector('span')),text(r.querySelector('strong'))]),
   notes:[...box.querySelectorAll('.pf-note')].map(text),details:[...box.querySelectorAll('details .subtle')].map(text),button:text($('#pf-approve'))||text($('#pf-split-go'))};}
 function success(){const box=$('#pf-review .pf-success');if(!box)return null;
  const txids=[...box.querySelectorAll('a.pf-link')].map(a=>(a.getAttribute('href')||'').split('/tx/')[1]).filter(Boolean);
  for(const m of box.querySelectorAll('.pf-mono'))txids.push(text(m).replace(/^Transaction /,'').replace(/…$/,''));
  return {title:text(box.querySelector('.pf-success-head')),rows:[...box.querySelectorAll('.pf-row')].map(r=>[text(r.querySelector('span')),text(r.querySelector('strong'))]),txids};}
 // Wait until the started task asks for approval (a review with Approve), or finishes.
 async function settle(){const task=running;if(!task)throw Error('Nothing was started.');
  for(;;){if($('#pf-approve'))return {stage:'review',review:review()};
   const done=await Promise.race([task,sleep(200).then(()=>null)]);if(!done)continue;
   // The split screen keeps one button: "Review" → (its review) "Split into 3 coins", or "Check coins" when the coin check is needed.
   const go=$('#pf-split-go'),live=go&&!go.hidden;
   if(!done.ok){if(live&&text(go)==='Check coins')return {stage:'check-coins',message:done.error};return {stage:'error',error:done.error,code:done.code};}
   if(live&&!success()&&text(go)==='Split into 3 coins')return {stage:'review',review:review()};
   return {stage:'done',result:success(),progress:text($('#progress'))};}}
 function click(selector){const el=$(selector);if(!el)throw Error('This step is not available right now ('+selector+').');el.click();}
 function fill(selector,value){const el=$(selector);if(!el)throw Error('Form field missing ('+selector+').');el.value=value;}
 const assets=()=>pf.state.backend?.assets??[];
 function asset(mint){const r=assets().find(a=>a.mint===mint);if(!r)throw Error('The bridge does not list this token on Monero.');return r;}
 // The token screen (Make private, Make open, pending operations) opens from the token's row, as a person would open it.
 function detail(mint){asset(mint);rows.innerHTML=pf.rowsHTML();pf.bind();const i=assets().findIndex(a=>a.mint===mint);click('#asset-private-'+i);}
 async function start(open){epoch++;running=null;await open();return settle();}
 return {
  pf,
  async sync(){await pf.refresh();return this.summary();},
  async summary(){const s=pf.state,debug=await globalThis.__pfDebug?.state?.().catch(()=>null),status=pf.syncStatus(),native=s.holder?.native||null;
   const spendable=native?native.outputs.filter(o=>!o.spent&&!o.reserved&&native.tip>=o.unlockedAt).length:0,held=native?native.outputs.filter(o=>!o.spent&&!o.reserved).length:0;
   return {error:status.error,ready:Boolean(s.holder),tip:s.holder?.tip??null,network:s.backend?.network??null,confirmations:s.backend?.confirmations??null,
    privateAddress:shownPrivateAddress(s.holder?.shieldedAddress||'')||null,feeAddress:debug?.nativeAddress||null,
    tokens:assets().map(r=>({mint:r.mint,symbol:r.symbol,name:r.name,decimals:r.decimals??6,open:s.holder?.public?.balances?.[r.asset]??'0',private:s.holder?.shielded?.balances?.[r.asset]??'0',
     solana:r.solanaBalance??null,payouts:(r.payouts||[]).map(p=>({txid:p.txid,amount:p.amount,status:p.status,confirmations:p.confirmations,feeDue:p.feeDue&&!p.feePaid?String(p.feeDue):null,binding:p.binding}))})),
    xmrForFees:native?{unlocked:String(native.unlocked),locked:String(native.locked),reserved:String(native.reserved),spendableCoins:spendable,coins:held}:null,
    pending:Object.entries(s.journal?.pending||{}).map(([id,p])=>({id,kind:p.kind,symbol:p.symbol,amount:p.amount,status:p.status,error:p.error||null,txids:(p.carriers||[]).filter(Boolean).map(c=>c.txid)})),
    history:(s.journal?.history||[]).slice(0,10).map(h=>({kind:h.kind,symbol:h.symbol,amount:h.amount,status:h.status,txids:h.txids||[]}))};},
  // Open transfer to a Monero address, or private transfer to an xmr20p1… (or penumbra1…) address.
  send({mint,to,amount,private:priv=false}){return start(async()=>{await pf.openSend(mint);if(priv)click('#pf-mode-private');fill('#pf-to',to);fill('#pf-amount',amount);click('#pf-send-go');});},
  makePrivate({mint,amount}){return start(async()=>{detail(mint);click('#pf-shield');fill('#pf-amount',amount);click('#pf-shield-go');});},
  makeOpen({mint,amount}){return start(async()=>{detail(mint);click('#pf-unshield');fill('#pf-amount',amount);click('#pf-unshield-go');});},
  // "Enable private transfers": reached from the Private tab of Send, which offers it when the account holds fewer than 2 coins.
  enablePrivate({mint}){return start(async()=>{await pf.openSend(mint);click('#pf-mode-private');if(!$('#pf-enable-private')){const n=pf.state.holder?.native;const coins=n?n.outputs.filter(o=>!o.spent&&!o.reserved).length:0;
    throw Error(coins>=2?`Not needed: this account already holds ${coins} XMR coins.`:n&&BigInt(n.unlocked||'0')+BigInt(n.locked||'0')===0n?'Receive a little XMR (about 0.001) at your Monero address first.':'Not available yet: let the wallet finish syncing.');}
   click('#pf-enable-private');click('#pf-split-go');});},
  bridgeToMonero({mint,amount}){return start(async()=>{await pf.openBridge(mint,'deposit');fill('#pf-amount',amount);click('#pf-bridge-go');});},
  bridgeToSolana({mint,amount}){return start(async()=>{await pf.openBridge(mint,'redeem');fill('#pf-amount',amount);click('#pf-bridge-go');});},
  // Saved operations whose record is proved but needs (new) carrier transactions, and abandoning ones that never reached the chain.
  publishPending({mint,id}){return start(async()=>{detail(mint);click(`[data-carry="${CSS.escape(id)}"]`);});},
  abandonPending({mint,id}){return start(async()=>{detail(mint);click(`[data-abandon="${CSS.escape(id)}"]`);});},
  payPayoutFee({mint,binding}){return start(async()=>{await pf.openBridge(mint,'redeem');click(`[data-payfee="${CSS.escape(binding)}"]`);});},
  // Answer the waiting review (or run the coin check), then wait for the next stop.
  async approve(){if($('#pf-approve'))click('#pf-approve');else if($('#pf-split-go'))click('#pf-split-go');else throw Error('Nothing is waiting for approval.');return settle();},
  async cancel(){if($('#pf-cancel')){click('#pf-cancel');return settle();}modal.innerHTML='';screen=null;return {stage:'error',error:'Cancelled. Nothing was signed or sent.'};},
  get screen(){return screen;},
  close(){epoch++;clearInterval(watch);pf.reset();host.remove();}
 };
}
