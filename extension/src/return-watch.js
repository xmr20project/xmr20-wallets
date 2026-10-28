// 27 Oct 2026: tell the owner when a saved return to Solana is ready to finish. A return's Solana step runs only in an open,
// unlocked wallet (one explicit click per session), and Chrome closes the popup whenever focus moves, so returns sat
// finished-on-Monero for hours. This background watcher reads only the bridge's PUBLIC history for the exact saved return
// (mint, nonce, receipt address), then shows a badge and a notification. It never reads keys, signs or submits anything.
// Self-contained (no imports): appended to the installed background bundle and imported by src/background.js.
const RETURN_WATCH_KEY='xmr20-return-watch',RETURN_WATCH_ALARM='xmr20-return-watch',RETURN_WATCH_MAX_AGE=3*86400000;
const RETURN_WATCH_BASE58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
async function returnWatches(){try{const value=(await chrome.storage.local.get(RETURN_WATCH_KEY))[RETURN_WATCH_KEY];return value&&typeof value==='object'?value:{};}catch{return {};}}
async function saveReturnWatches(watches){
 if(Object.keys(watches).length){await chrome.storage.local.set({[RETURN_WATCH_KEY]:watches});}
 else{await chrome.storage.local.remove(RETURN_WATCH_KEY);await chrome.alarms.clear(RETURN_WATCH_ALARM);}
}
function validReturnWatch(m){
 return RETURN_WATCH_BASE58.test(m?.mint||'')&&RETURN_WATCH_BASE58.test(m?.receipt||'')&&/^[a-f0-9]{64}$/.test(m?.nonce||'')
  &&typeof m.amount==='string'&&m.amount.length<=40&&/^[0-9.,]+$/.test(m.amount)&&typeof m.symbol==='string'&&/^[A-Za-z0-9]{1,16}$/.test(m.symbol);
}
// Ready = the bridge lists the burn as pending with this exact receipt address, or has accepted this exact nonce.
export function returnIsReady(report,watch,nonce){
 if(!report||report.complete!==true)return false;
 return (Array.isArray(report.pending)&&report.pending.some(e=>e?.operation==='burn'&&e.receipt===watch.receipt))
  ||(Array.isArray(report.accepted)&&report.accepted.some(e=>e?.envelope?.record?.op==='burn'&&e.envelope.record.nonce===nonce));
}
export async function checkReturnWatches({fetcher=fetch,now=Date.now}={}){
 const watches=await returnWatches();let changed=false;
 for(const [nonce,watch] of Object.entries(watches)){
  if(now()-watch.since>RETURN_WATCH_MAX_AGE){delete watches[nonce];changed=true;continue;}
  if(watch.notified)continue;
  let report;
  try{const response=await fetcher('https://api.xmr20.org/api/joint-transferable/'+watch.mint+'/snapshot',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(90000)});if(!response.ok)continue;report=await response.json();}
  catch{continue;}
  if(!returnIsReady(report,watch,nonce))continue;
  watch.notified=true;changed=true;
  try{await chrome.action.setBadgeBackgroundColor({color:'#ff813d'});await chrome.action.setBadgeText({text:'1'});}catch{}
  try{chrome.notifications?.create('xmr20-return-'+nonce,{type:'basic',iconUrl:'icons/128.png',title:'Your XMR20 return is ready',message:'Monero confirmed your return of '+watch.amount+' '+watch.symbol+'. Open XMR20 Wallet, go to Bridge and press Resume return to finish it. No new Monero step is needed.',priority:2});}catch{}
 }
 if(changed)await saveReturnWatches(watches);
}
export async function handleReturnWatch(m){
 const watches=await returnWatches();
 if(m?.action==='watch'){
  if(!validReturnWatch(m))throw Error('Invalid return watch.');
  if(!watches[m.nonce])watches[m.nonce]={mint:m.mint,receipt:m.receipt,amount:m.amount,symbol:m.symbol,since:Date.now(),notified:false};
  await saveReturnWatches(watches);await chrome.alarms.create(RETURN_WATCH_ALARM,{delayInMinutes:2,periodInMinutes:2});return {watching:Object.keys(watches).length};
 }
 if(m?.action==='done'){if(/^[a-f0-9]{64}$/.test(m.nonce||'')&&watches[m.nonce]){delete watches[m.nonce];await saveReturnWatches(watches);}return {watching:Object.keys(watches).length};}
 throw Error('Unknown return watch action.');
}
if(typeof chrome!=='undefined'&&chrome.runtime?.onMessage&&chrome.alarms?.onAlarm){
 chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.channel!=='xmr20-return-watch'||sender.id!==chrome.runtime.id||sender.url?.split('?')[0]!==chrome.runtime.getURL('popup.html'))return;
  handleReturnWatch(message).then(value=>reply({value}),error=>reply({error:error.message}));return true;
 });
 chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===RETURN_WATCH_ALARM)void checkReturnWatches().catch(()=>{});});
 chrome.notifications?.onClicked?.addListener(id=>{if(String(id).startsWith('xmr20-return-')){chrome.notifications.clear(id);void chrome.tabs.create({url:chrome.runtime.getURL('popup.html')});}});
}
