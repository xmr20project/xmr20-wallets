// MONERO MARKET candidate (29 Oct 2026): the wallet side of the market, running in the extension's own market window.
// A port of the lab's wallet process (research/monero-market-20261029/wallet/wallet-process.mjs) onto the real wallet:
//   - the engine is the token worker (holder.wasm with the market ops); every key stays there;
//   - durable state is the ENCRYPTED market journal (private-journal.js, slot xmr20-market-journal, sealed with a key the
//     worker derives from the account root): a seller signature is journaled BEFORE it leaves, a buyer's signed sale BEFORE
//     it is broadcast, and retries re-send the same bytes;
//   - approvals exist only here (the wallet's own window); the website gets the bounded market.* v2 views through the
//     background and can never approve;
//   - OFFLINE FAKECHAIN ONLY: the engine refuses market signatures on any other network. Real trading disabled.
// Stand-ins kept from the lab, labelled: the order book's unauthenticated relay and its keyless NFT index.
import {listingMessage,listingId,withdrawMessage,validateListing} from './market-nft-messages.js';
import {verifySigV2} from '../token/market-nft-ledger.js';
import {newRelayKey,seal,open as openSealed,relayKeyMessage,isRelayKey} from './market-relay-seal.js';
export const PROTOCOL='xmr20-market-wallet/2';
const hex32=/^[0-9a-f]{64}$/,dec=/^(0|[1-9][0-9]{0,19})$/;
const LIVE_BUYER=new Set(['requested','drafting','awaiting-seller','awaiting-approval','signed','published','uncertain','delivered','unconfirmed']);
const counterpartyOf=t=>t.counterparty||(t.role==='seller'?t.buyer:t.seller);
const xa1Inputs=wire=>{const b=Uint8Array.from(wire.match(/../g),x=>parseInt(x,16));const n=b[36];const h=u=>Array.from(u,x=>x.toString(16).padStart(2,'0')).join('');return Array.from({length:n},(_,i)=>h(b.subarray(38+32*i,70+32*i)));};
const publicError=e=>String(e?.message||e).replace(/[0-9a-f]{65,}/g,'…').slice(0,300);
const randomHex=n=>Array.from(crypto.getRandomValues(new Uint8Array(n)),x=>x.toString(16).padStart(2,'0')).join('');
const sha256hex=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),x=>x.toString(16).padStart(2,'0')).join('');
const fail=(msg,status)=>Object.assign(Error(msg),{status});
export function emptyMarketState(){return {version:1,requests:{},approvals:{},trades:{},offers:{},lots:{},rings:{},nftListings:{},nftRings:{},nftCancels:{},relists:{},spares:{},waiting:{},spareError:null,relayKey:null,relayCursor:0,events:[]};}
/**
 * client: the token worker client (call(action,args,timeout,{idle})). journal: a private journal (write/read) unlocked for
 * the market slot. ids: {ownerKey, nativeAddress, tokenAddress}. manifest: the shipped parameter manifest. marketUrl: the
 * pinned order-book origin. finality: D (from the engine's market profile). accountId: a public label for the binding.
 * lotPayout (optional, Monero accounts service only): {address, sign(message)→SigV2} — token-lot sales pay that standard
 * address (the service's XMR wallet) instead of this wallet's own, and its relay key is attested by that address.
 * anchorMode (optional): 'spare' or 'inline' — default 'spare' everywhere but the offline lab chain (see spare anchors below).
 */
export function createMarketHost({client,journal,ids,manifest,marketUrl,finality,asset,accountId,lotPayout=null,anchorMode=null,sessionId=randomHex(12),fetch:f=globalThis.fetch.bind(globalThis),now=()=>Math.floor(Date.now()/1000),log=()=>{},onChange=()=>{}}){
 const {ownerKey,nativeAddress,tokenAddress}=ids;
 let doc=emptyMarketState(),holder=null,mst=null,synced=null,syncError=null,nftIndex={tokens:[],indexedHeight:-1,confirmations:finality},busy=Promise.resolve(),closed=false;
 const serial=fn=>{const p=busy.then(fn);busy=p.catch(()=>{});return p;};
 const ns=j=>{j.market??={};const m=(j.market[tokenAddress]??=emptyMarketState());for(const k of Object.keys(emptyMarketState()))m[k]??=emptyMarketState()[k];return m;};
 // Durable update: the mutator runs on the latest journal content under the cross-window lock; the mirror follows the result.
 async function update(mutate,label=null){doc=await journal.write(j=>{const m=ns(j);mutate(m);if(label)m.events.push({at:Date.now(),label});if(m.events.length>200)m.events.splice(0,m.events.length-200);return JSON.parse(JSON.stringify(m));});onChange();return doc;}
 const history=(t,phase,note=null)=>{t.phase=phase;t.updatedAt=Date.now();(t.history||=[]).push({at:Date.now(),phase,...(note?{note:String(note).slice(0,300)}:{})});};
 const mk=async(p,body)=>{let r;try{r=await f(marketUrl+p,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000),credentials:'omit',redirect:'error'});}catch(e){throw Object.assign(Error('Order book unreachable: '+publicError(e)),{status:0});}const v=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(Error(v.error||('market '+r.status)),{status:r.status});return v;};
 // Sealed relay (review W7): bodies are sealed to the counterparty's relay key (market-relay-seal.js); the first request carries
 // this wallet's own key inside. The relay key pair lives in the encrypted market journal.
 const relayWith=async(R,to,type,tradeId,body={})=>{if(!isRelayKey(R))throw Error('No relay key for this counterparty');const me=doc.relayKey;const h={to,from:ownerKey,type,tradeId};
  return mk('/api/relay',{...h,body:type==='request'?await seal({...body,buyerKey:me.pub},h,R):await seal(body,h,R,me)});};
 const relay=(to,type,tradeId,body={})=>relayWith(doc.trades[tradeId]?.peerKey,to,type,tradeId,body);
 const payoutAddress=lotPayout?.address||nativeAddress;
 const attest=async id=>({key:doc.relayKey.pub,signature:lotPayout?await lotPayout.sign(relayKeyMessage(id,doc.relayKey.pub)):(await w.signMessage(relayKeyMessage(id,doc.relayKey.pub))).signature});
 // A token lot's payout address is on the ledger's network (stagenet: prefix 0x18); NFT owners are always mainnet-format.
 const lotPrefix=manifest.network?.kind==='stagenet'?0x18:0x12;
 const sellerKey=(id,r,address,prefix=0x12)=>{if(!r||!isRelayKey(r.key)||!verifySigV2(relayKeyMessage(id,r.key),address,r.signature,prefix))throw fail('The listing has no valid relay key attestation from its seller',422);return r.key;};
 const w={
  sync:()=>client.call('sync',{reserveKeyImages:[]},600000,{idle:true}),
  marketStatus:()=>client.call('marketStatus',{},60000),
  nativeRelease:keyImages=>client.call('nativeRelease',{keyImages},30000),
  recoverReserve:keyImages=>client.call('marketRecoverReserve',{keyImages},30000),
  lookup:txid=>client.call('carrierLookup',{txid},60000),
  publish:blob=>client.call('carrierPublish',{blob},120000),
  publishWithRecovery:(blob,txid)=>client.call('carrierPublishRecover',{blob,txid},240000),
  checkOffer:(wire,t)=>client.call('marketCheckOffer',{wire,now:t},30000),
  ring:lot=>client.call('marketRing',{lot},300000),
  buy:a=>client.call('marketBuy',a,300000),buyDraft:buildId=>client.call('marketBuyDraft',{buildId},120000),
  sellerApprove:a=>client.call('marketSellerApprove',a,120000),buyerFinish:a=>client.call('marketBuyerFinish',a,120000),
  prepareLot:a=>client.call('marketPrepare',a,300000),cancelLot:lot=>client.call('marketCancelLot',{lot},300000),spare:()=>client.call('marketSpare',{},300000),
  sign:buildId=>client.call('marketSign',{buildId},120000),cancelBuild:buildId=>client.call('marketCancel',{buildId},30000),
  offer:a=>client.call('marketOffer',a,30000),withdraw:a=>client.call('marketWithdraw',a,30000),
  signMessage:message=>client.call('marketSignMessage',{message},30000),
  anchorSpent:async keyImage=>(await client.call('marketAnchorSpent',{keyImage},30000)).spent,
  // Anchored NFT sales (30 Oct 2026): the worker keeps this wallet's own NFT ledger and runs the NFT constructions.
  nftLedger:()=>client.call('nftLedger',{},600000,{idle:true}),
  nftAnchor:async a=>{const r=await client.call('nftAnchorStart',a,300000);return client.call('nftAnchorSign',{buildId:r.buildId},120000);},
  nftRing:anchor=>client.call('nftRing',{anchor},300000),
  nftBuy:a=>client.call('nftBuy',a,300000),nftBuyDraft:buildId=>client.call('nftBuyDraft',{buildId},120000),
  nftSellerApprove:a=>client.call('nftSellerApprove',a,120000),nftBuyerFinish:a=>client.call('nftBuyerFinish',a,120000),
 };
 const records=()=>Object.values(holder?.records||{});
 // The wallet's OWN NFT ledger (worker, market reader rules over its own node): every ownership, last-event and anchor fact a
 // signature or payment depends on. The order book's index (nftIndex) is display data only.
 let nftLedger={tokens:[],events:[],tip:-1};
 const ledgerToken=id=>nftLedger.tokens.find(t=>t.id===id)||null;
 const anchorHeld=ki=>Boolean(ki)&&(holder?.native?.outputs||[]).some(o=>o.keyImage===ki&&!o.spent);
 const anchorDepth=t=>t?.anchorHeight==null?0:Math.max(0,nftLedger.tip+1-t.anchorHeight);
 const ownedNfts=()=>nftLedger.tokens.filter(t=>t.owner===nativeAddress).map(t=>{const d=nftIndex.tokens.find(x=>x.id===t.id)||{};const held=anchorHeld(t.anchor);
  return {...d,id:t.id,owner:t.owner,last:t.last,edition:t.edition,collection:t.collection,name:d.name||t.name,collectionName:d.collectionName||t.collectionName,anchor:t.anchor,anchorHeight:t.anchorHeight,anchorHeld:held,anchorConfirmations:anchorDepth(t),saleReady:held&&anchorDepth(t)>=finality};});
 const nftBusy=token=>Object.values(doc.trades).some(x=>x.kind==='nft'&&x.role==='seller'&&x.token===token&&['awaiting-approval','released','published','delivered'].includes(x.phase));
 // ---- Spare anchors (31 Oct 2026, DECISION-ANCHOR-PRIVACY.md). A lot, or a lot this wallet buys, names an anchor made EARLIER
 // in an ordinary-looking payment to this wallet's anchor key, so its later sale or cancellation hides that coin among 16
 // ordinary ring members (no real-spend leak, no black marble). Spares only, except on the offline lab chain (inline anchors
 // unless anchorMode is 'spare'). An operation that finds no ready spare waits while the wallet makes one (usable after 10
 // blocks); once the wallet has used the market it keeps one spare ready. A spare key image is named at most once.
 const spareMode=(anchorMode||(manifest.network?.kind==='offline-fakechain'?'inline':'spare'))==='spare';
 const SPARE_FEE_CAP=10_000_000_000n;
 const namedSpares=()=>{const s=new Set();for(const l of Object.values(doc.lots))if(l.anchor)s.add(l.anchor);for(const t of Object.values(doc.trades))if(t.spare)s.add(t.spare);for(const x of Object.values(doc.waiting))if(x.spare)s.add(x.spare);return s;};
 const freeSpares=()=>{const n=namedSpares();return (mst?.spares?.ready||[]).filter(x=>!n.has(x.keyImage));};
 const comingSpares=()=>{const n=namedSpares(),known=new Set([...(mst?.spares?.ready||[]),...(mst?.spares?.maturing||[])].map(x=>x.keyImage));
  return (mst?.spares?.maturing||[]).filter(x=>!n.has(x.keyImage)).length+Object.values(doc.spares).filter(x=>x.status==='sent'&&!known.has(x.anchor)&&Date.now()-x.createdAt<6*3600e3).length;};
 const waitingCount=()=>Object.values(doc.waiting).filter(x=>x.status==='waiting').length+Object.values(doc.trades).filter(t=>t.role==='buyer'&&t.phase==='waiting-anchor').length;
 const marketUsed=()=>Object.keys(doc.lots).length>0||Object.values(doc.trades).some(t=>t.role==='buyer');
 async function makeSpare(){
  const q=await w.spare();
  if(BigInt(q.fee)>SPARE_FEE_CAP){await w.cancelBuild(q.buildId);throw Error(`Network fee ${q.fee} for a spare anchor is above ${SPARE_FEE_CAP}`);}
  const s=await w.sign(q.buildId);
  await update(x=>{x.spares[s.txid]={txid:s.txid,blob:s.blob,anchor:s.anchorKeyImage,fee:s.fee,status:'sent',createdAt:Date.now()};},'spare-signed');
  const p=await w.publishWithRecovery(s.blob,s.txid);
  if(!p.ok){await update(x=>{x.spares[s.txid].status='refused';});throw Error('Spare anchor payment not accepted: '+(p.reason||p.status));}
  return s;
 }
 // In tick (serialised): start what waits for a spare, then make one more if the waiting work (+1 kept ready) needs it.
 async function spareWork(){
  if(!spareMode||!mst)return;
  for(const wt of Object.values(doc.waiting)){
   if(wt.status!=='waiting')continue;const pick=freeSpares()[0];if(!pick)break;
   await update(x=>{x.waiting[wt.id].spare=pick.keyImage;});
   try{const r=await prepareWith(wt.review,pick.keyImage);
    await update(x=>{Object.assign(x.waiting[wt.id],{status:'done',result:r});const q=wt.requestId&&x.requests[wt.requestId];if(q)q.result={...q.result,...r,waiting:null};},'prepare-from-spare');}
   catch(e){const msg=publicError(e);await update(x=>{Object.assign(x.waiting[wt.id],{status:'failed',error:msg});const q=wt.requestId&&x.requests[wt.requestId];if(q){q.status='failed';q.error=msg;}});}
  }
  for(const t of Object.values(doc.trades)){
   if(t.role!=='buyer'||t.phase!=='waiting-anchor')continue;const pick=freeSpares()[0];if(!pick)break;
   await update(x=>{const tt=x.trades[t.tradeId];tt.spare=pick.keyImage;history(tt,'requested');});
   await relay(t.seller,'request',t.tradeId,{offerId:t.offerId}).catch(e=>log('relay request',publicError(e)));
  }
  if(freeSpares().length+comingSpares()<waitingCount()+(marketUsed()?1:0)){
   try{await makeSpare();if(doc.spareError)await update(x=>{x.spareError=null;});}catch(e){const msg=publicError(e);await update(x=>{x.spareError=msg;});}
  }
 }
 async function checkListing(e,tok){
  const l=validateListing(e.listing);
  if(l.genesis!==manifest.network.genesis)throw Error('Listing is for another chain');if(!tok)throw Error('Listed NFT is not on this chain');
  if(tok.last!==l.last)throw Error('The NFT moved since this listing was signed');if(tok.owner!==l.owner)throw Error('Listing signer is not the current owner');
  if(l.created>now()+300)throw Error('Listing created in the future');if(now()>=l.expires)throw Error('Listing expired');
  if(!verifySigV2(await listingMessage(l),l.owner,e.signature))throw Error('Listing signature rejected');
  return listingId(l);
 }
 // ---- Stalled buyers (owner decision 30 Oct 2026). After an automatic approval the buyer has stallSeconds (default 10 min) to
 // put the sale in the node's pool; payBy travels with the seller's signature so the buyer's review can show it. Past that,
 // the seller's wallet cancels on chain (spending the anchor makes the released signature useless) and lists the same item
 // again at the same terms once it is ready: an NFT re-anchors (nftAnchoring() posts the listing when final); a lot is
 // cancelled, made again from the returned Open balance and listed when final. A cancellation the node refuses (the
 // payment is already in the pool) is not retried and nothing is relisted; the sale then completes as usual.
 const STALL_DEFAULT=600;
 const payWindow=t=>{const s=t.kind==='nft'?doc.nftListings[t.listingId]?.stallSeconds:doc.offers[t.offerId]?.stallSeconds;return s?{payBy:Date.now()+s*1000}:{};};
 const payByOf=b=>Number.isSafeInteger(b?.payBy)?b.payBy:null;
 const approvalOf=b=>{const {payBy,...rest}=b||{};return rest;};
 async function stalls(){
  for(const t of Object.values(doc.trades)){
   if(t.role!=='seller'||t.phase!=='released'||t.stallCancel||!t.payBy||Date.now()<t.payBy)continue;
   await update(x=>{x.trades[t.tradeId].stallCancel='started';});
   const why='the buyer did not pay in time; cancelled on chain and listed again when ready';
   try{
    if(t.kind==='nft'){
     const l=doc.nftListings[t.listingId];
     await execute({kind:'nftCancel',review:{token:t.token,maxFee:'10000000000'}});
     const c=doc.nftCancels[t.token],lifetime=l?.lifetime||Math.max(300,(l?.listing?.expires||0)-(l?.listing?.created||0))||86400;
     await update(x=>{const id='anchoring:'+t.token;x.nftListings[id]={id,token:t.token,price:t.price,lifetime,approval:'auto',stallSeconds:l?.stallSeconds||STALL_DEFAULT,anchorTxid:c.txid,anchorKeyImage:c.anchorKeyImage,status:'anchoring',relisted:t.listingId,createdAt:Date.now()};
      const tt=x.trades[t.tradeId];tt.stallCancel='cancelled';history(tt,'cancelled',why);},'stall-cancel');
    }else{
     const o=doc.offers[t.offerId];
     const r=await execute({kind:'cancelLot',review:{lot:t.lot,quantity:t.quantity,released:true}});
     await update(x=>{x.relists[t.lot]={from:t.lot,offerId:t.offerId,quantity:t.quantity,price:t.price,lifetime:o?.lifetime||86400,stallSeconds:o?.stallSeconds||STALL_DEFAULT,cancelTxid:r.txid,stage:'cancelling',attempts:0,createdAt:Date.now()};
      const tt=x.trades[t.tradeId];tt.stallCancel='cancelled';history(tt,'cancelled',why);},'stall-cancel');
    }
   }catch(e){const msg=publicError(e);
    await update(x=>{const tt=x.trades[t.tradeId];tt.stallCancel='refused';(tt.history||=[]).push({at:Date.now(),phase:tt.phase,note:'automatic cancellation not accepted (the payment may already be in the pool): '+msg});});}
  }
 }
 // Lot relisting after a stall: cancel mined → make the same lot again → list it when final, at the same terms.
 async function relists(){
  for(const r of Object.values(doc.relists)){
   if(!['cancelling','preparing'].includes(r.stage)||!mst)continue;
   const set=patch=>update(x=>{Object.assign(x.relists[r.from],patch);});
   try{
    if(r.stage==='cancelling'){
     if(records().some(x=>x.kind==='lot-sale'&&x.status==='accepted'&&x.detail?.lot===r.from)){await set({stage:'sold'});continue;}
     const k=await w.lookup(r.cancelTxid).catch(()=>null);if(!k?.known||k.inPool||mst.lots.some(l=>l.id===r.from))continue;
     if(BigInt(mst.openBalances[asset]||'0')<BigInt(r.quantity))continue;
     if(spareMode&&!freeSpares().length)continue;// spareWork keeps one coming once the market is used
     const p=await execute({kind:'prepare',review:{asset,quantity:r.quantity,maxFee:'10000000000'}});
     await set({stage:'preparing',lot:p.lot,prepareTxid:p.txid});
    }else{
     const lot=mst.lots.find(l=>l.id===r.lot);if(!lot?.tradable)continue;
     const o=await execute({kind:'list',review:{lot:r.lot,price:r.price,lifetime:r.lifetime,approval:'auto',stallSeconds:r.stallSeconds}});
     await set({stage:'listed',offerId:o.offerId});
    }
   }catch(e){const n=(r.attempts||0)+1;await set({attempts:n,error:publicError(e),...(n>=20?{stage:'failed'}:{})});}
  }
 }
 const lotBusy=lot=>Object.values(doc.trades).some(x=>x.role==='seller'&&x.lot===lot&&['awaiting-approval','released','published','delivered'].includes(x.phase));
 const refusals=new Map();
 // ---- start: load the journal, re-reserve the funding of unfinished buyer trades (same as the lab's restart recovery)
 // NFTs (31 Oct 2026): while the order book says NFT trading is "soon" (mainnet), the wallet skips all NFT work. Its NFT ledger reads
 // every block since the ledger start through the node (thousands of blocks on mainnet) and every request waited behind it.
 let nftsOn=true;
 async function start(){
  try{const s=await mk('/api/market');if(s?.nftTrading==='soon')nftsOn=false;}catch(e){log('market summary',publicError(e));}
  doc=JSON.parse(JSON.stringify(ns(await journal.read())));
  const reserve=[];for(const t of Object.values(doc.trades))if(t.role==='buyer'&&t.fundingKeyImages&&LIVE_BUYER.has(t.phase))reserve.push(...t.fundingKeyImages);
  if(reserve.length)await w.recoverReserve(reserve).catch(e=>log('recoverReserve',publicError(e)));
  await update(m=>{m.relayKey??=newRelayKey();m.events.push({at:Date.now(),label:'start',session:sessionId});});
 }
 async function tick(){
  if(closed)return;
  try{holder=await w.sync();mst=await w.marketStatus();synced=Date.now();syncError=null;}catch(e){syncError=publicError(e);onChange();return;}
  if(nftsOn){
   try{nftIndex=await mk('/api/nfts');}catch(e){log('nft index',publicError(e));}
   try{nftLedger=await w.nftLedger();}catch(e){log('nft ledger',publicError(e));}
   await nftAnchoring().catch(e=>log('nft anchoring',publicError(e)));
  }
  await handleRelay().catch(e=>log('relay',publicError(e)));
  await track().catch(e=>log('track',publicError(e)));
  await stalls().catch(e=>log('stalls',publicError(e)));
  await relists().catch(e=>log('relists',publicError(e)));
  await spareWork().catch(e=>log('spares',publicError(e)));
  await autoLists().catch(e=>log('auto list',publicError(e)));
  await announcePending().catch(e=>log('announce',publicError(e)));
  await outbox().catch(e=>log('outbox',publicError(e)));
  onChange();
 }
 // Listing soon, for everyone (31 Oct 2026, owner: "so when someone lists a token it shows on everyones monero market"): a make-and-list
 // lot that waits for its anchor or for its first block is announced to the order book — signed by this wallet's Monero address over
 // an id that commits to asset, quantity, price, address and a nonce — and renewed every minute until it is listed. The nonce lives in
 // the approved listing terms, so the lot made from a waiting request keeps the same id (one public row from approval to listing).
 const announced=new Map();
 async function announcePending(){
  if(lotPayout)return;const t=Date.now(),items=[];
  for(const x of Object.values(doc.waiting))if(x.status==='waiting'&&x.kind==='prepare'&&x.review?.list?.price)
   items.push({key:'w:'+x.id,stage:'anchor',quantity:x.review.quantity,price:x.review.list.price,nonce:x.review.list.pendNonce,save:n=>update(d=>{d.waiting[x.id].review.list.pendNonce=n;})});
  for(const l of Object.values(doc.lots)){const al=l.autoList;if(!al||al.status!=='waiting'||l.cancelTxid)continue;
   items.push({key:'l:'+l.lot,stage:'lot',quantity:l.quantity,price:al.price,nonce:al.pendNonce,save:n=>update(d=>{d.lots[l.lot].autoList.pendNonce=n;})});}
  for(const it of items){
   if(t-(announced.get(it.key)||0)<60000)continue;announced.set(it.key,t);
   let nonce=it.nonce;if(!nonce){nonce=randomHex(32);await it.save(nonce);}
   const id=await sha256hex(['xmr20-market-pending-v1',asset,it.quantity,it.price,nativeAddress,nonce].join('|'));
   await mk('/api/pending',{asset,quantityAtoms:it.quantity,totalPiconero:it.price,payoutAddress:nativeAddress,nonce,stage:it.stage,relay:await attest(id)}).catch(e=>log('announce',publicError(e)));
  }
 }
 // Make and list: the listing approved with the lot is signed and posted once the lot is in a block (one approval in all).
 // Runs inside tick, which already holds serial(): listLot is called directly.
 async function autoLists(){
  for(const l of Object.values(doc.lots)){
   const al=l.autoList;if(!al||al.status!=='waiting'||l.cancelTxid)continue;
   const lot=mst?.lots?.find(x=>x.id===l.lot);if(!lot||!lot.anchorHeld||!(lot.confirmations>=1))continue;
   if(Object.values(doc.offers).some(o=>o.lot===l.lot&&['listed','posting'].includes(o.status))){await update(x=>{x.lots[l.lot].autoList.status='listed';});continue;}
   try{const r=await listLot({lot:l.lot,price:al.price,lifetime:al.lifetime,approval:al.approval,stallSeconds:al.stallSeconds});await update(x=>{Object.assign(x.lots[l.lot].autoList,{status:'listed',offerId:r.offerId});});}
   catch(e){await update(x=>{Object.assign(x.lots[l.lot].autoList,{status:'failed',error:publicError(e)});});}
  }
 }
 async function outbox(){
  for(const t of Object.values(doc.trades)){
   if(t.role==='seller'&&t.phase==='released'&&t.released&&!t.releasedSent){
    try{await relay(counterpartyOf(t),'approval',t.tradeId,t.released);await update(x=>{x.trades[t.tradeId].releasedSent=true;history(x.trades[t.tradeId],'released','journaled approval delivered (same signature)');});}catch(e){log('outbox approval',publicError(e));}
   }
   if(t.role==='buyer'&&t.finalBlob&&['signed','uncertain'].includes(t.phase)){
    const p=await w.publishWithRecovery(t.finalBlob,t.txid).catch(e=>({ok:false,reason:e.message}));
    await update(x=>{history(x.trades[t.tradeId],p.ok?'published':(p.uncertain?'uncertain':'refused'),p.ok?(p.recovered?'already known to the node':'same bytes re-sent'):(p.reason||p.status));});
   }
  }
  for(const o of Object.values(doc.offers))if(o.status==='posting'){try{await mk('/api/offers',{wire:o.wire,relay:await attest(o.offerId)});await update(x=>{x.offers[o.offerId].status='listed';});}catch(e){log('outbox offer',publicError(e));}}
  for(const l of Object.values(doc.nftListings))if(l.status==='posting'){try{await mk('/api/nft-listings',{listing:l.listing,signature:l.signature,relayTo:ownerKey,relay:await attest(l.id)});await update(x=>{x.nftListings[l.id].status='listed';});}catch(e){if(e.status>=400&&e.status<500)await update(x=>{x.nftListings[l.id].status='rejected';x.nftListings[l.id].error=publicError(e);});else log('outbox nft listing',publicError(e));}}
 }
 async function handleRelay(){
  const cursor=doc.relayCursor||0;
  const {messages=[]}=await mk(`/api/relay?to=${ownerKey}&after=${cursor}`);
  for(const m of messages){try{
   const h={to:m.to,from:m.from,type:m.type,tradeId:m.tradeId};let plain=null,peerKey=null;
   if(m.type==='request'){if(m.body?.mode==='anon'){plain=await openSealed(m.body,h,doc.relayKey).catch(()=>null);peerKey=isRelayKey(plain?.buyerKey)?plain.buyerKey:null;}}
   else{const t=doc.trades[m.tradeId];if(t?.peerKey&&m.body?.mode==='auth')plain=await openSealed(m.body,h,doc.relayKey,t.peerKey).catch(()=>null);}
   if(plain&&(m.type!=='request'||peerKey))await onMessage({...m,body:plain,peerKey});
  }catch(e){log('message',m.type,publicError(e));}await update(d=>{d.relayCursor=Math.max(d.relayCursor||0,m.id);});}
 }
 async function onMessage(m){
  const t=doc.trades[m.tradeId];
  if(m.type==='request'&&m.body?.kind==='nft')return t?undefined:nftRequest(m);
  if(t?.kind==='nft'&&['draft','ring','approval'].includes(m.type)&&m.from===counterpartyOf(t))return nftMessage(t,m);
  if(m.type==='request'){
   if(t)return;const offer=doc.offers[m.body?.offerId];
   const last=refusals.get(m.from)||0;const refuse=async reason=>{if(Date.now()-last<60000)return;refusals.set(m.from,Date.now());await relayWith(m.peerKey,m.from,'reject',m.tradeId,{reason});};
   if(!offer||offer.status!=='listed')return refuse('Offer not available');
   if(lotBusy(offer.lot))return refuse('This lot is reserved by another buyer’s trade');
   let ring=doc.rings[offer.lot];
   if(!ring){const r=await w.ring(offer.lot);ring={keyImage:r.keyImage,decoys:r.decoys,amount:r.amount};await update(d=>{d.rings[offer.lot]=ring;});}
   const rec={role:'seller',tradeId:m.tradeId,peerKey:m.peerKey,offerId:m.body.offerId,offer:offer.wire,lot:offer.lot,buyer:m.from,counterparty:m.from,quantity:offer.quantity,price:offer.price,ring,createdAt:Date.now()};
   history(rec,'ring-sent');await update(d=>{d.trades[m.tradeId]=rec;});
   return relay(m.from,'ring',m.tradeId,{offerId:m.body.offerId,ring});
  }
  if(!t||m.from!==counterpartyOf(t))return;
  if(t.role==='seller'&&m.type==='draft'&&t.phase==='ring-sent'){
   const d=m.body.draft;
   if(d.sellerDecoys!==t.ring.decoys)throw Error('draft uses another ring');
   // A listing withdrawn after this buyer asked must not sell (30 Oct 2026): refuse the draft before anything is signed.
   if(t.kind!=='nft'&&doc.offers[t.offerId]?.status!=='listed'){await update(x=>{history(x.trades[t.tradeId],'failed','the listing was withdrawn');});return relay(t.buyer,'reject',t.tradeId,{reason:'The seller withdrew this listing'});}
   if(lotBusy(t.lot)){await update(x=>{history(x.trades[t.tradeId],'failed','another trade holds this lot');});return relay(t.buyer,'reject',t.tradeId,{reason:'This lot is reserved by another buyer’s trade'});}
   if(!dec.test(d.fee||'')||!dec.test(d.total||'')||BigInt(d.total)!==BigInt(t.price)+BigInt(d.fee))throw Error('draft totals are not price + fee');
   const review={kind:'sell',tradeId:t.tradeId,offerId:t.offerId,lot:t.lot,quantity:t.quantity,price:t.price,payout:payoutAddress,buyer:t.buyer,fee:d.fee,total:d.total,expires:null};
   const auto=doc.offers[t.offerId]?.approval==='auto';
   const a=newApproval('sell',review,{tradeId:t.tradeId,...autoStart(auto)});
   await update(x=>{x.trades[t.tradeId].draft=d;history(x.trades[t.tradeId],'awaiting-approval');x.approvals[a.id]=a;});
   if(auto)await autoRelease(a);
  }
  if(t.role==='seller'&&m.type==='published'&&t.phase==='released'&&!t.txid&&hex32.test(m.body?.txid||'')){await update(x=>{x.trades[t.tradeId].txid=m.body.txid;});}
  if(t.role==='seller'&&m.type==='abandon'&&['ring-sent','awaiting-approval'].includes(t.phase)){await update(x=>{history(x.trades[t.tradeId],'abandoned','buyer abandoned before any signature');for(const a of Object.values(x.approvals))if(a.tradeId===t.tradeId&&a.status==='pending')a.status='expired';});}
  if(t.role==='buyer'&&m.type==='reject'&&t.phase==='requested'){await update(x=>{history(x.trades[t.tradeId],'failed',m.body?.reason||'seller refused');});}
  if(t.role==='buyer'&&m.type==='ring'&&t.phase==='requested'){
   await update(x=>{history(x.trades[t.tradeId],'drafting');});
   try{
    const q=await w.buy({offer:t.offer,sellerRing:m.body.ring,maxFee:t.maxFee,now:now(),...(t.spare?{anchor:'spare',anchorKeyImage:t.spare}:spareMode?{anchor:'spare'}:{})});
    const r=await w.buyDraft(q.buildId);
    const draft={...r.draft,sellerDecoys:m.body.ring.decoys};
    await update(x=>{const tt=x.trades[t.tradeId];tt.draft=draft;tt.continuation=r.continuation;tt.fundingKeyImages=r.continuation.mineKeyImages;tt.fee=draft.fee;tt.total=draft.total;tt.spare??=draft.buyerAnchor||null;history(tt,'awaiting-seller');});
    await relay(t.seller,'draft',t.tradeId,{offerId:t.offerId,draft});
   }catch(e){await releaseFunding(t.tradeId,'failed',publicError(e));}
  }
  if(t.role==='buyer'&&m.type==='approval'&&t.phase==='awaiting-seller'){
   const review={kind:'pay',tradeId:t.tradeId,offerId:t.offerId,lot:t.lot,quantity:t.quantity,price:t.price,fee:t.fee,total:t.total,payout:t.payout,seller:t.seller,confirmationsAtQuote:t.lotConfirmations,finalityDepth:finality,payBy:payByOf(m.body)};
   const a=newApproval('pay',review,{tradeId:t.tradeId});
   await update(x=>{const tt=x.trades[t.tradeId];tt.sellerApproval=approvalOf(m.body);tt.payBy=payByOf(m.body);history(tt,'awaiting-approval');x.approvals[a.id]=a;});
  }
  if(t.role==='buyer'&&m.type==='decline'&&t.phase==='awaiting-seller'){await releaseFunding(t.tradeId,'declined','seller declined');}
 }
 // ---- anchored NFT trades (port of the lab wallet process; engine nft_ops.rs through the worker)
 async function nftRequest(m){
  const last=refusals.get(m.from)||0;const refuse=async reason=>{if(Date.now()-last<60000)return;refusals.set(m.from,Date.now());await relayWith(m.peerKey,m.from,'reject',m.tradeId,{reason});};
  const l=doc.nftListings[m.body?.listingId];
  if(!l||l.status!=='listed')return refuse('Listing not available');
  const tok=ledgerToken(l.listing.token);
  if(!tok||tok.owner!==nativeAddress||tok.last!==l.listing.last||!anchorHeld(tok.anchor))return refuse('This NFT is no longer available');
  if(nftBusy(tok.id))return refuse('This NFT is reserved by another buyer’s trade');
  let ring=doc.nftRings[tok.anchor];
  if(!ring){const r=await w.nftRing(tok.anchor);ring={keyImage:r.keyImage,decoys:r.decoys,amount:r.amount};await update(d=>{d.nftRings[tok.anchor]=ring;});}
  const rec={kind:'nft',role:'seller',tradeId:m.tradeId,peerKey:m.peerKey,listingId:l.id,listing:l.listing,token:tok.id,anchor:tok.anchor,buyer:m.from,counterparty:m.from,price:l.listing.pricePiconero,ring,createdAt:Date.now()};
  history(rec,'ring-sent');await update(d=>{d.trades[m.tradeId]=rec;});
  return relay(m.from,'ring',m.tradeId,{listingId:l.id,ring});
 }
 async function nftMessage(t,m){
  const disp=nftIndex.tokens.find(x=>x.id===t.token)||{};
  if(t.role==='seller'&&m.type==='draft'&&t.phase==='ring-sent'){
   const d=m.body.draft;
   if(d.sellerDecoys!==t.ring.decoys)throw Error('draft uses another ring');
   if(nftBusy(t.token)){await update(x=>{history(x.trades[t.tradeId],'failed','another trade holds this NFT');});return relay(t.buyer,'reject',t.tradeId,{reason:'This NFT is reserved by another buyer’s trade'});}
   if(!dec.test(d.fee||'')||!dec.test(d.total||'')||BigInt(d.total)!==BigInt(t.price)+BigInt(d.fee))throw Error('draft totals are not price + fee');
   const review={kind:'nftSell',tradeId:t.tradeId,listingId:t.listingId,token:t.token,name:disp.name||null,collection:disp.collectionName||null,edition:disp.edition||null,price:t.price,payout:nativeAddress,buyer:d.buyer||null,fee:d.fee,total:d.total};
   const auto=doc.nftListings[t.listingId]?.approval==='auto';
   const a=newApproval('nftSell',review,{tradeId:t.tradeId,...autoStart(auto)});
   await update(x=>{x.trades[t.tradeId].draft=d;history(x.trades[t.tradeId],'awaiting-approval');x.approvals[a.id]=a;});
   if(auto)await autoRelease(a);
  }
  if(t.role==='buyer'&&m.type==='ring'&&t.phase==='requested'){
   await update(x=>{history(x.trades[t.tradeId],'drafting');});
   try{
    const q=await w.nftBuy({listing:t.listing,nft:t.nft,sellerRing:m.body.ring,maxFee:t.maxFee,now:now()});
    const r=await w.nftBuyDraft(q.buildId);
    const draft={...r.draft,sellerDecoys:m.body.ring.decoys};
    await update(x=>{const tt=x.trades[t.tradeId];tt.draft=draft;tt.continuation=r.continuation;tt.fundingKeyImages=r.continuation.mineKeyImages;tt.fee=draft.fee;tt.total=draft.total;history(tt,'awaiting-seller');});
    await relay(t.seller,'draft',t.tradeId,{listingId:t.listingId,draft});
   }catch(e){await releaseFunding(t.tradeId,'failed',publicError(e));}
  }
  if(t.role==='buyer'&&m.type==='approval'&&t.phase==='awaiting-seller'){
   const review={kind:'nftPay',tradeId:t.tradeId,listingId:t.listingId,token:t.token,name:disp.name||null,collection:disp.collectionName||null,edition:disp.edition||null,price:t.price,fee:t.fee,total:t.total,seller:t.listing.owner,anchorConfirmationsAtQuote:t.anchorConfirmations,finalityDepth:finality,payBy:payByOf(m.body)};
   const a=newApproval('nftPay',review,{tradeId:t.tradeId});
   await update(x=>{const tt=x.trades[t.tradeId];tt.sellerApproval=approvalOf(m.body);tt.payBy=payByOf(m.body);history(tt,'awaiting-approval');x.approvals[a.id]=a;});
  }
 }
 async function nftAnchoring(){
  for(const e of Object.values(doc.nftListings)){
   if(e.status!=='anchoring')continue;
   const tok=ledgerToken(e.token);
   if(tok&&tok.owner===nativeAddress&&tok.anchor===e.anchorKeyImage&&anchorHeld(tok.anchor)&&anchorDepth(tok)>=finality){
    const listing={v:1,genesis:manifest.network.genesis,token:e.token,last:tok.last,owner:nativeAddress,pricePiconero:e.price,created:now(),expires:now()+e.lifetime,nonce:randomHex(16)};
    const {signature}=await w.signMessage(await listingMessage(listing));const id=await listingId(listing);
    await update(x=>{delete x.nftListings[e.id];x.nftListings[id]={id,listing,signature,status:'posting',approval:e.approval==='auto'?'auto':'manual',stallSeconds:e.stallSeconds??null,lifetime:e.lifetime,anchorTxid:e.anchorTxid,relisted:e.relisted||null,createdAt:e.createdAt};
     // A finished re-anchor (cancellation) no longer blocks sales of this NFT.
     if(x.nftCancels?.[e.token]?.anchorKeyImage===tok.anchor)delete x.nftCancels[e.token];},'nft-listing-signed');
    try{await mk('/api/nft-listings',{listing,signature,relayTo:ownerKey,relay:await attest(id)});await update(x=>{x.nftListings[id].status='listed';});}catch(err){log('post nft listing',publicError(err));}
    continue;
   }
   const l=await w.lookup(e.anchorTxid).catch(()=>null);
   if(l&&l.known===false&&Date.now()-e.createdAt>120000)await update(x=>{x.nftListings[e.id].status='failed';x.nftListings[e.id].error='the anchoring transaction is no longer known to the node';});
  }
 }
 async function trackNft(t){
  const tok=ledgerToken(t.token);
  if(t.role==='buyer'&&['requested','drafting','awaiting-seller','awaiting-approval'].includes(t.phase)){
   // The ledger applies records only once final, so a mined re-anchor or sale shows first as a spent anchor key image.
   const spent=tok&&tok.anchor===t.nft.anchor?await w.anchorSpent(t.nft.anchor).catch(()=>0):0;
   if(!tok||tok.owner!==t.nft.owner||tok.last!==t.nft.prev||tok.anchor!==t.nft.anchor||spent===1){await update(x=>{for(const a of Object.values(x.approvals))if(a.tradeId===t.tradeId&&a.status==='pending')a.status='expired';});await releaseFunding(t.tradeId,'failed','the NFT is no longer available as listed');return;}
  }
  if(t.role==='seller'&&['released','published','delivered','unconfirmed','cancelled'].includes(t.phase)){
   const ev=nftLedger.events.find(e=>e.status==='pending'&&e.record?.op==='nft_sale'&&e.record.token===t.token&&e.record.offer===t.listingId)||(tok?.history||[]).find(h=>h.op==='nft_sale'&&h.offer===t.listingId);
   if(ev&&ev.txid!==t.txid)await update(x=>{x.trades[t.tradeId].txid=ev.txid;});
  }
  const txid=doc.trades[t.tradeId].txid;if(!txid)return;
  const l=await w.lookup(txid).catch(()=>null);if(!l)return;
  const ev=nftLedger.events.find(e=>e.txid===txid);
  const patch={native:l.known?(l.inPool?'pool':'mined'):'unknown',confirmations:l.confirmations||0,token:ev?ev.status:null,tokenError:ev?.reason||null};
  let phase=t.phase;
  if(l.known&&!l.inPool)phase=ev?.status==='accepted'?'final':ev?.status==='pending'?'delivered':ev?.status==='rejected'?'payment-without-delivery':'delivered';
  else if(l.known&&l.inPool)phase='published';
  else if(['published','delivered','payment-without-delivery'].includes(t.phase)){
   if(t.role==='buyer'&&t.finalBlob){const r=await w.publish(t.finalBlob).catch(e=>({ok:false,reason:e.message}));phase=r.ok?'published':(r.doubleSpend?'refused':'uncertain');patch.lastRelay=r.ok?'OK':(r.reason||r.status||'refused');}
   else phase='unconfirmed';
  }
  if(phase!==t.phase||patch.confirmations!==t.confirmations||patch.token!==t.token)await update(x=>{Object.assign(x.trades[t.tradeId],patch);if(phase!==t.phase)history(x.trades[t.tradeId],phase);});
  if(t.role==='buyer'&&phase==='refused'&&t.fundingKeyImages&&!t.fundingReleased){await w.nativeRelease(t.fundingKeyImages).catch(()=>{});await update(x=>{x.trades[t.tradeId].fundingReleased=true;});}
 }
 async function releaseFunding(tradeId,phase,note){
  const t=doc.trades[tradeId];if(t.fundingKeyImages)await w.nativeRelease(t.fundingKeyImages).catch(()=>{});
  await update(x=>{history(x.trades[tradeId],phase,note);});
 }
 async function track(){
  const recs=records();
  for(const t of Object.values(doc.trades)){
   if(['final','abandoned','declined','failed','refused-busy'].includes(t.phase))continue;
   if(t.kind==='nft'){await trackNft(t);continue;}
   if(t.role==='buyer'&&['requested','drafting','awaiting-seller','awaiting-approval'].includes(t.phase)){
    let gone=null;try{await w.checkOffer(t.offer,now());}catch(e){gone=publicError(e);}
    if(gone){await update(x=>{for(const a of Object.values(x.approvals))if(a.tradeId===t.tradeId&&a.status==='pending')a.status='expired';});await releaseFunding(t.tradeId,'failed','the lot is no longer available: '+gone);continue;}
   }
   if(t.role==='seller'&&['released','published','delivered','unconfirmed','cancelled'].includes(t.phase)){const sale=recs.find(r=>r.kind==='lot-sale'&&r.status==='accepted'&&r.detail?.lot===t.lot&&r.detail?.offer===t.offerId);if(sale&&sale.txid!==t.txid)await update(x=>{x.trades[t.tradeId].txid=sale.txid;});}
   if(!doc.trades[t.tradeId].txid)continue;
   const l=await w.lookup(t.txid).catch(()=>null);if(!l)continue;
   const rec=recs.find(r=>r.txid===t.txid);
   const patch={native:l.known?(l.inPool?'pool':'mined'):'unknown',confirmations:l.confirmations||0,token:rec?rec.status:null,tokenError:rec?.error||null};
   let phase=t.phase;
   if(l.known&&!l.inPool){phase=rec?.status==='accepted'?(l.confirmations>=finality?'final':'delivered'):'payment-without-delivery';}
   else if(l.known&&l.inPool)phase='published';
   else if(['published','delivered','payment-without-delivery'].includes(t.phase)){
    if(t.role==='buyer'&&t.finalBlob){const r=await w.publish(t.finalBlob).catch(e=>({ok:false,reason:e.message}));phase=r.ok?'published':(r.doubleSpend?'refused':'uncertain');patch.lastRelay=r.ok?'OK':(r.reason||r.status||'refused');}
    else phase='unconfirmed';
   }
   if(phase!==t.phase||patch.confirmations!==t.confirmations||patch.token!==t.token)await update(x=>{Object.assign(x.trades[t.tradeId],patch);if(phase!==t.phase)history(x.trades[t.tradeId],phase);});
   if(t.role==='buyer'&&phase==='refused'&&t.fundingKeyImages&&!t.fundingReleased){await w.nativeRelease(t.fundingKeyImages).catch(()=>{});await update(x=>{x.trades[t.tradeId].fundingReleased=true;});}
  }
  // A re-anchor (cancellation) that is final no longer blocks sales of the NFT.
  for(const [token,c] of Object.entries(doc.nftCancels)){const tok=ledgerToken(token);if(tok?.anchor===c.anchorKeyImage&&anchorDepth(tok)>=finality)await update(x=>{delete x.nftCancels[token];});}
  for(const l of Object.values(doc.nftListings)){
   if(l.status!=='listed')continue;const tok=ledgerToken(l.listing.token);
   if(nftLedger.tip>=0&&(!tok||tok.last!==l.listing.last))await update(x=>{x.nftListings[l.id].status=(tok?.history||[]).some(h=>h.op==='nft_sale'&&h.offer===l.id)?'sold':'closed';});
  }
  for(const o of Object.values(doc.offers)){
   if(o.status!=='listed')continue;
   const lot=(mst?.lots||[]).find(l=>l.id===o.lot);
   if(mst&&!lot)await update(x=>{x.offers[o.offerId].status='closed';});
  }
 }
 // ---- approvals (this window only)
 function newApproval(kind,review,extra={}){return {id:randomHex(10),kind,review,nonce:randomHex(16),status:'pending',createdAt:Date.now(),...extra};}
 const consuming=new Set();
 // Automatic seller approval (owner decision 30 Oct 2026): a listing made with sellerApproval 'auto' releases the sale signature
 // without a click, through the same execute() checks as a manual approval (the engine refuses a draft that does not pay this
 // wallet the listed price). Called from tick(), which is already serialised. A failure before any signature declines the trade.
 // An automatic approval is written as 'approving' from the start (31 Oct 2026): written as 'pending' first, it showed in the
 // wallet as waiting for a click until autoRelease's first write, and anything watching pending approvals could prompt.
 const autoStart=auto=>auto?{status:'approving',auto:true}:{};
 async function autoRelease(a){
  consuming.add(a.id);
  try{await execute(a);await update(x=>{x.approvals[a.id].status='approved';},'auto-release');}
  catch(e){const msg=publicError(e),unsigned=doc.trades[a.tradeId]?.phase==='awaiting-approval';
   await update(x=>{x.approvals[a.id].status='failed';x.approvals[a.id].error=msg;if(unsigned)history(x.trades[a.tradeId],'failed','automatic approval refused: '+msg);});
   if(unsigned)await relay(doc.trades[a.tradeId].buyer,'decline',a.tradeId).catch(()=>{});}
 }
 async function decide(id,nonce,decision){
  const a=doc.approvals[id];
  if(!a||a.status!=='pending'||a.nonce!==nonce||consuming.has(id))throw fail('Unknown, used or expired approval',409);
  consuming.add(id);
  await update(x=>{x.approvals[id].status=decision==='approve'?'approving':'declined';});
  if(decision!=='approve'){
   if(a.kind==='sell'||a.kind==='nftSell'){await update(x=>{history(x.trades[a.tradeId],'declined','seller declined');});await relay(doc.trades[a.tradeId].buyer,'decline',a.tradeId).catch(()=>{});}
   if(a.kind==='pay'||a.kind==='nftPay')await releaseFunding(a.tradeId,'declined','buyer declined at the final review');
   if(a.requestId)await update(x=>{x.requests[a.requestId].status='declined';});
   return {status:'declined'};
  }
  try{const r=await serial(()=>execute(a));await update(x=>{x.approvals[id].status='approved';if(a.requestId){x.requests[a.requestId].status='done';x.requests[a.requestId].result=r;}});return {status:'approved',result:r};}
  catch(e){const msg=publicError(e);
   const again=['sell','pay','nftSell','nftPay'].includes(a.kind)&&doc.trades[a.tradeId]?.phase==='awaiting-approval'?newApproval(a.kind,a.review,{tradeId:a.tradeId}):null;
   await update(x=>{x.approvals[id].status='failed';x.approvals[id].error=msg;if(again)x.approvals[again.id]=again;if(a.requestId){x.requests[a.requestId].status='failed';x.requests[a.requestId].error=msg;}}).catch(()=>{});
   throw fail(msg+(again?' — nothing was released; the review is available again in this wallet.':''),422);}
 }
 // Sign and post one listing (an approved 'list', or the listing approved together with 'make and list').
 async function listLot(r){
  if(Object.values(doc.offers).some(o=>o.lot===r.lot&&['listed','posting'].includes(o.status)))throw Error('This lot is already listed');
  const o=await w.offer({lot:r.lot,price:r.price,now:now(),expires:now()+r.lifetime,...(lotPayout?{payout:lotPayout.address}:{})});
  await update(x=>{x.offers[o.offerId]={offerId:o.offerId,wire:o.wire,lot:r.lot,quantity:o.quantity,price:o.price,payout:o.payout,expires:o.expires,lifetime:r.lifetime,status:'posting',approval:r.approval==='auto'?'auto':'manual',stallSeconds:r.stallSeconds??null};});
  try{await mk('/api/offers',{wire:o.wire,relay:await attest(o.offerId)});await update(x=>{x.offers[o.offerId].status='listed';});}
  catch(e){if(e.status>=400&&e.status<500){await update(x=>{x.offers[o.offerId].status='rejected';});throw Error('The order book refused the listing: '+publicError(e));}log('post offer',publicError(e));}
  return {offerId:o.offerId,expires:o.expires};
 }
 const DEFAULT_SPARE_BLOCKS=11;// one block for the spare payment, then the 10-block spendable age
 async function prepareWith(r,spare){
  const excludeNotes=[];for(const l of Object.values(doc.lots)){if(!l.inputs)continue;const k=await w.lookup(l.txid).catch(()=>null);if(!k||k.known===false||k.inPool)excludeNotes.push(...l.inputs);}
  const q=await w.prepareLot({asset:r.asset,quantity:r.quantity,excludeNotes,...(spare?{anchor:'spare',anchorKeyImage:spare}:{})});
  if(BigInt(q.fee)>BigInt(r.maxFee)){await w.cancelBuild(q.buildId);throw Error(`Network fee ${q.fee} is above the approved ${r.maxFee}`);}
  const s=await w.sign(q.buildId);
  await update(x=>{x.lots[s.notes[0]]={lot:s.notes[0],quantity:r.quantity,txid:s.txid,blob:s.blob,inputs:xa1Inputs(s.wire),anchor:s.anchorKeyImage||null,createdAt:Date.now(),...(r.list?{autoList:{...r.list,status:'waiting'}}:{})};},'lot-signed');
  const p=await w.publishWithRecovery(s.blob,s.txid);if(!p.ok)throw Error('Lot preparation not accepted: '+(p.reason||p.status));
  return {txid:s.txid,lot:s.notes[0],fee:s.fee};
 }
 async function execute(a){
  const r=a.review;
  if(a.kind.startsWith('nft')){if(!nftsOn)throw fail('NFT trading on this market is coming soon',409);holder=await w.sync();nftLedger=await w.nftLedger();}
  if(a.kind==='prepare'){
   if(!spareMode)return prepareWith(r,null);
   const pick=freeSpares()[0];if(pick)return prepareWith(r,pick.keyImage);
   const id=randomHex(8);
   await update(x=>{x.waiting[id]={id,kind:'prepare',review:r,requestId:a.requestId||null,status:'waiting',createdAt:Date.now()};},'prepare-waits-for-spare');
   return {waiting:'anchor',readyInBlocks:DEFAULT_SPARE_BLOCKS};
  }
  if(a.kind==='list')return listLot(r);
  if(a.kind==='cancelLot'){
   if(doc.lots[r.lot]?.cancelTxid)throw Error('A cancellation of this lot was already signed');
   const q=await w.cancelLot(r.lot);const s=await w.sign(q.buildId);
   await update(x=>{for(const o of Object.values(x.offers))if(o.lot===r.lot&&['listed','posting'].includes(o.status))o.status='cancelling';x.lots[r.lot]={...(x.lots[r.lot]||{}),cancelTxid:s.txid,cancelBlob:s.blob};
    for(const ap of Object.values(x.approvals))if(ap.kind==='sell'&&ap.status==='pending'&&x.trades[ap.tradeId]?.lot===r.lot){ap.status='expired';history(x.trades[ap.tradeId],'declined','seller cancelled the lot');}},'cancel-signed');
   for(const t of Object.values(doc.trades))if(t.role==='seller'&&t.lot===r.lot&&t.phase==='declined'&&!t.declineSent){await relay(t.buyer,'decline',t.tradeId).catch(()=>{});await update(x=>{x.trades[t.tradeId].declineSent=true;});}
   const p=await w.publishWithRecovery(s.blob,s.txid);if(!p.ok)throw Error('Cancellation not accepted: '+(p.reason||p.status));
   for(const o of Object.values(doc.offers))if(o.lot===r.lot)await withdrawOffer(o.offerId).catch(()=>{});
   return {txid:s.txid,fee:s.fee};
  }
  if(a.kind==='sell'){
   const t=doc.trades[a.tradeId];if(t.phase!=='awaiting-approval')throw Error('Trade is not awaiting approval');
   if(Object.values(doc.trades).some(x=>x.role==='seller'&&x.lot===t.lot&&x.tradeId!==t.tradeId&&['released','published','delivered','final'].includes(x.phase)))throw Error('A sale of this lot was already approved');
   if(doc.lots[t.lot]?.cancelTxid)throw Error('This lot is being cancelled on chain');
   const approval=await w.sellerApprove({offer:t.offer,draft:t.draft,now:now()});
   if(approval.fee!==t.draft.fee||approval.paid!==t.price)throw Error('The transaction’s fee or payout differs from what was reviewed');
   const body={signedRecord:approval.signedRecord,clsag:approval.clsag,pseudoOut:approval.pseudoOut,...payWindow(t)};
   await update(x=>{const tt=x.trades[a.tradeId];tt.released=body;tt.payBy=body.payBy??null;tt.fee=approval.fee;history(tt,'released','signature released to the buyer; revocable only by a native cancellation');},'release');
   await relay(t.buyer,'approval',a.tradeId,body);
   await update(x=>{x.trades[a.tradeId].releasedSent=true;});
   return {released:true};
  }
  if(a.kind==='nftList'){
   const tok=ownedNfts().find(t=>t.id===r.token);if(!tok)throw Error('This wallet no longer owns the NFT');
   if(Object.values(doc.nftListings).some(l=>(l.listing?.token||l.token)===r.token&&['listed','posting','anchoring'].includes(l.status)))throw Error('This NFT is already listed');
   if(r.anchoring){
    const s=await w.nftAnchor({token:tok.id,prev:tok.last,...(tok.anchorHeld?{anchor:tok.anchor}:{})});
    if(BigInt(s.fee)>BigInt(r.maxFee))throw Error(`Network fee ${s.fee} is above the approved ${r.maxFee}`);
    const id='anchoring:'+tok.id;
    await update(x=>{x.nftListings[id]={id,token:tok.id,price:r.price,lifetime:r.lifetime,approval:r.approval==='auto'?'auto':'manual',stallSeconds:r.stallSeconds??null,anchorTxid:s.txid,anchorKeyImage:s.anchorKeyImage,blob:s.blob,status:'anchoring',createdAt:Date.now()};},'nft-anchor-signed');
    const p=await w.publishWithRecovery(s.blob,s.txid);if(!p.ok)throw Error('Anchoring transaction not accepted: '+(p.reason||p.status));
    return {anchoring:true,txid:s.txid,fee:s.fee,listsAfterConfirmations:finality};
   }
   if(!tok.saleReady)throw Error('The NFT’s anchor is not final yet');
   const listing={v:1,genesis:manifest.network.genesis,token:r.token,last:tok.last,owner:nativeAddress,pricePiconero:r.price,created:now(),expires:now()+r.lifetime,nonce:randomHex(16)};
   const {signature}=await w.signMessage(await listingMessage(listing));const id=await listingId(listing);
   await update(x=>{x.nftListings[id]={id,listing,signature,status:'posting',approval:r.approval==='auto'?'auto':'manual',stallSeconds:r.stallSeconds??null,lifetime:r.lifetime,createdAt:Date.now()};},'nft-listing-signed');
   try{await mk('/api/nft-listings',{listing,signature,relayTo:ownerKey,relay:await attest(id)});await update(x=>{x.nftListings[id].status='listed';});}
   catch(e){if(e.status>=400&&e.status<500){await update(x=>{x.nftListings[id].status='rejected';});throw Error('The order book refused the listing: '+publicError(e));}log('post nft listing',publicError(e));}
   return {listing:id,expires:listing.expires};
  }
  if(a.kind==='nftSell'){
   const t=doc.trades[a.tradeId];if(t.phase!=='awaiting-approval')throw Error('Trade is not awaiting approval');
   if(Object.values(doc.trades).some(x=>x.kind==='nft'&&x.role==='seller'&&x.token===t.token&&x.tradeId!==t.tradeId&&['released','published','delivered','final'].includes(x.phase)))throw Error('A sale of this NFT was already approved');
   const tok=ledgerToken(t.token);if(!tok||tok.owner!==nativeAddress||tok.last!==t.listing.last||tok.anchor!==t.anchor)throw Error('The NFT changed since it was listed');
   if(doc.nftCancels[t.token])throw Error('This NFT is being re-anchored (cancelled) on chain');
   const approval=await w.nftSellerApprove({listing:t.listing,nft:{token:t.token,prev:tok.last,anchor:tok.anchor},draft:t.draft});
   if(approval.fee!==t.draft.fee||approval.paid!==t.price)throw Error('The transaction’s fee or payout differs from what was reviewed');
   const body={carrier:approval.carrier,clsag:approval.clsag,pseudoOut:approval.pseudoOut,...payWindow(t)};
   await update(x=>{const tt=x.trades[a.tradeId];tt.released=body;tt.payBy=body.payBy??null;tt.fee=approval.fee;history(tt,'released','signature released to the buyer; revocable only by a native re-anchor');},'release');
   await relay(t.buyer,'approval',a.tradeId,body);
   await update(x=>{x.trades[a.tradeId].releasedSent=true;});
   return {released:true};
  }
  if(a.kind==='nftPay'){
   const t=doc.trades[a.tradeId];if(t.phase!=='awaiting-approval')throw Error('Trade is not awaiting approval');
   const fin=await w.nftBuyerFinish({continuation:t.continuation,...t.sellerApproval});
   await update(x=>{const tt=x.trades[a.tradeId];tt.finalBlob=fin.blob;tt.txid=fin.txid;tt.buyerAnchor=fin.buyerAnchor;history(tt,'signed');},'signed');
   const p=await w.publishWithRecovery(fin.blob,fin.txid);
   await update(x=>{history(x.trades[a.tradeId],p.ok?'published':(p.uncertain?'uncertain':'refused'),p.ok?null:(p.reason||p.status));});
   relay(t.seller,'published',a.tradeId,{txid:fin.txid}).catch(()=>{});
   return {txid:fin.txid,published:p.ok};
  }
  if(a.kind==='nftCancel'){
   const tok=ownedNfts().find(t=>t.id===r.token);if(!tok?.anchorHeld)throw Error('This wallet does not hold the NFT’s anchor');
   if(doc.nftCancels[r.token])throw Error('A cancellation of this NFT was already signed');
   const s=await w.nftAnchor({token:tok.id,prev:tok.last,anchor:tok.anchor});
   if(BigInt(s.fee)>BigInt(r.maxFee))throw Error(`Network fee ${s.fee} is above the approved ${r.maxFee}`);
   await update(x=>{x.nftCancels[r.token]={txid:s.txid,blob:s.blob,anchorKeyImage:s.anchorKeyImage};
    for(const l of Object.values(x.nftListings))if((l.listing?.token||l.token)===r.token&&['listed','posting'].includes(l.status))l.status='cancelling';
    for(const ap of Object.values(x.approvals))if(ap.kind==='nftSell'&&ap.status==='pending'&&x.trades[ap.tradeId]?.token===r.token){ap.status='expired';history(x.trades[ap.tradeId],'declined','seller cancelled the NFT sale');}},'nft-cancel-signed');
   const p=await w.publishWithRecovery(s.blob,s.txid);if(!p.ok)throw Error('Cancellation not accepted: '+(p.reason||p.status));
   for(const l of Object.values(doc.nftListings))if(l.listing?.token===r.token&&l.status==='cancelling')await withdrawNftListing(l.id).catch(()=>{});
   return {txid:s.txid,fee:s.fee};
  }
  if(a.kind==='pay'){
   const t=doc.trades[a.tradeId];if(t.phase!=='awaiting-approval')throw Error('Trade is not awaiting approval');
   const fin=await w.buyerFinish({continuation:t.continuation,...t.sellerApproval});
   await update(x=>{const tt=x.trades[a.tradeId];tt.finalBlob=fin.blob;tt.txid=fin.txid;tt.buyerNote=fin.buyerNote;history(tt,'signed');},'signed');
   const p=await w.publishWithRecovery(fin.blob,fin.txid);
   await update(x=>{history(x.trades[a.tradeId],p.ok?'published':(p.uncertain?'uncertain':'refused'),p.ok?null:(p.reason||p.status));});
   relay(t.seller,'published',a.tradeId,{txid:fin.txid}).catch(()=>{});
   return {txid:fin.txid,published:p.ok};
  }
  throw Error('Unknown approval kind');
 }
 async function withdrawNftListing(id){
  const l=doc.nftListings[id];if(!l)throw fail('Unknown listing',404);
  const withdrawal={v:1,listing:id,owner:nativeAddress,created:now()};const {signature}=await w.signMessage(await withdrawMessage(withdrawal));
  await mk('/api/nft-withdrawals',{withdrawal,signature});
  await update(x=>{x.nftListings[id].status='withdrawn';});
  return {listing:id,withdrawn:true};
 }
 async function withdrawOffer(offerId){
  const o=doc.offers[offerId];if(!o)throw Error('Unknown offer');
  const wd=await w.withdraw({offer:o.wire,now:now()});
  await mk('/api/withdrawals',{offer:o.wire,wire:wd.wire});
  await update(x=>{x.offers[offerId].status='withdrawn';});
  return {offerId,withdrawn:true};
 }
 // ---- market.* v2 requests (forwarded by the background from the pinned website origin)
 // sellerApproval: 'auto' (default: the wallet approves matching sales itself) or 'manual' (a review per sale).
 const sellerApproval=b=>{const v=b.sellerApproval??'auto';if(v!=='auto'&&v!=='manual')throw fail("sellerApproval: 'auto' or 'manual'",400);return v;};
 // stallSeconds: how long a buyer has to pay after an automatic approval before the wallet cancels and relists (auto only).
 const listingTerms=b=>{const approval=sellerApproval(b);if(approval!=='auto')return {approval,stallSeconds:null};
  const n=b.stallSeconds===undefined?STALL_DEFAULT:Number(b.stallSeconds);
  if(!Number.isInteger(n)||n<60||n>3600)throw fail('stallSeconds: 60 to 3600',400);return {approval,stallSeconds:n};};
 async function request(kind,b){
  const id=String(b?.requestId||'');if(!/^[A-Za-z0-9_-]{8,96}$/.test(id))throw fail('requestId required',400);
  const existing=doc.requests[id];if(existing){if(existing.kind!==kind)throw fail('requestId reused for another action',409);return view(existing);}
  if(!mst)throw fail('The wallet has not synced yet',503);
  if(kind.startsWith('nft')){if(!nftsOn)throw fail('NFT trading on this market is coming soon',409);nftLedger=await w.nftLedger();}
  const st=mst;
  let rec={id,kind,status:'awaiting-approval',createdAt:Date.now()},approval=null;
  if(kind==='prepare'){
   if(!dec.test(b.quantityAtoms||'')||b.quantityAtoms==='0')throw fail('quantityAtoms: canonical positive decimal',400);
   if(b.asset!==asset)throw fail('Unknown asset',400);
   const open=BigInt(st.openBalances[b.asset]||'0');if(BigInt(b.quantityAtoms)>open)throw fail('Quantity is above your Open balance (Private balance is never used for a lot)',422);
   const maxFee=b.maxFeePiconero===undefined?'10000000000':b.maxFeePiconero;if(!dec.test(maxFee))throw fail('maxFeePiconero: canonical decimal',400);
   // Make and list: with listTotalPiconero the same approval also lists the lot at that price once it is in a block.
   let list=null;if(b.listTotalPiconero!==undefined){if(!dec.test(b.listTotalPiconero||'')||b.listTotalPiconero==='0')throw fail('listTotalPiconero: canonical positive decimal',400);
    list={price:b.listTotalPiconero,lifetime:Math.min(Math.max(Number(b.lifetimeSeconds)||86400,300),604800),...listingTerms(b)};}
   approval=newApproval('prepare',{asset:b.asset,quantity:b.quantityAtoms,maxFee,openAfter:(open-BigInt(b.quantityAtoms)).toString(),finalityDepth:finality,...(list?{list,payout:payoutAddress}:{}),...(spareMode?{spare:freeSpares().length?'ready':'make'}:{})},{requestId:id});
  }else if(kind==='list'){
   const lot=st.lots.find(l=>l.id===b.lot);if(!lot)throw fail('Not one of your lots',422);
   // Listed from the lot's first confirmation (owner, 30 Oct 2026); buyers still wait for D before anything moves.
   if(!lot.anchorHeld)throw fail('This wallet no longer holds the lot',422);
   if(!(lot.confirmations>=1))throw fail('The lot is not in a block yet; list it after its first confirmation',422);
   if(!dec.test(b.totalPiconero||'')||b.totalPiconero==='0')throw fail('totalPiconero: canonical positive decimal',400);
   if(Object.values(doc.offers).some(o=>o.lot===b.lot&&['listed','posting'].includes(o.status))||Object.values(doc.approvals).some(a=>a.kind==='list'&&a.status==='pending'&&a.review.lot===b.lot))throw fail('This lot is already listed or awaiting your approval',409);
   const lifetime=Math.min(Math.max(Number(b.lifetimeSeconds)||86400,300),604800);
   approval=newApproval('list',{lot:b.lot,quantity:lot.amount,price:b.totalPiconero,payout:payoutAddress,lifetime,finalityDepth:finality,...listingTerms(b)},{requestId:id});
  }else if(kind==='cancelLot'){
   const lot=st.lots.find(l=>l.id===b.lot);if(!lot)throw fail('Not one of your lots',422);
   const released=Object.values(doc.trades).some(t=>t.role==='seller'&&t.lot===b.lot&&t.phase==='released');
   approval=newApproval('cancelLot',{lot:b.lot,quantity:lot.amount,released},{requestId:id});
  }else if(kind==='withdraw'){
   const o=doc.offers[b.offerId];if(!o)throw fail('Unknown offer',404);
   const released=Object.values(doc.trades).some(t=>t.role==='seller'&&t.lot===o.lot&&t.phase==='released');
   const r=await withdrawOffer(b.offerId);
   rec={...rec,status:'done',result:{...r,warning:released?'A sale signature was already released for this lot: withdrawing the listing does not revoke it. Cancel the lot in your wallet (a native spend) to revoke it.':null}};
  }else if(kind==='nftCancel'){
   const tok=ownedNfts().find(t=>t.id===b.token);if(!tok?.anchorHeld)throw fail('Not one of your anchored NFTs',422);
   const released=Object.values(doc.trades).some(t=>t.kind==='nft'&&t.role==='seller'&&t.token===b.token&&t.phase==='released');
   const maxFee=dec.test(b.maxFeePiconero||'')?b.maxFeePiconero:'10000000000';
   approval=newApproval('nftCancel',{token:b.token,name:tok.name,released,maxFee},{requestId:id});
  }else if(kind==='nftBuy'){
   const lid=String(b.listing||'');if(!hex32.test(lid))throw fail('listing: 64-hex listing id',400);
   const {listings=[]}=await mk('/api/nft-listings');const e=listings.find(x=>x.id===lid);if(!e)throw fail('Listing not available',404);
   if(e.status!=='active')throw fail(`Listing not available (${e.status})`,410);
   const tok=ledgerToken(e.listing.token);
   await checkListing(e,tok).catch(err=>{throw fail(publicError(err),422);});
   if(e.listing.owner===nativeAddress)throw fail('This is your own NFT',422);
   if(!tok.anchor)throw fail('This NFT is not anchored for sale',422);
   if(anchorDepth(tok)<finality)throw fail(`The NFT's anchor has ${anchorDepth(tok)} of ${finality} confirmations`,422);
   if(!hex32.test(e.relayTo||''))throw fail('Listing has no seller contact',422);
   const peerKey=sellerKey(lid,e.relay,e.listing.owner);
   const dup=Object.values(doc.trades).find(t=>t.kind==='nft'&&t.role==='buyer'&&t.listingId===lid&&!['abandoned','declined','failed','refused'].includes(t.phase));
   if(dup)return {requestId:id,kind,status:'done',approvalId:null,approvalUrl:null,result:{tradeId:dup.tradeId,existing:true},error:null};
   const maxFee=dec.test(b.maxFeePiconero||'')?b.maxFeePiconero:'10000000000';
   const tradeId=randomHex(16);
   const t={kind:'nft',role:'buyer',tradeId,peerKey,listingId:lid,listing:e.listing,token:tok.id,seller:e.relayTo,counterparty:e.relayTo,price:e.listing.pricePiconero,nft:{token:tok.id,prev:tok.last,owner:tok.owner,anchor:tok.anchor,anchorHeight:tok.anchorHeight},anchorConfirmations:anchorDepth(tok),maxFee,createdAt:Date.now()};
   history(t,'requested');
   await update(x=>{x.trades[tradeId]=t;x.requests[id]={...rec,status:'done',result:{tradeId}};});
   await relay(e.relayTo,'request',tradeId,{kind:'nft',listingId:lid});
   return view(doc.requests[id]);
  }else if(kind==='nftList'){
   const tok=ownedNfts().find(t=>t.id===b.token);if(!tok)throw fail('Not one of your NFTs (or its last transfer is not final yet)',422);
   if(!dec.test(b.pricePiconero||'')||b.pricePiconero==='0')throw fail('pricePiconero: canonical positive decimal',400);
   if(Object.values(doc.nftListings).some(l=>(l.listing?.token||l.token)===b.token&&['listed','posting','anchoring'].includes(l.status))||Object.values(doc.approvals).some(a=>a.kind==='nftList'&&a.status==='pending'&&a.review.token===b.token))throw fail('This NFT is already listed or awaiting your approval',409);
   const lifetime=Math.min(Math.max(Number(b.lifetimeSeconds)||86400,300),604800);
   const anchoring=!(tok.anchorHeld&&tok.anchorConfirmations>=finality);
   if(anchoring&&tok.anchorHeld)throw fail(`The NFT's anchor needs ${finality} confirmations before listing (has ${tok.anchorConfirmations})`,422);
   const maxFee=dec.test(b.maxFeePiconero||'')?b.maxFeePiconero:'10000000000';
   approval=newApproval('nftList',{token:b.token,name:tok.name,collection:tok.collectionName,edition:tok.edition,max:tok.collectionMax,price:b.pricePiconero,payout:nativeAddress,lifetime,anchoring,maxFee:anchoring?maxFee:null,finalityDepth:finality,...listingTerms(b)},{requestId:id});
  }else if(kind==='nftWithdraw'){
   const r=await withdrawNftListing(String(b.listing||''));rec={...rec,status:'done',result:r};
  }else if(kind==='buy'){
   if(typeof b.offer!=='string'||!/^[0-9a-f]{600,1024}$/.test(b.offer))throw fail('offer: signed listing hex',400);
   const c=await w.checkOffer(b.offer,now()).catch(e=>{throw fail(publicError(e),422);});
   if(c.seller===ownerKey)throw fail('This is your own listing',422);
   if(!c.final)throw fail(`Lot has ${c.confirmations} of ${finality} confirmations`,422);
   const dup=Object.values(doc.trades).find(t=>t.role==='buyer'&&t.offerId===c.offerId&&!['abandoned','declined','failed','refused'].includes(t.phase));
   if(dup)return {requestId:id,kind,status:'done',approvalId:null,approvalUrl:null,result:{tradeId:dup.tradeId,existing:true},error:null};
   const maxFee=dec.test(b.maxFeePiconero||'')?b.maxFeePiconero:'10000000000';
   const entry=(await mk('/api/offers')).offers?.find(o=>o.offerId===c.offerId);
   const peerKey=sellerKey(c.offerId,entry?.relay,c.payout,lotPrefix);
   const tradeId=randomHex(16);
   const t={role:'buyer',tradeId,peerKey,offerId:c.offerId,offer:b.offer,lot:c.lot,seller:c.seller,counterparty:c.seller,quantity:c.quantity,price:c.price,payout:c.payout,maxFee,lotConfirmations:c.confirmations,createdAt:Date.now()};
   // Spare anchors: the bought lot is anchored to a spare of this wallet; without a ready one the request waits (spareWork).
   const pick=spareMode?freeSpares()[0]:null;
   if(spareMode&&!pick){history(t,'waiting-anchor');await update(x=>{x.trades[tradeId]=t;x.requests[id]={...rec,status:'done',result:{tradeId,waiting:'anchor',readyInBlocks:DEFAULT_SPARE_BLOCKS}};});return view(doc.requests[id]);}
   if(pick)t.spare=pick.keyImage;
   history(t,'requested');
   await update(x=>{x.trades[tradeId]=t;x.requests[id]={...rec,status:'done',result:{tradeId}};});
   await relay(c.seller,'request',tradeId,{offerId:c.offerId});
   return view(doc.requests[id]);
  }else throw fail('Unknown request',404);
  if(approval){rec.approvalId=approval.id;await update(x=>{x.requests[id]=rec;x.approvals[approval.id]=approval;});}
  else await update(x=>{x.requests[id]=rec;});
  return view(doc.requests[id]);
 }
 // The extension has no approval URL a website could open: approvals live in this window (approvalUrl is null by contract).
 const view=r=>({requestId:r.id,kind:r.kind,status:r.status,approvalId:r.approvalId||null,approvalUrl:null,result:r.result||null,error:r.error||null});
 const pendingFor=tradeId=>Object.values(doc.approvals).find(a=>a.tradeId===tradeId&&a.status==='pending')||null;
 const tradeView=t=>({tradeId:t.tradeId,kind:t.kind||'lot',role:t.role,offerId:t.offerId||null,listingId:t.listingId||null,token:t.token||null,lot:t.lot||null,quantityAtoms:t.quantity,totalPiconero:t.price,feePiconero:t.fee||null,totalDebitPiconero:t.total||null,phase:t.phase,txid:t.txid||null,native:t.native||null,confirmations:t.confirmations||0,tokenError:t.tokenError||null,finalityDepth:finality,history:(t.history||[]).slice(-12),approvalUrl:null,approvalId:pendingFor(t.tradeId)?.id||null});
 const binding=()=>({network:manifest.network.kind,genesis:manifest.network.genesis,domain:manifest.ledgerDomain,accountId,ownerKey,payoutAddress:nativeAddress,sessionId,asset});
 function state(){
  const st=mst,n=holder?.native||null;
  const shielded=holder?.shielded?.balances?(holder.shielded.balances[asset]||'0'):null;
  return {binding:binding(),sync:{state:syncError?'unavailable':(synced?'ready':'syncing'),tipHeight:synced&&st?st.tip:null,error:syncError},
   balances:{openAtoms:synced&&st?(st.openBalances[asset]||'0'):null,lotAtoms:synced&&st?(st.lotBalances[asset]||'0'):null,privateAtoms:synced?shielded:null,nativeAvailablePiconero:synced&&n?n.unlocked:null,nativeLockedPiconero:synced&&n?n.locked:null,nativeReservedPiconero:synced&&n?n.reserved:null},
   lots:(st?.lots||[]).map(l=>({id:l.id,quantityAtoms:l.amount,height:l.height,confirmations:l.confirmations,tradable:l.tradable,anchorHeld:l.anchorHeld,listed:Object.values(doc.offers).find(o=>o.lot===l.id&&['listed','posting'].includes(o.status))?.offerId||null,released:Object.values(doc.trades).some(t=>t.role==='seller'&&t.lot===l.id&&t.phase==='released'),listable:Boolean(l.anchorHeld&&l.confirmations>=1),autoList:doc.lots[l.id]?.autoList?{status:doc.lots[l.id].autoList.status,totalPiconero:doc.lots[l.id].autoList.price,error:doc.lots[l.id].autoList.error||null}:null})),
   offers:Object.values(doc.offers).map(o=>({offerId:o.offerId,lot:o.lot,quantityAtoms:o.quantity,totalPiconero:o.price,expires:o.expires,status:o.status==='posting'?'listed':o.status})),
   trades:Object.values(doc.trades).sort((a,b)=>b.createdAt-a.createdAt).map(tradeView),
   nfts:ownedNfts().map(t=>({id:t.id,name:t.name,collection:t.collection,collectionName:t.collectionName,edition:t.edition,max:t.collectionMax,confirmations:t.confirmations,anchored:Boolean(t.anchor),anchorHeld:t.anchorHeld,anchorConfirmations:t.anchorConfirmations,tradable:!(t.anchorHeld&&t.anchorConfirmations<finality),saleReady:t.saleReady,listed:Object.values(doc.nftListings).find(l=>(l.listing?.token||l.token)===t.id&&['listed','posting','anchoring'].includes(l.status))?.id||null,released:Object.values(doc.trades).some(x=>x.kind==='nft'&&x.role==='seller'&&x.token===t.id&&x.phase==='released')})),
   nftListings:Object.values(doc.nftListings).map(l=>({id:l.id,token:l.listing?.token||l.token,pricePiconero:l.listing?.pricePiconero||l.price,expires:l.listing?.expires||null,status:l.status==='posting'?'listed':l.status,anchorTxid:l.anchorTxid||null})),
   nftIndexedHeight:nftIndex.indexedHeight,
   anchors:{mode:spareMode?'spare':'inline',ready:freeSpares().length,coming:comingSpares(),error:doc.spareError||null,unlockBlocks:10,
    maturing:(mst?.spares?.maturing||[]).filter(x=>!namedSpares().has(x.keyImage)).map(x=>({height:x.height})),
    sending:(()=>{const known=new Set([...(mst?.spares?.ready||[]),...(mst?.spares?.maturing||[])].map(x=>x.keyImage));return Object.values(doc.spares).filter(x=>x.status==='sent'&&!known.has(x.anchor)&&Date.now()-x.createdAt<6*3600e3).length;})()},
   waiting:Object.values(doc.waiting).filter(x=>x.status==='waiting').map(x=>({id:x.id,kind:x.kind,quantityAtoms:x.review.quantity,listTotalPiconero:x.review.list?.price||null,since:x.createdAt,spare:x.spare||null})),
   pendingApprovals:Object.values(doc.approvals).filter(a=>a.status==='pending').map(a=>({approvalId:a.id,kind:a.kind,url:null}))};
 }
 async function handle(m){
  const method=String(m?.method||''),b=m?.body&&typeof m.body==='object'?m.body:{};
  if(method==='handshake')return {protocol:PROTOCOL,adapterId:'xmr20-wallet-extension-market',binding:binding(),capabilities:['public-state','prepare-lot','make-and-list','list-offer','withdraw-offer','cancel-lot-native','buy-whole-lot','wallet-owned-review','journal-before-release','recover-saved','nft-list','nft-withdraw','nft-anchor','nft-buy','nft-cancel-native','spare-anchors'],realTradingEnabled:false,settlement:'anchored-lots-experimental-unreviewed',finalityDepth:finality};
  if(method==='state')return state();
  if(method==='request'){const r=doc.requests[String(m.id||'')];if(!r)throw fail('Unknown request',404);return view(r);}
  if(method==='trade'){const t=doc.trades[String(m.id||'')];if(!t)throw fail('Unknown trade',404);return tradeView(t);}
  if(['prepare','list','withdraw','cancelLot','buy','nftList','nftWithdraw','nftBuy','nftCancel'].includes(method))return serial(()=>request(method,b));
  if(method==='abandon')return serial(async()=>{const t=doc.trades[b.tradeId];if(!t||t.role!=='buyer')throw fail('Unknown trade',404);
   if(!['waiting-anchor','requested','drafting','awaiting-seller','awaiting-approval','refused'].includes(t.phase))throw fail('A signature may exist: this trade can only be reconciled, not abandoned',409);
   if(Object.values(doc.approvals).some(a=>a.tradeId===t.tradeId&&(a.status==='approving'||consuming.has(a.id)&&a.status==='pending')))throw fail('An approval of this trade is in progress',409);
   for(const a of Object.values(doc.approvals))if(a.tradeId===t.tradeId&&a.status==='pending')consuming.add(a.id);
   await update(x=>{for(const a of Object.values(x.approvals))if(a.tradeId===t.tradeId&&a.status==='pending')a.status='expired';});
   await releaseFunding(t.tradeId,'abandoned',t.phase==='refused'?'abandoned after the network refused the signed sale':'buyer abandoned before signing');relay(t.seller,'abandon',t.tradeId).catch(()=>{});return tradeView(doc.trades[t.tradeId]);});
  if(method==='retry')return serial(async()=>{const t=doc.trades[b.tradeId];if(!t?.finalBlob)throw fail('Nothing signed to re-send',409);
   const r=await w.publishWithRecovery(t.finalBlob,t.txid);await update(x=>{history(x.trades[t.tradeId],r.ok?'published':(r.uncertain?'uncertain':'refused'),r.ok?'same bytes re-sent':(r.reason||r.status));});return tradeView(doc.trades[t.tradeId]);});
  throw fail('Unknown wallet method',404);
 }
 // Open market work the background can move on without the user (unexpired listings, unfinished trades of the last week): the
 // background keeps a runner going and the wallet unlocked while this is non-zero. A buyer's payment review waits for the window.
 const IDLE=new Set(['final','abandoned','declined','failed','refused-busy','refused','payment-without-delivery','cancelled']);
 function activity(){const t=now(),week=Date.now()-7*86400000;
  return Object.values(doc.offers).filter(o=>['listed','posting'].includes(o.status)&&!(o.expires<=t)).length
   +Object.values(doc.nftListings).filter(l=>['listed','posting','anchoring','cancelling'].includes(l.status)&&!(l.listing?.expires<=t)).length
   +Object.values(doc.relists).filter(r=>['cancelling','preparing'].includes(r.stage)).length
   +Object.values(doc.lots).filter(l=>l.autoList?.status==='waiting'&&!l.cancelTxid).length
   +Object.values(doc.trades).filter(x=>!IDLE.has(x.phase)&&!(x.role==='buyer'&&x.phase==='awaiting-approval')&&x.createdAt>week).length;}
 return {
  start,tick:()=>serial(tick),handle,state,binding,activity,
  approvals:()=>Object.values(doc.approvals).filter(a=>a.status==='pending').map(a=>({id:a.id,kind:a.kind,review:a.review,nonce:a.nonce,createdAt:a.createdAt,requestId:a.requestId||null,tradeId:a.tradeId||null})),
  decide,
  get doc(){return doc;},get synced(){return synced;},get syncError(){return syncError;},
  close(){closed=true;},
 };
}
