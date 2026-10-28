// Feedback follows real requests. No artificial percentage or simulated stages.
export function jointProgress({document:doc=globalThis.document,now=()=>performance.now(),setTimer=setInterval,clearTimer=clearInterval,isCurrent,changed}={}){
 let timer=null,started=0,stage='';
 const update=()=>{if(!isCurrent()){stop();return;}const el=doc.getElementById('joint-elapsed');if(el&&!doc.hidden)el.textContent=`${Math.floor((now()-started)/1000)}s`;const row=doc.getElementById('progress');if(row)row.dataset.paused=String(doc.hidden);};
 function stop(){if(timer!==null)clearTimer(timer);timer=null;stage='';doc.removeEventListener('visibilitychange',update);}
 return {start(text){stop();stage=text;started=now();timer=setTimer(update,1000);doc.addEventListener('visibilitychange',update);changed?.();},stage(text){stage=text;const label=doc.getElementById('joint-stage');if(label)label.textContent=text;},stop,render(esc){return timer===null?'':`<span id="joint-stage">${esc(stage)}</span><span id="joint-elapsed" class="joint-elapsed" aria-hidden="true">${Math.floor((now()-started)/1000)}s</span>`;},update};
}
