// A failed funding check never changes the approved amount or submits a payment.
export function showNativeFundingSetup({error,funding,account,layout,content,message,retry}){
 if(funding?.ready)return false;
 if(!funding&&!/Add (?:spendable )?XMR|insufficient (?:unlocked |spendable )?(?:XMR|Monero)|not enough (?:unlocked |spendable )?XMR/i.test(error?.message||''))return false;
 const valid=n=>typeof n==='string'&&/^(0|[1-9][0-9]*)$/.test(n);
 const xmr=raw=>{const n=BigInt(raw),fraction=String(n%1000000000000n).padStart(12,'0').replace(/0+$/,'');return String(n/1000000000000n)+(fraction?'.'+fraction:'')+' XMR';};
 const values=funding&&['totalRaw','availableRaw','requiredRaw'].every(k=>valid(funding[k]));
 const observed=values&&valid(funding.nativeBalance?.balanceRaw)&&BigInt(funding.nativeBalance.balanceRaw)>BigInt(funding.totalRaw)?funding.nativeBalance.balanceRaw:funding?.totalRaw;
 const recent=values&&BigInt(observed)>=BigInt(funding.requiredRaw)&&BigInt(funding.totalRaw)<BigInt(funding.requiredRaw);
 const reason=recent?'confirming':funding?.reason;
 const title=reason==='confirming'?'XMR is confirming':reason==='reserved'?'XMR is reserved':values?'Add XMR for fees':'Check XMR funding';
 const copy=reason==='confirming'?'Your XMR is detected. Wait for the verified funding history; you do not need to add more.':reason==='reserved'?'Some XMR is reserved by a saved payment or bridge. Check its recovery receipt before starting another.':reason==='fragmented'?'Your XMR is split across too many small coins. One larger XMR payment is needed for this bridge.':values?'Add XMR to this Monero address for fees, then check again.':'Check again to reopen and resync this wallet. Nothing was sent.';
 const details=values?`<dl class="native-send-costs"><div><dt>XMR detected</dt><dd>${xmr(observed)}</dd></div><div><dt>Available for this bridge</dt><dd>${xmr(funding.availableRaw)}</dd></div><div><dt>Required</dt><dd>${xmr(funding.requiredRaw)}</dd></div>${reason==='confirming'&&valid(funding.blocksRemaining)?`<div><dt>Verified blocks remaining</dt><dd>${funding.blocksRemaining}</dd></div>`:''}</dl>`:'';
 layout.render('<h2 class="native-funding-title">'+title+'</h2><p class="native-send-help">'+copy+'</p>'+details+'<details class="native-send-disclosure" '+(reason==='insufficient'?'open':'')+'><summary>Monero receiving address</summary><div class="native-send-address" data-funding-address></div></details><div class="native-send-actions"><button type="button" class="native-primary" data-funding-check>Check again</button></div>');
 content.querySelector('[data-funding-address]').textContent=account?.monero||'Open Receive in this wallet to copy your Monero address.';
 content.querySelector('[data-funding-check]').onclick=retry;message.textContent='';return true;
}
