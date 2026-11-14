// The market host with two tokens: the build's own token (XMR20) and a second token the wallet holds on Monero.
// Covers: making a lot of the second token, the "listing soon" announcement and its id, the relist after a stalled sale,
// the token on the purchase approval, refusals of a token the wallet cannot name, entries saved before lots had a token,
// and the per-token balances beside the single-token fields. Scripted stand-in (helpers/market-stand-in.mjs): no chain, no engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarketHost,offerToken,PROTOCOL} from '../../engine/shared/market-host.js';
import {relayKeyMessage} from '../../engine/shared/market-relay-seal.js';
import {createWorld,createWallet,memJournal,approveAll,manifest,offerWire,sha256hex,FIN} from './helpers/market-stand-in.mjs';
const XMR20='3c'.repeat(32),LUKE='53'.repeat(32),OTHER='ee'.repeat(32);
const ROWS=[{asset:XMR20,symbol:'XMR20',name:'XMR20',mint:'Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR',decimals:6},{asset:LUKE,symbol:'LUKE',name:'Monero Cat',mint:'KzTQBqjkz1fCybZW1Wm44UDvYNr1VAbzupCaLvDfXMR',decimals:6}];
const host=(world,w,{journal=memJournal(),tokenList=async()=>ROWS}={})=>{const h=createMarketHost({client:w.client,journal,ids:{ownerKey:w.ownerKey,nativeAddress:w.address,tokenAddress:w.tokenAddress},manifest,marketUrl:'http://order-book.test',finality:FIN,asset:XMR20,accountId:w.name,tokenList,fetch:world.fetch});h.journal=journal;return h;};
const ready=async(...hs)=>{for(const h of hs){await h.start();await h.tick();}};
const spin=async(hs,cond,what,world=null)=>{for(let i=0;i<40;i++){for(const h of hs)await h.tick();if(await cond())return;if(world)world.mine(1);}throw Error('never: '+what);};
const prepares=w=>w.calls.filter(c=>c.action==='marketPrepare').map(c=>c.args.asset);

test('the handshake keeps its binding and protocol and adds the capability',async()=>{
 const world=createWorld(),S=createWallet(world,'seller',{open:{[XMR20]:'5000000',[LUKE]:'9000000'}});const h=host(world,S);await ready(h);
 const hs=await h.handle({method:'handshake'});
 assert.equal(hs.protocol,PROTOCOL);assert.equal(PROTOCOL,'xmr20-market-wallet/2');
 assert.deepEqual(Object.keys(hs.binding),['network','genesis','domain','accountId','ownerKey','payoutAddress','sessionId','asset'],'the binding has the same fields');
 assert.equal(hs.binding.asset,XMR20,'the binding still names the build’s own token');
 assert.ok(hs.capabilities.includes('multi-asset-lots'));assert.ok(hs.capabilities.includes('prepare-lot'));
});

test('balances: the single-token fields stay, per-token balances stand beside them, not known is not zero',async()=>{
 const world=createWorld(),S=createWallet(world,'seller',{open:{[XMR20]:'5000000',[LUKE]:'9000000'},shielded:{[LUKE]:'42'}});const h=host(world,S);
 await h.start();let st=h.state();
 assert.equal(st.assets,null,'before the first sync the per-token balances are unknown, not empty');assert.equal(st.balances.openAtoms,null);
 await h.tick();st=h.state();
 assert.equal(st.balances.openAtoms,'5000000');assert.equal(st.balances.lotAtoms,'0');assert.equal(st.balances.privateAtoms,'0','the old fields are the build’s own token');
 assert.deepEqual(st.assets,{[XMR20]:{openAtoms:'5000000',lotAtoms:'0',privateAtoms:'0'},[LUKE]:{openAtoms:'9000000',lotAtoms:'0',privateAtoms:'42'}});
 await spin([h],()=>h.state().tokens[LUKE],'token names read');
 assert.deepEqual(h.state().tokens[LUKE],{symbol:'LUKE',name:'Monero Cat',mint:ROWS[1].mint,decimals:6});
});

test('make: a lot of any token held Open; refused without a balance or without a name',async()=>{
 const world=createWorld(),S=createWallet(world,'seller',{open:{[XMR20]:'5000000',[LUKE]:'9000000',[OTHER]:'7000000'}});const h=host(world,S);await ready(h);
 await assert.rejects(h.handle({method:'prepare',body:{requestId:'prep-00000001',asset:'not-hex',quantityAtoms:'1'}}),/Unknown asset/);
 await assert.rejects(h.handle({method:'prepare',body:{requestId:'prep-00000002',quantityAtoms:'1'}}),/Unknown asset/);
 await assert.rejects(h.handle({method:'prepare',body:{requestId:'prep-00000003',asset:'aa'.repeat(32),quantityAtoms:'1'}}),/above your Open balance/,'a token the wallet does not hold');
 await assert.rejects(h.handle({method:'prepare',body:{requestId:'prep-00000004',asset:LUKE,quantityAtoms:'9000001'}}),/above your Open balance/);
 await assert.rejects(h.handle({method:'prepare',body:{requestId:'prep-00000005',asset:OTHER,quantityAtoms:'1000000'}}),/no name for that token/,'held, but not on the token list');
 assert.equal(h.approvals().length,0);assert.deepEqual(prepares(S),[]);
 const p=await h.handle({method:'prepare',body:{requestId:'prep-00000006',asset:LUKE,quantityAtoms:'4000000'}});assert.equal(p.status,'awaiting-approval');
 const a=h.approvals()[0];assert.equal(a.kind,'prepare');assert.equal(a.review.asset,LUKE);assert.equal(a.review.openAfter,'5000000');
 assert.deepEqual(a.review.tokenInfo,{asset:LUKE,symbol:'LUKE',name:'Monero Cat',mint:ROWS[1].mint,decimals:6},'the review names the token');
 const [r]=await approveAll(h);assert.equal(r.status,'approved');
 assert.deepEqual(prepares(S),[LUKE],'the engine was asked for a lot of the chosen token');
 assert.equal(h.doc.lots[r.result.lot].asset,LUKE,'the saved lot carries its token');
 world.mine(1);await h.tick();const st=h.state();
 assert.deepEqual(st.lots.map(l=>[l.id,l.asset,l.quantityAtoms]),[[r.result.lot,LUKE,'4000000']]);
 assert.equal(st.assets[LUKE].openAtoms,'5000000');assert.equal(st.assets[LUKE].lotAtoms,'4000000');assert.equal(st.balances.openAtoms,'5000000');assert.equal(st.balances.lotAtoms,'0','no XMR20 lot was made');
 // The build's own token still works exactly as before.
 await h.handle({method:'prepare',body:{requestId:'prep-00000007',asset:XMR20,quantityAtoms:'1000000'}});const [r2]=await approveAll(h);
 assert.equal(h.doc.lots[r2.result.lot].asset,XMR20);assert.deepEqual(prepares(S),[LUKE,XMR20]);
});

test('without a token list only the build’s own token has a name',async()=>{
 const world=createWorld(),S=createWallet(world,'seller',{open:{[XMR20]:'5000000',[LUKE]:'9000000'}});
 for(const tokenList of [null,async()=>{throw Error('bridge unreachable');},async()=>[]]){
  const h=host(world,S,{tokenList});await ready(h);
  await assert.rejects(h.handle({method:'prepare',body:{requestId:'prep-1000000'+h.binding().sessionId.slice(0,4),asset:LUKE,quantityAtoms:'1'}}),/no name for that token/);
  const p=await h.handle({method:'prepare',body:{requestId:'prep-2000000'+h.binding().sessionId.slice(0,4),asset:XMR20,quantityAtoms:'1'}});assert.equal(p.status,'awaiting-approval');
  assert.deepEqual(h.approvals()[0].review.tokenInfo,{asset:XMR20,symbol:'XMR20',name:'XMR20',mint:null,decimals:6});
  await h.decide(h.approvals()[0].id,h.approvals()[0].nonce,'decline');
 }
});

test('names from the list are cleaned; rows with a bad token id, mint or decimals are left out; another number of decimals is refused',async()=>{
 const world=createWorld(),S=createWallet(world,'seller',{open:{[LUKE]:'9000000',[OTHER]:'7000000'}});
 const rows=[{asset:LUKE,symbol:'LU‮KE\n',name:'  Monero\u0000 Cat  ',mint:ROWS[1].mint,decimals:6},{asset:LUKE,symbol:'DUP',name:'second row for the same token',mint:ROWS[1].mint,decimals:6},
  {asset:'zz',symbol:'BAD',name:'bad id',mint:ROWS[1].mint,decimals:6},{asset:'ab'.repeat(32),symbol:'NOMINT',name:'x',mint:'0OIl',decimals:6},{asset:OTHER,symbol:'EIGHT',name:'Eight decimals',mint:ROWS[0].mint,decimals:8}];
 const h=host(world,S,{tokenList:async()=>rows});await ready(h);await spin([h],()=>h.state().tokens[LUKE],'names');
 assert.deepEqual(h.state().tokens[LUKE],{symbol:'LUKE',name:'Monero Cat',mint:ROWS[1].mint,decimals:6},'control and direction characters are dropped; the first row stands');
 assert.equal(h.state().tokens['ab'.repeat(32)],undefined);
 await assert.rejects(h.handle({method:'prepare',body:{requestId:'prep-00000001',asset:OTHER,quantityAtoms:'1'}}),/6 decimals only/);
});

test('"listing soon": the announcement names the lot’s own token and keeps the id formula',async()=>{
 const world=createWorld(),S=createWallet(world,'seller',{open:{[XMR20]:'5000000',[LUKE]:'9000000'}});const h=host(world,S);await ready(h);
 await h.handle({method:'prepare',body:{requestId:'prep-00000001',asset:LUKE,quantityAtoms:'4000000',listTotalPiconero:'250000000000'}});await approveAll(h);
 await h.tick();
 assert.equal(world.pending.length,1);const p=world.pending[0];
 assert.equal(p.asset,LUKE);assert.equal(p.quantityAtoms,'4000000');assert.equal(p.totalPiconero,'250000000000');assert.equal(p.payoutAddress,S.address);assert.equal(p.stage,'lot');
 const id=sha256hex(['xmr20-market-pending-v1',LUKE,'4000000','250000000000',S.address,p.nonce].join('|'));
 assert.ok(S.signed.includes(relayKeyMessage(id,p.relay.key)),'the wallet signed the id made from the lot’s own token');
 assert.ok(!S.signed.includes(relayKeyMessage(sha256hex(['xmr20-market-pending-v1',XMR20,'4000000','250000000000',S.address,p.nonce].join('|')),p.relay.key)),'not an id that names XMR20');
 // Listed at its first block: the listing is this lot's, and the saved offer carries the token.
 world.mine(1);await h.tick();
 const o=Object.values(h.doc.offers)[0];assert.equal(o.asset,LUKE);assert.equal(offerToken(o.wire).asset,LUKE);assert.equal(h.state().offers[0].asset,LUKE);
});

test('buying: the purchase is approved by the token’s name; a lot of a token without a name is refused',async()=>{
 const world=createWorld(),S=createWallet(world,'seller',{open:{[XMR20]:'5000000',[LUKE]:'9000000',[OTHER]:'7000000'}}),B=createWallet(world,'buyer');
 const hs=host(world,S,{tokenList:async()=>[...ROWS,{asset:OTHER,symbol:'XMR20',name:'XMR20',mint:'9MwJfFGc3jNkAKLwma4kkUYivs19yJsWXuPD15RegXMR',decimals:6}]}),hb=host(world,B);await ready(hs,hb);
 // The seller lists a lot of LUKE and a lot of a token the buyer's list does not have (and which calls itself XMR20).
 const offers={};
 for(const [k,asset] of [['luke',LUKE],['other',OTHER]]){
  await hs.handle({method:'prepare',body:{requestId:'prep-'+k.padEnd(8,'0'),asset,quantityAtoms:'3000000',listTotalPiconero:'90000000000',sellerApproval:'manual'}});await approveAll(hs);}
 world.mine(1);await hs.tick();world.mine(FIN);await hs.tick();await hb.tick();
 for(const o of Object.values(hs.doc.offers))offers[o.asset]=o;
 assert.equal(Object.keys(offers).length,2);
 await assert.rejects(hb.handle({method:'buy',body:{requestId:'buy-00000001',offer:offers[OTHER].wire}}),/no name for that token/);
 assert.equal(Object.keys(hb.doc.trades).length,0,'nothing was started for the token without a name');
 const b=await hb.handle({method:'buy',body:{requestId:'buy-00000002',offer:offers[LUKE].wire}});assert.equal(b.status,'done');const id=b.result.tradeId;
 assert.equal(hb.doc.trades[id].asset,LUKE);assert.equal(hb.doc.trades[id].tokenInfo.symbol,'LUKE');
 await spin([hs,hb],()=>hs.approvals().some(a=>a.kind==='sell'),'seller review');
 const sell=hs.approvals().find(a=>a.kind==='sell');assert.equal(sell.review.asset,LUKE);assert.equal(sell.review.tokenInfo.name,'Monero Cat');assert.equal(hs.doc.trades[id].asset,LUKE);
 await approveAll(hs);
 await spin([hs,hb],()=>hb.approvals().some(a=>a.kind==='pay'),'payment review');
 const pay=hb.approvals().find(a=>a.kind==='pay');
 assert.equal(pay.review.asset,LUKE);assert.deepEqual(pay.review.tokenInfo,{asset:LUKE,symbol:'LUKE',name:'Monero Cat',mint:ROWS[1].mint,decimals:6},'the payment review names the token and its mint');
 assert.equal(pay.review.quantity,'3000000');assert.equal(BigInt(pay.review.total),BigInt(pay.review.price)+BigInt(pay.review.fee));
 const [r]=await approveAll(hb);assert.equal(r.status,'approved');
 world.mine(1);await hb.tick();await hs.tick();
 const tv=await hb.handle({method:'trade',id});assert.equal(tv.asset,LUKE);assert.equal(tv.phase,'delivered');assert.equal(tv.token,'accepted','the trade’s ledger status keeps its field');
 assert.equal(hb.state().lots[0].asset,LUKE);assert.equal(hb.state().assets[LUKE].lotAtoms,'3000000');
});

test('a stalled sale of another token is relisted as that token, at the same quantity and price',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 // The seller holds less XMR20 than the lot: a relist that looked at the XMR20 balance would wait for good.
 const world=createWorld(),S=createWallet(world,'seller',{open:{[XMR20]:'1000000',[LUKE]:'9000000'}}),B=createWallet(world,'buyer');const hs=host(world,S),hb=host(world,B);await ready(hs,hb);
 await hs.handle({method:'prepare',body:{requestId:'prep-00000001',asset:LUKE,quantityAtoms:'4000000',listTotalPiconero:'120000000000',stallSeconds:60}});await approveAll(hs);
 world.mine(1);await hs.tick();world.mine(FIN);await hs.tick();await hb.tick();
 const offer=Object.values(hs.doc.offers)[0];
 const id=(await hb.handle({method:'buy',body:{requestId:'buy-00000001',offer:offer.wire}})).result.tradeId;
 await spin([hs,hb],()=>hb.approvals().some(a=>a.kind==='pay'),'payment review (the seller approved by itself)');
 assert.ok(hs.doc.trades[id].payBy>Date.now());
 t.mock.timers.tick(61000);// the buyer lets the pay window pass
 await hs.tick();
 assert.equal((await hs.handle({method:'trade',id})).phase,'cancelled');
 const rl=Object.values(hs.doc.relists)[0];assert.equal(rl.asset,LUKE,'the relist is saved with the lot’s token');assert.equal(rl.from,offer.lot);
 await spin([hs],()=>Object.values(hs.doc.relists)[0].stage==='preparing','lot made again',world);
 assert.deepEqual(prepares(S),[LUKE,LUKE],'both lots are of the stalled lot’s token; no XMR20 lot was made');
 const again=Object.values(hs.doc.relists)[0];assert.equal(hs.doc.lots[again.lot].asset,LUKE);assert.equal(world.lots.get(again.lot).asset,LUKE);assert.equal(world.lots.get(again.lot).amount,'4000000');
 await spin([hs],()=>Object.values(hs.doc.relists)[0].stage==='listed','lot listed again',world);
 const o2=hs.doc.offers[Object.values(hs.doc.relists)[0].offerId];assert.equal(o2.asset,LUKE);assert.equal(o2.price,'120000000000');assert.equal(o2.quantity,'4000000');
 assert.equal(S.open[XMR20],'1000000','the XMR20 balance was never touched');
});

test('entries saved before lots had a token: the engine’s lot list, then the signed listing, then the build’s own token',async()=>{
 const world=createWorld(),S=createWallet(world,'seller',{open:{[XMR20]:'9000000',[LUKE]:'9000000'}});
 // Chain state: L1 an XMR20 lot this wallet made; L2 a LUKE lot it holds (bought earlier); L3 a LUKE lot whose stalled sale was
 // cancelled (the cancellation is mined, the lot is gone); L4 a cancelled lot of which the journal kept only the relist.
 const lot=(asset,amount,gone=false)=>{const id=(world.lots.size+1).toString(16).padStart(64,'a');world.lots.set(id,{id,asset,amount,owner:S.ownerKey,height:world.tip-20,gone});return id;};
 const L1=lot(XMR20,'1000000'),L2=lot(LUKE,'2000000'),L3=lot(LUKE,'3000000',true),L4=lot(XMR20,'500000',true),L5=lot(LUKE,'600000',true);
 const mined=()=>{const txid='c'.repeat(63)+world.txs.size;world.txs.set(txid,{txid,height:world.tip-5});return txid;};
 const w2=offerWire(LUKE,L2),w3=offerWire(LUKE,L3),w5=offerWire(LUKE,L5);
 for(const [id,wire,l] of [['o2'.repeat(32),w2,L2],['o3'.repeat(32),w3,L3]])world.offers.set(id,{offerId:id,wire,asset:LUKE,lot:l,seller:S.ownerKey,quantity:world.lots.get(l).amount,price:'70000000000',payout:S.address,expires:Math.floor(Date.now()/1000)+3600});
 const old={version:1,requests:{},approvals:{},rings:{},nftListings:{},nftRings:{},nftCancels:{},spares:{},waiting:{},spareError:null,relayKey:null,relayCursor:0,events:[],
  lots:{[L1]:{lot:L1,quantity:'1000000',txid:mined(),blob:'00',inputs:[],anchor:null,createdAt:1}},
  offers:{['o2'.repeat(32)]:{offerId:'o2'.repeat(32),wire:w2,lot:L2,quantity:'2000000',price:'70000000000',payout:S.address,expires:Math.floor(Date.now()/1000)+3600,lifetime:3600,status:'listed',approval:'auto',stallSeconds:600},
   ['o3'.repeat(32)]:{offerId:'o3'.repeat(32),wire:w3,lot:L3,quantity:'3000000',price:'70000000000',payout:S.address,expires:1,lifetime:3600,status:'withdrawn',approval:'auto',stallSeconds:600},
   ['o5'.repeat(32)]:{offerId:'o5'.repeat(32),wire:w5,lot:L5,quantity:'600000',price:'9000000000',payout:S.address,expires:1,lifetime:3600,status:'closed',approval:'manual',stallSeconds:null}},
  trades:{['t3'.repeat(16)]:{role:'seller',tradeId:'t3'.repeat(16),offerId:'o3'.repeat(32),offer:w3,lot:L3,buyer:'bb'.repeat(32),counterparty:'bb'.repeat(32),quantity:'3000000',price:'70000000000',phase:'cancelled',stallCancel:'cancelled',createdAt:1,history:[]}},
  relists:{[L3]:{from:L3,offerId:'o3'.repeat(32),quantity:'3000000',price:'70000000000',lifetime:3600,stallSeconds:600,cancelTxid:mined(),stage:'cancelling',attempts:0,createdAt:1},
   [L4]:{from:L4,offerId:'gone'.repeat(16),quantity:'500000',price:'10000000000',lifetime:3600,stallSeconds:600,cancelTxid:mined(),stage:'cancelling',attempts:0,createdAt:2}}};
 for(const group of ['lots','offers','trades','relists'])for(const e of Object.values(old[group]))assert.equal(e.asset,undefined,'the saved entries name no token');
 const journal=memJournal({[S.tokenAddress]:old});const h=host(world,S,{journal});await ready(h);
 const st=h.state();
 assert.deepEqual(Object.fromEntries(st.lots.map(l=>[l.id,l.asset])),{[L1]:XMR20,[L2]:LUKE},'held lots: the engine’s lot list');
 assert.deepEqual(Object.fromEntries(st.offers.map(o=>[o.lot,o.asset])),{[L2]:LUKE,[L3]:LUKE,[L5]:LUKE},'offers: the lot list, and for a lot that is gone the signed listing (L5 has nothing else)');
 assert.equal(st.trades.find(x=>x.tradeId==='t3'.repeat(16)).asset,LUKE,'trade: the signed listing kept with it');
 // The two relists run: L3's as LUKE (its listing names LUKE), L4's as the build's own token (nothing names another).
 await spin([h],()=>Object.values(h.doc.relists).every(r=>r.stage!=='cancelling'),'both relists made their lots');
 assert.equal(h.doc.relists[L3].asset,LUKE);assert.equal(h.doc.lots[h.doc.relists[L3].lot].asset,LUKE);assert.equal(world.lots.get(h.doc.relists[L3].lot).amount,'3000000');
 assert.equal(h.doc.relists[L4].asset,XMR20);assert.equal(h.doc.lots[h.doc.relists[L4].lot].asset,XMR20);
 assert.deepEqual(prepares(S).sort(),[XMR20,LUKE].sort());
 // Nothing saved was rewritten or dropped: the old entries are still there, with their fields.
 const saved=journal.doc.market[S.tokenAddress];
 assert.deepEqual(saved.lots[L1],old.lots[L1]);assert.deepEqual(saved.offers['o2'.repeat(32)],old.offers['o2'.repeat(32)]);assert.deepEqual(saved.trades['t3'.repeat(16)],old.trades['t3'.repeat(16)]);
 assert.deepEqual(Object.keys(saved).sort(),Object.keys(old).sort(),'no journal key was added or removed');
});

test('a payment review saved before lots had a token is shown with its token, and is approved only once the token has a name',async()=>{
 const world=createWorld(),S=createWallet(world,'seller',{open:{[LUKE]:'9000000'}}),B=createWallet(world,'buyer');
 const L=('1').padStart(64,'a');world.lots.set(L,{id:L,asset:LUKE,amount:'2000000',owner:S.ownerKey,height:world.tip-20});
 const wire=offerWire(LUKE,L),O='0f'.repeat(32),T='7a'.repeat(16);
 world.offers.set(O,{offerId:O,wire,asset:LUKE,lot:L,seller:S.ownerKey,quantity:'2000000',price:'70000000000',payout:S.address,expires:Math.floor(Date.now()/1000)+3600,posted:true});
 const review={kind:'pay',tradeId:T,offerId:O,lot:L,quantity:'2000000',price:'70000000000',fee:'5',total:'70000000005',payout:S.address,seller:S.ownerKey,confirmationsAtQuote:20,finalityDepth:FIN,payBy:null};
 const old={version:1,requests:{},offers:{},lots:{},rings:{},nftListings:{},nftRings:{},nftCancels:{},relists:{},spares:{},waiting:{},spareError:null,relayKey:null,relayCursor:0,events:[],
  approvals:{ap1:{id:'ap1',kind:'pay',review,nonce:'n1',status:'pending',createdAt:1,tradeId:T}},
  trades:{[T]:{role:'buyer',tradeId:T,peerKey:'aa'.repeat(32),offerId:O,offer:wire,lot:L,seller:S.ownerKey,counterparty:S.ownerKey,quantity:'2000000',price:'70000000000',payout:S.address,maxFee:'10000000000',fee:'5',total:'70000000005',phase:'awaiting-approval',continuation:{mineKeyImages:[],offer:O},sellerApproval:{signedRecord:'aa',clsag:'bb',pseudoOut:'cc'},createdAt:Date.now(),history:[]}}};
 let rows=[];const h=host(world,B,{journal:memJournal({[B.tokenAddress]:old}),tokenList:async()=>rows});await ready(h);
 let a=h.approvals()[0];assert.equal(a.review.asset,LUKE,'the token comes from the listing saved with the trade');assert.equal(a.review.tokenInfo.symbol,null,'no name yet');
 await assert.rejects(h.decide(a.id,a.nonce,'approve'),/no name for that token/);
 assert.equal(h.approvals().length,1,'the review is still there');assert.equal(B.calls.filter(c=>c.action==='marketBuyerFinish').length,0,'nothing was signed');
 rows=ROWS;t_advance:{const real=Date.now;Date.now=()=>real()+31000;try{await assert.doesNotReject(h.decide(a.id,a.nonce,'approve'));}finally{Date.now=real;}}
 assert.equal(B.calls.filter(c=>c.action==='marketBuyerFinish').length,1,'approved once the token list names it');
});

test('an old list review of a bought lot is held until the first sync, then shows its own token',async()=>{
 const world=createWorld(),S=createWallet(world,'seller',{open:{[XMR20]:'5000000'}});
 // A LUKE lot this wallet bought with the old host: on chain at its owner key, not in its own lot records.
 const L='b0'.repeat(32);world.lots.set(L,{id:L,asset:LUKE,amount:'2000000',owner:S.ownerKey,height:world.tip-30});
 const old={version:1,requests:{r1:{id:'r1',kind:'list',status:'awaiting-approval',approvalId:'ap1',createdAt:1}},offers:{},lots:{},trades:{},rings:{},nftListings:{},nftRings:{},nftCancels:{},relists:{},spares:{},waiting:{},spareError:null,relayKey:null,relayCursor:0,events:[],
  approvals:{ap1:{id:'ap1',kind:'list',review:{lot:L,quantity:'2000000',price:'70000000000',payout:S.address,lifetime:3600,finalityDepth:FIN,approval:'auto',stallSeconds:600},nonce:'n1',status:'pending',createdAt:1,requestId:'r1'}}};
 const h=host(world,S,{journal:memJournal({[S.tokenAddress]:old})});await h.start();
 assert.deepEqual(h.approvals(),[],'not shown before the wallet has read its lots');
 await assert.rejects(h.decide('ap1','n1','approve'),/not synced yet/);assert.equal(h.doc.approvals.ap1.status,'pending','still waiting, nothing signed');
 await h.tick();for(let i=0;i<10&&!h.state().tokens[LUKE];i++){await new Promise(r=>setTimeout(r,20));await h.tick();}
 const a=h.approvals()[0];assert.equal(a.id,'ap1');assert.equal(a.review.asset,LUKE);assert.equal(a.review.tokenInfo.symbol,'LUKE','after the sync the review names the lot’s own token');
});

test('names lose C1 controls, line separators, invisible joiners and byte-order marks',async()=>{
 const world=createWorld(),S=createWallet(world,'seller',{open:{[LUKE]:'9000000'}});
 const bad=[0x85,0x9f,0xad,0x61c,0x2028,0x2029,0x2060,0x2064,0xfeff].map(c=>String.fromCharCode(c)).join('');
 const h=host(world,S,{tokenList:async()=>[{...ROWS[1],symbol:'LU'+bad+'KE',name:'Monero'+bad+' Cat'}]});await ready(h);
 for(let i=0;i<10&&!h.state().tokens[LUKE];i++){await new Promise(r=>setTimeout(r,20));await h.tick();}
 assert.equal(h.state().tokens[LUKE].symbol,'LUKE');assert.equal(h.state().tokens[LUKE].name,'Monero Cat');
});
