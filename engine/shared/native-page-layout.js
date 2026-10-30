// Keep the review body scrollable while progress, errors and actions stay in view.
// All controls remain inside content so the existing review/recovery handlers
// keep their scope. Rendering a new step always replaces the previous actions.
export function createNativePageLayout(root, client) {
 const content=root.querySelector('.native-send-content');
 const message=root.querySelector('.native-send-message'),error=root.querySelector('.native-send-error');
 const scroll=document.createElement('div'),body=document.createElement('div'),footer=document.createElement('div');
 scroll.className='native-send-scroll';body.className='native-send-fields';footer.className='native-send-footer';
 for(const el of root.querySelectorAll('.native-token-mark,.native-send-network'))scroll.append(el);
 scroll.append(body);
 const disclosure=root.querySelector('.native-send-disclosure');if(disclosure)scroll.append(disclosure);
 footer.append(message,error);content.replaceChildren(scroll,footer);
 let busy=false,waiting=false,timer,started=0,labels=new Map();
 const elapsed=document.createElement('span');elapsed.className='native-send-elapsed';elapsed.hidden=true;footer.prepend(elapsed);
 function activity(){
  clearInterval(timer);elapsed.hidden=!busy&&!waiting;
  if(busy){started=Date.now();elapsed.textContent='Working…';timer=setInterval(()=>{
   elapsed.textContent=Math.floor((Date.now()-started)/1000)+'s · You can go Back.';
  },1000);}else if(waiting)elapsed.textContent='Waiting for the network…';
 }
 function controls(updateLabels=false){
  content.querySelectorAll('button,input,textarea,select').forEach(el=>{
   // Closing revokes the host and terminates the worker; it never submits work.
   // A direction switch only reopens the other screen, so it stays usable too.
   if(el.matches('[data-cancel],[data-switch]'))return;
   el.disabled=busy||el.dataset.disabled==='true';
  });
  if(updateLabels)for(const button of footer.querySelectorAll('.native-send-actions .native-primary')){
   if(busy){if(!labels.has(button))labels.set(button,button.textContent);button.textContent=button.matches('[data-next],[data-review]')?'Checking…':'Working…';}
	   else if(labels.has(button)){
	    // A completed request may render a new state while the page is still
	    // marked busy. Keep that state-specific label instead of restoring the
	    // label captured before the request finished.
	    if(['Working…','Checking…'].includes(button.textContent))button.textContent=labels.get(button);
	    labels.delete(button);
	   }
  }
 }
 const unsubscribe=client?.subscribeProgress?.(value=>{
  if(busy&&typeof value==='string'&&value.length<=240)message.textContent=value;
 });
 return {
  render(html){
   footer.querySelector('.native-send-actions')?.remove();footer.querySelector('.native-action-terms')?.remove();labels.clear();
   body.innerHTML=html;
   let actions=body.querySelector(':scope > .native-send-actions');
   if(!actions){
    const buttons=[...body.querySelectorAll(':scope > button')];
    if(buttons.length){actions=document.createElement('div');actions.className='native-send-actions';actions.append(...buttons);}
   }
   const terms=body.querySelector('.native-action-terms');if(terms)footer.append(terms);if(actions)footer.append(actions);
   scroll.scrollTop=0;controls(true);
  },
  append(node){body.append(node);controls();},
  setBusy(value){
   busy=value;root.setAttribute('aria-busy',String(value));activity();
   controls(true);
  },
  setWaiting(value){waiting=Boolean(value);if(!busy)activity();},
  close(){clearInterval(timer);unsubscribe?.();}
 };
}
