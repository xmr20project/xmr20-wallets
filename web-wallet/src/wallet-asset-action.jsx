import {requestLifetime,untilClosed} from '../../engine/shared/request-lifetime.js';
import {websiteBridgeRoute,legacyWithdrawalRequest} from './bridge-route.js';
import {maxBridgeAmount,maxSendAmount,bridgeAmountDisplay,bridgeTaxLabel} from './bridge-amount.js';
import {TRANSFER_LIMIT} from '../shared/xmr20/protocol.js';
import ExtensionBridge from './xmr20-extension-bridge.jsx';
import BridgeUnlockProgress from './bridge-unlock-progress.jsx';
import {resolveBridgePair} from './wallet-link.js';
import MoneroSendApproval from './monero-send-approval.jsx';
import React,{lazy,Suspense,useEffect,useId,useRef,useState} from 'react';
const JointBridgeChoice=import.meta.env.VITE_XMR20_JOINT_BRIDGE_LOCAL==='1'?lazy(()=>import('./joint-bridge-choice.jsx')):null;

import {Buffer} from 'buffer';
import {VersionedTransaction} from '@solana/web3.js';
import {request as defaultRequest} from './launch-api.js';
import {prepareSolanaTokenSend,signAndSubmitSolanaTokenSend,checkSolanaTokenSend,rawUnits} from './wallet-sol-send.js';
import {validateWalletMessage} from '../shared/pilot-transaction.js';
import {burnReview} from '../shared/xmr20/burn-review.js';
import {transferReview} from '../shared/xmr20/transfer-review.js';
import {createMoneroBurnSigner} from './monero-burn-client.js';
import {createMoneroTransferSigner} from './monero-transfer-client.js';
import {reviewMoneroTokenSend} from './monero-send-review.js';
import {moneroSendStatus,sendReceiptAdvanced,receiptPollDelay} from './monero-send-status.js';

import {createBridgePreparation,bridgeAmounts} from './bridge-preparation.js';
import {savedWithdrawalResolution,bridgeReceiptAdvanced} from './bridge-signed-recovery.js';
import {restoreBridge} from './bridge-restoration.js';
const TransferableWalletBridge=lazy(()=>import('./transferable-wallet-bridge.jsx'));

const localPreview=typeof location!=='undefined'&&['127.0.0.1','localhost'].includes(location.hostname)&&import.meta.env.VITE_XMR20_LOCAL_WALLET_LIVE!=='1';
const units=text=>rawUnits(text).toString();
const fmt=raw=>new Intl.NumberFormat('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(raw)/1e6);
const safeId=id=>typeof id==='string'&&/^[a-zA-Z0-9-]{8,80}$/.test(id);
function receiptLink(t){const xmr=t?.destinationTxid||t?.sourceTxid||t?.txid;return t?.destinationSignature?`https://solscan.io/tx/${t.destinationSignature}`:xmr?`https://xmrchain.net/tx/${xmr}`:t?.sourceSignature?`https://solscan.io/tx/${t.sourceSignature}`:null;}

export default function WalletAssetAction(props){
 const [legacy,setLegacy]=useState(false);
 if(!legacy&&websiteBridgeRoute(props)==='transferable'&&props.provider?.kind!=='xmr20')return <Suspense fallback={<p role="status">Opening bridge…</p>}><TransferableWalletBridge {...props} onLegacy={()=>setLegacy(true)}/></Suspense>;
 if(props.provider?.kind==='xmr20')return props.kind==='bridge'?<ExtensionBridge {...props}/>:<p role="status">Open XMR20 Wallet to review this transfer using the same connected account.</p>;
 if(import.meta.env.VITE_XMR20_JOINT_BRIDGE_LOCAL==='1'&&props.kind==='bridge')return <Suspense fallback={<p role="status">Loading bridge choices…</p>}><JointBridgeChoice {...props} request={props.request||defaultRequest} renderLegacy={legacyProps=><LegacyWalletAssetAction {...legacyProps}/>}/></Suspense>;
 return <LegacyWalletAssetAction {...props} legacyWithdrawOnly={props.kind==='bridge'} request={props.kind==='bridge'?legacyWithdrawalRequest(props.request||defaultRequest):props.request||defaultRequest}/>;
}
function LegacyWalletAssetAction({row,kind,network,address,owner,pair,provider,onLink,onClose,resumeId,request=defaultRequest,legacyWithdrawOnly=false}){
 const [amount,setAmount]=useState(''),[to,setTo]=useState(''),[quote,setQuote]=useState(null),[transfer,setTransfer]=useState(null),[prepared,setPrepared]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[signature,setSignature]=useState(''),[solReceipt,setSolReceipt]=useState(null),[phraseOpen,setPhraseOpen]=useState(false),[messageCopied,setMessageCopied]=useState(false);
 const [moneroSubmitting,setMoneroSubmitting]=useState(false);
 const [receiptLoading,setReceiptLoading]=useState(kind==='bridge'),[restoreError,setRestoreError]=useState(''),[restoreVersion,setRestoreVersion]=useState(0);
 const [stage,setStage]=useState(''),[reviewing,setReviewing]=useState(false),[bridgeReady,setBridgeReady]=useState(false),[bridgeLoading,setBridgeLoading]=useState(false),[bridgeError,setBridgeError]=useState('');
 const bridgeCache=useRef(null);if(!bridgeCache.current)bridgeCache.current=createBridgePreparation({request});
 const draft=useRef(null),latestTransfer=useRef(null);latestTransfer.current=transfer;
 const phrase=useRef(),signer=useRef(),flight=useRef(false),alive=useRef(true);
 const isBridge=kind==='bridge',isMonero=network==='monero';
 const needsLink=isBridge&&isMonero&&!pair?.address&&typeof onLink==='function';
 const key=`xmr20-wallet-action:${owner}:${network}:${kind}:${row.id}`;
 function resetDraft(expired=false){
  draft.current?.close();bridgeCache.current.clear();signer.current?.dispose();
  const saved=latestTransfer.current;
  if(saved?.state==='reserved'&&!isBridge&&!sessionStorage.getItem(key+':signed'))void request('cancelMoneroTransfer',{id:saved.id}).then(()=>{sessionStorage.removeItem(key);if(alive.current)setTransfer(null);}).catch(e=>{if(alive.current)setError(e.message);});
  setAmount('');setTo('');setQuote(null);setPrepared(null);setReviewing(false);setBusy(false);setStage('');setError(expired?'Unsigned request expired after 10 minutes. Start a new request.':'Request cancelled. You can start a new one.');
  draft.current=requestLifetime({onExpire:()=>resetDraft(true)});
 }
 function canCancelDraft(){return !solReceipt&&!sessionStorage.getItem(key+':signed')&&(!transfer||!isBridge&&transfer.state==='reserved'&&!moneroSubmitting);}
 useEffect(()=>{draft.current=requestLifetime({onExpire:()=>resetDraft(true)});return()=>{draft.current?.close();const t=latestTransfer.current;if(t?.state==='reserved'&&!isBridge&&!sessionStorage.getItem(key+':signed'))void request('cancelMoneroTransfer',{id:t.id}).then(()=>sessionStorage.removeItem(key)).catch(()=>{});};},[key]);
 useEffect(()=>{if(!canCancelDraft())draft.current?.submitted();},[transfer,solReceipt,moneroSubmitting]);
 useEffect(()=>{
  alive.current=true;let cancelled=false,id;setTransfer(null);setRestoreError('');setReceiptLoading(isBridge);
  try{id=sessionStorage.getItem(key);if(!isBridge&&!isMonero){const prefix=`xmr20-sol-send:${owner}:${row.mint}:`;for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);if(k?.startsWith(prefix)){const saved=JSON.parse(sessionStorage.getItem(k));if(saved?.signature)setSolReceipt({signature:saved.signature,confirmed:false,savedKey:k});break;}}}}catch{}
  if(isBridge||safeId(id))void request('account').then(async a=>{
   const found=isBridge?restoreBridge(a.transfers,{owner,launchId:row.id,mint:row.mint,network,address:isMonero?address:pair?.address},{savedId:id,resumeId}):(a.moneroTransfers||[]).find(t=>t.id===id);
   if(cancelled)return;
   if(found&&!isBridge&&isMonero&&found.state==='reserved'&&!found.txid&&Number.isSafeInteger(found.createdAt)&&Date.now()-found.createdAt>=600000){
    await request('cancelMoneroTransfer',{id:found.id});sessionStorage.removeItem(key);if(!cancelled)setError('Unsigned request expired after 10 minutes. Start a new request.');return;
   }
   if(found&&['cancelled','complete'].includes(found.state)){sessionStorage.removeItem(key);return;}
   if(found){setTransfer(found);sessionStorage.setItem(key,found.id);}else if(id)sessionStorage.removeItem(key);
  }).catch(e=>{if(!cancelled)setRestoreError(e.message||'Saved bridges could not load. Retry before starting another bridge.');}).finally(()=>{if(!cancelled)setReceiptLoading(false);});
  return()=>{cancelled=true;alive.current=false;signer.current?.dispose();if(phrase.current)phrase.current.value='';};
 },[key,resumeId,restoreVersion,owner,row.mint,address,pair?.address]);
 useEffect(()=>{
  if(!transfer||['complete','cancelled','halted'].includes(transfer.state))return;
  let cancelled=false,timer;
  async function poll(){try{
   const a=await request('account'),next=(isBridge?a.transfers||[]:a.moneroTransfers||[]).find(t=>t.id===transfer.id);
   if(!cancelled&&next){setTransfer(next);if(isBridge?bridgeReceiptAdvanced(transfer,next):sendReceiptAdvanced(transfer,next))setError('');if(['complete','cancelled','halted'].includes(next.state)){sessionStorage.removeItem(key);return;}}
  }catch{/* Preserve the saved receipt during a temporary read failure. */}
  if(!cancelled)timer=setTimeout(poll,receiptPollDelay(transfer,{moneroSend:!isBridge&&isMonero,submitting:moneroSubmitting}));}
  timer=setTimeout(poll,Math.min(3000,receiptPollDelay(transfer,{moneroSend:!isBridge&&isMonero,submitting:moneroSubmitting})));return()=>{cancelled=true;clearTimeout(timer);};
 },[transfer?.id,transfer?.state,transfer?.txid,isBridge,isMonero,moneroSubmitting,key]);
 useEffect(()=>{if(isBridge&&transfer?.sourceSignature)window.dispatchEvent(new Event('xmr20-bridge-updated'));},[isBridge,transfer?.id,transfer?.state,transfer?.sourceSignature]);
 const savedResolution=isBridge?savedWithdrawalResolution(transfer,sessionStorage.getItem(key+':signed'),owner):null;
 useEffect(()=>{
  if(!savedResolution)return;
  // Preserve unknown or still-live signed transactions, even after refresh.
  if(savedWithdrawalResolution(transfer,sessionStorage.getItem(key+':signed'),owner)===savedResolution){sessionStorage.removeItem(key+':signed');setError('');}
 },[savedResolution,transfer?.id,key,owner]);
 const signable=isBridge&&transfer&&((transfer.state==='reserved'&&transfer.direction==='sol-to-xmr')||(transfer.state==='source_finalized'&&transfer.direction==='xmr-to-sol'&&!transfer.destinationSignature));
 async function prepareBridge(t=transfer){
  if(!t||sessionStorage.getItem(key+':signed'))return;
  setBridgeLoading(true);setBridgeError('');
  try{await bridgeCache.current.prepare({...t,owner});if(alive.current)setBridgeReady(true);}
  catch(e){if(alive.current){setBridgeReady(false);setBridgeError(e.message);}}
  finally{if(alive.current)setBridgeLoading(false);}
 }
 useEffect(()=>{
  bridgeCache.current.clear();setBridgeReady(false);setBridgeError('');
  if(!signable)return;
  void prepareBridge(transfer);
  const timer=setInterval(()=>{if(!flight.current&&!document.hidden&&bridgeCache.current.renewIfDue({...transfer,owner})){setBridgeReady(false);void prepareBridge(transfer);}},1000);
  return()=>{clearInterval(timer);bridgeCache.current.clear();};
 },[signable,transfer?.withdrawalHistory?.length,transfer?.id,transfer?.state,owner,transfer?.mint,transfer?.amountRaw,transfer?.moneroAddress]);
 async function run(fn){if(flight.current)return;const scope=draft.current;flight.current=scope;if(canCancelDraft())scope.touch();setBusy(true);setError('');try{await untilClosed(fn(scope),scope.signal);}catch(e){if(alive.current&&draft.current===scope){setError(e.message||'This action could not complete. Check its receipt before retrying.');if((isBridge||isMonero)&&!e.localValidation){const saved=sessionStorage.getItem(key);if(safeId(saved))try{const a=await request('account'),found=(isBridge?a.transfers||[]:a.moneroTransfers||[]).find(t=>t.id===saved);if(alive.current&&found){setTransfer(found);setQuote(null);if(isBridge?bridgeReceiptAdvanced(transfer,found):sendReceiptAdvanced(transfer,found))setError('');}}catch{}}if(!isBridge&&!isMonero){const prefix=`xmr20-sol-send:${owner}:${row.mint}:`;for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);if(k?.startsWith(prefix)){try{const saved=JSON.parse(sessionStorage.getItem(k));if(saved?.signature)setSolReceipt({signature:saved.signature,confirmed:false,savedKey:k});}catch{}break;}}}}}finally{if(flight.current===scope)flight.current=false;if(alive.current&&draft.current===scope){setBusy(false);setStage('');}}}
 async function refresh(){if(!transfer)return;const action=isBridge?'advanceBridge':'advanceMoneroTransfer';let next=await request(action,{id:transfer.id});setTransfer(next);if(['complete','cancelled','halted'].includes(next.state))sessionStorage.removeItem(key);}
 async function review(scope=draft.current){const raw=units(amount);if(BigInt(raw)>BigInt(row.amountRaw))throw Error('Amount exceeds the displayed balance. Refresh holdings.');
  if(!isBridge&&!isMonero){const recipient=to.trim();if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recipient))throw Error('Enter a Solana wallet address.');const p=await prepareSolanaTokenSend({row,owner,to:recipient,amount});scope.assert();setPrepared(p);return;}
  if(isBridge){if(needsLink)setStage('Linking your imported Monero wallet…');await resolveBridgePair({pair,address,isMonero,onLink,assertCurrent:()=>{scope.assert();if(!alive.current)throw Error('Wallet panel closed.');provider?.assertCurrent?.();}});scope.assert();setReviewing(true);setStage('Checking available balance, bridge backing and the amount you will receive…');try{const q=await request('bridgeQuote',{launchId:row.id,direction:isMonero?'xmr-to-sol':'sol-to-xmr',amountRaw:raw});scope.assert();bridgeAmounts(q);setQuote(q);}catch(e){setReviewing(false);throw e;}}
  else{setStage('Checking the available balance for this send…');const q=await reviewMoneroTokenSend({request,launchId:row.id,from:address,to,amountRaw:raw});scope.assert();setQuote(q);}
 }
 async function reserve(scope=draft.current){scope.assert();setStage('Saving your bridge details and preparing the wallet transaction…');if(localPreview)throw Error('Local preview: no transaction request was created.');const id=sessionStorage.getItem(key)||crypto.randomUUID();sessionStorage.setItem(key,id);const input=isBridge?{id,launchId:row.id,direction:quote.direction,amountRaw:quote.amountRaw}:{id,launchId:row.id,from:address,to:quote.to,amountRaw:quote.amountRaw};const t=await request(isBridge?'bridgeIntent':'moneroTransferIntent',input);if(scope.signal.aborted||!alive.current){if(!isBridge)await request('cancelMoneroTransfer',{id:t.id});scope.assert();return;}setTransfer(t);setQuote(null);setPrepared(null);}
 async function signMonero(savedSeed){const scope=draft.current;scope.assert();if(!alive.current)throw Error('Wallet panel closed.');provider?.assertCurrent?.();if(!transfer)throw Error('Saved action missing.');const review=isBridge?burnReview(transfer,{owner,network:'mainnet',token:row.deployment}):transferReview(transfer,{owner,token:row.deployment});const client=isBridge?createMoneroBurnSigner():createMoneroTransferSigner();signer.current=client;const pending=client.sign(typeof savedSeed==='string'?savedSeed:phrase.current.value,review);if(phrase.current)phrase.current.value='';try{const sig=await pending;scope.assert();if(!alive.current)throw Error('Wallet panel closed.');provider?.assertCurrent?.();setSignature(sig);await submitMoneroSignature(sig);setPhraseOpen(false);}finally{client.dispose();signer.current=null;}}
 async function submitMoneroSignature(sig){draft.current?.assert();draft.current?.submitted();
  if(!isBridge){setMoneroSubmitting(true);setStage('Submitting your approval and preparing the Monero transaction…');}
  try{const next=await request(isBridge?'authorizeBurn':'authorizeMoneroTransfer',{id:transfer.id,signature:sig});if(alive.current)setTransfer(next);}
  finally{if(alive.current)setMoneroSubmitting(false);}
 }
 async function signSolanaBridge(scope=draft.current){scope.assert();
  if(localPreview)throw Error('Local preview: signing and submission are disabled.');
  if(!transfer||!provider||provider.publicKey?.toBase58()!==owner)throw Error('Connect the correct Solana wallet.');
  if(sessionStorage.getItem(key+':signed'))throw Error('Check the saved signed transaction before requesting another signature.');
  const operation=transfer.direction==='sol-to-xmr'?'Deposit':'Withdrawal';
  const bridgeScope={...transfer,owner};const fresh=bridgeCache.current.peek(bridgeScope);
  if(!fresh){setBridgeReady(false);await prepareBridge();throw Error('The transaction was refreshed. Click approve to open your wallet.');}
  const tx=VersionedTransaction.deserialize(Buffer.from(fresh.transaction,'base64')),before=VersionedTransaction.deserialize(tx.serialize()).message;
  setStage('Waiting for approval in your Solana wallet…');
  // No HTTP/RPC await before the wallet call on the ready path.
  const signing=provider.signTransaction(tx);bridgeCache.current.clear();setBridgeReady(false);
  const signed=await signing;scope.assert();if(!alive.current)throw Error('Wallet panel closed.');validateWalletMessage(before,signed.message);
  if(provider.publicKey?.toBase58()!==owner)throw Error('Wallet changed. Nothing was submitted.');
  const bytes=Buffer.from(signed.serialize()).toString('base64');
  sessionStorage.setItem(key+':signed',JSON.stringify({id:transfer.id,transaction:bytes,ticket:fresh.ticket,operation}));
  setStage('Submitting your signed transaction. Your receipt is saved…');setPrepared(null);
  setTransfer(await request('submit'+operation,{id:transfer.id,transaction:bytes,ticket:fresh.ticket}));sessionStorage.removeItem(key+':signed');
 }
 async function retrySigned(){
  const savedText=sessionStorage.getItem(key+':signed'),saved=JSON.parse(savedText||'null');
  if(!saved||saved.id!==transfer?.id||!['Deposit','Withdrawal'].includes(saved.operation))throw Error('No saved signed transaction.');
  if(saved.operation==='Withdrawal'){
   setStage('Checking whether the saved Solana approval confirmed or expired…');
   const checked=await request('advanceBridge',{id:saved.id});setTransfer(checked);
   const resolution=savedWithdrawalResolution(checked,savedText,owner);
   if(resolution){sessionStorage.removeItem(key+':signed');return;}
   if(checked.destinationSignature||checked.state==='complete')return;
   if(checked.withdrawalHistory?.length)throw Error('The saved approval does not match the verified receipt. Keep this bridge open for review.');
  }
  const recovered=await request('submit'+saved.operation,{id:saved.id,transaction:saved.transaction,ticket:saved.ticket});
  setTransfer(recovered);sessionStorage.removeItem(key+':signed');
  if(recovered.state==='reserved'&&recovered.direction==='sol-to-xmr')await prepareBridge(recovered);
 }

 async function sendSol(scope=draft.current){scope.assert();if(localPreview)throw Error('Local preview: signing and submission are disabled.');if(!prepared)throw Error('Prepare the transfer again.');const receipt=await signAndSubmitSolanaTokenSend({prepared,provider,owner,row,to:to.trim(),amount,onSubmitted:receipt=>{scope.submitted();if(alive.current&&draft.current===scope)setSolReceipt(receipt);},assertCurrent:()=>{scope.assert();if(!alive.current)throw Error('Wallet panel closed.');}});if(draft.current!==scope||!alive.current)return;scope.submitted();setSolReceipt(receipt);setPrepared(null);}
 const amountId=useId();
 function changeAmount(value){draft.current?.touch();setAmount(value);setReviewing(false);setQuote(null);setPrepared(null);setError('');}
 const valid=amount&&/^\d+(?:\.\d{1,6})?$/.test(amount)&&Number(amount)>0&&Number(amount)<=Number(row.amountRaw)/1e6;
 const moneroReview=transfer?.state==='reserved'&&isMonero&&!moneroSubmitting?(()=>{try{return isBridge?burnReview(transfer,{owner,network:'mainnet',token:row.deployment}):transferReview(transfer,{owner,token:row.deployment});}catch{return null;}})():null;
 const link=receiptLink(transfer);
 const unlockFlow=isBridge&&transfer?.direction==='xmr-to-sol'&&['source_finalized','destination_pending','complete'].includes(transfer.state);
 const sendStatus=!isBridge&&isMonero?moneroSendStatus(transfer,{submitting:moneroSubmitting}):null;
 return <div className="wallet-action-sheet" role="region" aria-label={`${kind} ${row.ticker}`}>
  <div className="wallet-action-head"><strong>{isBridge?`Bridge to ${isMonero?'Solana':'Monero'}`:`Send ${row.ticker}`}</strong><button type="button" aria-label="Close action" onClick={onClose}>×</button></div>
  {<>
   {receiptLoading&&<p role="status">Loading your saved bridge…</p>}{restoreError&&<><p role="alert" className="form-error">{restoreError}</p><button type="button" onClick={()=>setRestoreVersion(n=>n+1)}>Retry loading saved bridge</button></>}
   {!receiptLoading&&!restoreError&&!transfer&&!solReceipt&&legacyWithdrawOnly&&!isMonero&&<p role="status">No saved legacy transfer for this account and token. Your funds have not moved.</p>}
   {!receiptLoading&&!restoreError&&!transfer&&!solReceipt&&!(legacyWithdrawOnly&&!isMonero)&&<><p>{bridgeAmountDisplay(row.amountRaw)} {row.ticker} available</p>{localPreview&&<p className="wallet-action-note">Local preview · review only. No transaction can be signed here.</p>}<div style={{margin:'12px 0'}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}><label htmlFor={amountId} style={{margin:0}}>Amount</label><button type="button" aria-label={isBridge?'Use maximum bridge amount':'Use maximum send amount'} disabled={busy||BigInt(row.amountRaw)<=0n} onClick={()=>changeAmount(isBridge?maxBridgeAmount(row.amountRaw):maxSendAmount(row.amountRaw,network))} style={{minHeight:44,padding:'4px 12px',margin:0}}>Max</button></div><input id={amountId} inputMode="decimal" value={amount} onChange={e=>changeAmount(e.target.value)} placeholder="0.00" disabled={busy}/></div>{isBridge&&<p className="wallet-action-note">Max uses your token balance, up to the bridge limit. Transfer tax is deducted from that amount. Review checks availability and shows exactly what you’ll receive. SOL fees are separate.</p>}{!isBridge&&<p className="wallet-action-note">{isMonero?'Review checks availability after pending sends and bridges.':'SOL network fees are paid separately.'}{isMonero&&BigInt(row.amountRaw)>TRANSFER_LIMIT&&' Max is limited to 50,000,000 tokens per send.'}</p>}{!isBridge&&<label>Recipient {isMonero?'Monero':'Solana'} address<input value={to} onChange={e=>{draft.current?.touch();setTo(e.target.value);setQuote(null);setPrepared(null);}} autoComplete="off" spellCheck={false} disabled={busy}/></label>}
    {!quote&&!prepared&&<>{needsLink&&<p className="wallet-action-note">Link this imported Monero wallet to your connected Solana wallet to review the bridge. Linking does not move any tokens.</p>}<button type="button" disabled={!valid||busy} onClick={()=>run(review)}>{needsLink?'Link this wallet & review bridge':`Review ${kind}`}</button></>}
    {reviewing&&!quote&&<div className="wallet-action-review"><div className="wallet-bridge-summary"><div><small>You send · {isMonero?'Monero':'Solana'}</small><strong>{bridgeAmountDisplay(units(amount))} {row.ticker}</strong></div><span aria-hidden="true">→</span><div><small>You receive · {isMonero?'Solana':'Monero'}</small><strong>Checking net amount…</strong></div></div></div>}{quote&&<div className="wallet-action-review">{isBridge&&<><div className="wallet-bridge-summary"><div><small>You send</small><strong>{bridgeAmountDisplay(quote.amountRaw)} {row.ticker}</strong></div><span aria-hidden="true">→</span><div><small>You receive</small><strong>{bridgeAmountDisplay(quote.netReceivedRaw)} {row.ticker}</strong></div></div><p className="wallet-bridge-rate">Same token across networks · 1 {row.ticker} → {bridgeAmounts(quote).rate.toFixed(6)} {row.ticker} after the token fee.<br/>{bridgeTaxLabel(quote)}: {bridgeAmountDisplay(quote.transferTaxRaw)} {row.ticker}. Solana network costs are separate.</p></>}<p>{bridgeAmountDisplay(quote.amountRaw)} {row.ticker}<br/>From {quote.from.slice(0,8)}…{quote.from.slice(-6)}<br/>To {quote.to.slice(0,8)}…{quote.to.slice(-6)}</p><p>{isBridge?'The Monero balance is backed by locked Solana tokens.':'This token transfer is recorded in a Monero inscription.'}</p><button type="button" disabled={busy||localPreview} onClick={()=>run(reserve)}>Confirm details</button><button type="button" disabled={busy} onClick={()=>{setQuote(null);setReviewing(false);}}>Edit</button></div>}
    {prepared&&<div className="wallet-action-review"><p>Send {bridgeAmountDisplay(units(amount))} {row.ticker} to {to.slice(0,8)}…{to.slice(-6)}.</p>{prepared.fee>0n&&<p>Token transfer fee: {bridgeAmountDisplay(prepared.fee.toString())} {row.ticker}. Solana network and account costs also apply.</p>}<button type="button" disabled={busy||localPreview} onClick={()=>run(sendSol)}>Approve in Solana wallet</button><button type="button" disabled={busy} onClick={()=>setPrepared(null)}>Edit</button></div>}</>}
   {solReceipt&&<p role="status">{solReceipt.confirmed?'Transfer confirmed':'Transfer submitted · confirmation pending'} · <a href={`https://solscan.io/tx/${solReceipt.signature}`} target="_blank" rel="noopener noreferrer">view receipt ↗</a>{!solReceipt.confirmed&&<button type="button" disabled={busy} onClick={()=>run(async()=>{const confirmed=await checkSolanaTokenSend(solReceipt.signature);setSolReceipt({...solReceipt,confirmed});if(confirmed&&solReceipt.savedKey)sessionStorage.removeItem(solReceipt.savedKey);})}>Check confirmation</button>}</p>}
   {transfer&&<div className="wallet-action-review"><p>{fmt(transfer.amountRaw)} {row.ticker}{!unlockFlow&&<> · {sendStatus?sendStatus.label:transfer.state==='destination_pending'&&transfer.direction==='sol-to-xmr'?`Waiting for Monero · ${transfer.confirmations||0}/10 confirmations`:transfer.state==='source_pending'&&transfer.direction==='sol-to-xmr'?'Confirming Solana deposit':transfer.state==='source_pending'&&transfer.direction==='xmr-to-sol'?`Waiting for Monero · ${transfer.confirmations||0}/10 confirmations`:transfer.state.replaceAll('_',' ')}</>}</p>{sendStatus?.detail&&<p role="status" className="wallet-action-progress">{sendStatus.waiting&&!busy&&<span className="wallet-action-spinner" aria-hidden="true"/>}{sendStatus.detail}</p>}{!unlockFlow&&link&&<a href={link} target="_blank" rel="noopener noreferrer">{sendStatus?'Monero transaction ↗':'View transaction ↗'}</a>}
    {moneroReview&&<>{!isBridge?<MoneroSendApproval owner={owner} address={transfer.moneroAddress} provider={provider} busy={busy} onApprove={seed=>run(()=>signMonero(seed))}/>:<><p>Sign this exact {isBridge?'burn':'transfer'} with the sending Monero wallet.</p><button type="button" disabled={busy} onClick={()=>setPhraseOpen(true)}>Approve with Monero wallet</button>{phraseOpen&&<label>25-word recovery phrase<input ref={phrase} type="password" autoComplete="off" spellCheck={false} maxLength={500} disabled={busy}/></label>}{phraseOpen&&<button type="button" disabled={busy} onClick={()=>run(signMonero)}>Sign and submit</button>}</>}<details><summary>Use external Monero signature</summary><p>Use your external Monero wallet to sign the exact approval message, then paste its signature below.</p><button type="button" onClick={()=>run(async()=>{await navigator.clipboard.writeText(moneroReview.message);setMessageCopied(true);})}>{messageCopied?'Signing message copied':'Copy signing message'}</button><label>Signature<input value={signature} onChange={e=>setSignature(e.target.value.trim())} autoComplete="off"/></label><button type="button" disabled={busy||!/^SigV2[1-9A-HJ-NP-Za-km-z]{80,110}$/.test(signature)} onClick={()=>run(()=>submitMoneroSignature(signature))}>Submit signature</button></details></>}
    {unlockFlow?<BridgeUnlockProgress transfer={transfer} ready={bridgeReady} loading={bridgeLoading} error={bridgeError} saved={!!sessionStorage.getItem(key+':signed')&&!savedResolution} busy={busy} stage={stage} onApprove={()=>run(signSolanaBridge)} onRetry={()=>prepareBridge()} onCheck={()=>run(retrySigned)} onRefresh={()=>run(refresh)} link={link}/>:<>
    {isBridge&&transfer.state==='reserved'&&transfer.direction==='sol-to-xmr'&&<button type="button" disabled={busy||!bridgeReady||bridgeLoading||!!sessionStorage.getItem(key+':signed')} onClick={()=>run(signSolanaBridge)}>Approve lock in Solana wallet</button>}
    {isBridge&&transfer.state==='source_finalized'&&transfer.direction==='xmr-to-sol'&&transfer.unlockRecovery&&<p role="status" className="wallet-action-note">The previous Solana approval expired or failed. Approve a fresh transaction to finish this same bridge. Your Monero burn is already recorded.</p>}
    {isBridge&&transfer.state==='source_finalized'&&transfer.direction==='xmr-to-sol'&&!transfer.destinationSignature&&<button type="button" disabled={busy||!bridgeReady||bridgeLoading||!!sessionStorage.getItem(key+':signed')} onClick={()=>run(signSolanaBridge)}>Approve unlock in Solana wallet</button>}
    {signable&&sessionStorage.getItem(key+':signed')&&!savedResolution&&<p role="status" className="wallet-action-note">A saved Solana approval needs to be checked before another can be requested. Use Check saved signed transaction below.</p>}
    {signable&&bridgeError&&<><p role="alert" className="form-error">{bridgeError}</p><button disabled={busy||bridgeLoading} onClick={()=>prepareBridge()}>Retry preparation</button></>}{signable&&bridgeLoading&&!busy&&<p role="status" className="wallet-action-progress"><span className="wallet-action-spinner" aria-hidden="true"/>Preparing and checking the wallet transaction…</p>}{sessionStorage.getItem(key+':signed')&&<button type="button" disabled={busy} onClick={()=>run(retrySigned)}>Check saved signed transaction</button>}
    {['pending','source_pending','source_finalized','destination_pending'].includes(transfer.state)&&<button type="button" disabled={busy} onClick={()=>run(refresh)}>Check status</button>}
    </>}
    {transfer.state==='reserved'&&!isBridge&&!moneroSubmitting&&<button type="button" disabled={busy} onClick={()=>run(async()=>{setTransfer(await request('cancelMoneroTransfer',{id:transfer.id}));sessionStorage.removeItem(key);})}>Cancel unsigned transfer</button>}
   </div>}
  </>}{canCancelDraft()&&<><button type="button" onClick={()=>resetDraft()}>Cancel request</button><p className="wallet-action-note">Unsigned requests expire after 10 minutes. Closing this panel cancels the draft.</p></>}{busy&&!unlockFlow&&<p role="status" className="wallet-action-progress"><span className="wallet-action-spinner" aria-hidden="true"/>{stage||'Checking your request…'}</p>}{error&&<p role="alert" className="form-error">{error}</p>}
 </div>;
}
