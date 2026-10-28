import React,{useEffect,useState} from 'react';

export default function CopyRecoveryPhrase({seed,disabled=false}){
 const [status,setStatus]=useState('');
 useEffect(()=>setStatus(''),[seed]);
 async function copy(){
  if(disabled||!seed)return;
  try{
   await navigator.clipboard.writeText(seed.trim().split(/\s+/).join(' '));
   setStatus('Recovery phrase copied — words only.');
  }catch{setStatus('Could not copy. Please try again.');}
 }
 return <div className="wallet-phrase-copy"><button type="button" disabled={disabled||!seed} onClick={copy}>Copy recovery phrase</button><small role="status" aria-live="polite">{status||'Copies all 25 words in order, without numbers.'}</small></div>;
}
