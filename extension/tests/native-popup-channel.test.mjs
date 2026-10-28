import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativePopupChannel,attachNativePopupPorts,NATIVE_POPUP_PORT} from '../src/native-popup-channel.js';

const event=()=>{const listeners=[];return {addListener:f=>listeners.push(f),emit:(...args)=>listeners.forEach(f=>f(...args))};};
function fixture(sender={}){
 const onConnect=event(),runtime={id:'fixture',getURL:p=>'chrome-extension://fixture/'+p,onConnect};
 const calls=[],revoked=[],client={onMessage:event(),onDisconnect:event()},server={name:NATIVE_POPUP_PORT,sender:{id:runtime.id,url:runtime.getURL('popup.html'),...sender},onMessage:event(),onDisconnect:event()};
 let connected=false,disconnected=false;
 const disconnect=()=>{if(disconnected)return;disconnected=true;server.onDisconnect.emit();client.onDisconnect.emit();};
 Object.assign(client,{disconnect,postMessage:m=>server.onMessage.emit(m)});
 Object.assign(server,{disconnect,postMessage:m=>client.onMessage.emit(m)});
 runtime.connect=({name})=>{server.name=name;connected=true;onConnect.emit(server);return client;};
 const ports=attachNativePopupPorts({chrome:{runtime},uuid:()=> 'background-generated-id',dispatch:async(m,s)=>{calls.push({m,s});return {ok:true};},revoke:async id=>revoked.push(id)});
 return {runtime,calls,revoked,client,server,ports,disconnect,isConnected:()=>connected&&!disconnected};
}
const message={channel:'xmr20-site-approval',action:'openNativeSend'};
test('toolbar port works without tab/document metadata and binds requests to a background-generated lifetime',async()=>{
 const f=fixture(),channel=createNativePopupChannel(f.runtime);
 assert.deepEqual(await channel.sendMessage({...message,nativePopupId:'spoof'}),{value:{ok:true}});
 assert.equal(f.calls[0].s.nativePopupId,'background-generated-id');
 assert.equal(f.ports.has('background-generated-id'),true);
 channel.close();channel.close();
 assert.equal(f.ports.has('background-generated-id'),false);
 assert.deepEqual(f.revoked,['background-generated-id']);
 await assert.rejects(channel.sendMessage(message),/closed/);
});
test('foreign pages, child frames and ambiguous tab frames cannot connect a native popup port',()=>{
 for(const sender of [{id:'foreign'},{url:'https://example.org'},{url:'chrome-extension://fixture/market.html'},{frameId:1},{tab:{id:1}}]){
  const f=fixture(sender);f.runtime.connect({name:NATIVE_POPUP_PORT});
  assert.equal(f.isConnected(),false);assert.equal(f.ports.has('background-generated-id'),false);
 }
});
test('unexpected actions are rejected on both sides and disconnect rejects pending calls',async()=>{
 const f=fixture(),channel=createNativePopupChannel(f.runtime);
 await assert.rejects(channel.sendMessage({...message,action:'approve'}),/Unsupported/);
 const pending=channel.sendMessage(message);f.disconnect();
 await assert.rejects(pending,/closed/);
 const g=fixture();g.runtime.connect({name:NATIVE_POPUP_PORT});
 g.server.onMessage.emit({id:'x',message:{...message,action:'approve'}});
 assert.equal(g.isConnected(),false);assert.equal(g.calls.length,0);
});
