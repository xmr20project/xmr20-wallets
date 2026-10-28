// Public worker progress explains the wait; it never authorizes spending.
export function jointWaiting(job,esc,{paused=false,updatesUnavailable=false}={}){
 // The worker replays history under its publishing phase on each attempt.
 // A saved publication receipt means this is now a confirmation check.
 const rawPhase=job.background?.phase,link=job.proposal.operation==='register';
 const txid=job.publication?.txid,hasPublication=typeof txid==='string'&&/^[a-f0-9]{64}$/.test(txid)&&!/^0+$/.test(txid);
 const published=hasPublication&&!job.publication.confirmed;
 const delayedLink=link&&rawPhase==='delayed'&&published;
 const phase=(rawPhase==='publishing'&&published)||delayedLink?'monero-pending':rawPhase;
 const states={
  'solana-pending':{label:'Waiting for Solana confirmation',step:0,why:`Your signed ${link?'registration':'deposit'} is saved. Solana must confirm it before the service publishes ${link?'your wallet link':'your token credit'} on Monero.`},
  publishing:{label:link?'Publishing your Monero wallet link':'Publishing your Monero credit',step:1,why:link?'Solana registration is confirmed. The service is recording your wallet link on Monero.':'Your deposit is confirmed and your tokens are held on Solana. The service is recording the credit on Monero.'},
  'monero-pending':{label:link?'Wallet linking — waiting for Monero confirmations':'Waiting for Monero confirmations',step:2,why:link?'Your wallet link is published. After 10 Monero confirmations, you can bridge tokens or receive Monero transfers.':'Your credit is published. Your pending balance is not spendable yet. It becomes available after 10 Monero confirmations.'},
  complete:{label:link?'Wallet link confirmed':'Monero credit confirmed',step:3,why:link?'Your wallet link is confirmed. Checking the bridge before showing the deposit form…':'The service reports a confirmed credit. Checking your spendable balance…'},
  delayed:{label:'Waiting for the bridge service',why:'The service could not finish its last check. Your approval is saved and it will retry automatically.'},
  'needs-attention':{label:'This bridge needs attention',why:'The service could not safely finish this saved record. Keep your recovery receipt; do not approve another deposit.'},
  'approval-required':{label:'Checking an expired approval',why:'This approval expired or failed. Checking its result before offering a new approval.'}
 };
 const state=delayedLink?{label:'Wallet link published — checking confirmations',step:2,why:'Your wallet link is published. The confirmation check is delayed and will retry automatically. No new approval is needed.'}:states[phase]??{label:'Waiting for a status update',why:'Your approval is saved. Checking the service before continuing.'};
 const running=['solana-pending','publishing','monero-pending'].includes(phase)&&!updatesUnavailable&&!delayedLink;
 const confirmations=phase==='complete'&&hasPublication&&job.publication.confirmed===true?10:hasPublication&&Number.isInteger(job.background?.confirmations)&&job.background.confirmations>=0&&job.background.confirmations<10?job.background.confirmations:null;
 const confirmationCount=confirmations===null?'—/10':confirmations+'/10';
 const confirmationLabel=confirmations===null?'Checking Monero confirmations':`${confirmations} of 10 Monero confirmations`;
 const names=['Solana confirmation',link?'Monero wallet link':'Monero token credit','Ten Monero confirmations'];
 const steps=Number.isInteger(state.step)?`<ol class="joint-wait-steps" aria-label="${link?'Wallet connection':'Bridge'} progress">${names.map((name,i)=>{const done=i<state.step,current=i===state.step,count=i===2&&(done||current);return `<li data-state="${done?'done':current?'current':'queued'}"${current?' aria-current="step"':''}><span>${name}</span><span${count?` role="status" aria-label="${esc(confirmationLabel)}"`:''}>${count?confirmationCount:done?(i===1?'Published':'Confirmed'):current?(i===1?'Publishing':'Waiting'):'Next'}</span></li>`;}).join('')}</ol>`:'';
 const transaction=hasPublication?`<p class="joint-wait-transaction"><a href="https://xmrchain.net/tx/${txid}" target="_blank" rel="noopener noreferrer">View Monero transaction</a></p>`:'';
 const timing=phase==='monero-pending'?'<p><strong>Allow about 20 minutes for 10 Monero confirmations.</strong> The wait starts when the record is published on Monero. Network timing can vary.</p>':'';
 const background=['solana-pending','publishing','monero-pending','delayed'].includes(phase);
 return `<div class="joint-waiting"><p class="joint-busy joint-wait-label" data-loading="${running}" data-paused="${paused}" role="status"><strong>${updatesUnavailable?'Last known: ':''}${esc(state.label)}</strong></p>${timing}${steps}${transaction}<p>${esc(state.why)}</p>${background?`<p>${link?'No tokens have moved. Once linked, you can bridge tokens or receive Monero transfers.':'The service completes this saved deposit automatically.'}</p><p class="subtle">You can close the wallet. ${updatesUnavailable?'Reconnect later to check progress.':'Status updates automatically while it is open.'} No further approval is needed for this ${link?'wallet link':'deposit'}.</p>`:''}</div>`;
}
