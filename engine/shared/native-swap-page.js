import {createNativePageLayout} from './native-page-layout.js';
import {nativeCoinPanels,bindNativeBridgePanels,setPanelFee,bridgeTabs} from './native-bridge-panels.js';

const labels={waiting:'Waiting for your deposit',new:'Waiting for your deposit',confirming:'Confirming your deposit',exchanging:'Exchanging your funds',sending:'Sending to your wallet',finished:'ChangeNOW reports the payout complete',failed:'Exchange failed — contact ChangeNOW',refunding:'Refund in progress',refunded:'ChangeNOW reports a refund',expired:'Exchange expired — do not send a deposit',verifying:'ChangeNOW is reviewing this exchange',unknown:'Status unavailable'};
const money=(raw,decimals)=>{const n=BigInt(raw),scale=10n**BigInt(decimals);return String(n/scale)+((n%scale)?'.'+String(n%scale).padStart(decimals,'0').replace(/0+$/,''):'');};
// 29 Oct 2026: `direction` sets the starting side ('xmr-sol' from the website's Monero screen, Bridge); 'sol-xmr' otherwise.
export function createNativeSwapPage({container,account,assertCurrent,onClose,onPay,maximum,loadOrders,saveOrder,onTokens,balance,
 fetcher=globalThis.fetch,now=()=>Date.now(),direction='sol-xmr'}){
 container.classList.add('native-send-window');
 container.innerHTML='<main id="native-send"><div class="native-send-head"><h1>SOL ↔ XMR</h1><button type="button" data-close>Back</button></div><p class="native-send-message" role="status" aria-live="polite"></p><div class="native-send-content"></div><p class="native-send-error" role="alert" hidden></p></main>';
 const root=container.querySelector('main'),layout=createNativePageLayout(root),content=root.querySelector('.native-send-content'),message=root.querySelector('.native-send-message'),error=root.querySelector('.native-send-error');
 root.querySelector('[data-close]').onclick=onClose;
 // Inside Bridge, tabs replace the visual title; the heading stays for assistive technology.
 if(typeof onTokens==='function')root.querySelector('h1').before(bridgeTabs({active:'coins',onTokens}));
 let closed=false,busy=false,quote,order,kind=direction==='xmr-sol'?'xmr-sol':'sol-xmr';
 const current=()=>{if(closed)throw Error('Exchange closed.');assertCurrent();};
 const text=(sel,value)=>{content.querySelector(sel).textContent=value;};
 async function api(action,body={}){
  current();const r=await fetcher('https://xmr20.org/api/native-swap',{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...body}),signal:AbortSignal.timeout(30000)});
  current();const data=await r.json();if(!r.ok||data.error)throw Error(data.error||'Exchange unavailable. Keep any saved order.');return data;
 }
 async function run(work){
  if(busy||closed)return;busy=true;layout.setBusy(true);error.hidden=true;
  try{current();await work();current();}catch(e){if(!closed){message.textContent='Exchange needs attention.';error.textContent=e.name==='TimeoutError'?'The exchange check timed out. Check your saved order before creating another.':e.message;error.hidden=false;}}
  finally{busy=false;layout.setBusy(false);}
 }
 function form(){
  message.textContent='Exchange real SOL and XMR through ChangeNOW.';
  layout.render(nativeCoinPanels({direction:kind,destinationNote:''})+'<details class="native-send-disclosure"><summary>Exchange details</summary><label class="native-send-label" for="swap-destination">Receive at</label><textarea id="swap-destination" rows="1" spellcheck="false" autocomplete="off"></textarea><p class="native-send-help" data-refund></p><p class="native-send-help">ChangeNOW receives your deposit and sends the other asset to your wallet. The rate can change before completion. Provider and network fees apply; verification may be required. This exchange is not a trustless bridge.</p></details><div class="native-send-actions"><button class="native-secondary" data-cancel>Cancel</button><button class="native-primary" data-next>Get estimate</button></div>');
  // The arrow flips direction; redrawing clears the amount and Max for the new source.
  bindNativeBridgePanels(content,{onSwitch:()=>{kind=kind==='sol-xmr'?'xmr-sol':'sol-xmr';form();}});setPanelFee(content,'Floating rate');
  const input=content.querySelector('input'),destination=content.querySelector('textarea'),available=content.querySelector('[data-balance]');
  // Optional: the host shows the source's balance (the website shows its SOL); Max still replaces it with the amount after fee.
  if(available&&typeof balance==='function'){const d=kind;void Promise.resolve().then(()=>balance(d)).then(shown=>{if(!closed&&input.isConnected&&kind===d&&typeof shown==='string'&&shown&&!available.textContent.startsWith('Max'))available.textContent='Available: '+shown;}).catch(()=>{});}
  // A swap pays into this wallet's own address; another address stays editable in the details.
  const own=kind==='sol-xmr'?account.monero||'':account.solana||'',network=kind==='sol-xmr'?'Monero':'Solana';
  const note=content.querySelector('.bridge-token-panel:last-of-type .bridge-panel-foot>span:first-child');
  const showDestination=()=>{if(note)note.textContent=destination.value.trim()===own&&own?'To your '+network+' wallet':destination.value.trim()?'To another address':'Add a receiving address';};
  destination.value=own;destination.oninput=showDestination;showDestination();if(!own)content.querySelector('.native-send-disclosure').open=true;
  text('[data-refund]','Refunds return to your '+(kind==='sol-xmr'?'Solana':'Monero')+' wallet. Max reserves the SOL fee or 0.0001 XMR. Payment review verifies the fee and excludes coins carrying XMR20.');
  content.querySelector('[data-cancel]').onclick=onClose;
  content.querySelector('[data-max]').onclick=()=>run(async()=>{message.textContent='Checking spendable balance and network fee…';const d=kind,raw=await maximum(d);current();if(kind!==d||!input.isConnected)return;const shown=money(raw,d==='sol-xmr'?9:12);input.value=shown;if(available)available.textContent='Max after fee: '+shown;message.textContent='Maximum after the estimated network fee.';});
  content.querySelector('[data-next]').onclick=()=>run(async()=>{
   message.textContent='Checking ChangeNOW’s minimum and estimate…';
   quote=await api('quote',{direction:kind,amount:input.value.trim(),destination:destination.value.trim(),refund:kind==='sol-xmr'?account.solana:account.monero});review();
  });
  const saved=loadOrders();
  if(saved.length){const details=document.createElement('details'),summary=document.createElement('summary');details.className='native-send-recovery';summary.textContent='Saved SOL/XMR exchanges';details.append(summary);
   for(const row of saved){const button=document.createElement('button');button.className='native-secondary';button.textContent=row.amount+' '+(row.direction==='sol-xmr'?'SOL → XMR':'XMR → SOL');button.onclick=()=>run(async()=>{order=row;showOrder();await check();});details.append(button);}layout.append(details);
  }
 }
 function review(){
  const [from,to]=quote.direction==='sol-xmr'?['SOL','XMR']:['XMR','SOL'];
  message.textContent='Review your exchange. Creating an order does not send funds.';
  layout.render('<dl class="native-send-costs"><div><dt>You send</dt><dd data-from></dd></div><div><dt>Estimated receive</dt><dd data-to></dd></div></dl><label>Receive at</label><div class="native-send-address" data-destination></div><label>Refund address</label><div class="native-send-address" data-refund></div><p class="native-send-help">Floating rate: the final amount can change. The estimate includes provider fees; your deposit network fee is additional. ChangeNOW may require identity checks. XMR must be unlocked before it can pay wallet fees.</p><div class="native-send-actions"><button class="native-secondary" data-edit>Back</button><button class="native-primary" data-create>Create exchange</button></div>');
  text('[data-from]',quote.amount+' '+from);text('[data-to]','≈ '+quote.receive+' '+to);text('[data-destination]',quote.destination);text('[data-refund]',quote.refund);
  content.querySelector('[data-edit]').onclick=form;
  content.querySelector('[data-create]').onclick=()=>run(async()=>{
   if(now()>=quote.expires)throw Error('Estimate expired. Go Back for a new estimate.');
   // Persist the exact request before creating the order, including on timeouts.
   const pending={requestId:quote.id,direction:quote.direction,amount:quote.amount,authorization:quote.authorization,created:now(),status:'creating'};
   await saveOrder(pending);current();message.textContent='Creating your exchange…';
   order=await api('create',{authorization:quote.authorization});await saveOrder(order);current();showOrder();
  });
 }
 function showOrder(){
  if(!order.id){
   message.textContent='Checking your saved exchange request.';
   layout.render('<p class="native-send-help">Order creation was interrupted. Recover this exact request before creating another exchange. Do not send funds until a deposit address is shown.</p><div class="native-send-actions"><button class="native-primary" data-recover>Recover exchange</button></div>');
   content.querySelector('button').onclick=()=>run(async()=>{order=await api('create',{authorization:order.authorization});await saveOrder(order);showOrder();});return;
  }
  const symbol=order.direction==='sol-xmr'?'SOL':'XMR';
  message.textContent=labels[order.status]||labels.unknown;
  layout.render('<p class="native-send-review-amount"></p><label>ChangeNOW deposit address</label><div class="native-send-address"></div><p class="native-send-help" data-id></p><p class="native-send-help">Send this amount once, using the correct network. Keep this saved exchange until the payout or refund completes. Check wallet Activity before attempting another payment.</p><a class="native-send-explorer" target="_blank" rel="noopener noreferrer">View exchange on ChangeNOW ↗</a><div class="native-send-actions"><button class="native-secondary" data-check>Check status</button><button class="native-primary" data-pay>Review payment</button></div>');
  text('.native-send-review-amount',order.amount+' '+symbol);text('.native-send-address',order.payin);text('[data-id]','Exchange ID: '+order.id);
  content.querySelector('a').href='https://changenow.io/exchange/txs/'+encodeURIComponent(order.id);
  const pay=content.querySelector('[data-pay]');pay.hidden=!['waiting','new'].includes(order.status)||order.paymentOpened===true;
  pay.onclick=()=>run(async()=>{order={...order,paymentOpened:true};await saveOrder(order);current();onPay(order);});
  content.querySelector('[data-check]').onclick=()=>run(check);
 }
 async function check(){if(!order.id)return;const result=await api('status',{receipt:order.receipt});order={...order,...result};await saveOrder(order);current();showOrder();}
 // open(requestId) resumes one saved exchange, e.g. after a website payment.
 return {open(requestId){form();const row=requestId&&loadOrders().find(r=>r.requestId===requestId);if(row){order=row;showOrder();void run(check);}},close(){closed=true;layout.close();}};
}
