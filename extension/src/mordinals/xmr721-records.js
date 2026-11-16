// XMR721 records approved in the XMR20 wallet (0.1.145): creating a collection, minting an NFT, and sending,
// selling, stopping a sale of or burning an NFT this wallet owns. A page hands over the bytes of a record body and
// nothing else. This file reads the bytes with the rule library, looks up what they refer to and checks it against
// its own record, shows what the record does and the exact text, and signs only after the person presses the
// button. The signed record goes to the relay from here. Keys stay in the wallet's Mordinals worker.
import {OP,NO_COLLECTION,MAX_RECORD,decodeRecord,encodeBody,recordId,renderText,nftLabel,attachSignature,signerOf,splitOf,formatXmr,canonical} from './rules/records.mjs';
import {hex,unhex} from './rules/monero.mjs';

const CONFIG=typeof __MORDINALS__!=='undefined'?__MORDINALS__:null;
const SIGNATURE=65,HEX64=/^[0-9a-f]{64}$/;
// The most this wallet ever pays a relay for carrying one record (0.01 XMR), whatever the service asks.
const MAX_RELAY_FEE=10n**10n;
const feeOf=(info,kind)=>{const v=info.relay?.fees?.[kind];return typeof v==='string'&&/^[0-9]{1,20}$/.test(v)?BigInt(v):0n;};
const TYPES={1:'PNG picture',2:'JPEG picture',3:'WebP picture',4:'GIF picture',5:'Text',6:'JSON',7:'MP4 video',8:'Text art'};
const MIME={1:'image/png',2:'image/jpeg',3:'image/webp',4:'image/gif'};
const count=v=>Number(v).toLocaleString('en-US');
let session=null;

async function api(path,body){
 let r;try{r=await fetch(CONFIG.endpoint+path,{...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),cache:'no-store',signal:AbortSignal.timeout(20000)});}
 catch{throw Error('The XMR721 service did not answer. Try again.');}
 let v=null;try{v=await r.json();}catch{}
 if(!r.ok){const e=Error(typeof v?.error==='string'?v.error:'The XMR721 service refused this request.');e.status=r.status;throw e;}
 if(!v||typeof v!=='object')throw Error('The XMR721 service sent an unreadable answer.');return v;}
// The service must serve the ledger this build was made for, take mints now and have a relay.
async function service(){
 const v=await api('/info');let fee='';try{fee=canonical(v.feeAddress,CONFIG.network);}catch{}
 if(v.network!==CONFIG.network||v.domain!==CONFIG.domain||fee!==CONFIG.feeAddress||!Number.isInteger(v.height))throw Error('This XMR721 service is for another ledger.');
 if(v.relay?.networkFee!=='relay')throw Error('This XMR721 service only reads right now. Nothing can be sent from this wallet until its relay is back.');
 return v;}
// A minted NFT as its own mint record states it; the collection's name comes from the collection's own record.
async function collectionName(id){
 const v=await api('/nft-collection/'+id);let d;
 try{d=decodeRecord(unhex(v.record),CONFIG.network);if(d.op!==OP.collection||recordId(CONFIG.domain,d.bodyBytes)!==id)throw 0;}catch{throw Error('The XMR721 service sent a collection that does not fit its code.');}
 return {name:d.body.name,max:d.body.max,creator:d.body.creator};}
async function minted(id){
 let v;try{v=await api('/nft/'+id);}catch(e){if(e.status===404)throw Error('This is not an NFT made under XMR721. Mordinals are sent and sold in the wallet’s Mordinals screens.');throw e;}
 let d;try{d=decodeRecord(unhex(v.record),CONFIG.network);if(d.op!==OP.mint||recordId(CONFIG.domain,d.bodyBytes)!==id)throw 0;}catch{throw Error('The XMR721 service sent an NFT that does not fit its code.');}
 const set=d.body.collection===NO_COLLECTION?null:await collectionName(d.body.collection);
 return {what:nftLabel(id,d.body,set?.name??null),title:d.body.name||(set?`${set.name} #${d.body.edition}`:'NFT '+id.slice(0,8)),mint:d.body};}

// What the record does, in this wallet's own words, read from the bytes.
async function describe(ui,d,me,info){
 const b=d.body,short=a=>a===me?'This wallet':ui.short(a),ctx={domain:CONFIG.domain,number:null,feeAddress:CONFIG.feeAddress};
 const priced=(kind,free)=>{const f=feeOf(info,kind);return {fee:f,feeLine:f?[['Relay fee',formatXmr(f)+' XMR']]:[],feeNote:f?'The relay fee is paid after signing; nothing is sent to the Monero network before it arrives.':free};};
 if(d.op===OP.collection){const f=priced('collection','Making a collection has no fee.');return {title:'Create a collection',label:'Sign and create',ctx,fee:f.fee,lines:[['Name',b.name],['Editions',count(b.max)],['Minted only by','This wallet'],...f.feeLine],
  note:'The name and the number of editions cannot be changed later. '+f.feeNote};}
 if(d.op===OP.mint){
  const set=b.collection===NO_COLLECTION?null:await collectionName(b.collection);
  if(set&&set.creator!==me)throw Error('Only the creator of this collection can mint into it. It was made by another address.');
  const f=priced('mint','Minting has no fee.');
  return {title:'Create an NFT',label:'Sign and mint',ctx:{...ctx,collectionName:set?.name??null},content:b,fee:f.fee,
   lines:[...(b.name?[['Name',b.name]]:[]),['Collection',set?`${set.name}, edition ${count(b.edition)} of ${count(set.max)}`:'None'],['Content',`${TYPES[b.type]||'Type '+b.type}, ${count(b.content.length)} bytes`],
    ['First owner',short(b.to||b.creator)],...f.feeLine,...(b.origin?[['Said to come from',`${b.origin.kind===1?'Bitcoin inscription':'kind '+b.origin.kind} ${ui.short(b.origin.ref)}`]]:[])],
   note:'The content is public for good and cannot be changed later. '+f.feeNote};}
 if(d.op===OP.burn){const n=await minted(b.nft);
  return {title:'Burn '+n.title,label:'Sign and burn',ctx:{...ctx,what:n.what},lines:[['NFT',n.title],['Code',ui.short(b.nft)]],
   warn:'Burning ends this NFT for good. It will have no owner, and nobody, including you, can send or sell it again.'};}
 if(d.op===OP.move){const n=await minted(b.reg);
  return {title:'Send '+n.title,label:'Sign and send',ctx:{...ctx,what:n.what},lines:[['NFT',n.title],['To',ui.short(b.to)]],note:'A sent NFT cannot be taken back.'};}
 if(d.op===OP.list){const n=await minted(b.reg),s=splitOf(b.price);
  return {title:'Sell '+n.title,label:'Sign and list',ctx:{...ctx,what:n.what},
   lines:[['NFT',n.title],['Price',formatXmr(b.price)+' XMR'],['You receive',formatXmr(s.seller)+' XMR'],['Protocol fee 5%',formatXmr(s.fee)+' XMR'],['Sale ends','Block '+count(b.until)],['Now','Block '+count(info.height)]]};}
 if(d.op===OP.cancel){
  const v=await api('/lot/'+b.lot);let l;
  try{const bytes=unhex(v.lot.body);l=decodeRecord(bytes,CONFIG.network,{sig:false});if(l.op!==OP.list||recordId(CONFIG.domain,bytes)!==b.lot)throw 0;}catch{throw Error('The XMR721 service sent a listing that does not fit its code.');}
  const n=await minted(l.body.reg);
  return {title:'Stop selling '+n.title,label:'Sign and stop selling',ctx:{...ctx,what:n.what},lines:[['NFT',n.title],['Listed for',formatXmr(l.body.price)+' XMR']],note:'The NFT stays yours. Nobody can buy it after the record is in a block.'};}
 throw Error('This wallet does not approve this kind of record here.');}

async function keys(ui,e,me){
 const a=ui.account();
 if(!a.xmrSeed)throw Error('This account has no Monero recovery phrase in this wallet, so it cannot sign.');
 if(session&&session.address===me&&session.client.alive)return session;
 session?.client.close();session=null;
 const client=ui.workerClient('mordinals.worker.js',{onProgress:()=>{}});
 try{const r=await client.call('open',{seed:a.xmrSeed,owner:a.xmr},90000);ui.same(e);if(r.address!==a.xmr)throw Error('Saved Monero wallet does not match this account.');}
 catch(error){client.close();throw error;}
 session={address:me,client};return session;}

// Shows one record for approval. Resolves with {id, state} once the signed record is with the relay; rejects when
// the person closes the screen or the record does not fit. Nothing is signed before the button is pressed.
export function approveRecord(ui,bodyHex,{origin=''}={}){
 return new Promise((resolve,reject)=>{
  if(!CONFIG)return reject(Error('XMR721 is not part of this wallet build.'));
  const modal=ui.$('#modal');let settled=false;
  const end=(fn,value)=>{if(settled)return;settled=true;modal.removeEventListener('close',gone);fn(value);};
  const gone=()=>end(reject,Object.assign(Error('Not approved. Nothing was signed.'),{cancelled:true}));
  const shut=()=>{if(modal.open)modal.close();modal.innerHTML='';};
  ui.show('XMR721','<p class="busy" id="progress">Reading the record…</p>');modal.addEventListener('close',gone);
  ui.run(async e=>{
   let d,bodyBytes,me;
   try{
    const a=ui.account();if(!a?.xmr)throw Error('This account has no Monero address.');me=canonical(a.xmr,CONFIG.network);
    if(typeof bodyHex!=='string'||!/^([0-9a-f]{2})+$/.test(bodyHex)||bodyHex.length/2+SIGNATURE>MAX_RECORD)throw Error('This is not an XMR721 record.');
    bodyBytes=unhex(bodyHex);d=decodeRecord(bodyBytes,CONFIG.network,{sig:false});
    // The bytes must be the one spelling of this record, so what is shown is all that is signed.
    if(hex(encodeBody(d.op,d.body,CONFIG.network))!==bodyHex)throw Error('This is not an XMR721 record.');
    if(signerOf(d.op,d.body)!==me)throw Error('This record is for another address, not for this wallet.');
    const info=await service();ui.same(e);
    if(d.op>=OP.collection&&(info.mintFrom==null||info.height<info.mintFrom))throw Error('Creating NFTs is not switched on for this ledger yet.');
    const v=await describe(ui,d,me,info);ui.same(e);
    const text=renderText(d.op,d.body,bodyBytes,v.ctx),id=recordId(CONFIG.domain,bodyBytes);
    let body='<span id="x7-approve" hidden></span>';
    if(origin)body+=`<div class="review-line"><span>Asked by</span><strong>${ui.esc(origin)}</strong></div>`;
    // The picture is at most a few hundred bytes, so it is shown from the record itself.
    if(v.content&&MIME[v.content.type]){let b='';for(const c of v.content.content)b+=String.fromCharCode(c);body+=`<div class="mord-picture"><img alt="" src="data:${MIME[v.content.type]};base64,${btoa(b)}"></div>`;}
    else if(v.content&&v.content.type===5)body+=`<div class="address mord-text x7-content">${ui.esc(new TextDecoder().decode(v.content.content).slice(0,400))}</div>`;
    body+=v.lines.map(([k,val])=>`<div class="review-line"><span>${ui.esc(k)}</span><strong>${ui.esc(val)}</strong></div>`).join('');
    if(v.warn)body+=`<div class="notice">${ui.esc(v.warn)}</div>`;
    body+=`<label>You sign this text</label><div class="address mord-text" id="x7-text">${ui.esc(text)}</div>`
     +`<p class="subtle">${ui.esc((v.note?v.note+' ':'')+'Signing moves no XMR. The relay puts the record on the Monero network. It counts once it is in a block.')}</p>`
     +`<p class="busy" id="progress"></p><button class="primary wide" id="x7-sign">${ui.esc(v.label)}</button><button class="text-btn" id="x7-cancel">Cancel</button>`;
    ui.show(v.title,body);
    ui.on('x7-cancel',()=>{shut();gone();});
    ui.on('x7-sign',()=>ui.run(async e2=>{
     const p=ui.$('#progress');if(p)p.textContent='Opening this wallet’s Monero keys…';
     const s=await keys(ui,e2,me);if(p)p.textContent='Signing…';
     const r=await s.client.call('sign',{text},30000);ui.same(e2);
     if(r.address!==ui.account().xmr)throw Error('The wallet signed with another address. Nothing was sent.');
     const record=attachSignature(bodyBytes,r.signature,v.ctx,CONFIG.network);
     if(p)p.textContent='Sending the record…';
     const out=await api('/records',{record:hex(record)});ui.same(e2);
     if(out.state==='refused')throw Error(typeof out.error==='string'?out.error:'The rules refuse this record.');
     const answer={id,state:out.state},finish=()=>{modal.removeEventListener('close',later);shut();end(resolve,answer);};
     // From here the record is with the relay: closing the screen no longer undoes anything.
     const later=()=>end(resolve,answer);modal.removeEventListener('close',gone);modal.addEventListener('close',later);
     if(out.state!=='unpaid'||!ui.payXmr)return finish();
     // The relay asks for its fee. This wallet pays only the amount it showed before signing, and never more than its own cap.
     const due=out.pay,amount=typeof due?.amount==='string'&&/^[1-9][0-9]{0,19}$/.test(due.amount)?BigInt(due.amount):0n;let to;
     try{to=canonical(due?.address,CONFIG.network);}catch{to=null;}
     if(!to||!amount||amount!==v.fee||amount>MAX_RELAY_FEE||to===me)return finish();
     const first=()=>{ui.show('Pay the relay fee',`<span id="x7-pay" hidden></span><div class="review-line"><span>Relay fee</span><strong>${ui.esc(formatXmr(amount))} XMR</strong></div><div class="review-line"><span>To the relay</span><strong>${ui.esc(ui.short(to))}</strong></div>`
       +`<div class="notice">Your record is signed and waits at the relay. It is sent to the Monero network once this fee is in a block. If you do not pay, nothing is sent and nothing is owed.</div>`
       +`<p class="busy" id="progress"></p><button class="primary wide" id="x7-review">Pay from this wallet</button><button class="text-btn" id="x7-other">Pay from another wallet</button>`);
      ui.on('x7-other',finish);
      ui.on('x7-review',()=>ui.run(async e3=>{
       const q=ui.$('#progress');if(q)q.textContent='Preparing the payment…';
       const review=await ui.payXmr.prepare([{address:to,amountRaw:amount.toString()}]);ui.same(e3);
       const d0=review?.destinations;if(!Array.isArray(d0)||d0.length!==1||d0[0].address!==to||d0[0].amountRaw!==amount.toString()||!/^[0-9]{1,20}$/.test(review.feeRaw||''))throw Error('The wallet prepared a different payment. Nothing was sent.');
       ui.show('Pay the relay fee',`<div class="review-line"><span>Relay fee</span><strong>${ui.esc(formatXmr(amount))} XMR</strong></div><div class="review-line"><span>Monero network fee</span><strong>${ui.esc(formatXmr(BigInt(review.feeRaw)))} XMR</strong></div><div class="review-line"><span>Total</span><strong>${ui.esc(formatXmr(amount+BigInt(review.feeRaw)))} XMR</strong></div>`
        +`<p class="subtle">Paid from this wallet’s XMR to the relay. The record goes out once the payment is in a block.</p><p class="busy" id="progress"></p><button class="primary wide" id="x7-pay-now">Pay ${ui.esc(formatXmr(amount+BigInt(review.feeRaw)))} XMR</button><button class="text-btn" id="x7-pay-back">Back</button>`);
       ui.on('x7-pay-back',first);
       ui.on('x7-pay-now',()=>ui.run(async e4=>{const w=ui.$('#progress');if(w)w.textContent='Sending the payment…';await ui.payXmr.relay(review);ui.same(e4);finish();}));}));};
     first();}));}
   catch(error){
    // A record that cannot be approved is said on the screen; closing it tells the page.
    ui.show('XMR721',`<div class="notice" id="x7-refused">${ui.esc(error.message||'This record cannot be approved.')}</div><button class="text-btn" id="x7-cancel">Close</button>`);
    ui.on('x7-cancel',()=>{shut();end(reject,error);});
    modal.removeEventListener('close',gone);modal.addEventListener('close',()=>end(reject,error),{once:true});}});});}
