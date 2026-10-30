// Same-origin, manual Cake ownership proof. No wallet import, signing or writes
// to the token index. Ownership grants only a read-only address connection.
const API='/__cake';
export const emptyCakeState=()=>({address:'',challenge:null,proof:null,snapshot:null,busy:false,error:'',notice:''});
export function createCakeConnection({fetcher=fetch,now=Date.now,onChange=()=>{}}={}){
  let state=emptyCakeState(),csrf='',revision=0,readingState=false,disposed=false,initial=true;
  const controllers=new Set();
  const currentProof=p=>p?.address===state.address&&p.signatureVersion===2&&p.signatureType==='spend'&&Number.isFinite(p.verifiedAt)&&p.verifiedAt<=now()&&Number.isFinite(p.expiresAt)&&p.expiresAt>now()?p:null;
  function emit(){if(state.proof&&!currentProof(state.proof))state={...state,proof:null};if(!disposed)onChange({...state});}
  async function request(path,body){
    const controller=new AbortController();controllers.add(controller);
    try{
      const r=await fetcher(API+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:body===undefined?{}:{'Content-Type':'application/json','X-Poc-CSRF':csrf},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(path==='/holdings'?55000:15000)])});
      const result=await r.json();if(!r.ok)throw Error(result.error||'Cake connection unavailable.');return result;
    }finally{controllers.delete(controller);}
  }
  function acceptServer(s){
    csrf=s.csrf||csrf;
    if(initial){state.address=s.challenge?.address||s.proof?.address||s.snapshot?.address||state.address;initial=false;}
    const challenge=s.challenge?.address===state.address?s.challenge:null;
    state={...state,challenge,proof:challenge?currentProof(s.proof):null,snapshot:s.snapshot?.address===state.address?s.snapshot:null};emit();
  }
  async function sync(){
    if(disposed||state.busy||readingState)return;
    readingState=true;const started=revision;
    try{const s=await request('/state');if(started===revision&&!state.busy&&!disposed)acceptServer(s);}
    catch{if(started===revision&&!disposed){state={...state,proof:null,error:'The wallet connection is unavailable. Ownership is unverified. Please try again.'};emit();}}
    finally{readingState=false;}
  }
  async function action(work){
    if(disposed||state.busy)return false;
    const started=++revision;state={...state,busy:true,error:'',notice:''};emit();
    try{await work(started);return true;}
    catch(e){if(started===revision&&!disposed)state={...state,error:e.name==='TimeoutError'?'The connection timed out. Retry the lookup or generate a fresh challenge.':e.message||'Local Cake connection unavailable.'};return false;}
    finally{if(started===revision&&!disposed){state={...state,busy:false};emit();}}
  }
  async function loadHoldings(started){
    const address=state.address;state={...state,notice:'Reading the public index…'};emit();
    try{
      const r=await request('/holdings',{address});
      if(started!==revision||disposed||address!==state.address)return;
      if(r.snapshot?.address!==address)throw Error('The index returned a different address.');
      state={...state,snapshot:r.snapshot,proof:state.challenge?currentProof(r.proof):null,notice:''};
    }catch(e){if(started===revision&&!disposed)state={...state,notice:'',error:e.message||'The public index is unavailable. No new balance was established.'};}
  }
  return {
    getState:()=>({...state,proof:currentProof(state.proof)}),sync,tick:emit,
    setAddress(value){
      if(state.busy||disposed)return;
      revision++;initial=false;state={...state,address:value.trim(),challenge:null,proof:null,snapshot:null,error:'',notice:''};emit();
    },
    issue:()=>action(async started=>{
      const r=await request('/challenge',{address:state.address});
      if(started===revision&&!disposed)state={...state,challenge:r.challenge,proof:null,error:'',notice:''};
    }),
    verify:signature=>action(async started=>{
      if(!state.challenge)throw Error('Generate an ownership challenge first.');
      const r=await request('/verify',{id:state.challenge.id,signature});
      if(started!==revision||disposed)return;
      const proof=currentProof(r.proof);if(!proof)throw Error('The returned ownership proof does not match this address or has expired.');
      state={...state,proof};emit();await loadHoldings(started);
    }),
    lookup:()=>action(loadHoldings),
    disconnect:()=>action(async started=>{await request('/reset',{});if(started===revision&&!disposed)state={...emptyCakeState(),busy:true};}),
    dispose(){disposed=true;revision++;for(const controller of controllers)controller.abort();controllers.clear();}
  };
}
