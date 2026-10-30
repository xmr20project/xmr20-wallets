// Public portfolio reads only. This module has no holder signer or submission API.
import {Buffer} from 'buffer';
import {commitment as identityCommitment} from './bridge-sdk/core-universal-link/records.mjs';
import {Connection,PublicKey} from '@solana/web3.js';
import {receiptCommitment,matchesReceipt} from './bridge-sdk/core-fast-send/records.mjs';
import {jointService} from './joint-service.js';
import {discoveredAssets,savedJointAssets} from './joint-bridge-assets.js';
import {walletManifest as transferableManifest,universalLinkEnabled} from './joint-deployment.js';
import {PRIVATE_TEST_POLICY,WALLET_TEST_POLICY} from './bridge-sdk/core-transferable/private-test.mjs';
import {canonical,digest,commitment,payload} from './bridge-sdk/core-transferable/records.mjs';
import {addresses,decodePosition} from './bridge-sdk/core-transferable/sdk.mjs';
import {createRuntimeHttpClient} from './bridge-sdk/core-transferable/runtime-api.mjs';
import {createSolanaAdapter} from './bridge-sdk/core-transferable/solana-adapter.mjs';
const need=(v,m)=>{if(!v)throw Error(m);},raw=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(v)&&BigInt(v)<=1000000000000000n;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const privateBuild=typeof __XMR20_JOINT_PRIVATE_TEST__!=='undefined'&&__XMR20_JOINT_PRIVATE_TEST__;
const walletTestBuild=typeof __XMR20_JOINT_WALLET_TEST__!=='undefined'&&__XMR20_JOINT_WALLET_TEST__;
export const isJointHolding=row=>row?.bridge==='joint-v3';
export function replaceHoldingSource(rows,incoming,{network,bridge}={}){return [...rows.filter(r=>bridge?!(isJointHolding(r)&&r.mint===bridge):r.network!==network||isJointHolding(r)),...incoming];}
export function jointHoldingRow(report,account,asset,{privateTest=false,walletTest=false,now=Date.now()}={}){
 const manifest=transferableManifest(asset.mint),policy=walletTest?WALLET_TEST_POLICY:privateTest?PRIVATE_TEST_POLICY:null;
 need(report?.schema==='joint-index-v3'&&report.complete===true&&canonical(report.manifest)===canonical(manifest)&&canonical(report.privateTestPolicy??null)===canonical(policy)&&Array.isArray(report.positions)&&Array.isArray(report.accepted),'Complete verified bridge history required.');
 if(privateTest&&!walletTest)need(account.sol===policy.owner&&account.xmr===policy.moneroOwner&&asset.mint===policy.mint,'Wrong private test account.');
 const config={...manifest,owner:account.sol,binding:digest(account.xmr)},position=addresses(config).position.toBase58(),matches=report.positions.filter(p=>p.position===position||p.moneroOwner===account.xmr);
 need(matches.length<=1,'Duplicate bridge position.');const p=matches[0];if(!p)return null;
 need(p.position===position&&p.solanaOwner===account.sol&&p.moneroOwner===account.xmr&&['abi','network','program','mint','verifier','owner','binding'].every(k=>p.config?.[k]===config[k])&&hash(p.linkTxid),'Bridge balance belongs to another linked wallet.');
 need([p.available,p.balance,p.chainBalance].every(raw)&&p.available===(BigInt(p.balance)<=BigInt(p.chainBalance)?p.balance:'0'),'Unreconciled bridge balance.');
 const link=report.accepted.find(e=>e.txid===p.linkTxid&&e.envelope?.record?.op==='link'&&e.envelope.record.owner===account.xmr&&e.envelope.record.to===account.sol&&(e.envelope.record.program===manifest.program&&e.envelope.record.mint===asset.mint||universalLinkEnabled&&e.envelope.record.p==='xmr20-identity'&&e.envelope.record.registry===manifest.program&&e.envelope.record.verifier===manifest.verifier&&p.identityCommitment===identityCommitment(e.envelope)));
 need(link,'Confirmed Monero link missing.');if(p.available==='0')return null;
 const latest=report.accepted.filter(e=>hash(e.txid)&&e.envelope?.record?.mint===asset.mint&&e.envelope.record.program===manifest.program&&(e.envelope.record.op==='credit'&&e.envelope.record.owner===account.xmr||e.envelope.record.op==='transfer'&&e.envelope.record.to===account.xmr)).at(-1);
 const fastCredit=(report.fastTransfers??[]).filter(r=>r?.settlement==='solana'&&r.kind===4&&r.to===position&&r.net===r.gross&&r.fee==='0'&&hash(r.nonce)&&r.commitment===receiptCommitment({...manifest,...r})&&r.receipt===PublicKey.findProgramAddressSync([Buffer.from('joint-v3-receipt'),new PublicKey(r.from).toBuffer(),Buffer.from(r.nonce,'hex')],new PublicKey(manifest.program))[0].toBase58()).at(-1);
 need(latest||fastCredit,'Confirmed token credit missing.');
 return {id:'joint-v3:'+asset.mint+':'+position,bridge:'joint-v3',network:'monero',mint:asset.mint,name:asset.name,ticker:asset.symbol,program:manifest.program,position,moneroOwner:account.xmr,solanaOwner:account.sol,amountRaw:p.available,chainBalance:p.chainBalance,linkTxid:p.linkTxid,...(fastCredit?{settlement:'solana',fastReceipt:fastCredit.receipt}:{}),receipt:fastCredit?{url:'https://solscan.io/account/'+position,label:'View Solana position'}:{url:'https://xmrchain.net/tx/'+latest.txid,label:'View Monero record'},checkedAt:now,stale:false};
}
// These rows are a separate display channel. Never merge them into holdings,
// MAX amounts, USD totals or any authorization input.
export function jointIncomingRows(report,account,asset,options={}){
 jointHoldingRow(report,account,asset,options); // exact deployment, policy and paired account checks
 const manifest=transferableManifest(asset.mint),position=addresses({...manifest,owner:account.sol,binding:digest(account.xmr)}).position.toBase58();
 const dest=report.positions.find(p=>p.position===position);if(!dest)return [];
 const seen=new Set(),out=[];
 for(const [items,state] of [[report.pending??[],'approval'],[report.observed??[],'confirming']]){
  need(Array.isArray(items)&&items.length<=10000,'Invalid incoming observations.');
  for(const item of items){
   const r=item.envelope?.record;
   if(!hash(item.txid)||seen.has(item.txid)||report.accepted.some(a=>a.txid===item.txid)||r?.mint!==asset.mint||r?.program!==manifest.program)continue;
   if(!(r.op==='transfer'&&r.to===account.xmr&&r.into===position))continue;
   try{payload(item.envelope);}catch{continue;}
   if(state==='approval'&&(item.reason!=='finalized-backing-receipt-missing'||!Number.isSafeInteger(item.confirmations)||item.confirmations<10))continue;
   if(r.op==='transfer'&&!report.positions.some(p=>p.position===r.from&&p.moneroOwner===r.owner&&BigInt(p.available)>=BigInt(r.amount)))continue;
   seen.add(item.txid);out.push({id:'joint-incoming:'+asset.mint+':'+item.txid,bridge:'joint-v3',mint:asset.mint,name:asset.name,ticker:asset.symbol,amountRaw:r.amount,txid:item.txid,state,checkedAt:options.now??Date.now(),stale:false});
  }
 }
 return out;
}
export function jointIncomingStatus(row){return row.stale?'Last seen · refresh delayed':row.state==='approval'?'Monero confirmed · Solana approval pending':'Waiting for 10 Monero confirmations';}
export function jointIncomingHelp(row){return row.state==='approval'?'The sender must open the saved send to approve or check the final Solana step. These tokens are not spendable yet.':'The record was submitted. Allow about 20 minutes for 10 Monero confirmations, then the sender completes the Solana approval.';}
// Display refresh: finalized custody is reread every cycle (two small Solana
// reads). The expensive complete history snapshot is requested again only when
// that custody account's bytes changed, the last snapshot is older than
// reportTtl, or the user forces a refresh. Rows remain display data; Bridge
// readiness, MAX, fees and signing use their own fresh snapshot and custody.
export function createJointHoldings({privateTest=privateBuild,walletTest=walletTestBuild,fetcher=fetch,storage=globalThis.localStorage,now=Date.now,adapters,ttl=15000,reportTtl=60000}={}){
 privateTest=privateTest||walletTest;
 const {endpoint,rpcEndpoint}=jointService({privateTest,walletTest}),entries=new Map();
 const key=(a,mint)=>'xmr20-joint-holdings-v3:'+transferableManifest(mint).program+':'+mint+':'+a.sol+':'+digest(a.xmr);
 function assets(a,rows){if(!a?.sol||!a?.xmr||privateTest&&!walletTest&&(a.sol!==PRIVATE_TEST_POLICY.owner||a.xmr!==PRIVATE_TEST_POLICY.moneroOwner))return [];const known=[...rows,...savedJointAssets(storage)],mints=new Set([PRIVATE_TEST_POLICY.mint,...known.map(r=>r.mint)]);return discoveredAssets(known).filter(v=>v.key!=='previous-xcat'&&mints.has(v.mint)&&(!privateTest||walletTest||v.mint===PRIVATE_TEST_POLICY.mint));}
 function cached(a,asset){try{const v=JSON.parse(storage?.getItem(key(a,asset.mint))??'null');if(!v||v.savedAt>now()||now()-v.savedAt>86400000||v.sol!==a.sol||v.xmr!==a.xmr||v.mint!==asset.mint)return null;const row=jointHoldingRow(v.report,a,asset,{privateTest,walletTest,now:v.savedAt});return row?{...row,stale:true}:null;}catch{return null;}}
 function cachedIncoming(a,asset){try{const v=JSON.parse(storage?.getItem(key(a,asset.mint))??'null');if(!v||v.savedAt>now()||now()-v.savedAt>86400000||v.sol!==a.sol||v.xmr!==a.xmr||v.mint!==asset.mint)return [];return jointIncomingRows(v.report,a,asset,{privateTest,walletTest,now:v.savedAt}).map(r=>({...r,stale:true}));}catch{return [];}}
 async function read(a,asset,signal,{force=false,verified=null,remember=()=>{}}={}){
  const manifest=transferableManifest(asset.mint),policy=walletTest?WALLET_TEST_POLICY:privateTest?PRIVATE_TEST_POLICY:undefined;
  const runtime=adapters?.runtime?.(asset,{signal})??createRuntimeHttpClient({fastSettlement:manifest.fastSend==='solana-settlement-v1',endpoint:'/api/joint-transferable/'+asset.mint,fetcher:(p,o)=>fetcher(endpoint+p,o),signal,shareKey:endpoint});
  const chain=adapters?.chain?.(asset,{signal})??createSolanaAdapter({connection:new Connection(rpcEndpoint,{commitment:'finalized',fetch:(url,o)=>fetcher(url,{...o,signal})}),manifest,privateTestPolicy:policy});
  // Unregistered tokens skip native history. A linked account with zero custody
  // must still check for incoming transfers awaiting the sender’s final approval.
  const position=addresses({...manifest,owner:a.sol,binding:digest(a.xmr)}).position.toBase58();
  const [,custody]=await Promise.all([chain.verifyProgram(),chain.readAccount(position)]);need(!signal.aborted,'Balance refresh cancelled.');
  let custodyBalance=null;
  if(custody){
   need(custody.finalized===true&&custody.owner===manifest.program&&!custody.executable,'Finalized bridge custody unavailable.');
   const p=decodePosition(custody.data);need(p.owner===a.sol&&p.verifier===manifest.verifier&&p.mint===asset.mint&&p.binding===digest(a.xmr),'Bridge custody belongs to another linked wallet.');
   custodyBalance=p.balance;
  }
  if(custody===null){
   try{storage?.setItem(key(a,asset.mint),JSON.stringify({sol:a.sol,xmr:a.xmr,mint:asset.mint,savedAt:now(),empty:true}));}catch{}
   return {row:null,pending:[]};
  }
  const custodyHex=Buffer.from(custody.data).toString('hex');
  const reusable=!force&&verified&&verified.custodyHex===custodyHex&&verified.position===position&&Number.isSafeInteger(verified.reportAt)&&now()-verified.reportAt>=0&&now()-verified.reportAt<=reportTtl;
  if(reusable){
   // Same finalized custody bytes and a recent complete snapshot: present the
   // same display rows again without another full history request.
   const row=jointHoldingRow(verified.report,a,asset,{privateTest,walletTest,now:now()});
   need(!signal.aborted,'Balance refresh cancelled.');
   return {row:row?{...row,historyAt:verified.reportAt}:null,pending:jointIncomingRows(verified.report,a,asset,{privateTest,walletTest,now:now()}),reused:true};
  }
  const report=await runtime.snapshot();need(!signal.aborted,'Balance refresh cancelled.');const reportAt=now();
  const row=jointHoldingRow(report,a,asset,{privateTest,walletTest,now:reportAt});
  // Positive verified backing cannot be reconciled by an index snapshot that
  // omits this position. Preserve last-known data instead of caching false zero.
  if(custodyBalance!==null&&BigInt(custodyBalance)>0n)need(report.positions.some(p=>p.position===position),'Bridge history is missing funded custody; refresh again.');
  let finalCustodyHex=custodyHex;
  if(row){const value=await chain.readAccount(row.position);need(value?.finalized===true&&value.owner===manifest.program&&!value.executable,'Finalized bridge custody unavailable.');const p=decodePosition(value.data);need(p.owner===a.sol&&p.verifier===manifest.verifier&&p.mint===asset.mint&&p.binding===digest(a.xmr)&&p.balance===row.chainBalance&&p.linkProof===((e)=>e.record.p==='xmr20-identity'?identityCommitment(e):commitment(e))(report.accepted.find(e=>e.txid===row.linkTxid).envelope),'Bridge custody changed; refresh again.');finalCustodyHex=Buffer.from(value.data).toString('hex');}
  if(row?.fastReceipt){const receipt=await chain.readAccount(row.fastReceipt);need(receipt?.finalized===true&&receipt.owner===manifest.program&&!receipt.executable&&matchesReceipt(manifest,row.fastReceipt,receipt.data)?.to===position,'Finalized fast-send credit unavailable.');}
  need(!signal.aborted,'Balance refresh cancelled.');try{storage?.setItem(key(a,asset.mint),JSON.stringify({sol:a.sol,xmr:a.xmr,mint:asset.mint,savedAt:now(),report}));}catch{/* Display cache is optional and never authorizes spending. */}
  remember({custodyHex:finalCustodyHex,position,reportAt,report});
  return {row:row?{...row,historyAt:reportAt}:null,pending:jointIncomingRows(report,a,asset,{privateTest,walletTest,now:now()}),reused:false};
 }
 return {
  cachedPending(account,rows=[]){return assets(account,rows).flatMap(asset=>cachedIncoming(account,asset));},
  cached(account,rows=[]){return assets(account,rows).map(asset=>cached(account,asset)).filter(Boolean);},
  async load(account,rows=[],{force=false,onResult=()=>{}}={}){
   const a={sol:account.sol,xmr:account.xmr},results=[];
   const queue=assets(a,rows);
   await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{while(queue.length){const asset=queue.shift();
    const id=key(a,asset.mint);let e=entries.get(id);
    if(!e){e={attempt:-Infinity,value:null};entries.set(id,e);}
    if(!e.pending&&now()-e.attempt>=(force?5000:ttl)){
     e.attempt=now();e.abort=new AbortController();const signal=e.abort.signal;
     e.pending=read(a,asset,signal,{force,verified:e.verified??null,remember:v=>{e.verified=v;}}).then(({row,pending,reused})=>e.value={mint:asset.mint,rows:row?[row]:[],pending,complete:true,reused:reused===true}).catch(()=>{e.verified=null;e.value={mint:asset.mint,rows:[cached(a,asset)].filter(Boolean),pending:cachedIncoming(a,asset),complete:false};}).finally(()=>{e.attempt=now();e.pending=null;});
    }
    if(e.pending)await e.pending;
    const result=e.value??{mint:asset.mint,rows:[],complete:false};results.push(result);onResult(result);
   }}));
   return {rows:results.flatMap(r=>r.rows),pending:results.flatMap(r=>r.pending??[]),complete:results.every(r=>r.complete)};
  },
  clear(){for(const e of entries.values())e.abort?.abort();entries.clear();}
 };
}
