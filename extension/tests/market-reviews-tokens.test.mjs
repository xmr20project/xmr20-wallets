// Approval screen text (market-reviews.js, shared by the extension window and the website wallet's dialog), two tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import {review,tokenSymbol,tokenLine} from '../../engine/shared/market-reviews.js';
const LUKE={asset:'53'.repeat(32),symbol:'LUKE',name:'Monero Cat',mint:'KzTQBqjkz1fCybZW1Wm44UDvYNr1VAbzupCaLvDfXMR',decimals:6};
const XMR20_LIST={asset:'3c'.repeat(32),symbol:'XMR20',name:'XMR20',mint:'Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR',decimals:6};
const XMR20_OWN={asset:'3c'.repeat(32),symbol:'XMR20',name:'XMR20',mint:null,decimals:6};
const LOT='62004a602eb33f07a9f775dc992dbcf83bcf7fa8e7017eb1b8dbefb67012b46e',ADDR='4'+'A'.repeat(94);
const REVIEWS={
 prepare:{asset:LUKE.asset,quantity:'3000000',maxFee:'10000000000',openAfter:'6000000',finalityDepth:25,list:{price:'120000000000',lifetime:86400,approval:'auto',stallSeconds:600},payout:ADDR,spare:'ready'},
 list:{lot:LOT,asset:LUKE.asset,quantity:'3000000',price:'120000000000',payout:ADDR,lifetime:86400,finalityDepth:25,approval:'auto',stallSeconds:600},
 cancelLot:{lot:LOT,asset:LUKE.asset,quantity:'3000000',released:false},
 sell:{tradeId:'ab'.repeat(16),offerId:'cd'.repeat(32),lot:LOT,asset:LUKE.asset,quantity:'3000000',price:'120000000000',payout:ADDR,buyer:'ef'.repeat(32),fee:'20000000',total:'120020000000',expires:null},
 pay:{tradeId:'ab'.repeat(16),offerId:'cd'.repeat(32),lot:LOT,asset:LUKE.asset,quantity:'3000000',price:'120000000000',fee:'20000000',total:'120020000000',payout:ADDR,seller:'ef'.repeat(32),confirmationsAtQuote:30,finalityDepth:25,payBy:null},
};
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
test('every lot review names its token: the ticker in place of XMR20, and the name with the short mint',()=>{
 for(const [kind,r] of Object.entries(REVIEWS)){const h=review({kind,review:{...r,tokenInfo:LUKE}});
  assert.ok(!/XMR20/.test(h),kind+': no XMR20 on a LUKE review');
  assert.ok(h.includes('3 LUKE'),kind+': the amount is in LUKE');
  assert.ok(h.includes('<small>Monero Cat · mint KzTQBqjk…vDfXMR</small>'),kind+': name and short mint under the amount');}
 const pay=text(review({kind:'pay',review:{...REVIEWS.pay,tokenInfo:LUKE}}));
 assert.match(pay,/^Approve payment One Monero transaction pays the seller and delivers the lot to you\. You receive 3 LUKE Monero Cat · mint KzTQBqjk…vDfXMR 3000000 atomic units · lot 62004a60…12b46e Lot price 0\.12 XMR/);
});
test('XMR20 from the token list shows its mint (three tokens share the ticker); the build’s own XMR20 without a list shows no extra line',()=>{
 assert.ok(review({kind:'pay',review:{...REVIEWS.pay,tokenInfo:XMR20_LIST}}).includes('<small>XMR20 · mint Cy5TzDyJ…VU6XMR</small>'));
 assert.equal(tokenLine({tokenInfo:XMR20_OWN}),'');assert.equal(tokenSymbol({tokenInfo:XMR20_OWN}),'XMR20');
});
test('a token without a name shows its token id; names are escaped',()=>{
 const h=review({kind:'pay',review:{...REVIEWS.pay,tokenInfo:{asset:LUKE.asset,symbol:null,name:null,mint:null,decimals:null}}});
 assert.ok(h.includes('3 tokens'));assert.ok(h.includes('<small>Token 53535353…535353</small>'));assert.ok(!/XMR20/.test(h));
 const x=review({kind:'pay',review:{...REVIEWS.pay,tokenInfo:{...LUKE,symbol:'<b>X',name:'"><img src=x>'}}});
 assert.ok(!x.includes('<b>X')&&!x.includes('<img'));assert.ok(x.includes('&lt;b&gt;X'));
});
