// Holder-funded carrier path (host side). The holder's engine (wasm) owns the
// Monero keys, the owned outputs, input selection and decoy sampling; this
// module only performs the daemon RPC calls the engine asks for and publishes
// the signed carrier. It talks to the daemon directly: no relay, no backend.
//
// What the daemon learns: exactly what any Monero wallet discloses to its node
// (the output indexes it asks `get_outs` for - the real one among the decoys,
// as monero-oxide does - and the signed transaction). Nothing here is sent to
// the test backend.
// `sanityChecks`: monerod's send_raw_transaction sanity checks (ring statistics). true for stagenet/mainnet (normal validation);
// false only for the offline fakechain whose few outputs cannot satisfy them.
export function createCarrierBuilder({engine,rpc,fetch:f=globalThis.fetch,onProgress:initialProgress=()=>{},sanityChecks=false}){
 let onProgress=initialProgress;
 const json=async(method,params={})=>{const r=await f(rpc+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'c',method,params}),signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('Daemon HTTP '+r.status);const v=await r.json();if(v.error)throw Error('Daemon: '+(v.error.message||JSON.stringify(v.error)));return v.result;};
 const other=async(path,body)=>{const r=await f(rpc+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('Daemon HTTP '+r.status);return r.json();};
 // Fee rate from the daemon (per byte + quantization mask). On the offline test
 // chain this is far above mainnet rates (tiny block-weight median); the engine
 // also reports an illustrative figure at a mainnet-like rate.
 async function feeRate(){const e=await json('get_fee_estimate',{grace_blocks:10});if(!(e.fee>0))throw Error('Daemon returned no fee estimate');return {perWeight:String(e.fee),mask:String(e.quantization_mask||1)};}
 // Cumulative RingCT output distribution per height 0..=tip (the engine checks
 // the last value against its own local count before trusting it for sampling).
 async function distribution(tip){const d=await json('get_output_distribution',{amounts:[0],from_height:0,to_height:tip,cumulative:true,binary:false});const row=(d.distributions||[])[0];if(!row)throw Error('Daemon returned no output distribution');const start=row.start_height||0;const out=new Array(tip+1).fill(0);for(let h=0;h<=tip;h++){const i=h-start;out[h]=i<0?0:Number(row.distribution[Math.min(i,row.distribution.length-1)]);}return out;}
 // Quote: pick the input in the engine, then satisfy its decoy-sampling needs.
 async function quote({kind,wireLen,excludeKeyImages=[]}){if(!(Number.isInteger(wireLen)&&wireLen>0))throw Error('quote needs the exact record length (wireLen) from the engine plan');
  onProgress({phase:'carrier',text:'Reading the fee rate and output distribution from the test daemon…'});
  const info=await json('get_info');const tip=info.height-1;const rate=await feeRate();const dist=await distribution(tip);
  // Pool awareness (fix from the restart cases): an output already spent by an UNCONFIRMED transaction in the daemon's pool
  // (for example this wallet's own carrier published by another installation, or before a restart) must not be chosen
  // again; the daemon would refuse the new carrier as a double spend. Key images spent in the pool are excluded here.
  const poolSpent=await poolSpentKeyImages();
  let r=engine.call({op:'carrierQuote',kind,wireLen,feeRate:rate,distribution:dist,exclude:[...new Set([...excludeKeyImages,...poolSpent])]});let rounds=0;
  while(!r.ready){if(++rounds>12)throw Error('Decoy selection did not converge');
   onProgress({phase:'carrier',text:`Sampling ring members for the carrier (round ${rounds}, ${r.need.length} outputs)…`});
   const got=await other('/get_outs',{outputs:r.need.map(index=>({amount:0,index})),get_txid:false});if(got.status!=='OK'||!Array.isArray(got.outs)||got.outs.length!==r.need.length)throw Error('Daemon get_outs failed: '+(got.status||'?'));
   r=engine.call({op:'carrierOuts',quoteId:r.quoteId,outs:got.outs.map((o,i)=>({index:r.need[i],key:o.key,mask:o.mask,unlocked:Boolean(o.unlocked)}))});}
  return {...r,feeRate:rate,tip,rounds,poolSpentExcluded:poolSpent.length};}
 async function poolSpentKeyImages(){const p=await other('/get_transaction_pool',{});return (p.spent_key_images||[]).map(k=>String(k.id_hash).toLowerCase());}
 function sign(quoteId,wire){const t0=Date.now();const out=engine.call({op:'carrierSign',quoteId,wire});return {...out,signMs:Date.now()-t0};}
 function cancel(quoteId){return engine.call({op:'carrierCancel',quoteId});}
 // Publish to the daemon. Re-sending the same blob is idempotent on monerod
 // (already-in-pool / already-in-chain are reported as OK), so a lost reply is
 // retried with the SAME transaction: never a second carrier, never a second fee.
 async function publish(blob){const r=await other('/send_raw_transaction',{tx_as_hex:blob,do_not_relay:false,do_sanity_checks:sanityChecks});
  if(r.status==='OK')return {ok:true,status:'OK'};
  const reason=r.reason||r.status||'rejected';return {ok:false,status:r.status,reason,doubleSpend:Boolean(r.double_spend),invalidInput:Boolean(r.invalid_input),lowMixin:Boolean(r.low_mixin),tooBig:Boolean(r.too_big),feeTooLow:Boolean(r.fee_too_low),notRelayed:Boolean(r.not_relayed)};}
 async function inPool(txid){const p=await other('/get_transaction_pool_hashes',{});return (p.tx_hashes||[]).includes(txid);}
 // Does the daemon know this transaction (pool or chain)? Used BEFORE any retry of an uncertain broadcast: a lost reply does
 // not mean a lost transaction. {known:false} only when the daemon positively reports the hash as missing.
 async function lookup(txid){const r=await other('/get_transactions',{txs_hashes:[txid],decode_as_json:false,prune:true});
  const t=(r.txs||[]).find(x=>x.tx_hash===txid)||(r.txs||[])[0]||null;
  if(!t)return {known:false,inPool:false,blockHeight:null,confirmations:0,status:r.status||null};
  return {known:true,inPool:Boolean(t.in_pool),blockHeight:t.in_pool?null:(t.block_height??null),confirmations:t.in_pool?0:Number(t.confirmations??0),status:r.status||null};}
 // Publish with LOST-REPLY recovery. A transport failure (connection reset, timeout) after the blob left the wallet is an
 // UNCERTAIN outcome, not a refusal: the daemon may hold the transaction. The wallet first asks the daemon whether it knows
 // the txid; only if the daemon positively does not, the SAME blob is re-sent (never a new carrier, never a second fee).
 // Every attempt is reported so a caller can show "outcome unknown" rather than "sent" or "failed". `onAttempt` may persist
 // state before each network call (a journal), so a crash between send and reply is recoverable by the same procedure.
 async function publishWithRecovery(blob,txid,{attempts=3,lookupRetries=3,delayMs=1500,onAttempt=async()=>{}}={}){
  const trail=[];let last=null;
  for(let i=0;i<attempts;i++){
   await onAttempt({attempt:i,action:'send'});
   try{const r=await publish(blob);trail.push({attempt:i,action:'send',outcome:r.ok?'accepted':'refused',status:r.status,reason:r.reason||null});if(r.ok)return {ok:true,status:r.status,uncertainReplies:trail.filter(t=>t.outcome==='uncertain').length,resends:i,trail,recovered:false};
    // A refusal that is only "already have it" never occurs on monerod (it answers OK); any other refusal is final.
    return {...r,resends:i,trail,recovered:false};}
   catch(e){trail.push({attempt:i,action:'send',outcome:'uncertain',error:String(e.cause?.code||e.cause?.message||e.message).slice(0,160)});last=e;}
   // Uncertain: did it reach the daemon? Ask (a few times: the daemon may be the one that is briefly unreachable).
   for(let j=0;j<lookupRetries;j++){try{await onAttempt({attempt:i,action:'lookup'});const l=await lookup(txid);trail.push({attempt:i,action:'lookup',...l});
     if(l.known)return {ok:true,status:l.inPool?'KNOWN_IN_POOL':'KNOWN_IN_CHAIN',uncertainReplies:trail.filter(t=>t.outcome==='uncertain').length,resends:i,trail,recovered:true,lookup:l};
     break;}catch(e2){trail.push({attempt:i,action:'lookup',error:String(e2.cause?.code||e2.message).slice(0,160)});await new Promise(r=>setTimeout(r,delayMs));}}
   await new Promise(r=>setTimeout(r,delayMs));}
  return {ok:false,status:'UNCERTAIN',reason:'no reply from the daemon and the transaction is not known to it after '+attempts+' attempts: '+(last?.message||''),uncertain:true,resends:attempts-1,trail,recovered:false};}
 return {quote,sign,cancel,publish,inPool,lookup,publishWithRecovery,poolSpentKeyImages,feeRate,set onProgress(fn){onProgress=fn;}};
}
export const PICONERO=1_000_000_000_000n;
// FIX (review L2): EXACT piconero-derived text (up to twelve decimals, only trailing zeros removed) — used for every fee shown on
// approval screens and journals. xmrApprox is the compact six-decimal display and is always labelled as approximate.
export function xmr(piconero){const n=BigInt(piconero);const neg=n<0n;const a=neg?-n:n;const whole=a/PICONERO,frac=a%PICONERO;const f=frac.toString().padStart(12,'0').replace(/0+$/,'');return (neg?'-':'')+(f?`${whole}.${f}`:`${whole}`);}
export function xmrApprox(piconero,digits=6){const n=BigInt(piconero);const whole=n/PICONERO,frac=n%PICONERO;const cut=`${whole}.${frac.toString().padStart(12,'0').slice(0,digits)}`;return (BigInt(cut.replace('.',''))*10n**BigInt(12-digits)===n?'':'≈')+cut;}
