import {showNativeFundingSetup} from './native-funding-setup.js';
import {checkNativeSend} from './native-action-approval.js';
import {createNativePageLayout} from './native-page-layout.js';
import {createNativeSendClient} from './native-market/wallet/native-send-client.mjs';

const units=text=>{if(!/^(0|[1-9][0-9]*)(\.[0-9]{0,6})?$/.test(text))throw Error('Enter an amount with up to 6 decimal places.');const [n,f='']=text.split('.');const raw=BigInt(n)*1000000n+BigInt(f.padEnd(6,'0'));if(raw<=0n)throw Error('Enter an amount greater than zero.');return raw;};
const exact=(raw,decimals=6)=>{const n=BigInt(raw),scale=10n**BigInt(decimals),fraction=(n%scale).toString().padStart(decimals,'0').replace(/0+$/,'');return (n/scale).toString()+(fraction?'.'+fraction:'');};
const compact=raw=>{const n=BigInt(raw);for(const [scale,label]of [[1000000000000000n,'B'],[1000000000000n,'M'],[1000000000n,'K']])if(n>=scale){const hundredths=(n*100n+scale/2n)/scale;return String(hundredths/100n)+'.'+String(hundredths%100n).padStart(2,'0')+label;}return Number(exact(n)).toLocaleString('en-US',{maximumFractionDigits:2});};
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');

// Packaged extension page, never website-controlled HTML. The private worker
// selects inputs, derives outputs and owns the exact approval/recovery record.
export function createNativeSendPage({client,account,assertCurrent,token={symbol:'XMR20'},api=createNativeSendClient({assertCurrent}),container=document.body,onReopen=()=>location.reload(),onClose=()=>window.close()}){
 const symbol=String(token.symbol||'XMR20').replace(/^\$/,'');
 container.classList.add('native-send-window');
 const root=document.createElement('main');root.id='native-send';root.innerHTML=`<div class="native-send-head"><h1></h1><button type="button" data-close aria-label="Close send">×</button></div><div class="native-token-mark" aria-hidden="true">M</div><p class="native-send-network">On Monero</p><p class="native-send-message" role="status" aria-live="polite"></p><div class="native-send-content"></div><p class="native-send-error" role="alert" hidden></p>`;
 container.replaceChildren(root);root.querySelector('h1').textContent='Send $'+symbol;
 root.querySelector('[data-close]').onclick=onClose;
 const message=root.querySelector('.native-send-message'),content=root.querySelector('.native-send-content'),error=root.querySelector('.native-send-error');
 const layout=createNativePageLayout(root,client);
 let closed=false,busy=false,inventory=[],receipts=[],review=null,signed=null,assembled=null,quantity='',recipient='',timer,signAttempted=false,retryKnown=true,complete=false;
 const current=()=>{if(closed)throw Error('Send window closed.');assertCurrent();};
 const text=(selector,value)=>{content.querySelector(selector).textContent=value;};
 function report(e){if(!closed){if(!signAttempted&&showNativeFundingSetup({error:e,account,layout,content,message,retry:()=>void run(sync)})){error.hidden=true;return;}error.textContent=e.message||'This send could not continue. Your saved approvals are kept.';error.hidden=false;if(signAttempted&&!assembled){message.textContent='Your signing attempt is saved. Reopen this send to check recovery before trying another send.';layout.render('<button class="native-secondary" type="button" data-reopen>Reopen saved sends</button>');content.querySelector('button').onclick=onReopen;}}}
 async function run(fn){if(busy||closed)return;busy=true;error.hidden=true;layout.setBusy(true);try{current();await fn();current();}catch(e){report(e);}finally{busy=false;layout.setBusy(false);}}
 const sum=()=>inventory.filter(r=>!r.held).reduce((n,r)=>n+BigInt(r.quantity),0n);
 function recoveryList(){
  if(!receipts.length)return;const details=document.createElement('details');details.className='native-send-recovery';const summary=document.createElement('summary');summary.textContent='Saved sends';details.append(summary);
  for(const row of receipts){const button=document.createElement('button');button.type='button';button.className='native-secondary';button.textContent=compact(row.quantity)+' '+symbol+' · '+row.recipientAddress.slice(0,6)+'…'+row.recipientAddress.slice(-6);button.onclick=()=>run(async()=>{
    signed=row;
    if(!row.txid)await synchronize();
    assembled=await client.recoverPeerSend({reservationId:row.reservationId,operationId:row.operationId,signatureHash:row.signatureHash});showProgress();await check();startChecks();
   });details.append(button);}layout.append(details);
 }
 function form(){
  review=null;message.textContent='';
  layout.render(`<label class="native-sr-only" for="native-recipient">Recipient’s Monero address</label><textarea id="native-recipient" rows="2" placeholder="Recipient’s Monero address" autocomplete="off" spellcheck="false"></textarea><div class="native-send-amount"><label class="native-sr-only" for="native-amount">Token amount</label><input id="native-amount" inputmode="decimal" placeholder="0" autocomplete="off"><span></span><button type="button" data-max>Max</button></div><p class="native-send-available"></p><p class="native-action-terms"><strong data-exact hidden></strong><span>Fee up to 0.0001 XMR, plus 0.000001 XMR sent with the tokens.</span></p><div class="native-send-actions"><button class="native-primary" data-review type="button">Send</button></div>`);
  const address=content.querySelector('textarea'),amount=content.querySelector('input');address.value=recipient;amount.value=quantity?compact(units(quantity)):'';text('.native-send-amount span',symbol);text('.native-send-available','Available '+compact(sum())+' '+symbol);
  const exactSummary=()=>{const node=content.querySelector('[data-exact]');try{node.textContent=exact(units(quantity))+' '+symbol;node.hidden=false;}catch{node.hidden=true;}};exactSummary();
  address.oninput=()=>recipient=address.value.trim();amount.onfocus=()=>{amount.value=quantity;};amount.oninput=()=>{quantity=amount.value;exactSummary();};amount.onblur=()=>{try{amount.value=compact(units(quantity));}catch{}};
  content.querySelector('[data-max]').onclick=()=>{const max=inventory.filter(r=>!r.held).reduce((n,r)=>BigInt(r.quantity)>n?BigInt(r.quantity):n,0n);quantity=max?exact(max):'';amount.value=max?compact(max):'';exactSummary();};
  
  content.querySelector('[data-review]').onclick=()=>run(async()=>{
   const raw=units(quantity),source=inventory.find(row=>!row.held&&BigInt(row.quantity)>=raw);if(!source)throw Error(raw>sum()?'Amount exceeds your available token balance.':'This send needs tokens combined from multiple outputs. That is not supported in this candidate yet.');
   if(!/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{95}$/.test(recipient))throw Error('Enter a Monero recipient address.');
   message.textContent='Preparing your Monero send…';review=await client.constructPeerSend({terms:{offerId:random(),source:source.source,recipientAddress:recipient,quantity:raw.toString(),carrier:'1000000',maximumFee:'100000000'}});current();checkNativeSend(review,{amount:raw.toString(),recipient});await submit();
  });recoveryList();
 }
 async function submit(){
  current();message.textContent='Sending on Monero…';signAttempted=true;
  signed=await client.signPeerSend({reviewHandle:review.handle});current();
  assembled=await client.assemblePeerSend({reviewHandle:review.handle,reservationId:signed.reservationId});current();showProgress();
  const result=await api.publish({transaction:assembled.transaction,retry:false});renderStatus(result);startChecks();
 }
 function renderStatus(value){
  current();complete=value.confirmed;message.textContent=({accepted:'Sent to the Monero network.',mempool:'Waiting for a Monero block…',confirming:'Confirming on Monero…',confirmed:'Tokens sent.',rejected:'The Monero transaction was mined, but the token transfer was not accepted. Keep your recovery receipt and refresh your token balance before another send.',unavailable:'Your signed send is saved. Checking is temporarily unavailable.','submission-unknown':'Your signed send is saved. Check its status before retrying.','not-found':'This signed send is saved in your wallet. Send the saved transaction to continue.'})[value.status];
  const counter=content.querySelector('[data-confirmations]');if(counter)counter.textContent=value.confirmations===undefined?'—':Math.min(value.confirmations,value.requiredConfirmations)+' / '+value.requiredConfirmations;
  const retry=content.querySelector('[data-retry]');retryKnown=value.status!=='not-found';if(retry){retry.hidden=!['submission-unknown','not-found'].includes(value.status);retry.textContent=retryKnown?'Retry saved send':'Send saved transaction';}
  if(value.status==='rejected')clearInterval(timer);
  if(value.confirmed){clearInterval(timer);content.querySelector('[data-check]').textContent='Done';content.querySelector('[data-check]').onclick=onClose;}
 }
 function showProgress(){
  message.textContent='Publishing your saved Monero send…';
  layout.render(`<p class="native-send-review-amount"></p><p class="native-send-help">You can close this window. Your signed transaction is saved; reopening does not create another transfer.</p><dl class="native-send-costs"><div><dt>Monero confirmations</dt><dd data-confirmations>—</dd></div></dl><a class="native-send-explorer" target="_blank" rel="noopener noreferrer">View transaction ↗</a><div class="native-send-actions"><button class="native-secondary" type="button" data-check>Check status</button><button class="native-primary" type="button" data-retry hidden>Retry saved send</button></div>`);
  text('.native-send-review-amount',compact(assembled.quantity)+' '+symbol);content.querySelector('a').href='https://xmrchain.net/tx/'+assembled.txid;
  content.querySelector('[data-check]').onclick=()=>run(check);
  content.querySelector('[data-retry]').onclick=()=>run(async()=>{renderStatus(await api.publish({transaction:assembled.transaction,retry:retryKnown}));startChecks();});
 }
 async function check(){const result=await api.status({txid:assembled.txid});current();renderStatus(result);}
 function startChecks(){clearInterval(timer);if(!complete)timer=setInterval(()=>{if(!document.hidden&&!busy&&!closed)void run(check);},5000);}
 async function synchronize(){
  await client.unlock();current();
  message.textContent='Syncing Monero history…';let synced;
  do{synced=await client.sync();current();if(!synced.ready)message.textContent='Syncing Monero history · block '+synced.height+' of '+synced.targetHeight;}while(!synced.ready&&!closed);
 }
 async function sync(){await synchronize();inventory=await client.inventory();current();form();}
 return Object.freeze({
  setTokenImage(image){
   if(closed||typeof image!=='string'||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)||image.length>700000)return;
   const mark=root.querySelector('.native-token-mark'),img=document.createElement('img');img.src=image;img.alt='';img.width=72;img.height=72;
   img.addEventListener('error',()=>{mark.textContent='M';},{once:true});mark.replaceChildren(img);
  },
  async open(){await run(async()=>{
   message.textContent='Opening your Monero wallet…';await client.unlock();receipts=await client.nativeSendReceipts();
   await sync();
  });},close(){closed=true;clearInterval(timer);layout.close();}
 });
}
