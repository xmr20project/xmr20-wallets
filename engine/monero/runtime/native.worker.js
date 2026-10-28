/* Pinned monero-ts full wallet. Keys remain in this worker; no persistence of keys.
 * Transactions are constructed without relay, then relayed only by an explicit approval.
 * Scan history may be checkpointed as an opaque wallet cache that the library
 * encrypts with a key derived from the recovery phrase inside this worker.
 */
'use strict';
/* XMR20 shared native spend guard v2 */
let spendGuard=null;
async function savedPaymentRead(data){
 if(!wallet||!spendGuard)throw Error('Open this wallet first');
 if(data.action==='paymentRecoveryStatus')return spendGuard.recoveryStatus();
 if(! /^[a-f0-9]{64}$/.test(data.txid))throw Error('Exact saved payment required');
 const target=await health(data.node);
 const response=await self.fetch(data.node+'/gettransactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:[data.txid],decode_as_json:false,prune:false})});
 if(!response.ok)throw Error('Payment status unavailable');const body=await response.text();
 if(body.length>2*1024*1024)throw Error('Payment status exceeds bound');
 return spendGuard.paymentStatus(data.txid,JSON.parse(body),target);
}
const NODES=['https://api.xmr20.org/monero','https://xmr-node.cakewallet.com:18081','https://node.sethforprivacy.com'];
const OWN_NODE=NODES[0],PUBLIC_RELAY_NODE=NODES[1];
const post=self.postMessage.bind(self),netFetch=self.fetch.bind(self);
let wallet=null,loaded=false,busy=false,currentId=null,lastProgress=0,pending=null,canRelay=false,scanStart=0,stopRequested=false,pauseRequested=false,currentAction=null,connectedNode=null;
for(const method of ['log','info','warn','error','debug'])console[method]=()=>{};
const readPaths=new Set(['/send_raw_transaction','/sendrawtransaction','/get_info','/get_height','/getblocks.bin','/gethashes.bin','/gettransactions','/get_transaction_pool_hashes.bin','/get_o_indexes.bin','/get_outs.bin','/get_output_distribution.bin','/is_key_image_spent','/json_rpc']);
// Block downloads from public nodes can legitimately take longer than small reads.
const SLOW_PATHS=new Set(['/getblocks.bin','/gethashes.bin','/get_outs.bin','/get_o_indexes.bin','/get_output_distribution.bin']);
const requestTimeout=pathname=>SLOW_PATHS.has(pathname)?90000:30000;
// Both fetch and XHR are guarded because the pinned library uses Axios.
function readRequest(input,body){
 const url=new URL(input);
 // wallet2 drops a daemon URI's path prefix. Accept its exact root RPC
 // aliases here, then map them to our fixed gateway before any network call.
 const base=NODES.find(node=>url.href.startsWith(node+'/'))||(url.origin===new URL(OWN_NODE).origin?url.origin:null);
 const pathname=base?url.href.slice(base.length):'';
 const rawPath=String(input).match(/^https:\/\/[^/?#]+(\/[^?#]*)$/)?.[1];
 if(!base||rawPath!==url.pathname||url.search||url.hash||url.username||url.password||!readPaths.has(pathname))throw Error('Node request blocked');
 if(['/sendrawtransaction','/send_raw_transaction'].includes(pathname)&&!canRelay)throw Error('Relay requires approval');
 if(pathname==='/json_rpc'&&body){const p=JSON.parse(body);if(!['get_version','get_info','hard_fork_info','get_txpool_backlog','get_fee_estimate','get_block_header_by_height','get_block_header_by_hash','get_last_block_header','get_block_headers_range','getblockheadersrange','get_block_count','get_output_distribution','get_output_histogram','get_height'].includes(p.method))throw Error('Node request blocked');}
 return pathname;
}
function requestDestination(input,pathname){
 // The owned gateway is read-only. Only an already-approved relay reaches this
 // branch; send the exact existing transaction body to the fixed public node.
 // Do not retry a relay or replace any prepared/saved transaction bytes.
 if(new URL(input).origin!==new URL(OWN_NODE).origin)return input;
 return ['/sendrawtransaction','/send_raw_transaction'].includes(pathname)?PUBLIC_RELAY_NODE+pathname:OWN_NODE+pathname;
}
self.fetch=(input,opts={})=>{let pathname,url;try{url=typeof input==='string'?input:input.url;pathname=readRequest(url,opts.body);if(opts.method&&!['GET','POST'].includes(opts.method.toUpperCase()))throw Error();}catch{return Promise.reject(Error('Node request blocked'));}return netFetch(requestDestination(url,pathname),{...opts,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(requestTimeout(pathname))});};
const BrowserXHR=self.XMLHttpRequest;
self.XMLHttpRequest=class extends BrowserXHR{
 open(method,url,...rest){if(!['GET','POST'].includes(method.toUpperCase()))throw Error('Node request blocked');const pathname=readRequest(url);this.nodeUrl=url;return super.open(method,requestDestination(url,pathname),...rest);}
 send(body){const pathname=readRequest(this.nodeUrl,body);this.withCredentials=false;this.timeout=requestTimeout(pathname);return super.send(body);}
};
async function health(node){
 if(!NODES.includes(node))throw Error('Invalid node');
 const response=await self.fetch(node+'/get_info');if(!response.ok)throw Error('Node unavailable');const data=await response.json();
 if(data.status!=='OK'||data.untrusted===true||data.mainnet!==true||data.nettype!=='mainnet'||!Number.isSafeInteger(data.height)||data.height<=0||data.offline===true||data.synchronized===false)throw Error('Mainnet node is not synced');
 return data.height;
}
// Respect an explicit node choice. The default is our node, with public-node
// fallback; a deliberately selected public node tries its public peer first.
function nodeOrder(primary,failover){
 if(!NODES.includes(primary))throw Error('Invalid node');
 return failover===false?[primary]:[primary,...NODES.filter(n=>n!==primary&&n!==OWN_NODE),...(primary!==OWN_NODE?[OWN_NODE]:[])];
}
// Bounds count failures, never checkpoint passes: a long first scan is many passes.
const SYNC_STALL_LIMIT=4,SYNC_RETRY_LIMIT=40,CHECKPOINT_MS=40000;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const bytes=value=>value instanceof Uint8Array?new Uint8Array(value):value instanceof ArrayBuffer?new Uint8Array(value.slice(0)):ArrayBuffer.isView(value)?new Uint8Array(value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength)):null;
// A wallet-cache password derived from the phrase. The app only ever stores
// the resulting opaque, library-encrypted bytes; it never sees this value.
async function cachePassword(seed){
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('xmr20-native-cache-v1\n'+seed.trim().split(/\s+/).join(' ')));
 return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
async function checkpoint(id,reason){
 if(!wallet)return;
 try{const data=await wallet.getData();const cache=bytes(data?.[1]);if(!cache||!cache.length)return;const height=await wallet.getHeight();post({id,checkpoint:{cache,height,reason,node:connectedNode,address:await wallet.getPrimaryAddress()}},[cache.buffer]);}
 catch{/* a missed checkpoint only costs a longer rescan later */}
}
// One scan pass. A timer interrupts long passes so progress can be checkpointed
// between batches. Closing the popup may lose the current batch, not the saved scan.
async function scanPass(){
 stopRequested=false;const timer=setTimeout(()=>{stopRequested=true;void wallet.stopSyncing().catch(()=>{});},CHECKPOINT_MS);
 try{await wallet.sync();}finally{clearTimeout(timer);}
}
async function syncWithRetry(id,primary,failover,persist){
 const order=nodeOrder(primary,failover);
 let index=0,passes=0,retries=0,stalled=0,lastHeight=await wallet.getHeight(),lastError='';
 // Progress counts from the restore height: a fresh wallet's own height starts at 1
 // while it still downloads the block-hash list below the restore height.
 scanStart=Math.max(lastHeight,typeof wallet.getRestoreHeight==='function'?await wallet.getRestoreHeight().catch(()=>0):0);
 for(;;){
  const node=order[index%order.length];passes++;
  try{
   const target=await health(node);
   if(connectedNode!==node){await wallet.setDaemonConnection({uri:node,rejectUnauthorized:true},false);connectedNode=node;}
   post({id,progress:{phase:'syncing',node,pass:passes,retries,height:lastHeight,target,start:scanStart}});
   if(!pauseRequested)await scanPass();
   const height=await wallet.getHeight(),advanced=height>lastHeight;
   if(advanced){stalled=0;lastHeight=height;}
   if(persist)await checkpoint(id,pauseRequested?'pause':'scan');
   if(pauseRequested){const paused=Error('Scan paused');paused.code='sync-paused';paused.sync={passes,retries,node,height,start:scanStart};throw paused;}
   if(height>=target-2){const result=await snapshot(node);result.passes=passes;result.retries=retries;result.start=scanStart;return result;}
   // Checkpoint passes that advance are unlimited. A pass with no progress
   // must fail over too, even when stopSyncing() resolves without an error.
   if(!advanced)throw Error('Scan stopped advancing');
   continue;
  }catch(error){
   if(error?.code==='sync-paused')throw error;
   connectedNode=null; // A failed connection must be recreated, even in single-node mode.
   lastError=String(error?.message||error);
   const height=await wallet.getHeight().catch(()=>lastHeight);
   if(height>lastHeight){stalled=0;lastHeight=height;}else stalled++;
   if(persist)await checkpoint(id,'retry');
   retries++;
   if(stalled>=SYNC_STALL_LIMIT||retries>=SYNC_RETRY_LIMIT){const failure=Error('Monero sync could not finish');failure.sync={passes,retries,node,height,stalled,lastError:lastError.slice(0,120)};throw failure;}
   index++;const wait=Math.min(1000*2**Math.min(stalled,3),8000),next=order[index%order.length];
   post({id,progress:{phase:'retrying',node:next,retry:retries,height,start:scanStart,wait}});
   await delay(wait);
  }
 }
}
// Freeze every owned output that an XN1 native token operation may have
// allocated tokens to before wallet2 selects inputs. Transactions whose extra is
// not available locally are only inspected through the node when the caller
// explicitly allows that lookup (it reveals this wallet's transaction ids).
// wallet2's thin output models can omit extra even after a complete sync.
// Retain only hash-verified lookup results inside this unlocked worker so a
// separate read-only check can precede Max/Send without asking again.
const carrierExtras=new Map(),CARRIER_CACHE_ENTRIES=4096,CARRIER_CACHE_BYTES=2*1024*1024;
let carrierExtraBytes=0;
function clearCarrierExtras(){for(const extra of carrierExtras.values())extra.fill(0);carrierExtras.clear();carrierExtraBytes=0;}
function carrierExtra(value){
 if(value===null||value===undefined)return null;
 if(value instanceof Uint8Array&&value.length<=CARRIER_CACHE_BYTES)return new Uint8Array(value);
 if(Array.isArray(value)&&value.length<=CARRIER_CACHE_BYTES){
  for(let i=0;i<value.length;i++)if(!Number.isInteger(value[i])||value[i]<0||value[i]>255)throw Error('Invalid locally stored transaction extra');
  return Uint8Array.from(value);
 }
 throw Error('Invalid locally stored transaction extra');
}
function carrierCapacityError(){const error=Error('This wallet has more coin records than can be safely checked in one session. Nothing was sent.');error.code='carrier-check-capacity';return error;}
function pruneCarrierExtras(required){
 for(const [hash,extra] of carrierExtras)if(!required.has(hash)){carrierExtraBytes-=extra.length;extra.fill(0);carrierExtras.delete(hash);}
}
function rememberCarrierExtra(hash,extra){
 if(!/^[a-f0-9]{64}$/.test(hash)||!(extra instanceof Uint8Array))throw Error('Verified transaction extra required');
 const previous=carrierExtras.get(hash);
 if(carrierExtras.size+(previous?0:1)>CARRIER_CACHE_ENTRIES||carrierExtraBytes-(previous?.length??0)+extra.length>CARRIER_CACHE_BYTES)throw carrierCapacityError();
 if(previous){carrierExtraBytes-=previous.length;previous.fill(0);}
 const copy=new Uint8Array(extra);carrierExtras.set(hash,copy);carrierExtraBytes+=copy.length;
}
async function guardCarriers(node,lookup){
 const guard=self.XMR20CarrierGuard;if(!guard)throw Error('Carrier guard unavailable');
 const outputs=await wallet.getOutputs({isSpent:false}),rows=[],verified=new Map(),requiredCached=new Set();let verifiedBytes=0;
 for(const o of outputs){
  const tx=o.getTx(),extra=carrierExtra(typeof tx.getExtra==='function'?tx.getExtra():null),image=o.getKeyImage()?.getHex(),hash=tx.getHash(),cached=carrierExtras.get(hash);
  if(typeof image!=='string')throw Error('Owned output without key image');
  if(extra===null)requiredCached.add(hash);
  if(cached&&extra!==null&&(cached.length!==extra.length||cached.some((b,i)=>b!==extra[i])))throw Error('Stored transaction extra changed');
  rows.push({keyImage:image,txHash:hash,vout:undefined,extra:extra??(cached?new Uint8Array(cached):null)});
 }
 pruneCarrierExtras(requiredCached);
 if(requiredCached.size>CARRIER_CACHE_ENTRIES)throw carrierCapacityError();
 let result=guard.classifyOwnedOutputs(rows);
 if(result.unknown.length){
  if(lookup!=='node'){const error=Error('Some coins could not be checked for XMR20 token carriers on this device.');error.code='carrier-check-unavailable';error.count=result.unknown.length;throw error;}
  const verify=self.XMR20CarrierVerifier?.verifiedCarrierExtra;if(!verify)throw Error('Transaction verifier unavailable');
  for(let offset=0;offset<result.unknown.length;offset+=50){
   const ids=result.unknown.slice(offset,offset+50);
   const response=await self.fetch(node+'/gettransactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:ids,decode_as_json:false,prune:false})});
   if(!response.ok||!response.body)throw Error('Node transaction lookup failed');
   let size=0;const chunks=[];
   for await(const chunk of response.body){size+=chunk.length;if(size>32*1024*1024)throw Error('Node transaction lookup exceeds bound');chunks.push(chunk);}
   const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
   const data=JSON.parse(new TextDecoder().decode(bytes));
   if(data.status!=='OK'||data.untrusted===true||data.missed_tx?.length||!Array.isArray(data.txs)||data.txs.length!==ids.length)throw Error('Node transaction lookup failed');
   for(const hash of ids){const entries=data.txs.filter(t=>t.tx_hash===hash);if(entries.length!==1)throw Error('Ambiguous node transaction');const extra=verify(entries[0],hash);verifiedBytes+=extra.length;if(carrierExtraBytes+verifiedBytes>CARRIER_CACHE_BYTES)throw carrierCapacityError();verified.set(hash,extra);}
  }
  for(const row of rows)if(row.extra===null){const extra=verified.get(row.txHash);if(!extra)throw Error('Node transaction lookup incomplete');row.extra=extra;}
  result=guard.classifyOwnedOutputs(rows);
  if(result.unknown.length)throw Error('Node transaction lookup incomplete');
 }
 // Website wallet, 28 Oct 2026: coins the classifier finds ordinary are released if an earlier guard froze them (XMR20-TKD1
 // carrier change); inputs reserved by the spend guard are frozen again by spendGuard.freeze below.
 {const keep=new Set(result.protected);for(const o of outputs){const image=o.getKeyImage()?.getHex();if(typeof image==='string'&&!keep.has(image)&&await wallet.isOutputFrozen(image)){await wallet.thawOutput(image);if(await wallet.isOutputFrozen(image))throw Error('Could not release an ordinary coin');}}}
 for(const image of result.protected){await wallet.freezeOutput(image);if(!(await wallet.isOutputFrozen(image)))throw Error('Could not protect a token carrier');}
 for(const [hash,extra] of verified)rememberCarrierExtra(hash,extra);
 if(!spendGuard)throw Error('Shared spend protection unavailable');
 return new Set([...result.protected,...await spendGuard.freeze(result.protected)]);
}
function checkInputs(tx,protectedImages){
 const inputs=typeof tx.getInputs==='function'?tx.getInputs():null;
 if(!Array.isArray(inputs)||inputs.length===0)throw Error('Constructed input identities unavailable');
 for(const input of inputs){const image=input?.getKeyImage?.()?.getHex?.();if(typeof image!=='string'||!/^[a-f0-9]{64}$/.test(image))throw Error('Constructed input identity unavailable');if(protectedImages.has(image))throw Error('Transaction would spend a protected token carrier');}
}
async function init(){
 if(loaded)return;
 importScripts('./market-ordinary-guard.js');
 importScripts('./native-carrier-guard.js');
 importScripts('./native-carrier-transaction.js');
 importScripts('./monero-full-0.11.16.js');
 // Replace the library's general-purpose RPC dispatcher synchronously.
 self.onmessage=handle;
 self.postMessage=message=>{if(Array.isArray(message)&&message[1]==='onSyncProgress_balance'&&Date.now()-lastProgress>500){lastProgress=Date.now();post({id:currentId,progress:{phase:'syncing',height:message[2],start:scanStart||message[3],target:message[4]}});}};
 await self.initOneTime();loaded=true;
}
async function discardWallet(){
 clearCarrierExtras();
 const current=self.WORKER_OBJECTS?.native;
 if(current){try{await current.close(false);}catch{}}
 if(self.WORKER_OBJECTS)delete self.WORKER_OBJECTS.native;
 wallet=null;connectedNode=null;
}
// Open from the phrase, reusing a previously checkpointed scan cache when the
// app supplies one. A cache that fails to open is discarded and reported so the
// app forgets it; the wallet is then opened fresh from the restore height.
async function openWallet(data){
 const password=await cachePassword(data.seed),server={uri:data.node,rejectUnauthorized:true},cache=bytes(data.cache);
 const create=()=>self.createWalletFull('native',{networkType:0,seed:data.seed,restoreHeight:data.restoreHeight,password,server,isTrustedDaemon:false,proxyToWorker:false});
 let restored=false,cacheRejected=false;
 if(cache&&cache.length){
  try{
   await create();
   const keys=bytes((await self.WORKER_OBJECTS.native.getData())[0]);await discardWallet();
   await self.openWalletData('native','',password,0,keys,cache,server);
   wallet=self.WORKER_OBJECTS.native;
   if(await wallet.getPrimaryAddress()!==data.address)throw Error('Cache belongs to another wallet');
   if(await wallet.getHeight()<data.restoreHeight)throw Error('Cache precedes restore height');
   restored=true;
  }catch{await discardWallet();cacheRejected=true;}
 }
 if(!wallet){await create();wallet=self.WORKER_OBJECTS.native;}
 connectedNode=data.node;
 return {restored,cacheRejected};
}
// XMR20 incoming summary v1: XMR sent to this wallet that is not spendable yet, either still in the transaction pool or
// in a block but locked (10 confirmations). wallet2 keeps change from this wallet's own sends out of incoming payments.
async function incomingSummary(w){
 const transfers=await w.getTransfers({isIncoming:true,txQuery:{isLocked:true}});
 let pendingRaw=0n,confirmingRaw=0n,count=0,minConfirmations=null;
 for(const transfer of transfers){
  const tx=transfer.getTx(),amount=BigInt(transfer.getAmount());if(amount<=0n||tx.getIsFailed?.())continue;count++;
  if(tx.getInTxPool()){pendingRaw+=amount;minConfirmations=0;}
  else{confirmingRaw+=amount;const n=Number(tx.getNumConfirmations()||0);minConfirmations=minConfirmations===null?n:Math.min(minConfirmations,n);}
 }
 return {pendingRaw:String(pendingRaw),confirmingRaw:String(confirmingRaw),count,minConfirmations};
}
async function snapshot(node){
 const target=await health(node),height=await wallet.getHeight();
 if(height<target-2)throw Error('Wallet sync incomplete');
 return {address:await wallet.getPrimaryAddress(),balanceRaw:String(await wallet.getBalance()),unlockedRaw:String(await wallet.getUnlockedBalance()),height,target,node,updatedAt:Date.now(),network:'mainnet',synced:true,incoming:await incomingSummary(wallet).catch(()=>null)};
}
async function handle({data}){
 if(!data||typeof data.id!=='string')return;
 // Stopping is the only request accepted while a scan runs: it asks the current
 // pass to end at its next block batch so progress is checkpointed and reported.
 if(data.action==='stop'){const stopping=busy&&currentAction==='sync'&&!!wallet;if(stopping){pauseRequested=true;stopRequested=true;void wallet.stopSyncing().catch(()=>{});}post({id:data.id,result:{stopping}});return;}
 if(busy){
  if(currentAction==='sync'&&['paymentRecoveryStatus','checkPayment'].includes(data.action)){
   try{post({id:data.id,result:await savedPaymentRead(data)});}catch{post({id:data.id,error:'Could not check this payment. Your saved transaction is kept; try again.'});}return;
  }
  post({id:data.id,error:'Wallet is busy syncing.'});return;
 }
 busy=true;currentId=data.id;currentAction=data.action;
 let relayStage='checking';
 // A failed replacement review, resync or close must not leave a previous
 // transaction eligible for a later relay request.
 if(['prepare','prepareMax','checkCarriers','sync','close'].includes(data.action))pending=null;
 if(data.action==='open'||data.action==='close')clearCarrierExtras();
 try{
  let result;
  if(data.action==='open'){
   if(wallet)throw Error('Wallet already unlocked');
   if(typeof data.seed!=='string'||data.seed.trim().split(/\s+/).length!==25||typeof data.address!=='string'||data.address.length!==95||!Number.isSafeInteger(data.restoreHeight)||data.restoreHeight<0)throw Error('Invalid wallet');
   let target;
   for(const node of nodeOrder(data.node,data.failover)){
    try{target=await health(node);data.node=node;break;}catch{post({id:data.id,progress:{phase:'opening',node}});}
   }
   if(!target)throw Error('Node unavailable');
   if(data.restoreHeight>target)throw Error('Invalid restore height');
   await init();
   const opened=await openWallet(data);
   data.seed='';data.cache=null;
   if(await wallet.getPrimaryAddress()!==data.address||await wallet.isViewOnly())throw Error('Recovery phrase does not match the linked wallet');
   spendGuard=await self.XMR20OrdinarySpendGuard.create(wallet);
   await self.addListener('native','balance');
   result={address:data.address,node:data.node,target,unlocked:true,restored:opened.restored,cacheRejected:opened.cacheRejected,height:await wallet.getHeight()};
  }else if(data.action==='sync'){
   if(!wallet)throw Error('Unlock first');
   pauseRequested=false;post({id:data.id,progress:{phase:'syncing'}});
   result=await syncWithRetry(data.id,data.node,data.failover,data.persist!==false);
  }else if(data.action==='checkCarriers'){
   if(!wallet)throw Error('Unlock first');
   await snapshot(data.node);await guardCarriers(data.node,data.carrierLookup);
   result={checked:true};
  }else if(data.action==='prepareMax'){
   if(!wallet||!/^(?:[48][1-9A-HJ-NP-Za-km-z]{94}|4[1-9A-HJ-NP-Za-km-z]{105})$/.test(data.to)||data.to===await wallet.getPrimaryAddress())throw Error('Invalid transfer');
   await snapshot(data.node);pending=null;
   const protectedImages=await guardCarriers(data.node,data.carrierLookup);
   const txs=await wallet.sweepUnlocked({accountIndex:0,address:data.to,relay:false});
   // Keep the existing single-transaction review/receipt contract. Never relay
   // or partially send a multi-transaction sweep from an amount shortcut.
   if(txs.length!==1)throw Error('Max needs a single transaction');
   checkInputs(txs[0],protectedImages);
   const tx=txs[0],destinations=tx.getOutgoingTransfer().getDestinations(),amountRaw=String(tx.getOutgoingAmount()),feeRaw=String(tx.getFee()),hash=tx.getHash();
   if(destinations.length!==1||destinations[0].getAddress()!==data.to||String(destinations[0].getAmount())!==amountRaw||tx.getIsRelayed()||! /^[1-9][0-9]{0,19}$/.test(amountRaw)||! /^[0-9]+$/.test(feeRaw)||! /^[a-f0-9]{64}$/.test(hash))throw Error('Transfer mismatch');
   const id=crypto.randomUUID();pending={id,tx,to:data.to,amountRaw,node:data.node,protectedImages,expires:Date.now()+120000};
   result={id,to:data.to,amountRaw,feeRaw,hash,expires:pending.expires};
  }else if(data.action==='prepareSplit'){
   // Website wallet / extension 0.1.116, 28 Oct 2026: one transaction to this wallet's own address leaving 3 coins.
   if(!wallet)throw Error('Unlock first');
   const own=await wallet.getPrimaryAddress();
   await snapshot(data.node);
   pending=null;
   const protectedImages=await guardCarriers(data.node,data.carrierLookup);
   const unlocked=BigInt(await wallet.getUnlockedBalance()),part=unlocked/3n;
   if(part<200000000n){const error=Error('You need at least 0.0006 unlocked XMR to make 3 coins. Receive more XMR, or wait until incoming XMR unlocks (10 confirmations).');error.code='split-too-small';throw error;}
   const tx=await wallet.createTx({accountIndex:0,destinations:[{address:own,amount:part},{address:own,amount:part}],relay:false});
   checkInputs(tx,protectedImages);
   const destinations=tx.getOutgoingTransfer().getDestinations();
   if(destinations.length!==2||destinations.some(d=>d.getAddress()!==own||BigInt(d.getAmount())!==part)||tx.getIsRelayed())throw Error('Transfer mismatch');
   const feeRaw=String(tx.getFee()),hash=tx.getHash(),amountRaw=String(part*2n);
   if(!/^[0-9]+$/.test(feeRaw)||! /^[a-f0-9]{64}$/.test(hash))throw Error('Invalid transaction');
   const id=crypto.randomUUID();pending={id,tx,to:own,amountRaw,node:data.node,protectedImages,expires:Date.now()+120000};
   result={id,to:own,amountRaw,partRaw:String(part),coins:3,unlockedRaw:String(unlocked),feeRaw,hash,expires:pending.expires};
  }else if(data.action==='prepare'){
   if(!wallet||!/^(?:[48][1-9A-HJ-NP-Za-km-z]{94}|4[1-9A-HJ-NP-Za-km-z]{105})$/.test(data.to)||! /^[1-9][0-9]{0,19}$/.test(data.amountRaw))throw Error('Invalid transfer');
   if(data.to===await wallet.getPrimaryAddress())throw Error('Same address');
   await snapshot(data.node);
   pending=null;
   const protectedImages=await guardCarriers(data.node,data.carrierLookup);
   const tx=await wallet.createTx({accountIndex:0,address:data.to,amount:BigInt(data.amountRaw),relay:false});
   checkInputs(tx,protectedImages);
   const transfer=tx.getOutgoingTransfer(),destinations=transfer.getDestinations();
   if(destinations.length!==1||destinations[0].getAddress()!==data.to||String(destinations[0].getAmount())!==data.amountRaw||tx.getIsRelayed())throw Error('Transfer mismatch');
   const feeRaw=String(tx.getFee()),hash=tx.getHash();
   if(!/^[0-9]+$/.test(feeRaw)||! /^[a-f0-9]{64}$/.test(hash))throw Error('Invalid transaction');
   const id=crypto.randomUUID();pending={id,tx,to:data.to,amountRaw:data.amountRaw,node:data.node,protectedImages,expires:Date.now()+120000};
   result={id,to:data.to,amountRaw:data.amountRaw,feeRaw,hash,expires:pending.expires};
  }else if(data.action==='paymentRecoveryStatus'){
   result=await savedPaymentRead(data);
  }else if(data.action==='checkPayment'){
   result=await savedPaymentRead(data);
  }else if(data.action==='exportPaymentRecovery'){
   if(!wallet||!spendGuard)throw Error('Open this wallet first');result={packageBytes:await spendGuard.exportRecovery()};
  }else if(data.action==='importPaymentRecovery'){
   pending=null;if(!wallet||!spendGuard)throw Error('Open this wallet first');
   result=await spendGuard.importRecovery(data.packageBytes);
  }else if(data.action==='prepareRecovery'){
   pending=null;if(!wallet||!spendGuard)throw Error('Open this wallet first');await health(data.node);
   const saved=await spendGuard.reviewRecovery(data.txid),id=crypto.randomUUID();
   pending={...saved,id,recovery:true,node:data.node,expires:Date.now()+120000};
   result={id,to:saved.to,amountRaw:saved.amountRaw,feeRaw:saved.feeRaw,hash:saved.hash,expires:pending.expires,recovery:true};
  }else if(data.action==='relay'){
   if(!pending||pending.id!==data.reviewId||Date.now()>pending.expires)throw Error('Review expired');
   const approved=pending;pending=null;
   if(data.node!==undefined&&data.node!==approved.node)throw Error('Reviewed node changed');
   if(approved.recovery){
    await health(approved.node);
    relayStage='saving';result=await spendGuard.relayRecovery(approved.hash,async(transaction,hash)=>{
     relayStage='submitting';
     canRelay=true;try{
      const r=await self.fetch(approved.node+'/send_raw_transaction',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tx_as_hex:transaction,do_not_relay:false})});
      if(!r.ok)throw Error('Saved payment submission uncertain');const value=await r.json();
      if(value.status!=='OK'||value.untrusted===true)throw Error('Saved payment submission uncertain');return {hash};
     }finally{canRelay=false;}
    });post({id:data.id,result});return;
   }
   await snapshot(approved.node);checkInputs(approved.tx,approved.protectedImages);
   const tx=approved.tx;relayStage='saving';
   result=await spendGuard.relay(tx,approved,async(transaction,hash)=>{
    relayStage='submitting';canRelay=true;try{
     const response=await self.fetch(approved.node+'/send_raw_transaction',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tx_as_hex:transaction,do_not_relay:false})});
     if(!response.ok)throw Error('Payment submission uncertain');const value=await response.json();
     if(value.status!=='OK'||value.untrusted===true)throw Error('Payment submission uncertain');return {hash};
    }finally{canRelay=false;}
   });
   // Remember the spend so a reopened wallet does not offer those coins again.
   if(data.persist!==false)await checkpoint(data.id,'relay');
  }else if(data.action==='cancel'){
   pending=null;result={cancelled:true};
  }else if(data.action==='close'){
   connectedNode=null;
   spendGuard?.close();spendGuard=null;if(wallet)await wallet.close(false);wallet=null;result={locked:true};
  }else throw Error('Unsupported wallet operation');
  post({id:data.id,result});
 }catch(error){
  if(data.action==='open'){spendGuard?.close();spendGuard=null;}
  if(data.action==='open'&&wallet){try{await wallet.close(false);}catch{}wallet=null;connectedNode=null;}
  data.seed='';data.cache=null;
  if(data.action==='relay'){
   const code=relayStage==='submitting'?'xmr-submission-unknown':relayStage==='saving'?'xmr-recovery-required':'xmr-not-submitted';
   post({id:data.id,code,error:code==='xmr-not-submitted'?'This payment was not submitted. Check its status before trying again.':'Check the saved payment to see whether it reached Monero. Retry only that saved transaction.'});return;
  }
  if(data.action==='checkPayment'){post({id:data.id,error:'Could not check this payment. Your saved transaction is kept; try again.'});return;}
  if(error?.code==='split-too-small'){post({id:data.id,error:error.message,code:error.code})
return
}
  if(error?.code==='carrier-check-unavailable'||error?.code==='carrier-check-capacity'){post({id:data.id,error:error.message,code:error.code,count:error.count});return;}
  if(data.action==='prepare'||data.action==='prepareMax'||data.action==='prepareSplit'){
   const insufficient=/^(?:not enough (?:unlocked )?money|insufficient (?:unlocked )?(?:funds|balance))/i.test(String(error?.message||''));
   post({id:data.id,code:insufficient?'xmr-insufficient-unlocked':'xmr-build-failed',error:insufficient?(data.action==='prepareMax'?'No unlocked XMR is available after fees and protected coins.':'Not enough unlocked XMR to cover this amount and the network fee. Use Max to check the available amount.'):'Could not build this XMR payment. Nothing was sent. Check your unlocked balance or try another node.'});return;
  }
  const sync=error?.sync?{passes:error.sync.passes,retries:error.sync.retries,node:error.sync.node,height:error.sync.height,start:scanStart}:undefined;
  if(error?.code==='sync-paused'){post({id:data.id,error:'Scan paused at block '+Number(sync.height).toLocaleString()+'. Progress is saved; sync again to continue.',code:error.code,sync});return;}
  post({id:data.id,error:data.action==='open'?'Could not unlock this Monero wallet. Check the phrase, restore height and node connection.':data.action==='checkCarriers'?'Could not check coins with the Monero node. Try again. Nothing was sent.':data.action==='prepareMax'?'Could not calculate Max for one XMR transaction. Sync your wallet and try a smaller amount. Nothing was sent.':data.action==='sync'?'Monero sync could not finish. Your balance is unavailable; retry or switch nodes.':'Monero transaction could not complete. Check the saved receipt before retrying.',sync});
 }finally{busy=false;currentAction=null;}
}
self.onmessage=handle;
