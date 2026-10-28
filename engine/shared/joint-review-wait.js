// Explanations only: elapsed time never enables approval or implies completed checks.
const messages = [
  'Confirming the exact review with the bridge…',
  'This is usually the longest preparation step.',
  'The bridge checks confirmed history on both networks and verifies your exact amount, fee and destination.',
  'Please keep this panel open. The approval button becomes available when the review is ready.',
];
const overdue = 'This is taking longer than estimated. The review is still pending; no approval is needed yet.';

export function createReviewWait({getElement,isCurrent,now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout,reducedMotion=()=>globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches??false}){
  let key=null,started=0,timer=null,animation=null,generation=0,node=null,target=null;
  function cancelAnimation(){generation++;animation?.cancel();animation=null;}
  function stop(){if(timer!==null)clearTimer(timer);timer=null;key=null;cancelAnimation();node=null;target=null;}
  function show(el,text){
    if(node===el&&target===text)return;
    const fade=node===el&&typeof el.animate==='function'&&!reducedMotion();
    cancelAnimation();node=el;target=text;
    if(!fade){el.textContent=text;return;}
    const version=generation;
    animation=el.animate([{opacity:1},{opacity:0}],{duration:150,fill:'forwards'});
    animation.onfinish=()=>{
      if(version!==generation||!key||!isCurrent()||getElement()!==el)return;
      animation.cancel();el.textContent=text;
      animation=el.animate([{opacity:0},{opacity:1}],{duration:200});
      animation.onfinish=()=>{if(version===generation)animation=null;};
    };
  }
  function update(){
    if(!key)return;
    if(!isCurrent()){stop();return;}
    const el=getElement();
    if(!el){stop();return;}
    const elapsed=Math.max(0,now()-started),step=Math.floor(elapsed/5000);
    // Continue rotating; acknowledge an exceeded estimate instead of claiming progress.
    show(el,step>=8&&step%messages.length===0?overdue:messages[step%messages.length]);
    if(timer!==null)clearTimer(timer);
    timer=setTimer(()=>{timer=null;update();},Math.max(1,(step+1)*5000-elapsed));timer?.unref?.();
  }
  return {
    sync(next){
      if(!next){stop();return;}
      if(key!==next){stop();key=next;started=now();}
      update();
    },
    close:stop,
  };
}
