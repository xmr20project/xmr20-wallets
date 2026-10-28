import React from 'react';
import {unlockProgress} from './bridge-progress.js';
const steps=['Preparing','Approve in wallet','Confirming','Complete'];
export default function BridgeUnlockProgress({transfer,ready,loading,error,saved,busy,stage,onApprove,onRetry,onCheck,onRefresh,link}){
 const progress=unlockProgress({state:transfer.state,ready,loading,error,saved,busy,stage});
 return <section aria-label="Solana unlock progress" style={{marginTop:16}}>
  <ol aria-label="Unlock steps" style={{display:'flex',flexWrap:'wrap',gap:'8px 16px',listStyle:'none',padding:0,margin:'0 0 20px',fontSize:11}}>{steps.map((label,i)=><li key={label} aria-current={progress.step===i?'step':undefined} style={{color:i===progress.step?'#ff914f':i<progress.step?'#b8d7a1':'#969da8'}}>{i<progress.step?'✓':i+1} {label}</li>)}</ol>
  <div role="status" aria-live="polite"><strong style={{display:'block',fontSize:17,lineHeight:1.4}}>{progress.waiting&&<span className="wallet-action-spinner" style={{display:'inline-block',marginRight:9,verticalAlign:'middle'}} aria-hidden="true"/>}{progress.title}</strong><p style={{margin:'10px 0 14px'}}>{progress.detail}</p></div>
  {progress.action==='approve'&&<button type="button" className="green" disabled={busy} onClick={onApprove}>Approve in Solana wallet</button>}
  {progress.action==='retry'&&<button type="button" disabled={busy||loading} onClick={onRetry}>Try again</button>}
  {progress.action==='check'&&<button type="button" disabled={busy} onClick={onCheck}>Check previous approval</button>}
  {error&&!loading&&<p role="alert" className="form-error">{error}</p>}
  {transfer.unlockRecovery&&transfer.state==='source_finalized'&&<p className="wallet-action-note">The previous Solana approval expired or failed. Approve a fresh transaction to finish this same bridge. Your Monero burn is already recorded.</p>}
  <details style={{marginTop:18}}><summary>Transaction details</summary>{link&&<p><a href={link} target="_blank" rel="noopener noreferrer">{transfer.destinationSignature?'Solana transaction ↗':'Monero transaction ↗'}</a></p>}{transfer.state!=='complete'&&<button type="button" disabled={busy} onClick={onRefresh}>Refresh status</button>}</details>
 </section>;
}
