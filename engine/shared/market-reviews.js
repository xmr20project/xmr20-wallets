// MONERO MARKET candidate (30 Oct 2026): the approval screens' text, shared by the extension's market window (market-wallet.js)
// and the website wallet's market dialog (research/monero-market-20261029/website/), so both wallets show the same review.
// `where` only changes how automatic sale approval is explained ('extension': while the wallet is unlocked; 'website': while
// the page is open). Pure functions; no DOM.
export const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isA=v=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v);
export const exact=(a,d)=>{if(!isA(a))return '—';const n=BigInt(a),s=10n**BigInt(d),w=(n/s).toString().replace(/\B(?=(\d{3})+(?!\d))/g,','),f=(n%s).toString().padStart(d,'0').replace(/0+$/,'');return w+(f?'.'+f:'');};
export const compact=(a,d)=>{if(!isA(a))return '—';const n=BigInt(a),s=10n**BigInt(d),w=n/s,fr=n%s,sh=fr*100n/s,lost=fr*100n%s!==0n;return (lost?'≈':'')+w.toString().replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+sh.toString().padStart(2,'0');};
export const T=a=>exact(a,6),X=a=>exact(a,12);
export const short=h=>typeof h==='string'&&h.length>16?h.slice(0,8)+'…'+h.slice(-6):String(h??'—');
export function lines(rows){return `<dl class="wl-lines">${rows.filter(Boolean).map(([k,v,cls])=>`<div class="${cls||''}"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;}
// Seller approval mode of a listing review: 'auto' (default) or 'manual'.
const AUTO_WHERE={extension:'Your wallet approves sales at this price by itself while it is unlocked and your browser is running, even with this window closed. While you have listings, the wallet does not lock itself after inactivity; lock it to pause sales.',
 website:'Your wallet approves sales at this price by itself while this page stays open with your wallet unlocked. Closing the page or locking the wallet pauses sales until you come back.'};
const approvalNote=(r,where)=>r.approval==='manual'?'<p class="wl-note">Withdrawing the listing is free until you approve a sale. Each sale still needs your approval here.</p>'
 :`<p class="wl-note">${AUTO_WHERE[where]}</p>`+(r.stallSeconds?`<p class="wl-note">If a buyer does not pay within ${Math.round(r.stallSeconds/60)||1} min of that approval, your wallet cancels the sale on chain (a network fee) and lists the item again when it is ready (${r.finalityDepth||25} confirmations).</p>`:'');
// The seller's wallet cancels a sale the buyer has not paid by payBy (automatic listings).
export const payByNote=r=>r.payBy?`<p class="wl-note warn">Approve by ${new Date(r.payBy).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}. After that the seller’s wallet cancels this sale and your XMR stays with you.</p>`:'';
export function review(a,where='extension'){
 const r=a.review;
 if(a.kind==='prepare')return `<h1 class="wl-title">Make a lot</h1><p class="wl-lead">Moves an exact amount of your Open XMR20 into one lot that only a sale or a cancellation can spend.</p>
  <div class="wl-big"><span>Lot</span><strong>${esc(T(r.quantity))} XMR20</strong><small>${esc(r.quantity)} atomic units</small></div>
  ${lines([['From','Open balance'],['Open balance after',`${esc(T(r.openAfter))} XMR20`],['Network fee',`at most ${esc(X(r.maxFee))} XMR, paid from this wallet`],
   ...(r.list?[['Then list for',`${esc(X(r.list.price))} XMR`,'total'],['Paid to (your address)',`<span class="mono">${esc(r.payout)}</span>`],['Listing ends',`in ${Math.round(r.list.lifetime/3600)} h`]]:[]),
   [r.list?'Listed':'Listable','after 1 confirmation'],['Buyers can pay after',`${esc(r.finalityDepth)} confirmations`]])}
  ${r.list?`<p class="wl-note">This one approval also signs the public listing once the lot is in a block (about 2 minutes). Buyers see it straight away; payment opens after ${esc(r.finalityDepth)} confirmations.</p>${approvalNote({...r.list,finalityDepth:r.finalityDepth},where)}`:''}
  ${r.spare?`<p class="wl-note">${r.spare==='ready'?'The lot uses an anchor your wallet set aside earlier in a separate ordinary payment':'Your wallet first sets aside an anchor in a separate ordinary payment (a small network fee) and makes the lot automatically about 20 minutes later'}, so a later sale or cancellation does not reveal which Monero coin it spends. Your wallet then keeps one anchor ready for your next trade (a small network fee each time it makes one).</p>`:''}
  <p class="wl-note">Your Private XMR20 is not touched. The lot is anchored to a 0 XMR output on this wallet’s separate anchor key, which ordinary Monero wallets restored from your phrase cannot see or spend.</p>`;
 if(a.kind==='list')return `<h1 class="wl-title">List a lot</h1><p class="wl-lead">Signs a public listing. Nothing is paid or moved.</p>
  <div class="wl-big"><span>Lot</span><strong>${esc(T(r.quantity))} XMR20</strong><small>${esc(r.quantity)} atomic units</small></div>
  ${lines([['Total price',`${esc(X(r.price))} XMR`,'total'],['Paid to (your address)',`<span class="mono">${esc(r.payout)}</span>`],['Listing ends',`in ${Math.round(r.lifetime/3600)} h`]])}
  ${approvalNote(r,where)}`;
 if(a.kind==='cancelLot')return `<h1 class="wl-title">Cancel lot on chain</h1><p class="wl-lead">Spends the lot’s Monero anchor in a transaction from this wallet; the lot becomes ordinary Open XMR20.</p>
  <div class="wl-big"><span>Lot</span><strong>${esc(T(r.quantity))} XMR20</strong></div>
  ${lines([['Network fee','paid from this wallet']])}
  ${r.released?'<p class="wl-note warn">You already approved a sale of this lot. Once this cancellation is mined, that sale can no longer be paid. A chain reorganisation that removes the cancellation could still let the buyer complete the sale at your agreed price.</p>':''}`;
 if(a.kind==='sell')return `<h1 class="wl-title">Approve sale</h1><p class="wl-lead">Your wallet checked the buyer’s transaction against your keys.</p>
  <div class="wl-big"><span>You sell</span><strong>${esc(T(r.quantity))} XMR20</strong><small>${esc(r.quantity)} atomic units · lot ${esc(short(r.lot))}</small></div>
  ${lines([['You receive',`${esc(X(r.price))} XMR`,'total'],['Paid to (your address, checked)',`<span class="mono">${esc(r.payout)}</span>`],['Buyer',`<span class="mono">${esc(short(r.buyer))}</span>`],['Network fee',`${esc(X(r.fee))} XMR, paid by the buyer`]])}
  <p class="wl-note warn">After you approve, withdrawing the listing does not stop this sale. Only cancelling the lot on chain does.</p>
  <p class="wl-note">Experimental settlement, not independently reviewed. Trade small amounts.</p>`;
 if(a.kind==='pay')return `<h1 class="wl-title">Approve payment</h1><p class="wl-lead">One Monero transaction pays the seller and delivers the lot to you.</p>
  <div class="wl-big"><span>You receive</span><strong>${esc(T(r.quantity))} XMR20</strong><small>${esc(r.quantity)} atomic units · lot ${esc(short(r.lot))}</small></div>
  ${lines([['Lot price',`${esc(X(r.price))} XMR`],['Network fee',`${esc(X(r.fee))} XMR`],['Total from this wallet',`${esc(X(r.total))} XMR`,'total'],['Paid to (seller)',`<span class="mono">${esc(r.payout)}</span>`],['Lot depth',`${esc(r.confirmationsAtQuote)} confirmations (needs ${esc(r.finalityDepth)})`]])}
  ${payByNote(r)}
  <p class="wl-note warn">Experimental settlement, not independently reviewed. Delivery and payment stand or fall together unless the chain reorganises deeper than ${esc(r.finalityDepth)} blocks.</p>`;
 const nftHead=r=>`<div class="wl-big"><span>NFT</span><strong>${esc(r.name||short(r.token))}</strong><small>${r.collection?esc(r.collection)+' · ':''}${r.edition?'edition '+esc(r.edition)+(r.max?' of '+esc(r.max):'')+' · ':''}${esc(short(r.token))}</small></div>`;
 if(a.kind==='nftList')return r.anchoring?`<h1 class="wl-title">Prepare and list an NFT</h1><p class="wl-lead">Sends one Monero transaction that binds this NFT to a new 0 XMR anchor of this wallet. The listing is signed and published automatically once that transaction has ${esc(r.finalityDepth)} confirmations.</p>
  ${nftHead(r)}
  ${lines([['Price',`${esc(X(r.price))} XMR`,'total'],['Paid to (your address)',`<span class="mono">${esc(r.payout)}</span>`],['Network fee',`at most ${esc(X(r.maxFee))} XMR, paid from this wallet`],['Listing ends',`${Math.round(r.lifetime/3600)} h after it goes live`]])}
  <p class="wl-note">The NFT stays yours. While it is anchored, it moves only in a transaction that spends the anchor: a sale you approve, or a cancellation from this wallet.</p>
  ${approvalNote(r,where)}
  <p class="wl-note warn">Experimental settlement, not independently reviewed. Trade small amounts.</p>`
  :`<h1 class="wl-title">List an NFT</h1><p class="wl-lead">Signs a public listing with this wallet’s spend key. Nothing is paid or moved.</p>
  ${nftHead(r)}
  ${lines([['Price',`${esc(X(r.price))} XMR`,'total'],['Paid to (your address)',`<span class="mono">${esc(r.payout)}</span>`],['Listing ends',`in ${Math.round(r.lifetime/3600)} h`]])}
  ${approvalNote(r,where)}`;
 if(a.kind==='nftSell')return `<h1 class="wl-title">Approve NFT sale</h1><p class="wl-lead">Your wallet checked the buyer’s transaction against your keys and your listing.</p>
  ${nftHead(r)}
  ${lines([['You receive',`${esc(X(r.price))} XMR`,'total'],['Paid to (your address, checked)',`<span class="mono">${esc(r.payout)}</span>`],['Buyer',`<span class="mono">${esc(short(r.buyer))}</span>`],['Network fee',`${esc(X(r.fee))} XMR, paid by the buyer`]])}
  <p class="wl-note warn">After you approve, withdrawing the listing does not stop this sale. Only cancelling the sale on chain does.</p>
  <p class="wl-note">Experimental settlement, not independently reviewed. Trade small amounts.</p>`;
 if(a.kind==='nftPay')return `<h1 class="wl-title">Approve NFT payment</h1><p class="wl-lead">One Monero transaction pays the seller and transfers the NFT to you.</p>
  ${nftHead(r)}
  ${lines([['Price',`${esc(X(r.price))} XMR`],['Network fee',`${esc(X(r.fee))} XMR`],['Total from this wallet',`${esc(X(r.total))} XMR`,'total'],['Paid to (seller)',`<span class="mono">${esc(r.seller)}</span>`],['Anchor depth',`${esc(r.anchorConfirmationsAtQuote)} confirmations (needs ${esc(r.finalityDepth)})`]])}
  ${payByNote(r)}
  <p class="wl-note warn">Experimental settlement, not independently reviewed. Payment and transfer stand or fall together unless the chain reorganises deeper than ${esc(r.finalityDepth)} blocks.</p>`;
 if(a.kind==='nftCancel')return `<h1 class="wl-title">Cancel NFT sale on chain</h1><p class="wl-lead">Moves the NFT’s anchor to a new 0 XMR output of this wallet in one transaction. Any sale signature you released stops working.</p>
  ${nftHead(r)}
  ${lines([['Network fee',`at most ${esc(X(r.maxFee))} XMR, paid from this wallet`]])}
  ${r.released?'<p class="wl-note warn">You already approved a sale of this NFT. Once this cancellation is mined, that sale can no longer be paid. A chain reorganisation that removes the cancellation could still let the buyer complete it at your agreed price.</p>':''}`;
 return `<p class="wl-empty">Unknown request.</p>`;
}
export const KIND_TITLE={prepare:'Make a lot',list:'List a lot',cancelLot:'Cancel lot',sell:'Approve sale',pay:'Approve payment',nftList:'List an NFT',nftSell:'Approve NFT sale',nftPay:'Approve NFT payment',nftCancel:'Cancel NFT sale'};
export const PHASE_WORD=p=>({'waiting-anchor':'Setting aside an anchor (about 20 min)',requested:'Asking the seller',drafting:'Building the transaction','awaiting-seller':'Waiting for the seller','awaiting-approval':'Waiting for you','ring-sent':'Buyer is building',released:'Sale approved',signed:'Signed',published:'In the node’s pool',delivered:'Delivered',final:'Final',failed:'Failed',declined:'Declined',abandoned:'Abandoned',uncertain:'Outcome unknown',refused:'Refused by the node',unconfirmed:'Unconfirmed',cancelled:'Cancelled: buyer did not pay'})[p]||p;
// The approve button's words and the line shown after a decision, per approval kind.
export const approveLabel=a=>({pay:'Approve and pay',sell:'Approve sale',list:'Sign listing',prepare:'Make lot',cancelLot:'Cancel lot',nftList:a.review.anchoring?'Prepare and list':'Sign NFT listing',nftSell:'Approve sale',nftPay:'Approve and pay',nftCancel:'Cancel on chain'})[a.kind]||'Approve';
export const doneText=(a,decision,result=null)=>decision==='approve'&&a.kind==='prepare'&&result?.waiting==='anchor'?'Your wallet is setting aside an anchor first. The lot is made automatically in about 20 minutes.':decision==='approve'?({pay:'Payment signed and sent.',sell:'Sale approved. The buyer’s wallet can now complete the payment.',list:'Listing signed and published.',prepare:'Lot transaction sent.',cancelLot:'Cancellation sent.',nftList:a.review.anchoring?'Anchoring transaction sent. The listing goes live when it is final.':'NFT listing signed and published.',nftSell:'Sale approved. The buyer’s wallet can now complete the payment.',nftPay:'Payment signed and sent.',nftCancel:'Cancellation sent.'})[a.kind]||'Approved.':'Declined. Nothing was signed.';
