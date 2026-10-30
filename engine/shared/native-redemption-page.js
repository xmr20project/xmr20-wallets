import {showNativeFundingSetup} from './native-funding-setup.js';
import {checkNativeRedemption} from './native-action-approval.js';
import {createJointCreditPreview} from './joint-credit-preview.js';
import {createNativePageLayout} from './native-page-layout.js';
import {PublicKey} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {NATIVE_MARKET_CONFIGURATION} from './website/native-market-config.js';
import {createNativeSendClient} from './native-market/wallet/native-send-client.mjs';
import {createOperatorRedemptionClient} from './native-market/wallet/operator-redemption-client.mjs';
import {OPERATOR_DISCLOSURE} from './native-market/operator-policy.mjs';
import {nativeBridgePanels,bindNativeBridgePanels,setPanelAvailable,setPanelReceive,setPanelFee,setPanelImage} from './native-bridge-panels.js';

const units=text=>{if(!/^(0|[1-9][0-9]*)(\.[0-9]{0,6})?$/.test(text))throw Error('Enter an amount with up to 6 decimal places.');const [whole,fraction='']=text.split('.'),n=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));if(n<=0n)throw Error('Enter an amount greater than zero.');return n;};
const exact=(raw,decimals=6)=>{const n=BigInt(raw),scale=10n**BigInt(decimals),f=(n%scale).toString().padStart(decimals,'0').replace(/0+$/,'');return String(n/scale)+(f?'.'+f:'');};
const compact=raw=>{const n=BigInt(raw);for(const [scale,label]of [[1000000000000000n,'B'],[1000000000000n,'M'],[1000000000n,'K']])if(n>=scale){const v=(n*100n+scale/2n)/scale;return String(v/100n)+'.'+String(v%100n).padStart(2,'0')+label;}return Number(exact(n)).toLocaleString('en-US',{maximumFractionDigits:2});};

export function createNativeRedemptionPage({client,account,assertCurrent,token={symbol:'XMR20'},api=createNativeSendClient({assertCurrent,operation:'burn'}),bridge=createOperatorRedemptionClient({configuration:NATIVE_MARKET_CONFIGURATION,assertCurrent}),container=document.body,onReopen=()=>location.reload(),onClose=()=>window.close(),onSwitch}){
 const symbol=String(token.symbol||'XMR20').replace(/^\$/,'');
 container.classList.add('native-send-window');
 const root=document.createElement('main');root.id='native-send';
 root.innerHTML='<div class="native-send-head"><h1>Bridge to Solana</h1><button type="button" data-close aria-label="Close bridge">×</button></div><div class="native-token-mark" aria-hidden="true">M</div><p class="native-send-message" role="status" aria-live="polite"></p><div class="native-send-content"></div><p class="native-send-error" role="alert" hidden></p>';
 container.replaceChildren(root);root.querySelector('[data-close]').onclick=onClose;
 const content=root.querySelector('.native-send-content'),message=root.querySelector('.native-send-message'),error=root.querySelector('.native-send-error');
 const layout=createNativePageLayout(root,client);
 let closed=false,busy=false,timer,inventory=[],receipts=[],review,quote,assembled,signAttempted=false,retryKnown=true,quotePreview,draftQuantity='',draftDestination='',tokenImage;
 const current=()=>{if(closed)throw Error('Bridge window closed.');assertCurrent();};
 const text=(selector,value)=>{content.querySelector(selector).textContent=value;};
 async function run(fn){
  if(busy||closed)return;busy=true;error.hidden=true;layout.setBusy(true);
  try{current();await fn();current();}catch(e){
   if(!closed){if(!signAttempted&&showNativeFundingSetup({error:e,account,layout,content,message,retry:()=>void run(form)})){error.hidden=true;return;}error.textContent=e.message||'The bridge is unavailable. Your saved approval is kept.';error.hidden=false;
    if(signAttempted&&!assembled){message.textContent='Your signing attempt is saved. Reopen the bridge to recover it before trying again.';layout.render('<button type="button" class="native-secondary">Reopen saved bridge</button>');content.querySelector('button').onclick=onReopen;}
   }
  }finally{busy=false;layout.setBusy(false);}
 }
 async function synchronize(){
  await client.unlock();current();
  let result;message.textContent='Syncing Monero history…';
  do{result=await client.sync();current();if(!result.ready)message.textContent='Syncing Monero history · block '+result.height+' of '+result.targetHeight;}while(!result.ready);
 }
 function saved(){
  if(!receipts.length)return;
  const list=document.createElement('details');list.className='native-send-recovery';const label=document.createElement('summary');label.textContent='Saved bridges';list.append(label);
  for(const row of receipts){
   const button=document.createElement('button');button.type='button';button.className='native-secondary';button.textContent=compact(row.quantity)+' '+symbol+' · '+new PublicKey(Buffer.from(row.recipient,'hex')).toBase58().slice(0,8)+'…';
   button.onclick=()=>run(async()=>{if(!row.txid)await synchronize();assembled=await client.recoverRedemption({reservationId:row.reservationId,operationId:row.operationId,signatureHash:row.signatureHash});quote=assembled.bridgeQuote;if(!quote)throw Error('This receipt belongs to an earlier bridge protocol. Keep it for recovery.');progress();await check();startChecks();});list.append(button);
  }layout.append(list);
 }
 async function form(){
  // Panels first: the direction switch stays usable while Monero history syncs.
  layout.render(nativeBridgePanels({symbol,image:tokenImage,source:'Monero',destination:'Solana',destinationNote:'Minimum',value:draftQuantity,canSwitch:typeof onSwitch==='function'})+'<label class="native-send-label" for="bridge-destination">Solana destination address</label><textarea id="bridge-destination" rows="1" placeholder="Solana destination address" autocomplete="off" spellcheck="false"></textarea><p class="native-action-terms">Fee up to 0.0001 XMR, plus 0.000001 XMR sent with the bridge record.</p><details class="native-send-disclosure"><summary>Bridge details</summary><p class="native-send-help">After 10 Monero confirmations, XMR20’s bridge service sends the tokens to your Solana address.</p><p data-risk></p></details><div class="native-send-actions"><button class="native-primary" data-next data-disabled="true" type="button">Bridge</button></div>');
  bindNativeBridgePanels(content,{onSwitch});
  await synchronize();inventory=await client.inventory();current();
  message.textContent='';
  const free=inventory.filter(row=>!row.held);
  setPanelAvailable(content,String(free.reduce((n,row)=>n+BigInt(row.quantity),0n)));text('[data-risk]',OPERATOR_DISCLOSURE.risk);
  let quantity=draftQuantity;const input=content.querySelector('input'),address=content.querySelector('textarea'),button=content.querySelector('[data-next]');
  // A swap returns to this wallet's own linked Solana address unless the holder edits it.
  const own=(()=>{try{return new PublicKey(account.solana).toBase58()===account.solana?account.solana:'';}catch{return '';}})();
  input.value=quantity?compact(units(quantity)):'';address.value=draftDestination||own;
  const terms=()=>{
   try{const amount=units(quantity),destination=address.value.trim(),key=new PublicKey(destination);
    if(key.toBase58()!==destination||key.equals(PublicKey.default)||!free.some(r=>BigInt(r.quantity)>=amount))return null;
    return {amount:String(amount),destination};
   }catch{return null;}
  };
  quotePreview?.close();quotePreview=createJointCreditPreview({isCurrent:()=>!closed&&input.isConnected,prepare:value=>bridge.quote(value),changed:state=>{
   const value=terms(),ready=quotePreview?.matches(value);const retry=state.status==='error';button.dataset.disabled=String(!ready&&!retry);button.disabled=busy||!ready&&!retry;button.textContent=retry?'Retry fee check':'Bridge';
   if(ready){const q=state.value,fee=BigInt(q.terms.maximumTokenFee),net=BigInt(q.terms.amount)-fee;setPanelReceive(content,net,'Minimum '+exact(net)+' '+symbol);setPanelFee(content,'Fee ≤ '+compact(fee),'Token fee (maximum) '+exact(fee)+' '+symbol);}
   else{setPanelReceive(content,undefined);setPanelFee(content);}
   message.textContent=state.status==='loading'?'Checking bridge fee…':state.status==='error'?state.error:'';
  }});
  const update=()=>{draftQuantity=quantity;draftDestination=address.value;error.hidden=true;quotePreview.request(terms());};
  input.oninput=()=>{quantity=input.value;update();};input.onfocus=()=>{input.value=quantity;};input.onblur=()=>{try{input.value=compact(units(quantity));}catch{}};
  address.oninput=update;
  content.querySelector('[data-max]').onclick=()=>{const n=free.reduce((n,row)=>BigInt(row.quantity)>n?BigInt(row.quantity):n,0n);quantity=n?exact(n):'';input.value=n?compact(n):'';update();};
  button.onclick=()=>run(async()=>{
   if(quotePreview.state.status==='error'){quotePreview.retry();return;}
   const value=terms();if(!value||!quotePreview.matches(value))throw Error('Wait for the current amount and fee before bridging.');
   quote=quotePreview.state.value;
   if(quote.terms.amount!==value.amount||quote.terms.destination!==value.destination)throw Error('The bridge quote changed. Check the amount again.');
   const source=free.find(row=>BigInt(row.quantity)>=BigInt(value.amount)),recipient=new PublicKey(value.destination).toBuffer().toString('hex');
   message.textContent='Preparing your bridge…';
   review=await client.constructRedemption({terms:{offerId:quote.redemption,source:source.source,recipient,quantity:value.amount,carrier:'1000000',maximumFee:'100000000',bridgeQuote:quote}});current();
   checkNativeRedemption(review,{amount:value.amount,recipient});
   signAttempted=true;message.textContent='Sending your bridge approval…';const signed=await client.signRedemption({reviewHandle:review.handle});current();
   assembled=await client.assembleRedemption({reviewHandle:review.handle,reservationId:signed.reservationId});current();quotePreview.close();progress();
   renderNative(await api.publish({transaction:assembled.transaction,retry:false}));startChecks();
  });saved();update();
 }
 function progress(){
  message.textContent='Publishing your saved Monero approval…';
  layout.render('<p class="native-send-review-amount"></p><p class="native-send-help">You can close this window. Your signed approval is saved and the bridge continues on the server.</p><dl class="native-send-costs"><div><dt>Monero confirmations</dt><dd data-confirmations>—</dd></div></dl><a class="native-send-explorer" data-monero target="_blank" rel="noopener noreferrer">View Monero transaction ↗</a><a class="native-send-explorer" data-solana target="_blank" rel="noopener noreferrer" hidden>View Solana transaction ↗</a><div class="native-send-actions"><button class="native-secondary" type="button" data-check>Check status</button><button class="native-primary" type="button" data-retry hidden>Retry saved approval</button></div>');
  text('.native-send-review-amount',compact(assembled.quantity)+' '+symbol);content.querySelector('[data-monero]').href='https://xmrchain.net/tx/'+assembled.txid;
  content.querySelector('[data-check]').onclick=()=>run(check);
  content.querySelector('[data-retry]').onclick=()=>run(async()=>{renderNative(await api.publish({transaction:assembled.transaction,retry:retryKnown}));startChecks();});
 }
 function renderNative(value){
  current();text('[data-confirmations]',value.confirmations===undefined?'—':Math.min(value.confirmations,value.requiredConfirmations)+' / '+value.requiredConfirmations);
  retryKnown=value.status!=='not-found';content.querySelector('[data-retry]').hidden=!['not-found','submission-unknown'].includes(value.status);
  message.textContent=value.confirmed?'Monero confirmed. Waiting for the Solana payout…':value.status==='rejected'?'The Monero transaction was mined, but the token redemption was not accepted. Keep your recovery receipt and refresh your token balance before another bridge.':value.status==='unavailable'?'Your saved approval is safe. Confirmation checks are temporarily unavailable.':value.status==='not-found'?'Your approval is saved. Publish the saved transaction to continue.':'Waiting for Monero confirmations…';
  if(value.status==='rejected')clearInterval(timer);
 }
 async function check(){
  const native=await api.status({txid:assembled.txid});renderNative(native);if(!native.confirmed)return;
  const result=await bridge.status(quote);current();
  message.textContent=result.status==='finalized'?'Bridge complete. Tokens arrived on Solana.':result.status==='fee-limit-exceeded'?'The token fee rose above your approval. Your bridge is saved and will wait for the approved fee.':result.status==='confirming'||result.status==='submitted'?'Confirming the Solana payout…':'Monero confirmed. The bridge service is preparing your payout.';
  if(result.signature){const link=content.querySelector('[data-solana]');link.href='https://solscan.io/tx/'+result.signature;link.hidden=false;}
  if(result.status==='finalized'){clearInterval(timer);const done=content.querySelector('[data-check]');done.textContent='Done';done.onclick=onClose;}
 }
 function startChecks(){clearInterval(timer);timer=setInterval(()=>{if(!closed&&!busy&&!document.hidden)void run(check);},5000);}
 return Object.freeze({
  async open(){await run(async()=>{await client.unlock();receipts=await client.nativeRedemptionReceipts();await form();});},
  setTokenImage(image){if(closed||typeof image!=='string'||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)||image.length>700000)return;tokenImage=image;setPanelImage(content,image);const mark=root.querySelector('.native-token-mark'),img=document.createElement('img');img.src=image;img.alt='';img.addEventListener('error',()=>{mark.textContent='M';},{once:true});mark.replaceChildren(img);},
  close(){closed=true;quotePreview?.close();clearInterval(timer);layout.close();}
 });
}
