// A scripted stand-in for the token worker and the order book, for market host tests that need no chain and no engine.
// It keeps per-token Open balances, lots with their token, transactions that are mined when the test says so, signed
// listings with the real byte layout (token and lot at their real offsets), a relay, and "listing soon" announcements.
// Messages are signed with real Monero message signatures (the lab's JS signer), so the host's own checks run unchanged.
// Nothing here signs a transaction or touches a network.
import {randomBytes,createHash} from 'node:crypto';
import {keysFromRoot,sign as signMessage} from './sigv2.mjs';
export const G='41'.repeat(32),D='93'.repeat(32),FIN=10;
export const manifest={network:{kind:'offline-fakechain',genesis:G},ledgerDomain:D};
const hex=n=>randomBytes(n).toString('hex');
export const sha256hex=s=>createHash('sha256').update(s).digest('hex');
// A signed listing as the engine lays it out: header, genesis, domain, token, lot, then the rest (filler here).
export const offerWire=(asset,lot)=>'584b31fe'+G+D+asset+lot+hex(250);
export function createWorld(){
 const world={tip:100,txs:new Map(),lots:new Map(),offers:new Map(),relay:[],relayId:0,pending:[],withdrawn:[],posts:[],wallets:[],
  // Mines n blocks: pool transactions get a height, cancelled lots return to their owner's Open balance, paid sales deliver.
  mine(n=1){for(let i=0;i<n;i++){world.tip++;for(const t of world.txs.values())if(t.height==null){t.height=world.tip;t.apply?.();}}},
  confirmations:h=>h==null?0:world.tip+1-h,
  fetch:async(url,opt={})=>{
   const u=new URL(url),body=opt.body?JSON.parse(opt.body):null,ok=v=>({ok:true,status:200,json:async()=>v}),no=(s,e)=>({ok:false,status:s,json:async()=>({error:e})});
   if(body)world.posts.push({path:u.pathname,body});
   if(u.pathname==='/api/market')return ok({nftTrading:'soon'});
   if(u.pathname==='/api/relay'&&opt.method==='POST'){world.relay.push({id:++world.relayId,...body});return ok({id:world.relayId});}
   if(u.pathname==='/api/relay'){const to=u.searchParams.get('to'),after=Number(u.searchParams.get('after'));return ok({messages:world.relay.filter(m=>m.to===to&&m.id>after)});}
   if(u.pathname==='/api/offers'&&opt.method==='POST'){const o=[...world.offers.values()].find(x=>x.wire===body.wire);if(!o)return no(422,'Listed lot is not an unspent note on this chain');o.relay=body.relay;o.posted=true;return ok({offerId:o.offerId});}
   if(u.pathname==='/api/offers')return ok({offers:[...world.offers.values()].filter(o=>o.posted).map(o=>({offerId:o.offerId,relay:o.relay,wire:o.wire,asset:o.asset}))});
   if(u.pathname==='/api/pending'){world.pending.push(body);return ok({});}
   if(u.pathname==='/api/withdrawals'){world.withdrawn.push(body.offer);return ok({});}
   return no(404,'no route '+u.pathname);
  },
 };
 return world;
}
// One wallet: keys for message signatures, an owner key, Open and Private balances per token, and the worker actions the host calls.
export function createWallet(world,name,{open={},shielded={}}={}){
 const keys=keysFromRoot(hex(32)),ownerKey=hex(32);
 const w={name,ownerKey,address:keys.address,tokenAddress:'xmr20t1'+name,open:{...open},shielded:{...shielded},records:{},calls:[],builds:new Map(),signed:[]};
 world.wallets.push(w);
 const myLots=()=>[...world.lots.values()].filter(l=>l.owner===ownerKey&&!l.gone);
 const tx=(apply=null)=>{const txid=hex(32);world.txs.set(txid,{txid,height:null,apply});return txid;};
 const actions={
  sync:()=>({records:w.records,native:{outputs:[],unlocked:'5000000000000',locked:'0',reserved:'0'},shielded:{balances:{...w.shielded}}}),
  marketStatus:()=>{const lotBalances={};for(const l of myLots())lotBalances[l.asset]=(BigInt(lotBalances[l.asset]||'0')+BigInt(l.amount)).toString();
   return {tip:world.tip,openBalances:{...w.open},lotBalances,spares:{ready:[],maturing:[]},
    lots:myLots().filter(l=>l.height!=null).map(l=>({id:l.id,asset:l.asset,amount:l.amount,height:l.height,confirmations:world.confirmations(l.height),tradable:world.confirmations(l.height)>=FIN,anchorHeld:true}))};},
  marketPrepare:a=>{if(BigInt(w.open[a.asset]||'0')<BigInt(a.quantity))throw Error('Insufficient unreserved public balance of this asset');const buildId=hex(8);w.builds.set(buildId,{kind:'prepare',asset:a.asset,quantity:a.quantity});return {buildId,fee:'1000'};},
  marketCancelLot:a=>{const buildId=hex(8);w.builds.set(buildId,{kind:'cancel',lot:a.lot});return {buildId,fee:'1000'};},
  marketCancel:()=>({}),
  marketSign:a=>{const b=w.builds.get(a.buildId);
   if(b.kind==='prepare'){const id=hex(32),lot={id,asset:b.asset,amount:b.quantity,owner:ownerKey,height:null};w.open[b.asset]=(BigInt(w.open[b.asset])-BigInt(b.quantity)).toString();world.lots.set(id,lot);
    const txid=tx(()=>{lot.height=world.tip;});return {txid,blob:'00',wire:'00'.repeat(38),notes:[id],anchorKeyImage:null,fee:'1000'};}
   const lot=world.lots.get(b.lot);const txid=tx(()=>{lot.gone=true;w.open[lot.asset]=(BigInt(w.open[lot.asset]||'0')+BigInt(lot.amount)).toString();});return {txid,blob:'00',fee:'1000'};},
  carrierPublishRecover:()=>({ok:true}),carrierPublish:()=>({ok:true}),
  carrierLookup:a=>{const t=world.txs.get(a.txid);return t?{known:true,inPool:t.height==null,blockHeight:t.height,confirmations:world.confirmations(t.height)}:{known:false};},
  marketOffer:a=>{const lot=world.lots.get(a.lot);if(!lot||lot.owner!==ownerKey||lot.gone)throw Error('Not one of your lots');
   const o={offerId:hex(32),wire:offerWire(lot.asset,lot.id),asset:lot.asset,lot:lot.id,seller:ownerKey,quantity:lot.amount,price:String(a.price),payout:keys.address,expires:a.expires};world.offers.set(o.offerId,o);
   return {offerId:o.offerId,wire:o.wire,quantity:o.quantity,price:o.price,payout:o.payout,expires:o.expires};},
  marketCheckOffer:a=>{const o=[...world.offers.values()].find(x=>x.wire===a.wire);if(!o)throw Error('Offer signature rejected');const lot=world.lots.get(o.lot);if(!lot||lot.gone||lot.owner!==o.seller)throw Error('Listed lot is not an unspent note on this chain');
   const c=world.confirmations(lot.height);return {valid:true,offerId:o.offerId,asset:o.asset,lot:o.lot,seller:o.seller,quantity:o.quantity,price:o.price,payout:o.payout,expires:o.expires,confirmations:c,final:c>=FIN};},
  marketWithdraw:()=>({wire:'00'}),
  marketRing:()=>({keyImage:hex(32),decoys:'decoys-'+hex(4),amount:'0'}),
  marketBuy:a=>{const buildId=hex(8);w.builds.set(buildId,{kind:'buy',offer:a.offer});return {buildId};},
  marketBuyDraft:a=>{const o=[...world.offers.values()].find(x=>x.wire===w.builds.get(a.buildId).offer);return {draft:{fee:'5',total:(BigInt(o.price)+5n).toString()},continuation:{mineKeyImages:[],offer:o.offerId}};},
  marketSellerApprove:a=>{const o=[...world.offers.values()].find(x=>x.wire===a.offer);return {fee:a.draft.fee,paid:o.price,signedRecord:'aa',clsag:'bb',pseudoOut:'cc'};},
  marketBuyerFinish:a=>{const o=world.offers.get(a.continuation.offer),lot=world.lots.get(o.lot);const txid=tx(()=>{const seller=world.wallets.find(x=>x.ownerKey===o.seller);lot.owner=ownerKey;lot.height=world.tip;
    for(const x of [w,seller])x.records[txid]={txid,kind:'lot-sale',status:'accepted',detail:{lot:o.lot,offer:o.offerId}};});return {blob:'00',txid,buyerNote:hex(32)};},
  marketSignMessage:a=>{w.signed.push(a.message);return {signature:signMessage(a.message,keys),address:keys.address};},
  marketRecoverReserve:()=>({}),nativeRelease:()=>({}),
 };
 w.client={call:async(action,args={})=>{const f=actions[action];if(!f)throw Error('stand-in has no action '+action);w.calls.push({action,args});return f(args);}};
 return w;
}
// The encrypted journal's contract (read, write(mutator)) in memory; `market` preloads saved market state for one token address.
export function memJournal(market=null){let doc={version:1,accounts:{},...(market?{market}:{})};
 return {read:async()=>JSON.parse(JSON.stringify(doc)),write:async m=>{const next=JSON.parse(JSON.stringify(doc));const r=await m(next);doc=next;return r??next;},get doc(){return doc;}};}
export const approveAll=async h=>{const out=[];for(const a of h.approvals())out.push(await h.decide(a.id,a.nonce,'approve'));return out;};
