// Holder engine host: loads the wasm module built from holder-wasm/ (no
// wasm-bindgen; JSON over a C ABI) and replays the PUBLIC chain from a Monero
// daemon's JSON-RPC into it. Environment-agnostic (worker or Node tests): the
// caller supplies fetch and the wasm bytes. Nothing here ever sees the recovery
// phrase: the worker derives the 32-byte root and hands it to `derive` once.
const enc=new TextEncoder(),dec=new TextDecoder();
export async function createHolderEngine({wasm,random=b=>crypto.getRandomValues(b)}){
 let memory;
 const imports={env:{xmr20_random(ptr,len){try{random(new Uint8Array(memory.buffer,ptr,len));return 0;}catch{return 1;}}}};
 const {instance}=wasm instanceof WebAssembly.Module?{instance:await WebAssembly.instantiate(wasm,imports)}:await WebAssembly.instantiate(wasm,imports);
 const x=instance.exports;memory=x.memory;x.xmr20_init();
 const read=(ptr,len)=>dec.decode(new Uint8Array(memory.buffer,ptr,len));
 const panicText=()=>{const n=x.xmr20_panic_len();return n?read(x.xmr20_panic_ptr(),n):'';};
 const put=bytes=>{const ptr=x.xmr20_alloc(bytes.length);new Uint8Array(memory.buffer,ptr,bytes.length).set(bytes);return ptr;};
 const finish=len=>{const v=JSON.parse(read(x.xmr20_out_ptr(),len));if(v.error)throw Error(v.error);return v.result;};
 const guard=fn=>{try{return fn();}catch(e){if(e instanceof WebAssembly.RuntimeError)throw Error('Holder engine fault: '+(panicText()||e.message));throw e;}};
 return {
  call(request){return guard(()=>{const bytes=enc.encode(JSON.stringify(request));return finish(x.xmr20_call(put(bytes),bytes.length));});},
  blob(slot,bytes){return guard(()=>finish(x.xmr20_blob(slot,put(bytes),bytes.length)));},
  memoryBytes(){return memory.buffer.byteLength;},
 };
}
// Public-chain replay against monerod JSON-RPC. EVERY block is fetched as a
// blob with its transaction blobs and handed to the engine's `applyBlock`, which
// scans the holder's native outputs (view key, local RingCT index count), tracks
// key images seen in inputs, and applies each transaction's extra to the token
// pool. A hash mismatch at any cached height (reorganization) resets the engine
// and replays from genesis.
// `network`: 'offline-fakechain' (default: the daemon must report nettype fakechain AND offline) or 'stagenet' (nettype stagenet, online allowed). Taken from the manifest.
// `startHeight`: first block of the pool (manifest network.startHeight; 0 = genesis). Blocks below it are never fetched;
// the RingCT output count before it is taken from the daemon's cumulative distribution (nativeStart).
// `lookahead`: blocks fetched ahead in parallel. Every scanner call is a read, so a busy answer (429/502/503/504 from the daemon
// or a gateway in front of it) or a dropped connection is retried with backoff before the sync reports an error.
const TRANSIENT=new Set([429,502,503,504]);
async function readRetrying(f,url,init){for(let attempt=0;;attempt++){let r=null,error=null;try{r=await f(url,init);}catch(e){error=e;}if(r&&(!TRANSIENT.has(r.status)||attempt>=5))return r;if(!r&&attempt>=5)throw error;await new Promise(done=>setTimeout(done,500*2**attempt));}}
// Saved scan progress (27 Oct 2026). The token pool (every XMR20 record; the same for all accounts) and the account's native
// wallet (its own Monero outputs, for carrier fees) advance separately. `saved.pool` {tip,log,hashes} and `saved.native`
// {state,hashes} resume each side; `hashes` are the last block hashes up to that side's tip. A side is only resumed while the
// daemon still has one of its saved hashes, rolled back to the newest one it still has (reorganization) or else rescanned.
// The native side of an account starts at its own first height (`nativeStartHeight`, never below the pool start).
// `onCheckpoint(saved)` receives progress to keep after each sync that moved, and during a long scan every `checkpointEvery`
// blocks or `checkpointMs`, whichever comes first (28 Oct 2026: a scan stopped part-way resumes close to where it was).
export function createChainScanner(engine,{rpc,fetch:fetchOnce=globalThis.fetch,onProgress=()=>{},genesis,network='offline-fakechain',startHeight=0,lookahead=32,nativeStartHeight=0,saved=null,onCheckpoint=null,checkpointEvery=200,checkpointMs=15000}){
 const f=(url,init)=>readRetrying(fetchOnce,url,init);
 const json=async(method,params={})=>{const r=await f(rpc+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'h',method,params})});if(!r.ok)throw Error('Daemon HTTP '+r.status);const v=await r.json();if(v.error)throw Error('Daemon: '+(v.error.message||JSON.stringify(v.error)));return v.result;};
 const other=async(path,body)=>{const r=await f(rpc+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('Daemon HTTP '+r.status);return r.json();};
 const base=Math.max(0,Number(startHeight)||0),nativeFirst=Math.max(base,Number(nativeStartHeight)||0);
 const known=new Map();// height -> hash of every recently applied (or resumed) block
 let poolNext=base,nativeNext=nativeFirst,ready=false,applied=0,received=0,resumeFrom=saved,lastSave={at:0,height:-1},savedOnce=false;
 const remember=(h,hash)=>{known.set(h,hash);if(known.size>600)for(const k of known.keys())if(k<h-512)known.delete(k);};
 const headerHash=async h=>(await json('get_block_header_by_height',{height:h})).block_header.hash;
 // RingCT outputs in blocks 0..h (the daemon's cumulative distribution, read once per start or rollback; the engine counts locally after that).
 async function rctThrough(h){if(h<0)return 0;const d=await json('get_output_distribution',{amounts:[0],from_height:h,to_height:h,cumulative:true,binary:false});/* one cumulative entry; asking from height 0 would return millions of entries */const row=(d.distributions||[])[0];const start=row?.start_height||0;const i=h-start;return !row||i<0?0:Number(row.distribution[Math.min(i,row.distribution.length-1)]);}
 // Newest saved height the daemon still agrees with (hashes are checked newest first; usually the first one matches).
 async function agreed(hashes,tip){for(const [h,hash] of [...(hashes||[])].sort((a,b)=>b[0]-a[0]))if(Number.isInteger(h)&&h<=tip&&await headerHash(h)===hash)return h;return null;}
 async function startNative(){if(nativeFirst>0)engine.call({op:'nativeStart',height:nativeFirst,rctOutputs:await rctThrough(nativeFirst-1)});nativeNext=nativeFirst;}
 // Puts the engine at the given progress (each side resumed at the newest height the daemon agrees with, or started fresh).
 async function resume(progress,tip){
  engine.call({op:'reset'});known.clear();poolNext=base;nativeNext=nativeFirst;
  const pool=progress?.pool,nat=progress?.native;
  if(pool&&Array.isArray(pool.log)){const h=await agreed(pool.hashes,tip).catch(()=>null);
   if(h!==null&&h>=base-1&&h<=pool.tip){try{engine.call({op:'poolRestore',tip:h,log:pool.log.filter(e=>e.height<=h)});poolNext=h+1;for(const [k,v] of pool.hashes)if(k<=h)remember(k,v);}catch{engine.call({op:'reset'});poolNext=base;}}}
  let nativeResumed=false;
  if(nat?.state&&nat.from<=nativeFirst){const top=nat.state.blocks-1,h=await agreed(nat.hashes,tip).catch(()=>null);
   if(h!==null&&h>=nativeFirst-1&&h<=top){try{engine.call({op:'nativeRestore',state:nat.state,...(h<top?{rollbackTo:h,rctOutputs:await rctThrough(h)}:{})});nativeNext=h+1;nativeResumed=true;for(const [k,v] of nat.hashes)if(k<=h)remember(k,v);}catch{nativeResumed=false;}}}
  // A refused native restore changes nothing (the engine validates all of it first), so the fresh start follows directly.
  if(!nativeResumed)await startNative();
  lastSave.height=Math.min(poolNext,nativeNext)-1;ready=true;
 }
 function progressNow(){
  const p=poolNext-1,n=nativeNext-1,hashes=top=>[...known].filter(([h])=>h<=top&&h>top-64).sort((a,b)=>a[0]-b[0]);
  return {pool:p>=base&&known.has(p)?{tip:p,log:engine.call({op:'poolSnapshot'}).log,hashes:hashes(p)}:null,native:n>=nativeFirst&&known.has(n)?{from:nativeFirst,state:engine.call({op:'nativeSnapshot'}),hashes:hashes(n)}:null};
 }
 async function checkpoint(){const progress=progressNow();resumeFrom=progress;lastSave={at:Date.now(),height:Math.min(poolNext,nativeNext)-1};savedOnce=true;if(onCheckpoint)try{await onCheckpoint(progress);}catch{}}
 async function reset(){engine.call({op:'reset'});known.clear();poolNext=base;nativeNext=nativeFirst;ready=false;resumeFrom=null;applied=0;received=0;}
 async function sync(){
  const info=await json('get_info');if(network==='stagenet'){if(info.nettype!=='stagenet')throw Error('Stagenet daemon required by the manifest (daemon reports '+info.nettype+').');}else if(network==='mainnet'){if(info.nettype!=='mainnet'||info.mainnet!==true)throw Error('Mainnet daemon required by the manifest (daemon reports '+info.nettype+').');}else if(info.nettype!=='fakechain'||info.offline!==true)throw Error('Offline fakechain required for this test build.');
  const tip=info.height-1;
  if(!ready){const g=await json('get_block',{height:0});if(g.block_header.hash!==genesis)throw Error('Daemon genesis does not match the public parameters.');
   // The pool starts at `base`. Until the daemon has reached base-1 the RingCT count before the start is not final, so nothing is seeded or scanned yet.
   if(tip<base-1)return {tip,tipHash:null,applied,received,startHeight:base,waitingForStart:true};
   await resume(resumeFrom,tip);}
  else{// Reorganization: the newest block held must still be the daemon's; otherwise go back to the newest block both agree on.
   const top=Math.max(poolNext,nativeNext)-1;
   if(known.has(top)&&(top>tip||await headerHash(top)!==known.get(top))){const now=progressNow();now.pool&&(now.pool.hashes=[...known].filter(([h])=>h<=now.pool.tip));now.native&&(now.native.hashes=[...known].filter(([h])=>h<=now.native.state.blocks-1));await resume(now,tip);}}
  // 27 Oct 2026 (mainnet pilot): fetch up to LOOKAHEAD blocks ahead in parallel (two RPC calls per block were sequential:
  // ~7 minutes for 1,400 mainnet blocks through the tunnel). Blocks are still applied strictly in height order with the same checks.
  const LOOKAHEAD=Math.max(1,Math.min(64,Number(lookahead)||32)),ahead=new Map();
  const fetchBlock=async h=>{const blk=await json('get_block',{height:h});const ids=blk.tx_hashes||[];let list=[];
   if(ids.length){const t=await other('/get_transactions',{txs_hashes:ids,decode_as_json:false,prune:false});const byHash=new Map((t.txs||[]).map(tx=>[tx.tx_hash,tx]));list=ids.map(id=>{const tx=byHash.get(id);if(!tx||!tx.as_hex)throw Error('Transaction missing from daemon reply');return {txid:id,hex:tx.as_hex};});}
   return {b:blk,txs:list};};
  const from=Math.min(poolNext,nativeNext);let moved=0;
  for(let height=from;height<=tip;height++){
   for(let h=height;h<=Math.min(tip,height+LOOKAHEAD-1);h++)if(!ahead.has(h)){const p=fetchBlock(h);p.catch(()=>{});ahead.set(h,p);}
   const got=await ahead.get(height);ahead.delete(height);const b=got.b;
   // A block that does not extend what is held (or differs from a resumed hash) means the chain changed under the scan:
   // start over from the newest saved progress the daemon still agrees with on the next sync.
   if((known.has(height-1)&&b.block_header.prev_hash!==known.get(height-1))||(known.has(height)&&known.get(height)!==b.block_header.hash)){ready=false;throw Error('Chain changed during replay; retry');}
   const pool=height>=poolNext,native=height>=nativeNext;
   const r=engine.call({op:'applyBlock',height,block:b.blob,txs:got.txs,pool,native});applied+=r.records.length;received+=r.native?.received||0;
   if(pool)poolNext=height+1;if(native)nativeNext=height+1;remember(height,b.block_header.hash);moved++;
   // `start` is the pool start, so the percentage is the same after a resume as before it.
   if(height%25===0||height===tip)onProgress({phase:'scan',height,target:tip,start:base});
   if((height-lastSave.height>=checkpointEvery||Date.now()-lastSave.at>=checkpointMs)&&height<tip)await checkpoint();
  }
  engine.call({op:'tip',height:tip});
  if(moved&&(Date.now()-lastSave.at>=checkpointMs||moved>=100||!savedOnce))await checkpoint();
  return {tip,tipHash:known.get(tip)||null,applied,received,startHeight:base,nativeStartHeight:nativeFirst};
 }
 // 29 Oct 2026 (owner: the receiving wallet "should say pending"): tokens on their way to this wallet. The node's waiting
 // transactions are listed by hash; each new one is downloaded once and kept while it waits. The engine tries them on a copy of
 // the token pool (peekPool, read-only) and reports the notes they would give this wallet, leaving out its own operations.
 const waitingTx=new Map();
 async function waiting(){
  if(!ready)return {incoming:[],checked:0,records:0};
  const ids=((await other('/get_transaction_pool_hashes',{})).tx_hashes||[]).slice(0,400),now=new Set(ids);
  for(const k of [...waitingTx.keys()])if(!now.has(k))waitingTx.delete(k);
  const fresh=ids.filter(id=>!waitingTx.has(id));
  for(let i=0;i<fresh.length;i+=100){const t=await other('/get_transactions',{txs_hashes:fresh.slice(i,i+100),decode_as_json:false,prune:false});
   for(const tx of t.txs||[])if(tx?.tx_hash&&tx.as_hex&&tx.in_pool!==false&&now.has(tx.tx_hash))waitingTx.set(tx.tx_hash,tx.as_hex);}
  return engine.call({op:'peekPool',txs:ids.filter(id=>waitingTx.has(id)).map(id=>({txid:id,hex:waitingTx.get(id)}))});
 }
 return {sync,reset,checkpoint,waiting,get height(){return Math.min(poolNext,nativeNext)-base;}};
}
