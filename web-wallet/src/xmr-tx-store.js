// This wallet's own Monero transactions sent from this browser (sends and, from 30 Oct 2026, splits), with their confirmations.
// Owner, 30 Oct 2026: "i just did a xmr split, can we add these to the activity panel? and also a pending and show confirmations
// … show the link as the tx begins". Rows live in localStorage under the key website-xmr-send.jsx has used since 28 Oct
// ('xmr20-xmr-sends:<Monero address>'); a row without `kind` is a send. Confirmations come from the project's Monero node through
// the gateway's /api/private-node route (get_transactions + get_info: read-only, no keys), at most once per 20 s per address.
const KEY=address=>'xmr20-xmr-sends:'+address;
const api=()=>location.origin==='https://xmr20.org'?'https://api.xmr20.org':location.origin;
export const XMR_TX_CONFIRMATIONS=10;
export function loadXmrTxs(address){try{const v=JSON.parse(localStorage.getItem(KEY(address))||'[]');return Array.isArray(v)?v.filter(r=>r&&typeof r.hash==='string'):[];}catch{return [];}}
export function saveXmrTx(address,row,replacing=null){
 try{const rows=loadXmrTxs(address).filter(r=>r.hash!==row.hash&&r.hash!==replacing);rows.push(row);localStorage.setItem(KEY(address),JSON.stringify(rows.slice(-50)));}catch{}
}
// Rows still moving: not yet 10 confirmations, not refused, and not older than three days.
export const openXmrTxs=address=>loadXmrTxs(address).filter(r=>r.status!=='confirmed'&&r.status!=='not submitted'&&Date.now()-(r.at||0)<3*86400000);
export function xmrTxLabel(r){
 if(r.status==='confirmed')return 'Completed';
 if(r.status==='not submitted')return 'Not sent';
 if(Number.isSafeInteger(r.confirmations)&&r.confirmations>0)return `Confirming ${Math.min(r.confirmations,XMR_TX_CONFIRMATIONS)}/${XMR_TX_CONFIRMATIONS}`;
 if(r.status==='uncertain')return 'Checking with the network';
 return 'Pending';
}
export const xmrTxTitle=r=>r.kind==='split'?`Split XMR into ${r.coins} coins`:'Sent XMR';
const last=new Map();
async function post(path,body){const r=await fetch(api()+'/api/private-node'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),credentials:'omit',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('node unavailable');return r.json();}
// Updates the open rows' confirmations from the node and saves them. Returns all rows. Failures leave the rows as they were.
export async function refreshXmrTxStatus(address,{force=false}={}){
 const open=openXmrTxs(address);if(!open.length)return loadXmrTxs(address);
 if(!force&&Date.now()-(last.get(address)||0)<20000)return loadXmrTxs(address);last.set(address,Date.now());
 try{
  const [info,txs]=await Promise.all([post('/get_info',{}),post('/get_transactions',{txs_hashes:open.map(r=>r.hash),decode_as_json:false})]);
  const tip=Number(info?.height);if(!Number.isSafeInteger(tip)||tip<=0)throw Error('tip');
  const byHash=new Map((txs?.txs||[]).map(t=>[t.tx_hash,t]));
  for(const r of open){const t=byHash.get(r.hash);const next={...r};
   if(!t){if(r.status==='submitted'&&Date.now()-(r.at||0)>3600000)next.status='uncertain';}
   else if(t.in_pool){next.status='pending';next.confirmations=0;}
   else if(Number.isSafeInteger(t.block_height)){const n=tip-t.block_height;next.confirmations=n;next.status=n>=XMR_TX_CONFIRMATIONS?'confirmed':'confirming';next.height=t.block_height;}
   if(JSON.stringify(next)!==JSON.stringify(r))saveXmrTx(address,next);}
 }catch{}
 return loadXmrTxs(address);
}
