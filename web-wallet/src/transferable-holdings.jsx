import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Connection} from '@solana/web3.js';
import {createJointHoldings,jointIncomingStatus,jointIncomingHelp} from '../../engine/shared/joint-holdings.js';
import {walletManifest as transferableManifest} from '../../engine/shared/joint-deployment.js';
import {WALLET_TEST_POLICY} from '../../engine/shared/bridge-sdk/core-transferable/private-test.mjs';
import {createRuntimeHttpClient} from '../../engine/shared/bridge-sdk/core-transferable/runtime-api.mjs';
import {createSolanaAdapter} from '../../engine/shared/bridge-sdk/core-transferable/solana-adapter.mjs';
import {inputAmount} from '../../engine/token/max-amount.js';
import WalletAssetAction from './wallet-asset-action.jsx';
import {bridgeActionRow} from './bridge-portfolio.js';
import {createHoldingsRefresh} from './holdings-refresh.js';
export default function TransferableHoldings({owner,address,pair,provider,rows=[],visible=true,onRows,bridgeRows=[],refreshHoldings}){
 const account={sol:owner,xmr:address},scope=owner+':'+address,catalogKey=[...new Set(rows.map(row=>row.mint))].sort().join(':');
 const loader=useMemo(()=>createJointHoldings({walletTest:true,adapters:{runtime:(asset,{signal}={})=>createRuntimeHttpClient({signal,endpoint:'/api/joint-transferable/'+asset.mint,shareKey:location.origin}),chain:(asset,{signal}={})=>createSolanaAdapter({connection:new Connection(location.origin+'/api/bridge-solana-read',{commitment:'finalized',fetch:(url,options)=>fetch(url,{...options,signal})}),manifest:transferableManifest(asset.mint),privateTestPolicy:WALLET_TEST_POLICY})}}),[owner,address]);
 const [reading,setReading]=useState(()=>({scope,rows:loader.cached(account,rows),pending:loader.cachedPending(account,rows)})),[loading,setLoading]=useState(true),[error,setError]=useState(false),[action,setAction]=useState(null);
 const refreshRef=useRef(null),rowsRef=useRef(rows),visibleRef=useRef(visible);rowsRef.current=rows;visibleRef.current=visible;
 const holdings=reading.scope===scope?reading.rows:[];
 const pending=reading.scope===scope?(reading.pending??[]):[];
 const actionRow=bridgeActionRow(action,holdings,scope);
 useEffect(()=>{
  const account={sol:owner,xmr:address},setHoldings=(value,pending=[])=>setReading({scope:owner+':'+address,rows:value,pending});
  setError(false);setHoldings(loader.cached(account,rowsRef.current),loader.cachedPending(account,rowsRef.current));
  const refresh=createHoldingsRefresh({interval:15000,visible:visibleRef.current,read:options=>loader.load(account,rowsRef.current,options),clear:()=>loader.clear(),onReading:setLoading,onPartial:()=>setHoldings(loader.cached(account,rowsRef.current),loader.cachedPending(account,rowsRef.current)),onResult:result=>{setHoldings(result.rows,result.pending);setError(!result.complete);},onError:()=>setError(true)});
  refreshRef.current=refresh;
  return()=>{refresh.dispose();if(refreshRef.current===refresh)refreshRef.current=null;};
 },[loader,catalogKey,owner,address]);
 useEffect(()=>{refreshRef.current?.setVisible(visible);},[visible]);
 useEffect(()=>{if(reading.scope===scope)onRows?.({owner,address,rows:reading.rows});},[reading,scope,owner,address,onRows]);
 // 30 Oct 2026 (owner: the "could not refresh" line "shows up everywhere, its like a bug"): this older-bridge section appears only when it
 // has a balance or an incoming transfer to show; it never prints a refresh error or an empty state.
 if(!visible||(!holdings.length&&!pending.length))return null;
 return <section aria-label="New bridge balances"><div className="wallet-assets-head"><h3>New bridge balances</h3><button disabled={loading} aria-label="Refresh new bridge balances" onClick={()=>void refreshRef.current?.refresh()}>↻</button></div>{actionRow&&<WalletAssetAction key={action.row.id+':'+action.kind} row={actionRow} kind={action.kind} bridgeProtocol="transferable" network="monero" address={address} owner={owner} pair={pair} provider={provider} bridgeRows={bridgeRows} refreshHoldings={refreshHoldings} onClose={()=>setAction(null)}/>} {holdings.map(row=><div className="wallet-asset-wrap" key={row.id}><article className="wallet-asset"><div className="wallet-asset-info"><strong>{row.ticker}</strong><small>{inputAmount(row.amountRaw)} {row.ticker}{row.stale?' · last known':' · on Monero'}</small></div><div className="wallet-asset-actions"><button onClick={()=>setAction({scope,row,kind:'send'})}>Send</button><button onClick={()=>setAction({scope,row,kind:'bridge'})}>Bridge</button></div></article></div>)}{pending.length>0&&<section aria-label="Incoming bridge transfers"><h3>Incoming · not spendable</h3>{pending.map(row=><article className="wallet-asset-wrap" key={row.id}><strong>+{inputAmount(row.amountRaw)} {row.ticker}</strong><p role="status">{jointIncomingStatus(row)}</p><p>{jointIncomingHelp(row)}</p><a href={'https://xmrchain.net/tx/'+row.txid} target="_blank" rel="noopener noreferrer">View Monero transaction</a></article>)}</section>}</section>;
}
