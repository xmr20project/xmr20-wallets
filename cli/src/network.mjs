// What the CLI's private browser may reach. Everything else is blocked.
//  - Monero nodes for XMR: the same three nodes and request paths the Monero worker itself allows.
//  - The XMR20 private bridge and its Monero node: fixed api.xmr20.org paths, forwarded by the CLI without a browser Origin
//    (the api.xmr20.org gateway admits browsers only from the extension and xmr20.org; programs send no Origin).
//  - One Solana read (the SOL balance shown before a bridge fee), done by the CLI itself.
export const API='https://api.xmr20.org';
export const MONERO_NODES=['https://api.xmr20.org/monero','https://xmr-node.cakewallet.com:18081','https://node.sethforprivacy.com'];
const MONERO_PATHS=new Set(['/send_raw_transaction','/sendrawtransaction','/get_info','/get_height','/getblocks.bin','/gethashes.bin','/gettransactions',
 '/get_transaction_pool_hashes.bin','/get_o_indexes.bin','/get_outs.bin','/get_output_distribution.bin','/is_key_image_spent','/json_rpc']);
export const SOLANA_RPC='https://solana-rpc.publicnode.com';
export function moneroRequest(url,method){
 const base=MONERO_NODES.find(n=>url.startsWith(n+'/'));if(!base||!['GET','POST'].includes(method))return null;
 const path=url.slice(base.length);if(!MONERO_PATHS.has(path))return null;
 return {base,path,relay:path==='/send_raw_transaction'||path==='/sendrawtransaction'};
}
// Same-origin paths of the CLI page that the loopback server forwards to api.xmr20.org.
const BRIDGE_ACTIONS=new Set(['state','register','publishAddress','lookupAddress','feeQuote','feeSubmit','depositPrepare','depositSubmit','recentBlockhash','redeemPrepare','claimPrepare','claimSubmit','view']);
const NODE_PATHS=new Set([...MONERO_PATHS,'/get_transactions','/get_outs','/get_transaction_pool','/get_transaction_pool_hashes']);
export function forwardRequest(pathname,method){
 let m=pathname.match(/^\/api\/private-bridge\/action\/([A-Za-z]+)$/);
 if(m)return method==='POST'&&BRIDGE_ACTIONS.has(m[1])?{url:API+pathname,kind:'bridge',action:m[1]}:null;
 // Proving-parameter files named by the shipped manifest (their bytes are checked against its sha256 in the holder worker).
 m=pathname.match(/^\/api\/private-bridge\/((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+)$/);
 if(m&&method==='GET'&&!m[1].includes('..')&&!m[1].startsWith('action/'))return {url:API+pathname,kind:'parameters'};
 m=pathname.match(/^\/api\/private-node(\/[a-z_.]+)$/);
 if(m&&method==='POST'&&NODE_PATHS.has(m[1]))return {url:API+pathname,kind:'node',relay:m[1]==='/send_raw_transaction'||m[1]==='/sendrawtransaction'};
 return null;
}
export async function solBalance(address,fetcher=fetch){
 try{const r=await fetcher(SOLANA_RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getBalance',params:[address,{commitment:'confirmed'}]}),redirect:'error',signal:AbortSignal.timeout(15000)});
  const v=await r.json();return Number.isSafeInteger(v?.result?.value)?String(v.result.value):null;}catch{return null;}
}
