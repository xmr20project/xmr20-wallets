// 30 Oct 2026 (a new transfer took the holder index more
// than ten minutes to show): the connected Solana wallet's XMR20 balances are read from the chain, the way the extension reads
// them (engine/shared/solana-holdings.js, used here unchanged), and its wXMR (wxmr.io) beside them. Reads go through
// the site's public read proxy, which serves getGenesisHash and getMultipleAccounts. The index still supplies prices, images
// and any token this read does not cover; if the chain read fails, the index result is used as before.
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {loadSolanaHoldings,catalogHoldings,LAUNCH_VENUE} from '../../engine/shared/solana-holdings.js';
import {sharedCatalog} from '../../engine/shared/catalog-cache.js';
import {loadWalletHoldings,cachedWalletHoldings} from './wallet-holdings.js';
import {WXMR,tokenAccount} from './wxmr-bridge.js';
import {loadTokenPrices} from './site-prices.js';

const READ='/api/bridge-solana-read',CATALOG='/api/xmr20/tokens';
// The extension's reader posts {action:'walletRpc',rpc} to its endpoint; the read proxy takes the JSON-RPC body itself.
const CHAIN='xmr20-chain-read';
const fetcher=(url,options={})=>url===CHAIN?fetch(READ,{...options,body:JSON.stringify(JSON.parse(options.body).rpc)}):fetch(url,options);

async function rpc(method,params){
 const id=crypto.randomUUID(),r=await fetch(READ,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',redirect:'error',cache:'no-store',body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('Solana balances unavailable.');const v=await r.json();if(v?.jsonrpc!=='2.0'||v.id!==id||v.error||!Object.hasOwn(v,'result'))throw Error('Solana balances unavailable.');return v.result;
}
// wXMR (12 decimals, the classic token program) in the wallet's associated account; '0' when it has none.
export async function loadWxmrBalance(owner){
 const holder=new PublicKey(owner),key=tokenAccount(owner).toBase58();
 const reply=await rpc('getMultipleAccounts',[[key],{encoding:'base64',commitment:'confirmed'}]),v=reply?.value?.[0];
 if(!Array.isArray(reply?.value)||reply.value.length!==1)throw Error('Solana balances unavailable.');
 if(!v)return '0';
 const data=Buffer.from(v.data?.[0]||'','base64');
 if(v.owner!==TOKEN_PROGRAM_ID.toBase58()||data.length!==165||!new PublicKey(data.subarray(0,32)).equals(WXMR.mint)||!new PublicKey(data.subarray(32,64)).equals(holder))throw Error('Unexpected wXMR account.');
 return data.readBigUInt64LE(64).toString();
}

async function load(owner){
 const [index,chain,wxmr,catalog]=await Promise.allSettled([loadWalletHoldings(owner,{network:'solana'}),loadSolanaHoldings(owner,{fetcher,endpoint:CHAIN,catalogEndpoint:CATALOG}),loadWxmrBalance(owner),sharedCatalog(fetcher,CATALOG).load()]);
 const wxmrRaw=wxmr.status==='fulfilled'?wxmr.value:null;
 if(chain.status==='rejected'||catalog.status==='rejected'){if(index.status==='rejected')throw index.reason;
  // The index does not list launches of the trading service. Without the chain read, the rows this browser saved for them are
  // kept as last known, and the answer is not complete, instead of the token vanishing until the next good read.
  const listed=new Set(index.value.rows.map(r=>r.mint)),kept=(cachedWalletHoldings(owner,{network:'solana'})?.rows||[]).filter(r=>r.venue===LAUNCH_VENUE&&!listed.has(r.mint));
  return kept.length?{...index.value,rows:[...index.value.rows,...kept],complete:false,wxmrRaw}:{...index.value,wxmrRaw};}
 const c=chain.value,ix=index.status==='fulfilled'?index.value:null,byMint=new Map((ix?.rows||[]).map(r=>[r.mint,r]));
 // The catalog tokens loadSolanaHoldings checks (its own rule, launches of the trading service included): for these, the chain
 // answer replaces the index's.
 const checked=new Set(catalogHoldings(catalog.value.tokens).map(t=>t.mint));
 const prices=await loadTokenPrices(c.rows.map(r=>r.mint)).catch(()=>({}));
 const rows=c.rows.map(({balanceSource,frozen,...r})=>({...r,image:byMint.get(r.mint)?.image??null,priceUsd:byMint.get(r.mint)?.priceUsd??prices[r.mint]??null}));
 const held=new Set(rows.map(r=>r.mint));
 // A token the chain read did not cover keeps its index row; so does a covered one if part of the chain read failed.
 const kept=(ix?.rows||[]).filter(r=>!held.has(r.mint)&&(!checked.has(r.mint)||!c.complete));
 return {rows:[...rows,...kept],complete:c.complete&&kept.every(r=>!r.stale)&&(!ix||ix.complete||ix.rows.every(r=>checked.has(r.mint))),checked:Date.now(),cached:false,wxmrRaw};
}
// One read per wallet serves every list on the page (the wallet panel, its Monero tab and the profile) for 20 seconds.
const recent=new Map();
export function loadSolanaWalletHoldings(owner,{force=false}={}){
 const hit=recent.get(owner);if(!force&&hit&&Date.now()-hit.at<20000)return hit.promise;
 const promise=load(owner).catch(e=>{if(recent.get(owner)?.promise===promise)recent.delete(owner);throw e;});
 recent.set(owner,{at:Date.now(),promise});return promise;
}
