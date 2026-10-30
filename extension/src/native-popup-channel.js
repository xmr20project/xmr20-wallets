// A runtime port identifies one actual popup lifetime even when Chrome omits
// tab/frame/document metadata for action popups.
export const NATIVE_POPUP_PORT='xmr20-native-popup';
export const nativePopupActions=new Set(['openNativeSend','openNativeBridge','openNativeConvert','marketView','marketCheck','marketKeys','marketSignCustody','marketClose']);
export const isWalletPopup=(sender,runtime)=>sender?.id===runtime.id&&sender.url?.split('?')[0]===runtime.getURL('popup.html')&&(sender.frameId===0||sender.frameId===undefined&&sender.tab===undefined);

export function createNativePopupChannel(runtime=chrome.runtime){
 const port=runtime.connect({name:NATIVE_POPUP_PORT}),pending=new Map();let closed=false;
 function close(){
  if(closed)return;closed=true;port.disconnect();
  for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Wallet popup closed.'));}pending.clear();
 }
 port.onDisconnect.addListener(close);
 port.onMessage.addListener(response=>{
  const item=pending.get(response?.id);if(!item)return;
  pending.delete(response.id);clearTimeout(item.timer);item.resolve(response.reply);
 });
 return {
  getURL:path=>runtime.getURL(path),
  sendMessage(message){
   if(closed)return Promise.reject(Error('Wallet popup closed.'));
   if(message?.channel!=='xmr20-site-approval'||!nativePopupActions.has(message.action))return Promise.reject(Error('Unsupported Monero wallet action.'));
   return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Error('Wallet request timed out. Reopen to check saved recovery.'));},180000);
    pending.set(id,{resolve,reject,timer});
    try{port.postMessage({id,message});}catch{close();}
   });
  },
  close
 };
}

export function attachNativePopupPorts({chrome,dispatch,revoke,uuid=()=>crypto.randomUUID()}){
 const live=new Set();
 chrome.runtime.onConnect.addListener(port=>{
  if(port.name!==NATIVE_POPUP_PORT||!isWalletPopup(port.sender,chrome.runtime)){port.disconnect();return;}
  const id=uuid(),sender={...port.sender,nativePopupId:id};live.add(id);
  port.onDisconnect.addListener(()=>{live.delete(id);void Promise.resolve(revoke(id)).catch(()=>{});});
  port.onMessage.addListener(envelope=>{
   if(!live.has(id))return;
   if(typeof envelope?.id!=='string'||envelope.id.length>64||envelope.message?.channel!=='xmr20-site-approval'||!nativePopupActions.has(envelope.message.action)){port.disconnect();return;}
   void dispatch(envelope.message,sender).then(value=>({value}),e=>({error:e.message})).then(reply=>{
    if(live.has(id))try{port.postMessage({id:envelope.id,reply});}catch{port.disconnect();}
   });
  });
 });
 return {has:id=>live.has(id)};
}
