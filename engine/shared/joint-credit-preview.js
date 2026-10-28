// Read-only preparation. Typing, opening or refreshing never signs a transaction.
// Coalesce edits while a slow request finishes; obsolete replies cannot be used.
export function createJointCreditPreview({prepare,changed,isCurrent,setTimer=setTimeout,clearTimer=clearTimeout,delay=600}){
 let timer=null,closed=false,running=false,revision=0,wanted=null,wantedKey=null;
 let state={status:'empty',input:null,value:null,error:''};
 const key=input=>input===null?null:JSON.stringify(input);
 const publish=()=>{if(!closed&&isCurrent())changed(state);};
 async function start(){
  timer=null;if(closed||running||!wanted||!isCurrent())return;
  const version=revision,input=structuredClone(wanted);running=true;
  try{const value=await prepare(input);if(!closed&&version===revision&&isCurrent()){state={status:'ready',input,value,error:''};}}
  catch(e){if(!closed&&version===revision&&isCurrent())state={status:'error',input,value:null,error:e.message||'The amount could not be checked.',...(e?.code==='index-sync'?{errorCode:'index-sync'}:{})};}
  finally{running=false;if(!closed&&isCurrent()){publish();if(version!==revision&&wanted)schedule(0);}}
 }
 function schedule(wait=delay){clearTimer(timer);timer=setTimer(start,wait);timer?.unref?.();}
 return {
  get state(){return state;},get running(){return running;},
  request(input){if(closed)return;const next=key(input);if(next===wantedKey){if(input&&state.status==='loading'&&!running&&timer===null)schedule();return;}revision++;wanted=input?structuredClone(input):null;wantedKey=next;clearTimer(timer);timer=null;state={status:input?'loading':'empty',input,value:null,error:''};publish();if(input&&!running)schedule();},
  pause(){clearTimer(timer);timer=null;},
  matches(input){return !closed&&!running&&state.status==='ready'&&key(input)===wantedKey;},
  retry(){if(closed||running||!wanted)return;revision++;state={status:'loading',input:wanted,value:null,error:''};publish();schedule(0);},
  close(){closed=true;revision++;clearTimer(timer);wanted=null;state={status:'empty',input:null,value:null,error:''};}
 };
}
