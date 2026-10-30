// Public Solana balances are independent of Monero inscription admission.
// Catalog metadata discovers mints; finalized mint and token accounts prove the
// displayed balance. This reader never prepares or submits a transaction.
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackMint,unpackAccount,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {sharedCatalog,TOKEN_CATALOG_URL} from './catalog-cache.js';
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
export async function loadSolanaHoldings(owner,{fetcher=fetch,signal,now=Date.now,endpoint=ENDPOINT,catalogEndpoint=CATALOG}={}){
 need(mintAddress(owner),'Invalid Solana address.');const sender=new PublicKey(owner);
 const scope=signal?AbortSignal.any([signal,AbortSignal.timeout(18000)]):AbortSignal.timeout(18000);
 async function json(url,options={}){
  scope.throwIfAborted();const response=await fetcher(url,{...options,credentials:'omit',redirect:'error',cache:'no-store',signal:scope});
  need(response.ok,'Solana balances unavailable.');const text=await response.text();need(text.length<=4_000_000,'Solana balance response too large.');scope.throwIfAborted();return JSON.parse(text);
 }
 async function rpc(method,params){
  // The existing wallet service enforces Helius mainnet and holds its key.
  need(['getGenesisHash','getMultipleAccounts'].includes(method),'Public balance reads only.');
  const id=crypto.randomUUID(),value=await json(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'walletRpc',rpc:{jsonrpc:'2.0',id,method,params}})});
  need(value.jsonrpc==='2.0'&&value.id===id&&!value.error&&Object.hasOwn(value,'result'),'Helius balance read unavailable.');return value.result;
 }
 const checkedAt=genesisChecked.get(fetcher)?.get(endpoint),genesisKnown=Number.isFinite(checkedAt)&&now()-checkedAt<GENESIS_RECHECK_MS;
 const [catalog,genesis]=await Promise.all([sharedCatalog(fetcher,catalogEndpoint).load({signal:scope}),genesisKnown?GENESIS:rpc('getGenesisHash',[])]);
 need(genesis===GENESIS,'Wrong Solana network.');
 if(!genesisKnown){if(!genesisChecked.has(fetcher))genesisChecked.set(fetcher,new Map());genesisChecked.get(fetcher).set(endpoint,now());}
 need(catalog?.schema==='xmr20-launches-v1'&&catalog.solanaNetwork==='mainnet-beta'&&catalog.moneroNetwork==='mainnet'&&Array.isArray(catalog.tokens)&&catalog.tokens.length<=10000,'Token catalog unavailable.');
 const tokens=catalog.tokens.filter(t=>!t.hidden&&!t.halted&&!t.cancelledAt&&t.solanaFinalized===true&&mintAddress(t.mint)&&uuid(t.id)&&typeof t.name==='string'&&t.name.length<=256&&typeof t.ticker==='string'&&t.ticker.length>0&&t.ticker.length<=10&&/^[a-f0-9]{64}$/.test(t.moneroTxid||''));
 need(new Set(tokens.map(t=>t.mint)).size===tokens.length&&new Set(tokens.map(t=>t.id)).size===tokens.length,'Duplicate token identity.');
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
    rows.push({id:token.id,mint:token.mint,name:token.name,ticker:token.ticker,image:null,deployment:token.moneroTxid,listed:token.proofVerified===true,amountRaw:String(holding.amount),checkedAt:now(),stale:false,balanceSource:'solana-finalized',frozen:holding.isFrozen});
   }catch{partial=true;}
  }
 }
 scope.throwIfAborted();return {rows,complete:!partial,checked,cached:false,slot:Number.isFinite(minSlot)?minSlot:null};
}
