// MONERO MARKET candidate (29 Oct 2026): market operations inside the token worker. The engine (holder.wasm
// 0.0.6-market-experimental) holds every key; this module only performs the daemon RPC calls a construction needs
// (fee rate, output distribution, pool spends, get_outs rounds, anchor spend status) and hands public results back.
// The engine's marketGuard refuses every network but the offline fakechain: real trading stays disabled.
import {createNftLedger} from './market-nft-ledger.js';
const RETRY=/round limit|did not converge/;
// 30 Oct 2026: anchored NFT sales. `mapcodec` (the reader's palette-map codec) lets the wallet's own NFT ledger check artwork
// exactly as the reader does; without it the NFT actions are unavailable.
// nftStart (30 Oct 2026): the height the wallet's own NFT ledger starts at — the ledger's start height. It used to start at 0,
// which is fine on the tiny lab chain but never finishes on stagenet or mainnet (millions of blocks, one get_block each).
export function createMarketWorker({engine,scanner,rpc,fetch:f=globalThis.fetch.bind(globalThis),mapcodec=null,nftStart=0}){
 const json=async(method,params={})=>{const r=await f(rpc+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'m',method,params}),signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('Daemon HTTP '+r.status);const v=await r.json();if(v.error)throw Error('Daemon: '+v.error.message);return v.result;};
 const other=async(p,body)=>{const r=await f(rpc+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('Daemon HTTP '+r.status);return r.json();};
 async function chainInputs(){
  const info=await json('get_info');const tip=info.height-1;
  const e=await json('get_fee_estimate',{grace_blocks:10});
  const d=await json('get_output_distribution',{amounts:[0],from_height:0,to_height:tip,cumulative:true,binary:false});
  const row=d.distributions[0];const values=row.distribution.map(Number);while(values.length<tip+1)values.push(values[values.length-1]);values.length=tip+1;
  const pool=await other('/get_transaction_pool',{});
  return {tip,feeRate:{perWeight:String(e.fee),mask:String(e.quantization_mask||1)},distribution:values,poolSpent:(pool.spent_key_images||[]).map(k=>String(k.id_hash).toLowerCase())};
 }
 // Start a construction and answer the engine's get_outs requests until it is ready (bounded ring re-seeding on the tiny chain).
 async function build(op,args){
  if(op==='marketBuy'||op==='nftBuy'){const r=await other('/is_key_image_spent',{key_images:[args.sellerRing.keyImage]});if(r.status!=='OK'||!Array.isArray(r.spent_status))throw Error('Node did not report the anchor spend status');if(r.spent_status[0]!==0)throw Error('The lot anchor is already spent'+(r.spent_status[0]===2?' (in the pool)':'')+': this lot cannot be bought');}
  await scanner.sync();
  const c=await chainInputs();
  for(let attempt=0;;attempt++){
   try{
    let r=engine.call({op,...args,feeRate:c.feeRate,distribution:c.distribution,exclude:[...new Set([...(args.exclude||[]),...c.poolSpent])]});let rounds=0;
    while(!r.ready){if(++rounds>16)throw Error('Ring selection did not converge');
     const got=await other('/get_outs',{outputs:r.need.map(index=>({amount:0,index})),get_txid:false});
     if(got.status!=='OK'||got.outs.length!==r.need.length)throw Error('Daemon get_outs failed');
     r=engine.call({op:'marketOuts',buildId:r.buildId,outs:got.outs.map((o,i)=>({index:r.need[i],key:o.key,mask:o.mask,unlocked:Boolean(o.unlocked)}))});}
    return r;
   }catch(e){if(attempt>=10||!RETRY.test(String(e.message)))throw e;}
  }
 }
 const call=(op,args={})=>engine.call({op,...args});
 const S=v=>String(v);
 let ledger=null;
 const nftLedger=()=>{if(!mapcodec)throw Error('NFT ledger unavailable in this build');ledger??=createNftLedger({json,other,startHeight:Number.isSafeInteger(nftStart)&&nftStart>0?nftStart:0,confirmations:engine.call({op:'marketProfile'}).finalityDepth,open:async h=>engine.call({op:'nftDecode',carrier:h}).envelope,mapcodec});return ledger;};
 const ledgerView=st=>({tip:st.tip,confirmations:st.confirmations,tokens:st.tokens.map(t=>({id:t.id,collection:t.collection,collectionName:t.collectionName,name:t.name,edition:t.edition,owner:t.owner,last:t.last,anchor:t.anchor,anchorHeight:t.anchorHeight,history:t.history})),events:st.events.map(e=>({txid:e.txid,height:e.height,status:e.status,operation:e.operation||null,reason:e.reason||null,record:e.status==='pending'&&e.record&&['nft_sale','nft_anchor'].includes(e.record.op)?{op:e.record.op,token:e.record.token,offer:e.record.offer||null}:null}))});
 return {
  async call(action,d){
   switch(action){
    case 'marketProfile':return call('marketProfile',d.finalityDepth?{finalityDepth:d.finalityDepth}:{});
    case 'marketStatus':return call('marketStatus');
    case 'marketRecords':return call('marketRecords');
    case 'marketPrepare':return build('marketPrepare',{asset:d.asset,quantity:S(d.quantity),excludeNotes:d.excludeNotes||[],...(d.anchor?{anchor:d.anchor}:{}),...(d.anchorKeyImage?{anchorKeyImage:d.anchorKeyImage}:{}),excludeAnchors:d.excludeAnchors||[]});
    // Spare anchor (31 Oct 2026): a plain payment of 0 XMR to the wallet's anchor key, named later by a lot or a purchase.
    case 'marketSpare':return build('marketSpare',{});
    case 'marketCancelLot':return build('marketCancelLot',{lot:d.lot});
    case 'marketRing':return build('marketRing',{lot:d.lot});
    case 'marketBuy':return build('marketBuy',{offer:d.offer,sellerRing:d.sellerRing,maxFee:S(d.maxFee),now:d.now,...(d.anchor?{anchor:d.anchor}:{}),...(d.anchorKeyImage?{anchorKeyImage:d.anchorKeyImage}:{}),excludeAnchors:d.excludeAnchors||[]});
    case 'marketSign':return call('marketSign',{buildId:d.buildId});
    case 'marketCancel':return call('marketCancel',{buildId:d.buildId});
    case 'marketOffer':return call('marketOffer',{lot:d.lot,price:S(d.price),now:d.now,expires:d.expires});
    case 'marketCheckOffer':return call('marketCheckOffer',{wire:d.wire,now:d.now});
    case 'marketWithdraw':return call('marketWithdraw',{offer:d.offer,now:d.now});
    case 'marketCheckWithdraw':return call('marketCheckWithdraw',{offer:d.offer,wire:d.wire});
    case 'marketBuyDraft':return call('marketBuyDraft',{buildId:d.buildId});
    case 'marketSellerApprove':return call('marketSellerApprove',{offer:d.offer,draft:d.draft,now:d.now,...(d.maxFee?{maxFee:S(d.maxFee)}:{})});
    case 'marketBuyerFinish':return call('marketBuyerFinish',{continuation:d.continuation,signedRecord:d.signedRecord,clsag:d.clsag,pseudoOut:d.pseudoOut});
    case 'marketCheckSale':return call('marketCheckSale',{blob:d.blob});
    case 'marketRecoverReserve':return call('marketRecoverReserve',{keyImages:d.keyImages||[]});
    case 'marketSignMessage':return call('marketSignMessage',{message:d.message});
    // Anchor spend status for a buyer waiting to pay: 0 unspent, 1 spent on chain, 2 spent in the pool.
    case 'marketAnchorSpent':{if(!/^[0-9a-f]{64}$/.test(d.keyImage||''))throw Error('Invalid key image');const r=await other('/is_key_image_spent',{key_images:[d.keyImage]});if(r.status!=='OK'||!Array.isArray(r.spent_status))throw Error('Node did not report the anchor spend status');return {spent:r.spent_status[0]};}
    // Anchored NFT sales (engine nft_ops.rs; ledger = market-nft-ledger.js over this wallet's own node)
    case 'nftLedger':{await scanner.sync();return ledgerView(await nftLedger().sync());}
    case 'nftAnchorStart':return build('nftAnchorStart',{token:d.token,prev:d.prev,...(d.anchor?{anchor:d.anchor}:{})});
    case 'nftAnchorSign':return call('nftAnchorSign',{buildId:d.buildId});
    case 'nftRing':return build('nftRing',{anchor:d.anchor});
    case 'nftBuy':return build('nftBuy',{listing:d.listing,nft:d.nft,sellerRing:d.sellerRing,maxFee:S(d.maxFee),now:d.now});
    case 'nftBuyDraft':return call('nftBuyDraft',{buildId:d.buildId});
    case 'nftSellerApprove':return call('nftSellerApprove',{listing:d.listing,nft:d.nft,draft:d.draft,...(d.maxFee?{maxFee:S(d.maxFee)}:{})});
    case 'nftBuyerFinish':return call('nftBuyerFinish',{continuation:d.continuation,carrier:d.carrier,clsag:d.clsag,pseudoOut:d.pseudoOut});
    default:throw Error('Unknown action');
   }
  }
 };
}
