// Public Solana balances are independent of Monero inscription admission.
// Catalog metadata discovers mints; finalized mint and token accounts prove the
// displayed balance. This reader never prepares or submits a transaction.
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackMint,unpackAccount,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {sharedCatalog,TOKEN_CATALOG_URL} from './catalog-cache.js';
import {solanaRpcBody} from './solana-rpc.js';
const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const ENDPOINT='https://xmr20.org/api/wallet';
const CATALOG=TOKEN_CATALOG_URL;
// The fixed wallet service enforces mainnet. Re-prove its network identity every
// ten minutes instead of on every 15-second refresh.
const GENESIS_RECHECK_MS=600000,genesisChecked=new WeakMap();
async function concurrently(items,limit,fn){const out=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;out[i]=await fn(items[i],i);}}));return out;}
const need=(v,m)=>{if(!v)throw Error(m);};
const mintAddress=v=>{try{return typeof v==='string'&&new PublicKey(v).toBase58()===v;}catch{return false;}};
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
const labelled=t=>mintAddress(t.mint)&&typeof t.name==='string'&&t.name.length<=256&&typeof t.ticker==='string'&&t.ticker.length>0&&t.ticker.length<=10;
// A launchpad token: a finalized mint with its launch record and its Monero inscription.
const launchpadToken=t=>!t.hidden&&!t.halted&&!t.cancelledAt&&t.solanaFinalized===true&&uuid(t.id)&&labelled(t)&&/^[a-f0-9]{64}$/.test(t.moneroTxid||'');
// A launch of the trading service (xmr20.org/trade): a mint the catalog lists as launched for bridging. It was not inscribed on
// Monero and has no launch record, so it is known by its mint. The row kind is exact, the same rule the catalog's own merge
// applies: none of a launchpad row's record fields (launch id, inscription id, finalized flag) and the known values of every
// other field. A row that carries a launch id is a launchpad row and must pass the launchpad checks; this rule never admits it.
export const LAUNCH_VENUE='xmr20-trade';
const launchToken=t=>t.venue===LAUNCH_VENUE&&t.id===undefined&&t.moneroTxid===undefined&&t.solanaFinalized===undefined&&t.launchMode==='monero'&&t.state==='Launched'&&t.bridgeReady===true&&t.hidden===false&&!t.halted&&!t.cancelledAt&&t.transferTaxBps===0&&t.decimals===6&&t.moneroNetwork==='mainnet'&&labelled(t);
// The catalog tokens whose Solana balance is read. A launch row for a mint that a row with a launch id names is left out: the
// launchpad's row stands, whatever its state. Of several launch rows for one mint the first stands, as at the bridge, which
// takes the first row the catalog has for a mint. Anything that is not a row is skipped.
export function catalogHoldings(tokens){
 const recorded=new Set(),launches=new Set();
 for(const t of tokens)if(t&&typeof t==='object'&&t.id!==undefined)recorded.add(t.mint);
 return tokens.filter(t=>{
  if(!t||typeof t!=='object')return false;if(launchpadToken(t))return true;
  if(!launchToken(t)||recorded.has(t.mint)||launches.has(t.mint))return false;
  launches.add(t.mint);return true;
 });
}
export function solanaDisplayRows(previous,result){
 const current=new Set(result.rows.map(r=>r.mint));
 return [...result.rows,...(result.complete?[]:previous.filter(r=>r.network==='solana'&&!current.has(r.mint)).map(r=>({...r,stale:true})))];
}
function accountInfo(v){
 if(v===null)return null;
 need(v&&typeof v.executable==='boolean'&&Number.isSafeInteger(v.lamports)&&v.lamports>=0&&mintAddress(v.owner)&&Array.isArray(v.data)&&v.data.length===2&&v.data[1]==='base64'&&typeof v.data[0]==='string'&&v.data[0].length<=32768,'Invalid Solana account.');
 const data=Buffer.from(v.data[0],'base64');need(data.toString('base64')===v.data[0],'Invalid Solana account encoding.');
 return {...v,owner:new PublicKey(v.owner),data};
}
// `endpoint`: one service that takes JSON-RPC inside {action:'walletRpc',rpc} (the xmr20.org read service, or the website's
// read route), as before. `endpoints`: instead, a list of Solana nodes (or a function giving it) tried in turn until one
// answers as mainnet and gives every balance; plain JSON-RPC, except the xmr20.org read service. The extension popup passes
// the node chosen in Settings this way.
export async function loadSolanaHoldings(owner,{fetcher=fetch,signal,now=Date.now,endpoint=ENDPOINT,endpoints=null,catalogEndpoint=CATALOG}={}){
 need(mintAddress(owner),'Invalid Solana address.');
 if(endpoints===null)return loadFrom(owner,{fetcher,signal,now,endpoint,catalogEndpoint,wrap:true,timeoutMs:18000});
 const list=typeof endpoints==='function'?endpoints():endpoints;need(Array.isArray(list)&&list.length>0&&list.length<=5,'No Solana node configured.');
 let last;
 for(const url of list){
  try{return await loadFrom(owner,{fetcher,signal,now,endpoint:url,catalogEndpoint,wrap:false,timeoutMs:list.length>1?10000:18000});}
  catch(error){if(signal?.aborted)throw error;last=error;}
 }
 throw last;
}
async function loadFrom(owner,{fetcher,signal,now,endpoint,catalogEndpoint,wrap,timeoutMs}){
 const sender=new PublicKey(owner);
 const scope=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
 async function json(url,options={}){
  scope.throwIfAborted();const response=await fetcher(url,{...options,credentials:'omit',redirect:'error',cache:'no-store',signal:scope});
  need(response.ok,'Solana balances unavailable.');const text=await response.text();need(text.length<=4_000_000,'Solana balance response too large.');scope.throwIfAborted();return JSON.parse(text);
 }
 async function rpc(method,params){
  // Reads only. Whichever node answers, its network is checked (genesis hash) before its balances are used.
  need(['getGenesisHash','getMultipleAccounts'].includes(method),'Public balance reads only.');
  const id=crypto.randomUUID(),call={jsonrpc:'2.0',id,method,params};
  const value=await json(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(wrap?{action:'walletRpc',rpc:call}:solanaRpcBody(endpoint,call))});
  need(value.jsonrpc==='2.0'&&value.id===id&&!value.error&&Object.hasOwn(value,'result'),'Helius balance read unavailable.');return value.result;
 }
 const checkedAt=genesisChecked.get(fetcher)?.get(endpoint),genesisKnown=Number.isFinite(checkedAt)&&now()-checkedAt<GENESIS_RECHECK_MS;
 const [catalog,genesis]=await Promise.all([sharedCatalog(fetcher,catalogEndpoint).load({signal:scope}),genesisKnown?GENESIS:rpc('getGenesisHash',[])]);
 need(genesis===GENESIS,'Wrong Solana network.');
 if(!genesisKnown){if(!genesisChecked.has(fetcher))genesisChecked.set(fetcher,new Map());genesisChecked.get(fetcher).set(endpoint,now());}
 need(catalog?.schema==='xmr20-launches-v1'&&catalog.solanaNetwork==='mainnet-beta'&&catalog.moneroNetwork==='mainnet'&&Array.isArray(catalog.tokens)&&catalog.tokens.length<=10000,'Token catalog unavailable.');
 const tokens=catalogHoldings(catalog.tokens);
 need(new Set(tokens.map(t=>t.mint)).size===tokens.length&&new Set(tokens.map(t=>t.id??t.mint)).size===tokens.length,'Duplicate token identity.');
 // Bounded batches avoid one RPC per token and work through the existing
 // Helius allowlist. Each mint and its two possible ATAs share one slot. Up to
 // three batches travel at once; rows keep catalog order.
 const batches=[];for(let start=0;start<tokens.length;start+=30)batches.push(tokens.slice(start,start+30));
 const replies=await concurrently(batches,3,async batch=>{
  const keys=batch.flatMap(t=>{const mint=new PublicKey(t.mint);return [mint,getAssociatedTokenAddressSync(mint,sender,false,TOKEN_PROGRAM_ID),getAssociatedTokenAddressSync(mint,sender,false,TOKEN_2022_PROGRAM_ID)];});
  const reply=await rpc('getMultipleAccounts',[keys.map(k=>k.toBase58()),{encoding:'base64',commitment:'finalized'}]);
  need(Number.isSafeInteger(reply?.context?.slot)&&reply.context.slot>0&&Array.isArray(reply.value)&&reply.value.length===keys.length,'Incomplete Solana balances.');
  return {batch,keys,reply};
 });
 const rows=[];let checked=0,minSlot=Infinity,partial=false;
 for(const {batch,keys,reply} of replies){
  minSlot=Math.min(minSlot,reply.context.slot);
  for(let i=0;i<batch.length;i++){
   const token=batch[i],mintKey=keys[3*i];checked++;
   try{
    const info=accountInfo(reply.value[3*i]);need(info&&!info.executable&&[TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(info.owner)),'Token mint unavailable.');
    const mint=unpackMint(mintKey,info,info.owner);need(mint.isInitialized&&mint.decimals===6,'Unsupported token decimals.');
    const at=3*i+(info.owner.equals(TOKEN_PROGRAM_ID)?1:2),raw=accountInfo(reply.value[at]);if(!raw)continue;
    need(!raw.executable&&raw.owner.equals(info.owner),'Unexpected token-account program.');
    const holding=unpackAccount(keys[at],raw,info.owner);
    need(holding.isInitialized&&holding.owner.equals(sender)&&holding.mint.equals(mintKey)&&holding.amount<=1000000000000000n,'Token balance belongs to another wallet.');
    if(holding.amount===0n)continue;
    const launch=token.id===undefined;
    rows.push({id:launch?token.mint:token.id,mint:token.mint,name:token.name,ticker:token.ticker,image:null,deployment:launch?null:token.moneroTxid,listed:!launch&&token.proofVerified===true,...(launch?{venue:LAUNCH_VENUE}:{}),amountRaw:String(holding.amount),checkedAt:now(),stale:false,balanceSource:'solana-finalized',frozen:holding.isFrozen});
   }catch{partial=true;}
  }
 }
 scope.throwIfAborted();return {rows,complete:!partial,checked,cached:false,slot:Number.isFinite(minSlot)?minSlot:null};
}
