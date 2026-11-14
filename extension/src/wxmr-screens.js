// wXMR in the extension popup: Monero wrapped on Solana by wxmr.io, held at this account's Solana address.
//   - readWxmrBalance: the public wXMR balance (the account's associated token account), read from the Solana node chosen in
//     Settings, each node checked to be mainnet first;
//   - openWxmr: the wXMR screen with Send and Swap;
//   - openSwap: SOL ↔ wXMR through Jupiter, with the quote and transaction checks of the website wallet (sol-wxmr-swap.js):
//     the quote must be exactly the pair, amount, mode and slippage asked for, and the transaction must be paid by this account
//     and call only the programs a Jupiter SOL swap uses. Signed here with the account's Solana key; sent through the chosen node.
// Nothing here runs without the person pressing a button; every send and swap is reviewed first.
import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {quoteSwap,buildSolToWxmrSwap,parseSol,parseWxmr,solText,wxmrText,maxSwapLamports,SLIPPAGE_BPS,WXMR_SOL_FEE_LAMPORTS,WXMR_MINT} from '../../engine/shared/website/sol-wxmr-swap.js';
import {solanaReadEndpoints,solanaRpcBody,SOLANA_GENESIS} from '../../engine/shared/solana-rpc.js';
import {solanaConnection,signSolSend,sendSolSigned,importSol} from '../../engine/shared/core.js';
import {prepareSolanaTokenSend} from './sol-token-send.js';
import {maxControl} from '../../engine/token/max-amount.js';

export {WXMR_MINT};
export const WXMR_DECIMALS=12;
const QUOTE_MS=20000;
const need=(ok,message)=>{if(!ok)throw Error(message);};

// Public wXMR balance (raw, 12 decimals) of a Solana address; '0' when it has no wXMR account.
const mainnet=new Map();// node -> time its network was checked
export async function readWxmrBalance(owner,{fetcher=globalThis.fetch,signal,endpoints=solanaReadEndpoints,now=Date.now}={}){
 const holder=new PublicKey(owner),account=getAssociatedTokenAddressSync(new PublicKey(WXMR_MINT),holder,false,TOKEN_PROGRAM_ID).toBase58();
 const list=typeof endpoints==='function'?endpoints():endpoints;let last=Error('No Solana node configured.');
 for(const url of list){
  try{
   const call=async(method,params)=>{const id=crypto.randomUUID(),rpc={jsonrpc:'2.0',id,method,params};
    const r=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(solanaRpcBody(url,rpc)),credentials:'omit',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
    need(r.ok,'wXMR balance unavailable.');const v=await r.json();need(v?.id===id&&!v.error&&Object.hasOwn(v,'result'),'wXMR balance unavailable.');return v.result;};
   if(!(now()-(mainnet.get(url)??-Infinity)<600000)){need(await call('getGenesisHash',[])===SOLANA_GENESIS,'Wrong Solana network.');mainnet.set(url,now());}
   const reply=await call('getMultipleAccounts',[[account],{encoding:'base64',commitment:'confirmed'}]);
   need(Array.isArray(reply?.value)&&reply.value.length===1,'wXMR balance unavailable.');const v=reply.value[0];if(v===null)return '0';
   need(v.owner===TOKEN_PROGRAM_ID.toBase58()&&Array.isArray(v.data)&&v.data[1]==='base64','Unexpected wXMR account.');
   const data=Buffer.from(v.data[0],'base64');
   need(data.length===165&&new PublicKey(data.subarray(0,32)).toBase58()===WXMR_MINT&&new PublicKey(data.subarray(32,64)).equals(holder),'Unexpected wXMR account.');
   return data.readBigUInt64LE(64).toString();
  }catch(error){if(signal?.aborted)throw error;last=error;}
 }
 throw last;
}

// Waits for a Solana signature to be confirmed (polling, no websocket), for at most about a minute.
async function confirmed(signature,{tries=30,ms=2000}={}){
 for(let i=0;i<tries;i++){
  const s=(await solanaConnection().getSignatureStatuses([signature],{searchTransactionHistory:true}).catch(()=>null))?.value?.[0];
  if(s?.err)throw Error('Solana rejected the transaction. Your balance did not change.');
  if(s&&['confirmed','finalized'].includes(s.confirmationStatus))return true;
  await new Promise(r=>setTimeout(r,ms));
 }
 return false;
}
const explorer=signature=>`https://solscan.io/tx/${signature}`;

// host: {show,on,run,esc,toast,account,$,same,record,persist,refresh,solRaw,wxmrRaw,usdOf,back}
// solRaw()/wxmrRaw(): the balances the home screen shows (strings or null); usdOf(raw): a dollar text for wXMR or ''.
export function openWxmr(host){
 const {show,on,esc}=host,a=host.account();if(!a?.sol)return;
 const raw=host.wxmrRaw(),usd=raw==null?'':host.usdOf(raw);
 show('Wrapped Monero',`<div class="pf-hero"><span class="coin-wrap big"><span class="coin xmr">M</span></span><div class="pf-total" title="${esc(raw==null?'':wxmrText(raw,12))} wXMR">${esc(raw==null?'—':wxmrText(raw,6))}<span> wXMR</span></div>${usd?`<p class="pf-usd">${esc(usd)}</p>`:''}</div>
  <div class="pf-actions two"><button class="pf-act" id="wxmr-send">${host.icon('send')}<span>Send</span></button><button class="pf-act" id="wxmr-swap">${host.icon('repeat')}<span>Swap to SOL</span></button></div>
  <p class="subtle">wXMR is Monero wrapped on Solana by wxmr.io, worth one XMR each. It sits at this account's Solana address.</p>
  <details class="pf-more"><summary>Details</summary><label>Token mint</label><div class="address pf-addr small">${esc(WXMR_MINT)}</div></details>`);
 on('wxmr-send',()=>sendForm(host));on('wxmr-swap',()=>openSwap(host,'wxmr-sol'));
}

function sendForm(host,draft={}){
 const {show,on,run,esc,$}=host,a=host.account();if(!a?.sol)return;
 if(!a.solSecret){show('Watch-only account','<p class="notice">Import the Solana key of this account to send.</p>');return;}
 const balance=host.wxmrRaw();
 show('Send wXMR',`<label for="wx-to">Recipient's Solana address</label><input id="wx-to" autocomplete="off" spellcheck="false" placeholder="Paste the recipient's public address" value="${esc(draft.to||'')}">
  ${maxControl('wx-amount','Amount (wXMR)')}<input id="wx-amount" class="amount-input" inputmode="decimal" placeholder="0" autocomplete="off" value="${esc(draft.amount||'')}">
  <p class="field-hint" id="wx-avail">Available: ${esc(balance==null?'—':wxmrText(balance,12))} wXMR</p>
  <p class="subtle">The network fee is paid in SOL from this account. A recipient without a wXMR account gets one, paid by you (about 0.002 SOL).</p>
  <p id="progress" class="busy" role="status"></p><p id="error" class="error" role="alert"></p>
  <button class="primary wide" id="wx-review">Review</button><button class="secondary wide" id="wx-cancel" data-keep>Back</button>`);
 let maxExact=null;const input=$('#wx-amount');input.oninput=()=>{maxExact=null;};
 on('wx-cancel',()=>openWxmr(host));
 on('wx-amount-max',()=>{const b=host.wxmrRaw();if(b==null)return;maxExact=b;input.value=wxmrText(b,12);});
 on('wx-review',()=>void run(async e=>{
  const to=$('#wx-to').value.trim(),raw=maxExact!=null?BigInt(maxExact):parseWxmr(input.value);
  try{new PublicKey(to);}catch{throw Error('Enter a Solana address.');}
  need(raw!==null&&raw>0n,'Enter an amount of wXMR (at most 12 decimals).');
  const b=host.wxmrRaw();need(b==null||raw<=BigInt(b),'More than this account holds.');
  $('#progress').textContent='Checking the network fee…';
  const prepared=await prepareSolanaTokenSend({row:{mint:WXMR_MINT,decimals:WXMR_DECIMALS},owner:a.sol,to,amount:wxmrText(raw,12)});host.same(e);
  need(BigInt(prepared.netRaw)===raw,'The amount changed during the check. Nothing was sent.');
  review(host,{to,raw,prepared});}));
}

function review(host,{to,raw,prepared}){
 const {show,on,run,esc,$}=host,a=host.account();
 show('Review send',`<p class="review-line"><span>Send</span><strong>${esc(wxmrText(raw,12))} wXMR</strong></p><p class="review-line"><span>To</span><strong>${esc(to.slice(0,6)+'…'+to.slice(-6))}</strong></p>
  <p class="review-line"><span>Network fee</span><strong>${esc(solText(prepared.feeRaw))} SOL</strong></p>${BigInt(prepared.rentRaw)>0n?`<p class="review-line"><span>Recipient's wXMR account</span><strong>${esc(solText(prepared.rentRaw))} SOL</strong></p>`:''}
  <p id="progress" class="busy" role="status"></p><p id="error" class="error" role="alert"></p>
  <button class="primary wide" id="wx-approve">Approve and send</button><button class="secondary wide" id="wx-back" data-keep>Back</button>`);
 on('wx-back',()=>sendForm(host,{to,amount:wxmrText(raw,12)}));
 on('wx-approve',()=>void run(async e=>{
  if(Date.now()>=prepared.expires)throw Error('The review expired. Go back and review again; nothing was sent.');
  const signed=signSolSend(prepared,a.solSecret);
  const receipt=await host.record({chain:'solana',hash:signed.hash,to,amount:wxmrText(raw,12),symbol:'wXMR',status:'Submitting · check receipt'});host.same(e);
  $('#progress').textContent='Sending…';
  try{await sendSolSigned(signed.bytes);receipt.status='Submitted · awaiting confirmation';}
  catch(error){receipt.status='Submission uncertain · check receipt';await host.persist();throw error;}
  await host.persist();$('#progress').textContent='Waiting for Solana to confirm…';
  const ok=await confirmed(signed.hash);if(ok){receipt.status='Confirmed';await host.persist();}
  done(host,ok?'wXMR sent':'wXMR send submitted',signed.hash,ok);}));
}

function done(host,title,signature,ok){
 const {show,on,esc}=host;
 show(title,`<p class="subtle">${ok?'Confirmed on Solana.':'Sent. Solana has not confirmed it yet; check the receipt before trying again.'}</p><a class="pf-link" href="${esc(explorer(signature))}" target="_blank" rel="noopener noreferrer">View on Solscan ↗</a><button class="primary wide" id="wx-done">Done</button>`);
 on('wx-done',()=>{host.close?.();host.refresh();});
}

// SOL ↔ wXMR. direction: 'sol-wxmr' or 'wxmr-sol'.
export function openSwap(host,direction='sol-wxmr'){
 const {show,on,run,esc,$}=host,a=host.account();
 if(!a?.sol){host.toast('Add a Solana account to swap.');return;}
 if(!a.solSecret){show('Watch-only account','<p class="notice">Import the Solana key of this account to swap.</p>');return;}
 const toWxmr=direction==='sol-wxmr',from=toWxmr?'SOL':'wXMR',to=toWxmr?'wXMR':'SOL',text=toWxmr?solText:r=>wxmrText(r,12),parse=toWxmr?parseSol:parseWxmr,out=toWxmr?r=>wxmrText(r,6):solText;
 const balance=()=>toWxmr?host.solRaw():host.wxmrRaw(),max=()=>{const b=balance();return b==null?0n:toWxmr?maxSwapLamports(b):BigInt(b);};
 show(`Swap ${from} → ${to}`,`${maxControl('sw-amount',`You send (${from})`)}<input id="sw-amount" class="amount-input" inputmode="decimal" placeholder="0" autocomplete="off">
  <p class="field-hint" id="sw-avail">Available: ${esc(balance()==null?'—':text(balance()))} ${from}</p>
  <button class="secondary wide" id="sw-flip" data-keep>Swap the other way: ${to} → ${from}</button>
  <p class="review-line"><span>You receive</span><strong id="sw-out">0 ${to}</strong></p><p class="subtle" id="sw-terms">Priced by Jupiter · ${SLIPPAGE_BPS/100}% slippage</p>
  <p class="subtle">${toWxmr?'Max keeps 0.005 SOL for the network fee and, the first time, this account\'s wXMR account (about 0.002 SOL). wXMR is Monero wrapped on Solana by wxmr.io.':'The network fee is paid in SOL from this account.'}</p>
  <p id="progress" class="busy" role="status"></p><p id="error" class="error" role="alert"></p>
  <button class="primary wide" id="sw-go" disabled data-disabled="true">Swap</button><button class="secondary wide" id="sw-cancel" data-keep>Back</button>`);
 let quote=null,maxExact=null,ask=0,timer=null;const input=$('#sw-amount'),go=$('#sw-go'),err=$('#error');
 const set=(q,message='')=>{quote=q;go.disabled=!q;go.dataset.disabled=String(!q);$('#sw-out').textContent=q?'≈ '+out(q.outAmount)+' '+to:'0 '+to;
  const route=q?.routePlan?.map(r=>r.swapInfo?.label).filter(Boolean).join(' + '),impact=q?Number(q.priceImpactPct||0)*100:0;
  $('#sw-terms').textContent=q?`At least ${out(q.otherAmountThreshold)} ${to} (${SLIPPAGE_BPS/100}% slippage) · via ${route||'Jupiter'}${impact>=0.01?` · impact ${impact.toFixed(2)}%`:''}`:`Priced by Jupiter · ${SLIPPAGE_BPS/100}% slippage`;
  if(err)err.textContent=message;};
 const price=()=>{clearTimeout(timer);const n=++ask;set(null);const raw=maxExact??parse(input.value);if(raw===null||raw<=0n)return;
  const b=balance();if(b!=null&&raw>BigInt(b)){set(null,'More than this account holds.');return;}
  if(!toWxmr&&host.solRaw()!=null&&BigInt(host.solRaw())<WXMR_SOL_FEE_LAMPORTS){set(null,'Add a little SOL first: the swap needs about '+solText(WXMR_SOL_FEE_LAMPORTS)+' SOL for network fees.');return;}
  $('#progress').textContent='Getting a price from Jupiter…';
  timer=setTimeout(()=>{quoteSwap(raw,direction).then(q=>{if(n===ask&&input.isConnected)set({...q,at:Date.now()});}).catch(e=>{if(n===ask&&input.isConnected)set(null,e.message);})
   .finally(()=>{if(n===ask&&$('#progress'))$('#progress').textContent='';});},500);};
 input.oninput=()=>{maxExact=null;price();};
 on('sw-amount-max',()=>{const m=max();if(m<=0n)return;maxExact=m;input.value=text(m);price();});
 on('sw-flip',()=>openSwap(host,toWxmr?'wxmr-sol':'sol-wxmr'));
 on('sw-cancel',()=>host.back?host.back():host.close?.());
 on('sw-go',()=>void run(async e=>{
  need(quote,'Wait for the price.');let q=quote;
  if(Date.now()-q.at>QUOTE_MS){$('#progress').textContent='Refreshing the quote…';q={...await quoteSwap(BigInt(q.inAmount),direction),at:Date.now()};host.same(e);}
  $('#progress').textContent='Preparing the swap…';
  const {tx}=await buildSolToWxmrSwap(q,a.sol);host.same(e);
  const key=importSol(a.solSecret);try{tx.sign([key]);}finally{key.secretKey.fill(0);}
  need(tx.signatures[0]?.length===64&&tx.signatures[0].some(b=>b!==0),'The swap could not be signed.');const signature=bs58.encode(tx.signatures[0]);
  const receipt=await host.record({chain:'solana',hash:signature,to:'Jupiter swap',amount:text(BigInt(q.inAmount)),symbol:from+' → '+to,status:'Submitting · check receipt'});host.same(e);
  $('#progress').textContent='Sending the swap…';
  try{await solanaConnection().sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:2,preflightCommitment:'confirmed'});receipt.status='Submitted · awaiting confirmation';}
  catch(error){receipt.status='Submission uncertain · check receipt';await host.persist();throw Error((error?.message||'The swap was not sent.').slice(0,300));}
  await host.persist();$('#progress').textContent='Waiting for Solana to confirm…';
  const ok=await confirmed(signature);if(ok){receipt.status='Confirmed';await host.persist();}
  const {show:s,on:o}=host;
  s(ok?'Swap confirmed':'Swap sent',`<p class="review-line"><span>You receive</span><strong>about ${esc(out(q.outAmount))} ${to}</strong></p><p class="review-line"><span>At least</span><strong>${esc(out(q.otherAmountThreshold))} ${to}</strong></p>
   <p class="subtle">${ok?'Confirmed on Solana.':'Sent. Solana has not confirmed it yet; check the receipt before swapping again.'}</p><a class="pf-link" href="${esc(explorer(signature))}" target="_blank" rel="noopener noreferrer">View swap on Solscan ↗</a><button class="primary wide" id="sw-done">Done</button>`);
  o('sw-done',()=>{host.close?.();host.refresh();});}));
}
