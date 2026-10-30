// Only one public balance read may run at a time. Poll from completion so a
// slow index cannot accumulate refreshes while the wallet is open.
export function createHoldingsRefresh({read,clear,onReading,onResult,onPartial=()=>{},onError,visible=true,windowTarget=window,documentTarget=document,interval=30000,setTimer=setTimeout,clearTimer=clearTimeout}){
 let active=true,shown=visible,pending=null,timer=null;
 const stopTimer=()=>{if(timer!==null){clearTimer(timer);timer=null;}};
 const canRead=()=>!documentTarget.hidden;
 function schedule(){stopTimer();if(active&&shown&&canRead())timer=setTimer(()=>{timer=null;void refresh({force:false});},interval);}
 // Polls and focus refresh current custody without discarding a recent public
 // history projection. Only an explicit Refresh or mutation event forces it.
 function refresh({force=true}={}){
  if(!active||!canRead())return Promise.resolve(null);
  if(pending)return pending;
  stopTimer();onReading(true);
  const task=Promise.resolve().then(()=>active?read({force,onResult:value=>{if(active)onPartial(value);}}):null).then(result=>{if(active)onResult(result);return result;},()=>{if(active)onError();return null;}).finally(()=>{if(pending===task)pending=null;if(active){onReading(false);schedule();}});
  pending=task;return task;
 }
 const focus=()=>{if(shown)void refresh({force:false});};
 const visibility=()=>{if(canRead())focus();else stopTimer();};
 const manual=()=>{void refresh();};
 windowTarget.addEventListener('focus',focus);
 windowTarget.addEventListener('xmr20-holdings-refresh',manual);
 documentTarget.addEventListener('visibilitychange',visibility);
 // Keep the initial cross-tab portfolio discovery even when the Monero
 // section is collapsed; recurring scans only run while it is visible.
 void refresh({force:false});
 return {
  refresh,
  setVisible(value){if(shown===value)return;shown=value;if(shown)void refresh({force:false});else stopTimer();},
  dispose(){active=false;stopTimer();windowTarget.removeEventListener('focus',focus);windowTarget.removeEventListener('xmr20-holdings-refresh',manual);documentTarget.removeEventListener('visibilitychange',visibility);clear();}
 };
}
