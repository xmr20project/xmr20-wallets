// Mordinals in the XMR20 wallet (extension 0.1.142+, Collectibles tab): find the Mordinals this wallet holds, claim them, send them,
// sell them and buy them. Record bytes and the texts to sign are built here from the rule library; the keys stay in
// the Mordinals worker. The ledger's domain, network, fee address and owner-list hash are fixed in the build and
// never taken from the service. A record counts only once it is in a Monero block, so the screens say "waiting"
// until the service reports that block.
import {OP,PROOF,RULES,heldUntil,encodeBody,decodeRecord,recordId,codeOf,amounts,splitOf,renderText,attachSignature,formatXmr,parseXmr,canonical} from './rules/records.mjs';
import {claimKeyHash,verifyOutputKeySignature} from './rules/claim.mjs';
import {parseTxKey,provePayments} from './rules/payment.mjs';
import {hex,unhex,concat} from './rules/monero.mjs';
import {listCheck,checkPicture,toBase64,packTable,unpackTable,recordState,MAX_PICTURE} from './mordinals-data.js';

const CONFIG=typeof __MORDINALS__!=='undefined'?__MORDINALS__:null;
export const mordinalsEnabled=Boolean(CONFIG);
const FOUND_KEY='mordinals-found-v1',LIST_KEY='mordinals-list-v1',SENT_KEY='mordinals-sent-v1',PAID_KEY='mordinals-paid-v1',RESERVED_KEY='mordinals-reserved-v1';
// PAY_MARGIN: blocks that must be left on a reservation before this wallet sends a payment for it.
// NOT_SENT_AFTER: a payment the Monero node has not seen for this long most likely never left the wallet.
const SUBADDRESSES=50,LISTING_BLOCKS=720,PAY_MARGIN=3,NOT_SENT_AFTER=180000,PAID_KEEP=60*86400000;
// What the service and the relay say while the Monero node has not seen a payment yet.
const NOT_SEEN=/not known to the Monero node yet|does not know this transaction yet/;
const BAD_ANSWER='The Mordinals service sent an answer this wallet cannot read.';
const READ_ONLY='This Mordinals service only reads right now. Nothing can be claimed, sent, sold or bought from this wallet until its relay is back.';
const SIGN_NOTE='Signing moves no XMR. The signed record goes to the Mordinals relay, which puts it on the Monero network and pays that network fee. It counts once it is in a block, usually within a few minutes.';
let ui=null,session=null,info=null,listTable=null,watchSeq=0;
const pictures=new Map(),revealed=new Set();

const count=v=>Number(v).toLocaleString('en-US');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const progress=text=>{const p=ui.$('#progress');if(p)p.textContent=text;};
// An earlier refusal goes away when the person changes the field it was about.
const clearOnInput=(...ids)=>{for(const id of ids){const el=ui.$('#'+id);if(el)el.addEventListener('input',()=>{const e=ui.$('#error');if(e)e.textContent='';});}};
const line=(label,value)=>`<div class="review-line"><span>${ui.esc(label)}</span><strong>${ui.esc(value)}</strong></div>`;
const thumb=n=>listTable?`<span class="mord-thumb" data-mord="${Number(n)}"></span>`:'';
const row=(id,title,sub,value='',picture=null)=>`<button class="asset mord-row" id="${id}">${picture==null?'':thumb(picture)}<span class="asset-info"><strong>${ui.esc(title)}</strong><small>${ui.esc(sub)}</small></span><span class="asset-value">${ui.esc(value)}</span></button>`;
const large=n=>listTable?`<div class="mord-picture" data-mord="${Number(n)}"></div>`:'';
const actions=(primary,label,back='Back')=>`<p class="busy" id="progress"></p><button class="primary wide" id="${primary}">${ui.esc(label)}</button><button class="text-btn" id="mord-back">${back}</button>`;
const own=()=>{const a=ui.account();if(!a?.xmr)throw Error('This account has no Monero address.');return canonical(a.xmr,CONFIG.network);};
const testNote=()=>info?.test?'<div class="notice" id="mord-test">Test service on this computer. Its Monero chain is made up: nothing here is on the real Monero network.</div>':'';
const canSend=()=>info?.relay?.networkFee==='relay';
async function copy(value,what){try{await navigator.clipboard.writeText(value);ui.toast(what+' copied');}catch{ui.toast('Select the text and copy it manually.');}}
// Checks that keep running while a screen is open. They stop when the screen's marker element is gone.
function watch(marker,every,tick){
 const mine=++watchSeq,loop=async()=>{if(mine!==watchSeq||!ui.$('#'+marker))return;try{await tick();}catch{}if(mine===watchSeq)setTimeout(loop,every);};
 setTimeout(loop,every);}

async function api(path,body){
 let r;try{r=await fetch(CONFIG.endpoint+path,{...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),cache:'no-store',signal:AbortSignal.timeout(20000)});}
 catch{throw Error('The Mordinals service did not answer. Try again.');}
 let v=null;try{v=await r.json();}catch{}
 if(!r.ok){const e=Error(typeof v?.error==='string'?v.error:'The Mordinals service refused this request.');e.status=r.status;throw e;}
 if(!v||typeof v!=='object')throw Error('The Mordinals service sent an unreadable answer.');return v;}
// The service must serve the ledger and the owner list this build was made for.
async function service(){
 const v=await api('/info');let fee='';try{fee=canonical(v.feeAddress,CONFIG.network);}catch{}
 if(v.network!==CONFIG.network||v.domain!==CONFIG.domain||fee!==CONFIG.feeAddress||v.owners!==CONFIG.owners||!Number.isInteger(v.height)||!Number.isInteger(v.count)||!(v.chunk>0))throw Error('This Mordinals service is for another ledger.');
 info=v;return v;}
// The worker that holds this account's Monero keys. One per open account; closed with the wallet's other workers on lock.
async function keys(e){
 const a=ui.account();if(!a?.xmr)throw Error('This account has no Monero address.');
 if(!a.xmrSeed)throw Error('This account has no Monero recovery phrase in this wallet, so it cannot sign for Mordinals.');
 if(session&&session.address===a.xmr&&session.client.alive)return session;
 session?.client.close();session=null;progress('Opening this wallet’s Monero keys…');
 const client=ui.workerClient('mordinals.worker.js',{onProgress:()=>{}});
 try{const r=await client.call('open',{seed:a.xmrSeed,owner:a.xmr},90000);ui.same(e);if(r.address!==a.xmr)throw Error('Saved Monero wallet does not match this account.');}
 catch(error){client.close();throw error;}
 session={address:a.xmr,client};return session;}
// A listing as its own signed record states it. The service's plain fields are not trusted for price, seller or end.
function terms(l){
 let d,bytes;try{bytes=unhex(l.body);d=decodeRecord(bytes,CONFIG.network,{sig:false});}catch{d=null;}
 if(!d||d.op!==OP.list||recordId(CONFIG.domain,bytes)!==l.id||!Number.isInteger(l.number)||l.number<0)throw Error('The Mordinals service sent a listing that does not fit its code.');
 const r=l.reservation||null;
 if(r&&!(typeof r==='object'&&/^[0-9a-f]{64}$/.test(r.record)&&typeof r.buyer==='string'&&Number.isSafeInteger(r.payBy)&&Number.isInteger(r.rate)))throw Error(BAD_ANSWER);
 return {id:l.id,number:l.number,reg:d.body.reg,seq:d.body.seq,price:d.body.price,until:d.body.until,seller:d.body.seller,status:l.status,reservation:r};}
// The reservation that holds a listing now: until it runs out and 10 blocks more, nobody else can reserve it.
const running=(t,height)=>t.reservation&&heldUntil(t.reservation)>=height?t.reservation:null;
async function sign(e,bodyBytes,text,ctx){
 const s=await keys(e);progress('Signing…');const r=await s.client.call('sign',{text},30000);ui.same(e);
 if(r.address!==s.address)throw Error('The wallet signed with another address. Nothing was sent.');
 return attachSignature(bodyBytes,r.signature,ctx,CONFIG.network);}

// ---- What this wallet keeps: small lists per Monero address ----
async function saved(key,me){const all=await ui.store.get(key);return all&&typeof all==='object'&&!Array.isArray(all)?all[me]??null:null;}
async function save(key,me,value){const got=await ui.store.get(key),all=got&&typeof got==='object'&&!Array.isArray(got)?got:{};if(value==null)delete all[me];else all[me]=value;await ui.store.set(key,all);}
// Records handed to the relay and not seen in a block yet: {id, op, number, lot, record (hex), at}. A purchase stays
// here, marked seen, until its block is old enough not to be replaced.
async function sentOf(me){const v=await saved(SENT_KEY,me);
 return (Array.isArray(v)?v:[]).filter(x=>x&&/^[0-9a-f]{64}$/.test(x.id)&&Number.isInteger(x.op)&&Number.isInteger(x.number)&&typeof x.record==='string'&&/^([0-9a-f]{2})+$/.test(x.record)&&Number.isFinite(x.at));}
async function track(me,entry){await save(SENT_KEY,me,[...(await sentOf(me)).filter(x=>x.id!==entry.id),entry].slice(-24));}
async function untrack(me,test){const list=await sentOf(me),kept=list.filter(x=>!test(x));if(kept.length!==list.length)await save(SENT_KEY,me,kept);}
// Payments this wallet sent for a reservation, by the reservation's code: {lot, number, txid, keys, state, at} and,
// once it is built, the purchase record. The transaction keys stay here; the record holds proofs made from them.
// A payment the Monero node never saw, after which the buyer started again, is kept set aside under
// "<code>:<txid>" with aside: <code>. Nothing is kept longer than 60 days.
async function paidOf(me){const v=await saved(PAID_KEY,me);return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
async function setPaid(me,id,entry){const all=await paidOf(me),old=Date.now()-PAID_KEEP;
 for(const k of Object.keys(all))if(!(all[k]?.at>old))delete all[k];
 if(entry)all[id]=entry;else delete all[id];await save(PAID_KEY,me,all);}
// Tidy the saved payments each time the main screen opens. A purchase whose block is old enough not to be replaced
// needs its payment's transaction keys and its record no longer. One the rules refused is built anew the next time:
// its saved record goes, the payment stays. A payment that was set aside stays until it is 60 days old, in case it
// went out after all and the buyer has to show it to the seller.
async function tidyPaid(e,me,settled,refused,tracked){
 const lots=new Set(settled.map(x=>x.lot)),first=await paidOf(me);
 // A recorded purchase that is no longer on the short list of sent records: ask the service about it.
 for(const q of Object.values(first)){
  if(!q||q.aside||typeof q.record!=='string'||!/^([0-9a-f]{2})+$/.test(q.record)||lots.has(q.lot)||tracked.some(x=>x.record===q.record))continue;
  const st=await api('/status/'+recordId(CONFIG.domain,unhex(q.record))).catch(()=>null);
  if(st?.state==='done'&&st.confirmations>=RULES.settle)lots.add(q.lot);}
 ui.same(e);const all=await paidOf(me),old=Date.now()-PAID_KEEP;let changed=false;
 for(const [id,q] of Object.entries(all)){
  if(!(q?.at>old)||(!q.aside&&lots.has(q.lot))){delete all[id];changed=true;continue;}
  if(q.record&&refused.some(x=>x.record===q.record)){delete q.record;if(q.state==='recorded')q.state='sent';changed=true;}}
 if(changed)await save(PAID_KEY,me,all);}
// "Start the payment again": the payment the node never saw is set aside, not deleted.
async function setAside(me,id,entry){
 const all=await paidOf(me);if(all[id]?.txid!==entry.txid)return;
 const {record,...rest}=all[id];delete all[id];all[id+':'+entry.txid]={...rest,state:'unknown',aside:id};await save(PAID_KEY,me,all);}
// A payment that was set aside and that the Monero node knows now takes its place again: the purchase is finished
// with it and nothing is paid a second time. A service that cannot say gives an error, not a second payment.
async function revive(e,me,id){
 for(const [k,q] of Object.entries(await paidOf(me))){
  if(q?.aside!==id||!/^[0-9a-f]{64}$/.test(q.txid))continue;
  let seen=false;
  try{seen=(await api('/tx/'+q.txid)).payment?.txid===q.txid;}catch(error){if(!NOT_SEEN.test(error.message))throw error;}
  ui.same(e);if(!seen)continue;
  const all=await paidOf(me);if(all[id])return all[id];
  const {aside,...entry}=q;entry.state='sent';delete all[k];all[id]=entry;await save(PAID_KEY,me,all);return entry;}
 return null;}
// Reservations this wallet signed, by the reservation's code: {lot, number, seller, price, payBy, at}. This wallet pays
// only for one of these: the listing, seller and price that were on the screen when the reservation was signed.
async function reservedOf(me){const v=await saved(RESERVED_KEY,me);return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
async function setReserved(me,id,entry){const all=await reservedOf(me),old=Date.now()-60*86400000;
 for(const k of Object.keys(all))if(!(all[k]?.at>old))delete all[k];
 all[id]=entry;await save(RESERVED_KEY,me,all);}
const WHAT={[OP.claim]:'Claim of',[OP.move]:'Sending',[OP.list]:'Listing of',[OP.cancel]:'Stopping the sale of',[OP.reserve]:'Reservation of',[OP.buy]:'Purchase of'};
const what=x=>(WHAT[x.op]||'Record for')+' Mordinal #'+count(x.number);
const doneText=x=>'Mordinal #'+count(x.number)+({[OP.claim]:' is claimed.',[OP.move]:' was sent.',[OP.list]:' is for sale.',[OP.cancel]:' is no longer for sale.',[OP.reserve]:' is reserved for this wallet. Pay for it under Buying.',[OP.buy]:' is yours.'}[x.op]||' was updated.');

// Hand a record to the relay. It is remembered first, so a lost answer does not lose the record.
async function post(e,record,{bodyBytes,id:known,op,number,lot=null}){
 if(!canSend())throw Error(READ_ONLY);
 const me=own(),id=known||recordId(CONFIG.domain,bodyBytes),entry={id,op,number,lot,record:hex(record),at:Date.now()};
 await track(me,entry);ui.same(e);progress('Sending the record…');let out;
 try{out=await api('/records',{record:entry.record});}
 catch(error){
  // A plain refusal drops the record. A busy relay does not: the same record can be handed over again later.
  if(error.status&&error.status<500&&error.status!==429){await untrack(me,x=>x.id===id);error.refused=true;throw error;}
  if(error.status)throw Error(error.message+' The record is kept: open Mordinals again to send it.');
  throw Error('The Mordinals service did not answer. The record is kept: open Mordinals again to see whether it arrived.');}
 ui.same(e);
 if(out.state==='refused'){await untrack(me,x=>x.id===id);throw Object.assign(Error(typeof out.error==='string'?out.error:'The rules refuse this record.'),{refused:true});}
 return {...out,id};}
const onItsWay=x=>what(x)+' was handed to the relay. It counts once it is in a block.';

// ---- The owner list and pictures ----
// The whole public owner list is read in pieces and compared with the hash this wallet was built with. The same
// pass keeps the first bytes of every picture's hash, which is how a picture is checked before it is shown.
async function readList(e,each){
 const v=await service();ui.same(e);const check=listCheck(v.count);let from=0;
 while(from<v.count){
  progress(`Checking Mordinals: ${count(from)} of ${count(v.count)}…`);
  const page=await api(`/owners?from=${from}&limit=${v.chunk}`);ui.same(e);
  if(page.total!==v.count||page.from!==from||!Array.isArray(page.entries)||!page.entries.length)throw Error('The Mordinals list changed while it was checked. Try again.');
  check.add(page.entries);if(each){await each(page.entries);ui.same(e);}from+=page.entries.length;}
 listTable=check.finish(CONFIG.owners);pictures.clear();
 try{await ui.store.set(LIST_KEY,packTable(listTable,CONFIG.owners));}catch{}
 ui.same(e);return v;}
async function loadTable(){if(listTable||!info)return;try{listTable=unpackTable(await ui.store.get(LIST_KEY),CONFIG.owners,info.count);}catch{listTable=null;}}
let lanes=0;const queue=[];
const lane=work=>new Promise((resolve,reject)=>{const go=()=>{lanes++;work().then(resolve,reject).finally(()=>{lanes--;queue.shift()?.();});};if(lanes<4)go();else queue.push(go);});
// -> {url, sensitive} or null (no picture). The bytes are shown only if their hash is in the checked list.
function picture(n){
 if(!pictures.has(n)){
  if(pictures.size>=60)pictures.delete(pictures.keys().next().value);
  const p=lane(async()=>{
   const r=await fetch(CONFIG.endpoint+'/content/'+n,{signal:AbortSignal.timeout(20000)});if(r.status===404||r.status===415)return null;if(!r.ok)throw Error('unavailable');
   if(Number(r.headers.get('content-length'))>MAX_PICTURE)return null;
   const bytes=new Uint8Array(await r.arrayBuffer()),type=checkPicture(listTable,n,bytes);
   return type?{url:'data:'+type+';base64,'+toBase64(bytes),sensitive:r.headers.get('x-mordinal-sensitive')==='1'}:null;});
  p.catch(()=>{if(pictures.get(n)===p)pictures.delete(n);});pictures.set(n,p);}
 return pictures.get(n);}
// Fill the picture places of the screen that is open.
function paint(){
 if(!listTable)return;
 for(const el of ui.$('#modal')?.querySelectorAll('[data-mord]')||[]){// the open dialog, which on the website sits in the wallet's own shadow root
  const n=Number(el.dataset.mord),big=el.classList.contains('mord-picture');
  picture(n).then(p=>{
   if(!el.isConnected)return;
   if(!p){el.classList.add('mord-none');if(big)el.textContent='No picture';return;}
   if(p.sensitive&&!revealed.has(n)){el.classList.add('mord-none');
    if(big){el.innerHTML='<span>Marked sensitive</span><button class="text-btn" data-keep>Show picture</button>';el.querySelector('button').onclick=()=>{revealed.add(n);el.classList.remove('mord-none');el.textContent='';paint();};}
    return;}
   const img=new Image();img.alt='Mordinal #'+count(n);img.src=p.url;el.classList.remove('mord-none');el.replaceChildren(img);
  },()=>{if(el.isConnected&&big)el.textContent='Picture unavailable right now';});}}
const picturesOffer=()=>listTable?'':`<div><button class="text-btn" id="mord-pictures">Show pictures</button></div>`;
const picturesWire=after=>ui.on('mord-pictures',()=>ui.run(async e=>{await readList(e);return after(e);}));

// ---- Main screen ----
async function home(e,message=''){
 const me=own();await service();await loadTable();
 const [mine,claimed,found0,sent0]=await Promise.all([api('/address/'+me),api('/claimed'),saved(FOUND_KEY,me),sentOf(me)]);ui.same(e);
 const states=await Promise.all(sent0.map(x=>api('/status/'+x.id).catch(()=>null)));ui.same(e);
 if(!Array.isArray(mine.mordinals)||!Array.isArray(mine.buying)||!Array.isArray(claimed.numbers)
  ||!mine.mordinals.every(m=>m&&Number.isInteger(m.number)&&m.number>=0&&/^[0-9a-f]{64}$/.test(m.reg)&&Number.isInteger(m.seq)))throw Error(BAD_ANSWER);
 const height=info.height,notes=message?[message]:[],open=[],kept=[],settled=[],refused=[];let dirty=false;
 sent0.forEach((x,i)=>{
  const st=states[i],s=st?recordState(st,x.at):'waiting';
  if(s==='done'){
   if(!x.seen)notes.push(doneText(x));
   // A purchase stays on the list with its record, and its payment keeps its keys, until its block is old enough not
   // to be replaced. Should the blocks change before that, the same record can still be handed over again.
   if(x.op===OP.buy&&!(st.confirmations>=RULES.settle)){kept.push(x.seen?x:{...x,seen:true});if(!x.seen)dirty=true;return;}
   if(x.op===OP.buy)settled.push(x);dirty=true;return;}
  if(s==='refused'){notes.push(what(x)+' was refused: '+(typeof st.error==='string'&&st.error?st.error:'the rules do not allow it.'));if(x.op===OP.buy)refused.push(x);dirty=true;return;}
  // A purchase that was in a block and is not any more waits again.
  const y=x.seen?{...x,seen:false}:x;if(x.seen)dirty=true;kept.push(y);open.push({...y,state:s,held:st?.state==='held'});});
 await tidyPaid(e,me,settled,refused,sent0);ui.same(e);
 if(dirty){await save(SENT_KEY,me,kept);ui.same(e);}
 // Records the relay holds for this address that this wallet did not hand over itself (another device, a lost answer).
 for(const j of Array.isArray(mine.waiting)?mine.waiting:[])if(/^[0-9a-f]{64}$/.test(j?.id)&&Number.isInteger(j.number)&&!open.some(x=>x.id===j.id))open.push({id:j.id,op:j.op,number:j.number,lot:null,record:null,at:0,state:'waiting',held:j.state==='held'});
 const waiting=open.filter(x=>x.state==='waiting'),lost=open.filter(x=>x.state==='lost'),busy=new Map(waiting.map(x=>[x.number,x]));
 const done=new Set(claimed.numbers),found=(found0?.found||[]).filter(f=>!done.has(f.number));
 const yours=mine.mordinals.map(m=>({...m,terms:m.lot?terms(m.lot):null})),buying=mine.buying.map(terms).filter(t=>t.reservation);
 const shown=new Set([...yours.map(m=>m.number),...found.map(f=>f.number),...buying.map(t=>t.number)]),apart=waiting.filter(x=>!shown.has(x.number));
 const state=m=>busy.has(m.number)?'Waiting for a block':!m.terms?'Tap to send or sell':m.terms.until<height?'Listing ended':running(m.terms,height)?'Reserved by a buyer':'For sale';
 const buyState=t=>busy.get(t.number)?.op===OP.buy?(busy.get(t.number).held?'Purchase waiting for the payment to reach a block':'Purchase waiting for a block'):t.reservation.payBy<height?'Reservation ran out at block '+count(t.reservation.payBy):'Pay by block '+count(t.reservation.payBy);
 let body=`<span id="mord-home" hidden></span>`+testNote()+(canSend()?'':`<div class="notice" id="mord-readonly">${READ_ONLY}</div>`);
 if(notes.length)body+=`<p class="subtle" id="mord-message">${ui.esc(notes.join(' '))}</p>`;
 if(yours.length||buying.length)body+=picturesOffer();
 if(lost.length)body+=`<div class="section-label"><span>Did not reach a block</span><span>${count(lost.length)}</span></div>`+lost.map((x,i)=>row('mord-lost-'+i,what(x),'Tap to send it again')).join('');
 if(yours.length)body+=`<div class="section-label"><span>Yours</span><span>${count(yours.length)}</span></div>`+yours.map(m=>row('mord-own-'+m.number,'Mordinal #'+count(m.number),state(m),m.terms?formatXmr(m.terms.price)+' XMR':'',m.number)).join('');
 if(found.length)body+=`<div class="section-label"><span>Found in this wallet, not claimed yet</span><span>${count(found.length)}</span></div>`+found.map(f=>row('mord-found-'+f.number,'Mordinal #'+count(f.number),busy.has(f.number)?'Claim waiting for a block':'Tap to claim')).join('');
 if(buying.length)body+=`<div class="section-label"><span>Buying</span><span>${count(buying.length)}</span></div>`+buying.map(t=>row('mord-buying-'+t.number,'Mordinal #'+count(t.number),buyState(t),formatXmr(t.price)+' XMR',t.number)).join('');
 if(apart.length)body+=`<div class="section-label"><span>Waiting for a block</span><span>${count(apart.length)}</span></div>`+apart.map((x,i)=>row('mord-wait-'+i,what(x),x.held?'Waiting for the payment to reach a block':'Usually a few minutes')).join('');
 if(!yours.length&&!found.length&&!buying.length&&!open.length)body+=`<div class="empty"><strong>No Mordinals here yet</strong>Find the Mordinals this wallet already holds, or buy one.</div>`;
 body+=`<p class="busy" id="progress"></p><button class="primary wide" id="mord-find">Find my Mordinals</button><button class="secondary wide" id="mord-buy">Buy a Mordinal</button>`;
 ui.show('Mordinals',body);paint();picturesWire(x=>home(x));
 const wait=()=>ui.toast('A record for this Mordinal is waiting for a block.');
 ui.on('mord-find',()=>ui.run(find));ui.on('mord-buy',()=>ui.run(market));
 for(const m of yours)ui.on('mord-own-'+m.number,busy.has(m.number)?wait:()=>detail(m,height));
 for(const f of found)ui.on('mord-found-'+f.number,busy.has(f.number)?wait:()=>claim(f));
 for(const t of buying)ui.on('mord-buying-'+t.number,busy.get(t.number)?.op===OP.buy?wait:()=>ui.run(x=>pay(x,t.id)));
 lost.forEach((x,i)=>ui.on('mord-lost-'+i,()=>again(x)));
 apart.forEach((x,i)=>ui.on('mord-wait-'+i,x.op===OP.reserve&&x.lot?()=>ui.run(y=>pay(y,x.lot)):wait));
 // Look again while something waits, and show the new state when it changes.
 if(waiting.length)watch('mord-home',5000,async()=>{
  const now=await Promise.all(waiting.map(x=>api('/status/'+x.id).catch(()=>null)));
  if(now.some((st,i)=>st&&recordState(st,waiting[i].at||Date.now())!=='waiting')&&ui.$('#mord-home'))ui.run(x=>home(x));});}
const back=()=>ui.run(e=>home(e));

// A record that did not reach a block: the same bytes can be handed over again; nothing new is signed.
function again(x){
 ui.show(what(x),`<div class="notice">This record did not reach a block, so nothing changed. You can hand the same record to the relay again. Nothing new is signed.</div>`
  +`<p class="busy" id="progress"></p><button class="primary wide" id="mord-again">Send again</button><button class="secondary wide" id="mord-forget">Remove from this list</button><button class="text-btn" id="mord-back">Back</button>`);
 ui.on('mord-back',back);
 ui.on('mord-forget',()=>ui.run(async e=>{await untrack(own(),y=>y.id===x.id);ui.same(e);return home(e);}));
 ui.on('mord-again',()=>ui.run(async e=>{
  await service();ui.same(e);const out=await post(e,unhex(x.record),{id:x.id,op:x.op,number:x.number,lot:x.lot}).catch(async error=>{if(error.status===400){ui.same(e);return {refused:error.message};}throw error;});
  return home(e,out.refused?what(x)+' was refused: '+out.refused:onItsWay(x));}));}

// ---- Find ----
// The list is checked inside the worker, so no request names a Mordinal or an address of this wallet.
async function find(e){
 const me=own(),s=await keys(e),found=[];
 const v=await readList(e,async entries=>{const r=await s.client.call('find',{owners:entries,accounts:1,indices:SUBADDRESSES},180000);found.push(...r.found);});
 await save(FOUND_KEY,me,{found,checked:v.count,at:Date.now()});ui.same(e);
 return home(e,found.length?`Checked all ${count(v.count)} Mordinals: ${count(found.length)} held by this wallet.`
  :`Checked all ${count(v.count)} Mordinals: none are held by this wallet’s main address or its first ${SUBADDRESSES} subaddresses.`);}

// ---- Claim ----
function claim(f){
 const me=own();
 ui.show('Claim Mordinal #'+count(f.number),(listTable?`<div class="mord-picture mord-none" id="mord-claim-picture"><button class="text-btn" id="mord-show" data-keep>Show picture</button><span>Asking for the picture tells the Mordinals service which Mordinal this wallet looks at.</span></div>`:'')
  +line('Held by',f.account||f.index?`Subaddress ${f.account}/${f.index}`:'Main address')+line('Will belong to',ui.short(me))
  +`<div class="notice">Claiming records this Mordinal under this wallet’s Monero address. From then on it moves by signed message, and the address is public as its owner. No XMR moves and the coin that holds it is not spent.</div>`
  +`<p class="subtle">${SIGN_NOTE}</p>`+actions('mord-claim','Claim'));
 ui.on('mord-back',back);
 ui.on('mord-show',()=>{const el=ui.$('#mord-claim-picture');revealed.add(f.number);el.textContent='';el.dataset.mord=String(f.number);el.classList.remove('mord-none');paint();});
 ui.on('mord-claim',()=>ui.run(async e=>{
  await service();ui.same(e);if(!canSend())throw Error(READ_ONLY);
  const s=await keys(e),bodyBytes=encodeBody(OP.claim,{reg:f.registrationTx,ownerTx:f.ownerTx,to:me,proof:PROOF.outputKey},CONFIG.network);progress('Signing the claim…');
  const sig=await s.client.call('claimSign',{domain:CONFIG.domain,body:hex(bodyBytes),outputKey:f.ownerOutputKey,txPubKey:f.txPubKey,account:f.account,index:f.index},30000);ui.same(e);
  const c=unhex(sig.c),r=unhex(sig.r);
  if(!verifyOutputKeySignature(claimKeyHash(CONFIG.domain,bodyBytes),f.ownerOutputKey,c,r))throw Error('The claim signature did not verify. Nothing was sent.');
  const x={op:OP.claim,number:f.number},out=await post(e,concat(bodyBytes,c,r),{bodyBytes,...x});
  return home(e,out.state==='done'?'':onItsWay(x));}));}

// ---- One Mordinal of this wallet ----
function detail(m,height){
 const t=m.terms,r=t&&running(t,height);let body=large(m.number)+line('Inscription',ui.short(m.reg))+line('Owner','This wallet');
 if(!t){body+=`<button class="primary wide" id="mord-send">Send</button><button class="secondary wide" id="mord-sell">Sell</button><button class="text-btn" id="mord-back">Back</button>`;}
 else{const s=splitOf(t.price);
  body+=line('For sale',formatXmr(t.price)+' XMR')+line('You receive',formatXmr(s.seller)+' XMR')+line('Protocol fee 5%',formatXmr(s.fee)+' XMR')+line('Listing ends','Block '+count(t.until))+line('Now','Block '+count(height));
  if(r)body+=`<div class="notice">A buyer reserved it until block ${count(heldUntil(r))}. It cannot be stopped while it is reserved.</div><button class="text-btn" id="mord-back">Back</button>`;
  else body+=(t.until<height?`<div class="notice">This listing ended. Stop selling to send it or list it again.</div>`:'')+`<button class="primary wide" id="mord-stop">Stop selling</button><button class="text-btn" id="mord-back">Back</button>`;}
 ui.show('Mordinal #'+count(m.number),body);paint();ui.on('mord-back',back);
 ui.on('mord-send',()=>send(m,height));ui.on('mord-sell',()=>sell(m,height));ui.on('mord-stop',()=>stop(m,height));}
// The exact text, then one signature. track: {op, number, lot} of the record for the waiting list.
function review({title,lines,text,label,toDetail,done,keep,bodyBytes,ctx,track:x}){
 ui.show(title,lines+`<label>You sign this text</label><div class="address mord-text" id="mord-text">${ui.esc(text)}</div><p class="subtle">${SIGN_NOTE}</p>`+actions('mord-sign',label));
 ui.on('mord-back',toDetail);
 ui.on('mord-sign',()=>ui.run(async e=>{
  await service();ui.same(e);if(!canSend())throw Error(READ_ONLY);
  const record=await sign(e,bodyBytes,text,ctx);if(keep){await keep();ui.same(e);}
  const out=await post(e,record,{bodyBytes,...x});
  return done?done(e,out):home(e,out.state==='done'?'':onItsWay(x));}));}

function send(m,height,value=''){
 const me=own();
 ui.show('Send Mordinal #'+count(m.number),`<label for="mord-to">Monero address of the new owner</label><textarea id="mord-to" rows="3" spellcheck="false" autocomplete="off" placeholder="4… or 8…">${ui.esc(value)}</textarea><p class="subtle">The new owner needs a wallet that can sign messages for this address.</p>`+actions('mord-next','Continue'));
 clearOnInput('mord-to');
 ui.on('mord-back',()=>detail(m,height));
 ui.on('mord-next',()=>ui.run(async()=>{
  const typed=ui.$('#mord-to').value.trim();let to;try{to=canonical(typed,CONFIG.network);}catch{throw Error('Enter a Monero address (it starts with 4 or 8).');}
  if(to===me)throw Error('That is this wallet’s own address.');
  const body={reg:m.reg,seq:m.seq,from:me,to},bodyBytes=encodeBody(OP.move,body,CONFIG.network),ctx={domain:CONFIG.domain,number:m.number};
  review({title:'Send Mordinal #'+count(m.number),lines:line('To',ui.short(to)),text:renderText(OP.move,body,bodyBytes,ctx),label:'Sign and send',bodyBytes,ctx,toDetail:()=>send(m,height,typed),track:{op:OP.move,number:m.number}});}));}

function sell(m,height,value=''){
 const me=own();
 ui.show('Sell Mordinal #'+count(m.number),`<label for="mord-price">Price in XMR</label><input id="mord-price" inputmode="decimal" autocomplete="off" placeholder="0" value="${ui.esc(value)}"><p class="field-hint" id="mord-split"></p>`
  +`<p class="subtle">The buyer pays you directly. 5% of the price goes to the protocol fee address. The listing ends at block ${count(height+LISTING_BLOCKS)} (about one day).</p>`+actions('mord-next','Continue'));
 const read=()=>{const p=parseXmr(ui.$('#mord-price').value);if(p<RULES.minPrice)throw Error('The lowest price is '+formatXmr(RULES.minPrice)+' XMR.');return p;};
 const hint=()=>{let text='';try{const s=splitOf(read());text=`You receive ${formatXmr(s.seller)} XMR · protocol fee ${formatXmr(s.fee)} XMR`;}catch{}ui.$('#mord-split').textContent=text;};
 ui.$('#mord-price').oninput=hint;hint();clearOnInput('mord-price');
 ui.on('mord-back',()=>detail(m,height));
 ui.on('mord-next',()=>ui.run(async()=>{
  const typed=ui.$('#mord-price').value.trim();if(!typed)throw Error('Enter a price in XMR.');
  const price=read(),s=splitOf(price),body={reg:m.reg,seq:m.seq,until:height+LISTING_BLOCKS,price,seller:me},bodyBytes=encodeBody(OP.list,body,CONFIG.network),ctx={domain:CONFIG.domain,number:m.number};
  review({title:'Sell Mordinal #'+count(m.number),lines:line('Price',formatXmr(price)+' XMR')+line('You receive',formatXmr(s.seller)+' XMR')+line('Protocol fee 5%',formatXmr(s.fee)+' XMR')+line('Listing ends','Block '+count(body.until)),
   text:renderText(OP.list,body,bodyBytes,ctx),label:'Sign and list',bodyBytes,ctx,toDetail:()=>sell(m,height,typed),track:{op:OP.list,number:m.number}});}));}

function stop(m,height){
 const me=own(),body={lot:m.terms.id,seller:me},bodyBytes=encodeBody(OP.cancel,body,CONFIG.network),ctx={domain:CONFIG.domain,number:m.number};
 review({title:'Stop selling Mordinal #'+count(m.number),lines:line('Listing',formatXmr(m.terms.price)+' XMR'),text:renderText(OP.cancel,body,bodyBytes,ctx),label:'Sign and stop selling',bodyBytes,ctx,toDetail:()=>detail(m,height),
  track:{op:OP.cancel,number:m.number,lot:m.terms.id}});}

// ---- Buy ----
async function market(e){
 const me=own();await service();await loadTable();const v=await api('/listings');ui.same(e);if(!Array.isArray(v.listings))throw Error(BAD_ANSWER);
 const list=v.listings.map(terms).filter(t=>t.seller!==me&&t.until>=info.height),height=info.height;
 const state=t=>{const r=running(t,height);return r?(r.buyer===me?'Reserved by this wallet':'Reserved until block '+count(heldUntil(r))):'Seller '+ui.short(t.seller);};
 ui.show('Buy a Mordinal',(list.length?picturesOffer()+`<div class="section-label"><span>For sale</span><span>${count(list.length)}</span></div>`+list.map(t=>row('mord-lot-'+t.number,'Mordinal #'+count(t.number),state(t),formatXmr(t.price)+' XMR',t.number)).join('')
  :`<div class="empty"><strong>Nothing for sale right now</strong>Listings appear here when owners sell.</div>`)+`<button class="text-btn" id="mord-back">Back</button>`);
 paint();picturesWire(market);ui.on('mord-back',back);
 for(const t of list)ui.on('mord-lot-'+t.number,()=>{const r=running(t,height);if(r&&r.buyer===me)ui.run(x=>pay(x,t.id));else offer(t,height);});}

function offer(t,height){
 const me=own(),r=running(t,height),payBy=Math.min(height+RULES.maxReserve,t.until),s=splitOf(t.price);
 let body=large(t.number)+line('Price',formatXmr(t.price)+' XMR')+line('To the seller',formatXmr(s.seller)+' XMR')+line('Protocol fee 5%',formatXmr(s.fee)+' XMR')+line('Seller',ui.short(t.seller))+line('Listing ends','Block '+count(t.until));
 if(r){ui.show('Mordinal #'+count(t.number),body+`<div class="notice">Another buyer reserved it until block ${count(heldUntil(r))}. Look again after that.</div><button class="text-btn" id="mord-back">Back</button>`);paint();ui.on('mord-back',()=>ui.run(market));return;}
 body+=`<div class="notice">Reserving holds this Mordinal for you until block ${count(payBy)} (about ${Math.max(1,(payBy-height)*2)} minutes), starting when the reservation is in a block. In that time you pay two exact amounts, from this wallet’s XMR or from any other Monero wallet. If you do not pay in time, the reservation ends and nothing is owed.</div>`;
 ui.show('Mordinal #'+count(t.number),body+actions('mord-next','Reserve'));paint();
 ui.on('mord-back',()=>ui.run(market));
 ui.on('mord-next',()=>{
  const b={lot:t.id,payBy,buyer:me,rate:0},bodyBytes=encodeBody(OP.reserve,b,CONFIG.network),ctx={domain:CONFIG.domain,number:t.number,lot:{price:t.price,seller:t.seller},feeAddress:CONFIG.feeAddress};
  review({title:'Reserve Mordinal #'+count(t.number),lines:line('Price',formatXmr(t.price)+' XMR')+line('Pay by','Block '+count(payBy)),text:renderText(OP.reserve,b,bodyBytes,ctx),label:'Sign and reserve',bodyBytes,ctx,
   toDetail:()=>offer(t,height),track:{op:OP.reserve,number:t.number,lot:t.id},done:e=>pay(e,t.id),
    keep:()=>setReserved(me,recordId(CONFIG.domain,bodyBytes),{lot:t.id,number:t.number,seller:t.seller,price:String(t.price),payBy,at:Date.now()})});});}

// A reservation holds nothing until it is in a block, so nothing is paid before that.
function reserving(t,x){
 ui.show('Reserving Mordinal #'+count(t.number),`<span id="mord-wait" hidden></span>`+testNote()+line('Price',formatXmr(t.price)+' XMR')
  +`<div class="notice">Your reservation is on its way to the Monero network. It holds this Mordinal for you once it is in a block, usually within a few minutes. Do not pay before that.</div>`
  +`<p class="busy" id="progress">Waiting for a block…</p><button class="text-btn" id="mord-back">Back</button>`);
 ui.on('mord-back',back);
 watch('mord-wait',4000,async()=>{
  const s=recordState(await api('/status/'+x.id),x.at);if(s==='waiting'||!ui.$('#mord-wait'))return;
  ui.run(e=>s==='done'?pay(e,t.id):home(e));});}

// The purchase of this wallet's reservation: who is paid what, and the ways to pay.
async function pay(e,lotId){
 const me=own();await service();await loadTable();const v=await api('/lot/'+lotId);ui.same(e);if(!v.lot||typeof v.lot!=='object')throw Error(BAD_ANSWER);const t=terms(v.lot),r=t.reservation,height=info.height;
 if(t.id!==lotId)throw Error('The Mordinals service answered with another listing than the one asked for.');
 if(t.status==='sold'){await untrack(me,x=>x.lot===t.id&&x.op===OP.reserve);ui.same(e);return home(e,v.lot.buyer===me?'':'Mordinal #'+count(t.number)+' was sold to another buyer.');}
 if(t.status!=='open'||!r||r.buyer!==me){
  const x=(await sentOf(me)).find(y=>y.op===OP.reserve&&y.lot===t.id);ui.same(e);
  if(x&&recordState(await api('/status/'+x.id).catch(()=>null)||{state:'queued'},x.at)==='waiting'){ui.same(e);return reserving(t,x);}
  return home(e,x?'':'This wallet has no reservation for Mordinal #'+count(t.number)+'.');}
 if(r.rate)throw Error('This reservation was made through a marketplace. Finish it there.');
 const id=recordId(CONFIG.domain,encodeBody(OP.reserve,{lot:t.id,payBy:r.payBy,buyer:me,rate:0},CONFIG.network));
 if(id!==r.record)throw Error('The Mordinals service sent a reservation that does not fit its code.');
 // Pay only what this wallet signed for: the same listing, seller and price that were shown when it reserved.
 const mine=(await reservedOf(me))[id];ui.same(e);
 if(!mine||mine.lot!==t.id||mine.seller!==t.seller||mine.price!==String(t.price)||mine.number!==t.number||mine.payBy!==r.payBy)
  throw Error('This reservation was not made in this wallet on this device, so this wallet does not pay for it. Finish it where it was reserved.');
 await untrack(me,x=>x.id===id);ui.same(e);
 const p={t,r,id,a:amounts({price:t.price,rate:0,code:codeOf(id)}),height,late:height>r.payBy},paid=(await paidOf(me))[id]||await revive(e,me,id);ui.same(e);
 return paid?paidScreen(p,paid):choose(p);}

function choose(p){
 const {t,r,a,height,late}=p,here=Boolean(ui.payXmr)&&!late&&r.payBy-height>=PAY_MARGIN;
 const note=late?`This reservation ran out at block ${count(r.payBy)}. Do not pay now. If you already paid in time from another wallet, you can still finish there.`
  :here?`Pay both exact amounts by block ${count(r.payBy)}. This wallet can pay them in one Monero transaction from its XMR. It adds the Monero network fee and shows it before you approve.`
  :ui.payXmr?`Fewer than ${PAY_MARGIN} blocks are left, too few to pay safely from this wallet. A payment that reaches a block after block ${count(r.payBy)} can be lost.`
  :`Pay both exact amounts by block ${count(r.payBy)} from any Monero wallet.`;
 ui.show('Pay for Mordinal #'+count(t.number),large(t.number)+line('Seller',ui.short(t.seller))+line('To the seller',formatXmr(a.seller)+' XMR')+line('Protocol fee 5%',formatXmr(a.protocol)+' XMR')+line('Together',formatXmr(a.seller+a.protocol)+' XMR')
  +line('Pay by','Block '+count(r.payBy))+line('Now','Block '+count(height))+`<div class="notice">${note}</div><p class="busy" id="progress"></p>`
  +(here?`<button class="primary wide" id="mord-pay-here">Pay from this wallet</button><button class="secondary wide" id="mord-pay-other">Pay from another wallet</button>`:`<button class="primary wide" id="mord-pay-other">${late?'I paid from another wallet':'Pay from another wallet'}</button>`)
  +`<button class="text-btn" id="mord-back">Back</button>`);
 paint();ui.on('mord-back',back);ui.on('mord-pay-other',()=>manual(p));
 ui.on('mord-pay-here',()=>ui.run(async e=>{
  progress('Opening the Monero wallet and checking its balance…');
  const want=[{address:t.seller,amountRaw:String(a.seller)},{address:CONFIG.feeAddress,amountRaw:String(a.protocol)}];let v;
  try{v=await ui.payXmr.prepare(want);}
  catch(error){if(error.code==='xmr-insufficient-unlocked')throw Error(`Not enough unlocked XMR in this wallet for ${formatXmr(a.seller+a.protocol)} XMR plus the network fee. Nothing was sent. Receive XMR first, or pay from another wallet.`);throw error;}
  ui.same(e);
  const fits=v&&typeof v.id==='string'&&/^[0-9a-f]{64}$/.test(v.hash)&&/^[1-9][0-9]{0,15}$/.test(v.feeRaw)&&Array.isArray(v.keys)&&v.keys.length>=1&&v.keys.length<=RULES.maxKeys&&v.keys.every(k=>/^[0-9a-f]{64}$/.test(k))
   &&Number.isSafeInteger(v.chainHeight)&&Array.isArray(v.destinations)&&v.destinations.length===2&&want.every((w,i)=>v.destinations[i]?.address===w.address&&v.destinations[i]?.amountRaw===w.amountRaw);
  if(!fits)throw Error('The Monero wallet prepared something else than this purchase. Nothing was sent.');
  // The Monero node's own newest block decides whether there is still time, not only the Mordinals service.
  if(v.chainHeight>r.payBy-PAY_MARGIN)throw Error(`The Monero network is at block ${count(v.chainHeight)}, too close to the end of this reservation at block ${count(r.payBy)}. Nothing was sent.`);
  approve(p,v);}));}

// The prepared Monero transaction, with its exact network fee, before it is sent.
function approve(p,v){
 const {t,r,a,id}=p,fee=BigInt(v.feeRaw),total=a.seller+a.protocol+fee;
 ui.show('Pay for Mordinal #'+count(t.number),line('Seller',ui.short(t.seller))+line('To the seller',formatXmr(a.seller)+' XMR')+line('Protocol fee 5%',formatXmr(a.protocol)+' XMR')+line('Monero network fee',formatXmr(fee)+' XMR')+line('Total from this wallet',formatXmr(total)+' XMR')
  +`<div class="notice">This sends XMR from this wallet in one Monero transaction and cannot be undone. This wallet pays the network fee shown above. Then the purchase record, which names this payment and its amounts publicly, goes to the Mordinals relay. The payment’s transaction key stays in this wallet.</div>`
  +actions('mord-pay-now','Pay '+formatXmr(total)+' XMR'));
 ui.on('mord-back',()=>choose(p));
 ui.on('mord-pay-now',()=>ui.run(async e=>{
  const me=own();
  if((await paidOf(me))[id]||await revive(e,me,id)){ui.same(e);return pay(e,t.id);}
  if(Date.now()>v.expires-5000)throw Error('This review ran out. Go back and start the payment again. Nothing was sent.');
  // The payment is written down before anything else, so the purchase can always be finished and is never paid twice,
  // also not from a second window of this wallet.
  const entry={lot:t.id,number:t.number,txid:v.hash,keys:v.keys,state:'saved',at:Date.now()};
  await setPaid(me,id,entry);
  try{
   ui.same(e);await service();const now=terms((await api('/lot/'+t.id)).lot);ui.same(e);
   if(now.id!==t.id||now.status!=='open'||now.reservation?.record!==id||Math.max(info.height,v.chainHeight)>r.payBy-PAY_MARGIN+1)throw Error('The reservation changed or is about to run out. Nothing was sent.');
   if((await paidOf(me))[id]?.txid!==entry.txid)throw Error('Another window of this wallet is paying for this purchase. Nothing was sent from this one.');
   ui.same(e);}
  catch(error){if((await paidOf(me))[id]?.txid===entry.txid)await setPaid(me,id,null);throw error;}
  progress('Sending the payment…');
  try{await ui.payXmr.relay(v);}
  catch(error){
   // These three answers mean the Monero wallet never took the payment up.
   if(error.code==='xmr-not-submitted'||/^The Monero wallet was closed before approval/.test(error.message)||error.message==='Wallet is busy syncing.'){await setPaid(me,id,null);throw Error('The payment was not sent. Go back and start it again.');}
   entry.state='unknown';await setPaid(me,id,entry);ui.same(e);return paidScreen(p,entry,'');}
  entry.state='sent';await setPaid(me,id,entry);
  try{ui.same(e);return await finish(e,p,entry);}catch(error){try{ui.same(e);}catch{return;}paidScreen(p,entry,error.message);}}));}

// The purchase record for these payments: {txid, keys}. For each payee it carries a proof made here from the
// transaction key, which is not part of the record. The transactions come from the service; one that does not fit
// the key gives an error, not a proof.
async function buyBody(e,p,payments){
 const {t,a}=p,got=[];
 for(const q of payments){
  const v=await api('/tx/'+q.txid);ui.same(e);
  if(v.payment?.txid!==q.txid||!v.payment.tx||typeof v.payment.tx!=='object')throw Error(BAD_ANSWER);
  got.push({txid:q.txid,tx:v.payment.tx,txKey:q.keys.join('')});}
 let proofs;
 try{proofs=provePayments({lines:[{to:t.seller,amount:a.seller,what:'seller'},{to:CONFIG.feeAddress,amount:a.protocol,what:'protocol fee'}],payments:got,domain:CONFIG.domain,lot:t.id,network:CONFIG.network});}
 catch(error){throw error instanceof TypeError?Error(BAD_ANSWER):error;}
 return encodeBody(OP.buy,{lot:t.id,payments:proofs},CONFIG.network);}

// Hand over the purchase record for a payment this wallet sent. The Monero node needs a moment to see a new payment.
// Two proofs of one payment are never the same bytes, so the record is built once and kept: sending it again sends
// the same record. A record the relay refuses is dropped and built anew the next time.
async function finish(e,p,entry,tries=12){
 const me=own(),{t,id}=p,x={op:OP.buy,number:t.number,lot:t.id};
 for(let i=0;;i++){
  try{
   if(!entry.record){progress('Preparing the purchase record…');entry.record=hex(await buyBody(e,p,[{txid:entry.txid,keys:entry.keys}]));await setPaid(me,id,entry);ui.same(e);}
   const bodyBytes=unhex(entry.record),out=await post(e,bodyBytes,{bodyBytes,...x});entry.state='recorded';await setPaid(me,id,entry);ui.same(e);
   return home(e,out.state==='done'?'':'Paid. Your purchase of Mordinal #'+count(t.number)+' is waiting for a block. It becomes yours then.');}
  catch(error){
   const unseen=NOT_SEEN.test(error.message);
   if(entry.record&&error.refused&&!unseen){delete entry.record;if(entry.state==='recorded')entry.state='sent';await setPaid(me,id,entry);}
   if(i>=tries||!unseen)throw error;
   progress('Waiting for the Monero node to see the payment…');await sleep(2500);ui.same(e);}}}

function paidScreen(p,entry,message='',gone=false){
 const {t,a,id}=p,unsure=entry.state==='unknown'||entry.state==='saved';
 ui.show('Pay for Mordinal #'+count(t.number),line('Payment',ui.short(entry.txid))+line('To the seller',formatXmr(a.seller)+' XMR')+line('Protocol fee 5%',formatXmr(a.protocol)+' XMR')
  +`<div class="notice" id="mord-paid">${gone?'The Monero node has not seen this payment, so it most likely never left this wallet. Look at this wallet’s Monero screen. Only if the payment is not listed there, start the payment again.'
   :unsure?'This wallet could not confirm that the payment reached the Monero network. Check it on this wallet’s Monero screen first. Do not pay again from another wallet.'
   :entry.state==='recorded'?'This wallet paid for this purchase and handed over the purchase record. It is waiting for a block.'
   :'This wallet paid for this purchase. Finishing hands over the purchase record. The Mordinal becomes yours when the payment and the record are in a block.'}</div>`
  +`<div><button class="text-btn" id="mord-copy-txid" data-keep>Copy transaction ID</button></div><p class="busy" id="progress"></p><button class="primary wide" id="mord-finish">${entry.state==='recorded'?'Send the record again':'Finish purchase'}</button>`
  +(gone?`<button class="secondary wide" id="mord-restart">Start the payment again</button>`:'')+`<button class="text-btn" id="mord-back">Back</button>`);
 if(message&&ui.$('#error'))ui.$('#error').textContent=message;
 ui.on('mord-copy-txid',()=>copy(entry.txid,'Transaction ID'));ui.on('mord-back',back);
 ui.on('mord-restart',()=>ui.run(async e=>{await setAside(own(),id,entry);ui.same(e);return pay(e,t.id);}));
 ui.on('mord-finish',()=>ui.run(async e=>{
  await service();ui.same(e);const old=unsure&&Date.now()-entry.at>NOT_SENT_AFTER;
  try{return await finish(e,p,entry,old?0:12);}
  catch(error){if(!old||!NOT_SEEN.test(error.message))throw error;ui.same(e);return paidScreen(p,entry,'',true);}}));}

// Paid from another Monero wallet: the two exact payments, then the purchase record from the pasted payment details.
function manual(p,typed=[{txid:'',key:''}]){
 const {t,r,a,height,late}=p;
 const box=(n,label,amount,address)=>`<div class="section-label"><span>Payment ${n} of 2 · ${label}</span></div><label>Exact amount</label><div class="address" id="mord-amount-${n}">${formatXmr(amount)}</div><button class="text-btn" id="mord-copy-amount-${n}" data-keep>Copy amount</button>`
  +`<label>Monero address</label><div class="address" id="mord-address-${n}">${ui.esc(address)}</div><button class="text-btn" id="mord-copy-address-${n}" data-keep>Copy address</button>`;
 const field=(q,i)=>`<label for="mord-txid-${i}">Transaction ID${typed.length>1?' '+(i+1):''}</label><input id="mord-txid-${i}" spellcheck="false" autocomplete="off" value="${ui.esc(q.txid)}"><label for="mord-key-${i}">Transaction key${typed.length>1?' '+(i+1):''}</label><input id="mord-key-${i}" spellcheck="false" autocomplete="off" value="${ui.esc(q.key)}">`;
 ui.show('Pay for Mordinal #'+count(t.number),
  (late?`<div class="notice">This reservation ran out at block ${count(r.payBy)}. Do not pay now. If you already paid in time, you can still finish.</div>`
   :`<div class="notice">Pay both exact amounts by block ${count(r.payBy)} (now block ${count(height)}) from any Monero wallet. That wallet adds its own network fee. A different amount does not count.</div>`)
  +box(1,'to the seller',a.seller,t.seller)+box(2,'protocol fee',a.protocol,CONFIG.feeAddress)
  +`<div class="section-label"><span>After paying</span></div><p class="subtle">Paste each payment’s transaction ID and transaction key from the wallet that paid. One transaction can make both payments. The purchase record names these payments and their amounts publicly. The transaction key is used here to make the proof in that record; it is not sent or saved.</p>`
  +typed.map(field).join('')+(typed.length<RULES.maxPayments?`<div><button class="text-btn" id="mord-more" data-keep>Add another transaction</button></div>`:'')
  +actions('mord-finish','Finish purchase'));
 const values=()=>typed.map((q,i)=>({txid:ui.$('#mord-txid-'+i).value.trim().toLowerCase(),key:ui.$('#mord-key-'+i).value.trim().toLowerCase()}));
 for(const n of [1,2]){ui.on('mord-copy-amount-'+n,()=>copy(ui.$('#mord-amount-'+n).textContent,'Amount'));ui.on('mord-copy-address-'+n,()=>copy(ui.$('#mord-address-'+n).textContent,'Address'));}
 clearOnInput(...typed.flatMap((q,i)=>['mord-txid-'+i,'mord-key-'+i]));
 ui.on('mord-more',()=>manual(p,[...values(),{txid:'',key:''}]));
 ui.on('mord-back',()=>choose(p));
 ui.on('mord-finish',()=>ui.run(async e=>{
  const payments=values().filter(q=>q.txid||q.key).map(q=>{
   if(!/^[0-9a-f]{64}$/.test(q.txid))throw Error('A transaction ID is 64 hexadecimal characters.');parseTxKey(q.key);return {txid:q.txid,keys:q.key.match(/.{64}/g)};});
  if(!payments.length)throw Error('Paste the transaction ID and transaction key of your payment.');
  if(new Set(payments.map(q=>q.txid)).size!==payments.length)throw Error('The same transaction ID is given twice.');
  await service();ui.same(e);progress('Preparing the purchase record…');let bodyBytes;
  try{bodyBytes=await buyBody(e,p,payments);}
  catch(error){throw error.status===404&&NOT_SEEN.test(error.message)?Error('The Monero node has not seen this payment yet. Wait a few seconds and try again.'):error;}
  const out=await post(e,bodyBytes,{bodyBytes,op:OP.buy,number:t.number,lot:t.id});
  return home(e,out.state==='done'?'':out.state==='held'?'Your purchase of Mordinal #'+count(t.number)+' waits for the payment to reach a block. It becomes yours then.':'Your purchase of Mordinal #'+count(t.number)+' is waiting for a block. It becomes yours then.');}));}

export function openMordinals(host){
 ui=host;if(!CONFIG){ui.toast('Coming soon');return;}
 ui.show('Mordinals','<p class="busy" id="progress">Loading…</p>');ui.run(e=>home(e));}
