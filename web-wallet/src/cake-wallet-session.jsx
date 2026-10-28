import {useEffect,useRef,useState} from 'react';
import {createCakeConnection,emptyCakeState} from './cake-wallet-client.js';

export function useCakeConnection(enabled){
  const [state,setState]=useState(emptyCakeState),client=useRef(null);
  useEffect(()=>{
    if(!enabled)return;
    const c=createCakeConnection({onChange:setState});client.current=c;void c.sync();
    const sync=()=>{if(!document.hidden)void c.sync();};
    const refresh=setInterval(sync,15000),clock=setInterval(()=>c.tick(),1000);
    window.addEventListener('focus',sync);document.addEventListener('visibilitychange',sync);
    return()=>{clearInterval(refresh);clearInterval(clock);window.removeEventListener('focus',sync);document.removeEventListener('visibilitychange',sync);c.dispose();client.current=null;};
  },[enabled]);
  return {...state,setAddress:value=>client.current?.setAddress(value),issue:()=>client.current?.issue(),verify:value=>client.current?.verify(value),lookup:()=>client.current?.lookup(),disconnect:()=>client.current?.disconnect()};
}
