// Shared by the website's hosted native pages. The wallet frame has a fixed height, so a
// page fills the frame's visible content area and keeps its primary actions on screen.
export function fitWalletPanel(element){
 let scroller=element?.parentElement;
 while(scroller&&!/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))scroller=scroller.parentElement;
 if(!element||!scroller||typeof ResizeObserver==='undefined')return()=>{};
 // The page fills the scroller's visible height minus its own margins and border.
 const fit=()=>{const s=getComputedStyle(element),edge=['marginTop','marginBottom','borderTopWidth','borderBottomWidth'].reduce((n,k)=>n+(parseFloat(s[k])||0),0);
  element.style.setProperty('--wallet-panel-height',Math.max(300,Math.floor(scroller.clientHeight-edge))+'px');};
 fit();const observer=new ResizeObserver(fit);observer.observe(scroller);
 const frame=requestAnimationFrame(()=>element.scrollIntoView?.({block:'start',behavior:'smooth'}));
 return()=>{cancelAnimationFrame(frame);observer.disconnect();};
}
