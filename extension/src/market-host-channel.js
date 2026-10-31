// MONERO MARKET candidate (29 Oct 2026): the runtime port between the background and the wallet's packaged market window
// (market-wallet.html). The website never reaches this port: its `market` requests enter through onMessageExternal, the
// site broker checks the grant and the bound window, and only then forwards the bounded {method,id,body} here. Replies go
// back the same way. One port per market window; a reply arrives only while that window is open.
export const MARKET_HOST_PORT='xmr20-market-host';
export const isMarketWallet=(sender,runtime)=>sender?.id===runtime.id&&sender.url?.split('?')[0]===runtime.getURL('market-wallet.html')&&sender.frameId===0&&Number.isInteger(sender.tab?.id);
// Background side. `bind(requestId,sender)` must say whether this window is the one the broker opened for that request.
export function attachMarketHostPorts({chrome,bind,uuid=()=>crypto.randomUUID()}){
 const hosts=new Map();
 chrome.runtime.onConnect.addListener(port=>{
  if(port.name!==MARKET_HOST_PORT)return;// the native popup port has its own listener
  if(!isMarketWallet(port.sender,chrome.runtime)){try{port.disconnect();}catch{}return;}
  const requestId=new URL(port.sender.url).searchParams.get('request');
  Promise.resolve().then(()=>bind(requestId,port.sender)).then(ok=>{
   if(ok!==true)throw Error('unbound');
   const entry={port,pending:new Map()};hosts.set(requestId,entry);
   port.onMessage.addListener(m=>{const p=typeof m?.id==='string'?entry.pending.get(m.id):null;if(!p)return;entry.pending.delete(m.id);clearTimeout(p.timer);p.resolve(m.reply&&typeof m.reply==='object'?m.reply:{error:'Malformed wallet reply.'});});
   port.onDisconnect.addListener(()=>{if(hosts.get(requestId)===entry)hosts.delete(requestId);for(const p of entry.pending.values()){clearTimeout(p.timer);p.resolve({error:'The XMR20 Wallet market window closed.'});}entry.pending.clear();});
   try{port.postMessage({bound:true});}catch{}
  }).catch(()=>{try{port.disconnect();}catch{}});
 });
 return {
  has:id=>hosts.has(id),
  request(id,message,timeoutMs=30000){
   const e=hosts.get(id);if(!e)return Promise.resolve({error:'Open the market in XMR20 Wallet first (the wallet window is not open).'});
   return new Promise(resolve=>{const mid=uuid();const timer=setTimeout(()=>{e.pending.delete(mid);resolve({error:'The XMR20 Wallet market window did not answer.'});},timeoutMs);e.pending.set(mid,{resolve,timer});
    try{e.port.postMessage({id:mid,message});}catch{clearTimeout(timer);e.pending.delete(mid);resolve({error:'The XMR20 Wallet market window closed.'});}});
  }
 };
}
// Window side: answer forwarded requests; reconnect if the background restarts (its RAM map is rebuilt from the bound window).
export function serveMarketHost({runtime=chrome.runtime,handle,onBound=()=>{},onLost=()=>{}}){
 let port=null,closed=false,delay=500;
 function connect(){
  if(closed)return;
  try{port=runtime.connect({name:MARKET_HOST_PORT});}catch{port=null;setTimeout(connect,delay=Math.min(delay*2,8000));return;}
  port.onMessage.addListener(async m=>{
   if(m?.bound===true){delay=500;onBound();return;}
   if(typeof m?.id!=='string')return;let reply;
   try{reply={value:await handle(m.message)};}catch(e){reply={error:String(e?.message||e).slice(0,300),status:Number.isInteger(e?.status)?e.status:500};}
   try{port.postMessage({id:m.id,reply});}catch{}
  });
  port.onDisconnect.addListener(()=>{port=null;onLost();if(!closed)setTimeout(connect,delay=Math.min(delay*2,8000));});
 }
 connect();
 return {close(){closed=true;try{port?.disconnect();}catch{}}};
}
