// MONERO MARKET candidate (30 Oct 2026): the background side of "My wallet approves (while open)". While the wallet is
// unlocked and the active account has open market work (the market host publishes a count under MARKET_ACTIVE_KEY), an
// offscreen document (market-runner.html) runs the same market host as the market window: buyers are answered and sales of
// 'auto' listings are approved with every wallet window closed. While that count is fresh and non-zero the session is touched,
// so the wallet does not auto-lock; locking it (or switching account) closes the runner. Offscreen documents only have
// chrome.runtime: the runner's keys, journal storage and count go through the messages below, accepted from that document only.
export const MARKET_HOST_LOCK='xmr20-market-host',MARKET_ACTIVE_KEY='xmr20-market-active',RUNNER_PAGE='market-runner.html',RUNNER_STATUS_KEY='xmr20-market-runner-status';
const FRESH=3*60000,JOURNAL_KEYS=new Set(['xmr20-market-journal','xmr20-market-journal-salt']);
export function attachMarketRunner({chrome,controller,readVault,serial}){
 const url=chrome.runtime.getURL(RUNNER_PAGE);
 const documents=()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[url]});
 const hintFor=async s=>(await chrome.storage.local.get(MARKET_ACTIVE_KEY))[MARKET_ACTIVE_KEY]?.[s.activeId]||null;
 // Start the runner for any recorded work (it re-counts from the journal and reports 0 when there is none); keep the wallet
 // unlocked only on a fresh report, so a stale count can never hold it open.
 const ensure=()=>serial(async()=>{
  const s=await controller.read(),hint=s?await hintFor(s):null,on=(await documents()).length>0;
  if(s&&hint?.count>0){
   if(Date.now()-hint.at<FRESH)await controller.handle({action:'touch',id:s.id});
   if(!on)await chrome.offscreen.createDocument({url:RUNNER_PAGE,reasons:['WORKERS'],justification:'Answers buyers of your Monero Market listings while the wallet is unlocked.'});
  }else if(on)await chrome.offscreen.closeDocument();
 }).catch(e=>console.warn('[market runner]',e?.message||e));
 async function current(m){
  const s=await controller.read();
  if(!s||s.id!==m.sessionId||s.activeId!==m.accountId)throw Error('Wallet locked or account changed.');
  return s;
 }
 async function handle(m){
  if(m.action==='open'){
   const s=await controller.read();if(!s)throw Error('Wallet locked.');
   const a=(await readVault(s)).accounts.find(a=>a.id===s.activeId);
   if(!a?.xmrSeed||a.watch)throw Error('This account has no Monero keys in this wallet.');
   return {seed:a.xmrSeed,address:a.xmr,accountId:a.id,accountName:a.name,sessionId:s.id};
  }
  if(m.action==='check'){await current(m);return true;}
  // What the runner is doing (session storage, RAM only): shown to the wallet and read by tests. No secrets, bounded text.
  if(m.action==='status'){await chrome.storage.session.set({[RUNNER_STATUS_KEY]:{state:String(m.state).slice(0,20),detail:String(m.detail??'').slice(0,300),ticks:Number.isSafeInteger(m.ticks)?m.ticks:0,at:Date.now()}});return true;}
  if(m.action==='store'){
   await current(m);if(!JOURNAL_KEYS.has(m.key))throw Error('Not a market journal key.');
   if(m.op==='get')return (await chrome.storage.local.get(m.key))[m.key]??null;
   if(m.op==='set'){await chrome.storage.local.set({[m.key]:m.value});return true;}
   throw Error('Unsupported store operation.');
  }
  if(m.action==='activity'){
   await current(m);if(!Number.isSafeInteger(m.count)||m.count<0)throw Error('Bad count.');
   const all=(await chrome.storage.local.get(MARKET_ACTIVE_KEY))[MARKET_ACTIVE_KEY]||{};
   all[m.accountId]={count:m.count,at:Date.now()};await chrome.storage.local.set({[MARKET_ACTIVE_KEY]:all});return true;
  }
  throw Error('Unsupported market runner request.');
 }
 chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(m?.channel!=='xmr20-market-runner')return;
  if(sender.id!==chrome.runtime.id||sender.tab||sender.url?.split('?')[0]!==url){reply({error:'Not the market runner.'});return;}
  // Chrome gives no documentId for offscreen senders: the runner URL without a tab, while exactly one runner exists.
  documents().then(list=>{if(list.length!==1)throw Error('Not the market runner.');
   // Session reads go through the background's queue; journal storage does not need it (the journal holds its own Web Lock).
   return m.action==='store'?handle(m):serial(()=>handle(m));})
   .then(value=>reply({value}),e=>reply({error:e.message}));
  return true;
 });
 chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&(changes[MARKET_ACTIVE_KEY]||changes['xmr20-lock-signal']))void ensure();
  // Ignore the touches this module makes: only unlock, lock and account switches matter.
  const c=area==='session'&&changes['xmr20-unlocked-session'];
  if(c&&(!c.oldValue||!c.newValue||c.oldValue.id!==c.newValue.id||c.oldValue.activeId!==c.newValue.activeId))void ensure();
 });
 chrome.alarms.create('xmr20-market-runner',{periodInMinutes:1});
 chrome.alarms.onAlarm.addListener(a=>{if(a.name==='xmr20-market-runner')void ensure();});
 void ensure();
 return {ensure};
}
