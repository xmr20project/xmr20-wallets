// Private transfers screens of the XMR20 wallet popup, built into the extension's private-balance.js (see ../build.mjs).
// Opened from the Send list and the home rows.
// openPrivate(host) takes a few helpers from the popup: {show,on,run,esc,account,back}. All chain work is in
// ./private-balance.js; every request goes to the gateway the build names (CFG.endpoint: the XMR20 gateway in the extension), including Helius's
// signed prover policy, so the popup talks to no other host for this feature.
import {createPrivateBalance,formatRaw,parseAmount,activityLabel,SEND_FEE} from './private-balance.js';
import {SignedTeePolicy} from '@heliuslabs/spr/client';
import {SOL_MINT} from '@heliuslabs/spr';
import {maxControl,fillMaximum,maximumRaw} from '../../../engine/token/max-amount.js';

const CFG=__XMR20_PRIVATE_BALANCE__;// {endpoint, network, testMint, explorer}
const POLICY=/^https:\/\/d3gbdb0egjwcw9\.cloudfront\.net\/tee-policy\/((?:devnet|mainnet)\.json)$/;
const BASE=CFG.endpoint.replace(/\/+$/,'');// the gateway, without a trailing slash
const viaGateway=(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;const m=POLICY.exec(url);
 return fetch(m?BASE+'/tee-policy/'+m[1]:input,init);};
const SOL_RESERVE=10_000_000n;// kept back from Max on "Move in SOL" for this and later fees (0.01 SOL)
let service=null,session=null,sessionId='',Q=sel=>document.querySelector(sel);
async function connect(a){
 if(!service)service=await createPrivateBalance({rpcUrl:BASE+'/',network:CFG.network,proverTee:SignedTeePolicy.forNetwork(CFG.network),fetchImpl:viaGateway,testMint:CFG.testMint,discover:!!CFG.discover,
  // A build may set its own fee per private send (the extension does not); the fee wallet stays the same.
  ...(CFG.sendFeeLamports?{sendFee:{address:SEND_FEE.address,lamports:BigInt(CFG.sendFeeLamports)}}:{})});
 if(sessionId!==a.id){session?.close();session=null;sessionId='';const next=service.open(a.solSecret);
  if(next.address!==a.sol){next.close();throw Error('The Solana key does not match this account.');}session=next;sessionId=a.id;}return session;}
const sol=raw=>formatRaw(raw,9)+' SOL';
const amt=(raw,asset)=>formatRaw(raw,asset.decimals)+' '+asset.symbol;
// Two decimals for display (the exact amount stays in raw units); dust shows as <0.01, never as 0.00.
const compact=(raw,asset)=>{const v=formatRaw(raw,asset.decimals),[w,f='']=v.split('.');
 // Below 1, up to four decimals, so a small balance is not shown as 0.00.
 const d=w==='0'?(f.slice(0,4).replace(/0+$/,'').padEnd(2,'0')):f.slice(0,2).padEnd(2,'0'),out=w+'.'+d;
 return (Number(out)===0&&BigInt(raw)>0n?'<0.0001':out)+' '+asset.symbol;};
const ACTIONS={send:{title:'Send privately',verb:'Review'},deposit:{title:'Move in',verb:'Review'},withdraw:{title:'Move out',verb:'Review'}};

// Holdings refresh for the home screen: the same reading as the private balance screen, nothing signed.
export async function privateStatus(a){if(!a?.sol||!a.solSecret)return null;return (await connect(a)).status();}

export function openPrivate(host){
 const {show,on,run,esc,account,back}=host;Q=host.$||(sel=>document.querySelector(sel));
 const a=account();if(!a?.sol||!a.solSecret)return;
 const tx=sig=>CFG.explorer?`<a href="${esc(CFG.explorer.replace('{sig}',sig))}" target="_blank" rel="noreferrer">${esc(sig.slice(0,8))}…</a>`:esc(sig.slice(0,8))+'…';
 const assets=()=>service.assets;
 let last=null,autoError='';// last status, for Max and the rows
 // Website (host.onlyHeld): SOL, plus only the tokens this address holds (privately to send, publicly to move in).
 const held=kind=>!host.onlyHeld?assets():assets().filter(x=>x.mint===SOL_MINT||BigInt((kind==='deposit'?last?.publicRaw?.[x.mint]:last?.balances?.find(b=>b.mint===x.mint)?.amountRaw)||'0')>0n);

 const home=(note='')=>{
  show('Private balance',`<p class="subtle pb-note">Hides which token and how much. The sending and receiving Solana addresses stay public.${CFG.network==='devnet'?' <strong>Devnet test.</strong>':''}</p>
   <div id="pb-rows" class="hub-list" aria-live="polite"><div class="asset hub-row hub-wait" role="status"><span class="asset-info"><strong>Reading private balance…</strong></span></div></div>
   ${host.extraHome?host.extraHome.html():''}<div id="pb-actions" class="pb-actions"></div>
   ${note?`<p class="notice" id="pb-note">${note}</p>`:''}
   <p id="progress" class="busy" role="status"></p><p id="error" class="error" role="alert"></p>
   <button class="secondary wide" id="pb-back" data-keep>Back</button>`);
  on('pb-back',back);host.extraHome?.wire(home);
  void run(async e=>{
   $p('Reading private balance…');const s=await connect(a);last=await s.status();
   // Website (host.autoMoveIn): what sits at the address moves into the private balance by itself, except a little SOL
   // kept for fees. Signed by the address's own key; an error here leaves everything where it was.
   if(host.autoMoveIn&&last.registered){try{const keep=BigInt(host.autoMoveIn.keepLamports);let moved=false;
     for(const x of assets()){const pub=BigInt(last.publicRaw?.[x.mint]||'0'),amount=x.mint===SOL_MINT?pub-keep:pub;if(amount<(x.mint===SOL_MINT?1_000_000n:1n))continue;
      if(x.mint!==SOL_MINT&&BigInt(last.publicRaw[SOL_MINT]||'0')<3_000_000n){autoError='Add a little SOL (Top up) so your '+x.symbol+' can move into the private balance.';continue;}// a token's first move in needs SOL for rent
      $p('Moving '+x.symbol+' into your private balance…');await (await s.prepareDeposit({mint:x.mint,amountRaw:String(amount)})).approve();moved=true;}
     if(moved)last=await s.status();}catch(e){autoError=e?.message||'Could not move in automatically.';}}
   host.onStatus?.(a.sol,last);
   const rows=Q('#pb-rows');if(!rows)return;
   if(!last.registered){
    rows.innerHTML=`<div class="asset hub-row"><span class="asset-info"><strong>Private balance is off</strong><small>Turning it on publishes this address's encryption keys, so others can pay it privately.</small></span></div>`;
    Q('#pb-actions').innerHTML=`<button class="primary wide" id="pb-on">Turn on</button>`;on('pb-on',()=>{if(host.needSol&&BigInt(last.publicSolRaw||'0')<1_200_000n)return host.needSol();void run(turnOn);});}
   else{
    rows.innerHTML=last.balances.filter(b=>!host.onlyHeld||b.mint===SOL_MINT||BigInt(b.amountRaw)>0n).map(b=>{const x=assets().find(z=>z.mint===b.mint);const open=host.withdrawTo&&BigInt(b.amountRaw)>0n,tag=open?'button':'div';// website: a row with a balance opens that token's Send / Withdraw
     return `<${tag}${open?` type="button" data-pb-token="${esc(b.mint)}" aria-label="${esc(x.name)}: send or withdraw"`:''} class="asset hub-row" id="pb-bal-${esc(x.symbol)}"><span class="asset-info"><strong>${esc(x.name)}</strong><small>Private · ${esc(x.symbol)}</small></span><span class="asset-value">${esc(compact(b.amountRaw,x))}</span></${tag}>`;}).join('')
     +(host.autoMoveIn?`<p class="subtle pb-fees" id="pb-fees">Kept for fees: ${esc(sol(last.publicRaw?.[SOL_MINT]||'0'))}</p>`:'')
     +(last.history.length&&!host.singleSend?`<p class="subtle pb-history">Recent: ${last.history.slice(0,3).map(h=>{const x=assets().find(z=>z.mint===h.mint);return esc(activityLabel(h.kind,h.direction)+' '+(x?compact(h.amountRaw,x):''))+(h.signature?' '+tx(h.signature):'');}).join(' · ')}</p>`:'');
    Q('#pb-actions').innerHTML=host.singleSend?`<button class="primary wide" id="pb-send">Send</button>`:`<button class="primary wide" id="pb-send">Send privately</button><div class="pb-pair"><button class="secondary" id="pb-in">Move in</button><button class="secondary" id="pb-out">Move out</button></div>`;
    // Website: a row opens that token's own screen with Send and Withdraw.
    if(host.withdrawTo)for(const el of rows.querySelectorAll('[data-pb-token]'))el.onclick=()=>token(el.dataset.pbToken);
    on('pb-send',()=>form('send'));on('pb-in',()=>form('deposit'));on('pb-out',()=>form('withdraw'));}
   $p('');if(autoError&&Q('#error')){Q('#error').textContent=autoError;autoError='';}});};
 const $p=t=>{const p=Q('#progress');if(p)p.textContent=t;};

 // One token of the private balance: its amount, Send (private when the recipient has a private balance) and Withdraw (to the
 // connected wallet or another address).
 function token(mint){const x=assets().find(z=>z.mint===mint),b=last?.balances?.find(z=>z.mint===mint);if(!x||!b)return home();
  show(x.name,`<div class="asset hub-row"><span class="asset-info"><strong>${esc(x.symbol)}</strong><small>Private balance</small></span><span class="asset-value">${esc(amt(b.amountRaw,x))}</span></div>
   <p id="progress" class="busy" role="status"></p><p id="error" class="error" role="alert"></p>
   <div class="pb-pair"><button class="primary" id="pb-token-send">Send</button><button class="secondary" id="pb-token-withdraw">Withdraw</button></div>
   <button class="secondary wide" id="pb-cancel" data-keep>Back</button>`);
  on('pb-cancel',()=>home());on('pb-token-send',()=>form('send',{mint}));on('pb-token-withdraw',()=>form('withdraw',{mint,to:host.withdrawTo===true?'':host.withdrawTo}));}

 async function turnOn(){$p('Checking the fee…');const s=await connect(a);const r=await s.prepareRegister();$p('');
  review('Turn on private balance',[['Fee',sol(r.feeRaw)]],r,'Private balance is on.',undefined,false);}

 function form(kind,draft={}){
  const list=held(kind),asset=list.find(x=>x.mint===draft.mint)||list[0];
  const recipient=kind==='send'?`<label for="pb-to">Recipient's Solana address</label><input id="pb-to" autocomplete="off" spellcheck="false" placeholder="${host.singleSend?'Any Solana address':'Must have a private balance'}" value="${esc(draft.to||'')}">`
   :kind==='withdraw'?`<label for="pb-to">To Solana address</label><input id="pb-to" autocomplete="off" spellcheck="false" value="${esc(draft.to!=null?draft.to:a.sol)}">${host.withdrawTo?'':'<p class="field-hint">Moving out is public: the address, token and amount are visible.</p>'}`:'';
  const from=kind==='deposit'?'public':'private';
  const one=host.singleSend&&kind==='send',out=host.withdrawTo&&kind==='withdraw';
  show(one?'Send':out?'Withdraw':ACTIONS[kind].title,`<label for="pb-asset">Token</label><select id="pb-asset">${list.map(x=>`<option value="${esc(x.mint)}"${x.mint===asset.mint?' selected':''}>${esc(x.name)}</option>`).join('')}</select>
   <p class="field-hint" id="pb-avail" aria-live="polite"></p>
   ${recipient}
   ${maxControl('pb-amount','Amount')}<input id="pb-amount" class="amount-input" inputmode="decimal" placeholder="0" autocomplete="off" value="${esc(draft.amount||'')}">
   <div class="subtle" id="pb-fee">${host.singleSend&&kind==='send'?'Private when the recipient has a private balance, otherwise public. The fee is shown before you approve.':kind==='send'?'Fees: the network and privacy fee, plus the XMR20 fee of '+sol(service.sendFee.lamports)+', all paid from this address\'s public SOL. Shown exactly before you approve.':kind==='deposit'?'Moving in is public: the source, token and amount are visible. The network fee is paid from this address\'s public SOL.':'The network fee is paid from this address\'s public SOL.'}</div>
   <p id="progress" class="busy" role="status"></p><p id="error" class="error" role="alert"></p>
   <div class="pb-pair"><button class="secondary" id="pb-cancel" data-keep>Back</button><button class="primary" id="pb-review">${ACTIONS[kind].verb}</button></div>`);
  const sel=Q('#pb-asset'),input=Q('#pb-amount');
  const current=()=>list.find(x=>x.mint===sel.value);
  const avail=()=>{const x=current(),raw=from==='public'?last?.publicRaw?.[x.mint]:last?.balances?.find(b=>b.mint===x.mint)?.amountRaw;
   Q('#pb-avail').textContent=raw==null?'Available: —':'Available ('+from+'): '+compact(raw,x);};
  avail();sel.onchange=()=>{input.value='';avail();};// Max belongs to the selected token; clear it on change
  on('pb-cancel',()=>home());
  on('pb-amount-max',()=>void run(async()=>{const x=current(),e=sel.value;
   await fillMaximum(input,async()=>{last=await session.status();avail();
    if(from==='public')return x.mint===SOL_MINT?maximumRaw(last.publicRaw[x.mint],{reserved:String(SOL_RESERVE)}):last.publicRaw[x.mint];
    return last.balances.find(b=>b.mint===x.mint)?.amountRaw??'0';},{decimals:x.decimals,isCurrent:()=>input.isConnected&&sel.value===e});}));
  on('pb-review',()=>void run(async()=>{const x=current(),raw=parseAmount(input.value,x.decimals).toString(),to=Q('#pb-to')?.value.trim();
   $p(kind==='send'?'Proving the transfer…':'Checking the fee…');const s=await connect(a);
   const back=()=>form(kind,{mint:x.mint,amount:input.value,to});
   if(kind==='deposit'){const r=await s.prepareDeposit({mint:x.mint,amountRaw:raw});$p('');
    return review('Move in',[['Amount',amt(r.amountRaw,x)],['Visible to everyone','This address, the token and the amount'],['Network fee',sol(r.feeRaw)]],r,'Moved in.',back);}
   if(one){// One Send: private when the recipient has a private balance, otherwise a public payment, said plainly.
    let r,priv=true;try{r=await s.prepareSend({mint:x.mint,amountRaw:raw,recipient:to});}catch(e){if(e?.code!=='NOT_PRIVATE')throw e;priv=false;$p('Checking the fee…');r=await s.prepareWithdraw({mint:x.mint,amountRaw:raw,recipient:to});}$p('');
    return review('Send',priv?[['Amount',amt(r.amountRaw,x)],['To',to],['Privacy','Private: token and amount hidden'],['Fee',sol(BigInt(r.feeRaw)+BigInt(r.serviceFeeRaw))]]
     :[['Amount',amt(r.amountRaw,x)],['To',to],['Privacy','Public: this address has no private balance'],['Fee',sol(r.feeRaw)]],r,priv?'Sent privately.':'Sent (public).',back,false);}
   if(kind==='send'){const r=await s.prepareSend({mint:x.mint,amountRaw:raw,recipient:to});$p('');
    return review('Send privately',[['Amount',amt(r.amountRaw,x)+' (hidden on chain)'],['To',to],['Network and privacy fee',sol(r.feeRaw)],['XMR20 fee',sol(r.serviceFeeRaw)],['Total SOL from this address',sol(BigInt(r.feeRaw)+BigInt(r.serviceFeeRaw))]],r,'Sent privately.',back);}
   const r=await s.prepareWithdraw({mint:x.mint,amountRaw:raw,recipient:to});$p('');
   if(out)return review('Withdraw',[['Amount',amt(r.amountRaw,x)],['To',to],['Fee',sol(r.feeRaw)]],r,'Withdrawn.',back,false);
   return review('Move out',[['Amount',amt(r.amountRaw,x)],['To',to],['Visible to everyone','The address, the token and the amount'],['Network fee',sol(r.feeRaw)]],r,'Moved out.',back);}));}

 function review(title,lines,r,doneText,backTo=()=>home(),note=true){
  show(title,`<dl class="pb-review">${lines.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
   ${note?'<p class="subtle">Review expires in a minute. Nothing is sent until you approve.</p>':''}
   <p id="progress" class="busy" role="status"></p><p id="error" class="error" role="alert"></p>
   <div class="pb-pair"><button class="secondary" id="pb-cancel" data-keep>Back</button><button class="primary" id="pb-approve">Approve</button></div>`);
  on('pb-cancel',backTo);
  // The popup's run() refuses a nested run, so the home screen opens after this one has finished.
  on('pb-approve',async()=>{let sent=null;await run(async()=>{$p('Sending and waiting for confirmation…');sent=await r.approve();$p('');});if(sent)home(esc(doneText)+' '+tx(sent.signature));});}

 home();}
