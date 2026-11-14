// The Solana node the wallet reads balances from and sends transactions through.
// By default the wallet uses free public mainnet nodes, in order, and the xmr20.org read service last (reads only, as before).
// In Settings a person can enter their own RPC address instead; it is then the only node used, for reads and for sends.
// Every node is checked to be Solana mainnet (its genesis hash) before a balance read uses it, and an address is checked the
// same way before it is saved.
export const SOLANA_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const PUBLIC_SOLANA_RPCS=Object.freeze(['https://solana-rpc.publicnode.com','https://api.mainnet-beta.solana.com']);
export const XMR20_SOLANA_READS='https://xmr20.org/api/wallet';
const MAX_URL=512;

// A Solana RPC address a person may use: https, no user name or password in it, no fragment. A path and a query (for an
// API key) are kept as entered. Returns the address, or null.
export function normalizeSolanaRpc(value){
 if(typeof value!=='string')return null;const text=value.trim();if(!text||text.length>MAX_URL)return null;
 let url;try{url=new URL(text);}catch{return null;}
 if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.hash)return null;
 return url.href;
}
// What Settings shows for an address: the host only, so an API key in the address is not put on screen.
export function solanaRpcLabel(value){const url=normalizeSolanaRpc(value);return url?new URL(url).host:'Free public nodes';}

// The popup tells this module where its saved choice is; until then (and in other pages that import the wallet's modules)
// the public nodes are used.
let chosen=()=>null;
export function configureSolanaRpc(read){chosen=typeof read==='function'?read:()=>null;}
const custom=()=>normalizeSolanaRpc(chosen());
// Balance reads: the person's own node alone, or the public nodes and then the xmr20.org read service.
export function solanaReadEndpoints(){const own=custom();return own?[own]:[...PUBLIC_SOLANA_RPCS,XMR20_SOLANA_READS];}
// Building and sending transactions: the person's own node, or the first public node.
export function solanaSendEndpoint(){return custom()||PUBLIC_SOLANA_RPCS[0];}
// The xmr20.org read service takes JSON-RPC inside {action:'walletRpc',rpc}; every other node takes it as it is.
export const solanaRpcBody=(endpoint,rpc)=>endpoint===XMR20_SOLANA_READS?{action:'walletRpc',rpc}:rpc;

// Checks an address before it is saved: it must answer as Solana mainnet. Returns the normalized address.
export async function checkSolanaRpc(address,{fetcher=globalThis.fetch,timeoutMs=10000}={}){
 const url=normalizeSolanaRpc(address);if(!url)throw Error('Enter an https address of a Solana RPC node.');
 const id=crypto.randomUUID();let response;
 try{response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method:'getGenesisHash',params:[]}),credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(timeoutMs)});}
 catch{throw Error('This node did not answer. Check the address and try again.');}
 if(!response.ok)throw Error(`This node answered with an error (HTTP ${response.status}). Check the address.`);
 let value;try{value=await response.json();}catch{throw Error('This address is not a Solana RPC node.');}
 if(value?.id!==id||value.error||typeof value.result!=='string')throw Error('This address is not a Solana RPC node.');
 if(value.result!==SOLANA_GENESIS)throw Error('This node is not Solana mainnet.');
 return url;
}
