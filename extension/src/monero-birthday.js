import {MONERO_NODES} from '../../engine/monero/monero-node.js';
import {untilClosed} from '../../engine/shared/request-lifetime.js';

const GENESIS='418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3';
// First block of the XMR20 bridge ledger (mined 28 September 2026). No XMR20 record exists before it, so it is the
// default restore height for imported wallets instead of block 0 (26 Oct 2026, owner request).
export const XMR20_MONERO_START=3772610;
const HASH=/^[a-f0-9]{64}$/;
const need=(ok)=>{if(!ok)throw Error('Monero node did not provide a current mainnet height.');};
const cancelled=()=>Error('Wallet setup closed.');

async function readJson(url,body,fetchImpl,signal){
 const response=await untilClosed(fetchImpl(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,credentials:'omit',redirect:'error',cache:'no-store',signal}),signal);
 need(response.ok&&response.body);const reader=response.body.getReader(),chunks=[];let size=0;
 try{
  while(true){const {done,value}=await untilClosed(reader.read(),signal);if(done)break;size+=value.length;need(size<=65536);chunks.push(value);}
 }finally{void reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));need(value&&typeof value==='object'&&!Array.isArray(value)&&!value.error);return value;
}

// A birthday is chosen before creating keys, never inferred for an existing
// wallet. Preferences cannot introduce a different endpoint or skip our node.
export async function resolveWalletRestoreHeight({mode,restoreHeight=0,fetchImpl=fetch,signal,assertCurrent=()=>{},timeoutMs=8000,now=Date.now}={}){
 assertCurrent();if(signal?.aborted)throw signal.reason||cancelled();
 if(mode==='import'){
  if(!Number.isSafeInteger(restoreHeight)||restoreHeight<0)throw Error('Enter a valid restore height.');
  return restoreHeight;
 }
 if(mode!=='create')throw Error('Wallet creation or import required.');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw Error('Bounded birthday lookup required.');
 for(const {url} of MONERO_NODES){
  assertCurrent();if(signal?.aborted)throw signal.reason||cancelled();
  const controller=new AbortController(),stop=()=>controller.abort(signal.reason||cancelled());
  signal?.addEventListener('abort',stop,{once:true});const timer=setTimeout(()=>controller.abort(Error('Monero birthday lookup timed out.')),timeoutMs);
  try{
   const info=await readJson(url+'/get_info',null,fetchImpl,controller.signal);assertCurrent();
   need(info.status==='OK'&&info.mainnet===true&&info.nettype==='mainnet'&&info.testnet!==true&&info.stagenet!==true&&info.synchronized===true&&info.offline===false&&info.untrusted!==true);
   need(Number.isSafeInteger(info.height)&&info.height>30&&info.height<8000000&&HASH.test(info.top_block_hash));
   if(info.target_height!==undefined)need(Number.isSafeInteger(info.target_height)&&info.target_height>=0&&info.target_height<=info.height);
   const header=async height=>{
    const reply=await readJson(url+'/json_rpc',{jsonrpc:'2.0',id:'wallet-birthday',method:'get_block_header_by_height',params:{height}},fetchImpl,controller.signal);
    const r=reply.result,h=r?.block_header;need(r?.status==='OK'&&r.untrusted!==true&&h?.height===height&&h.orphan_status===false&&HASH.test(h.hash));return h;
   };
   const [genesis,tip]=await Promise.all([header(0),header(info.height-1)]);assertCurrent();
   need(genesis.hash===GENESIS&&tip.hash===info.top_block_hash&&Number.isSafeInteger(tip.timestamp)&&Math.abs(now()/1000-tip.timestamp)<=7200);
   if(signal?.aborted)throw signal.reason||cancelled();
   return info.height-30;
  }catch(error){
   assertCurrent();if(signal?.aborted)throw signal.reason||cancelled();
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);controller.abort();}
 }
 throw Error('Could not check the Monero network. Try again to create your wallet.');
}
