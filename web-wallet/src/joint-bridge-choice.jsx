import React,{useMemo,useState} from 'react';
import JointWalletBridge from './joint-wallet-bridge.jsx';
import {initialBridgeRoute,legacyWithdrawalRequest} from './bridge-route.js';
import './joint-wallet.css';

export default function JointBridgeChoice({renderLegacy,...props}){
 const [route,setRoute]=useState(()=>initialBridgeRoute(props));
 const request=useMemo(()=>legacyWithdrawalRequest(props.request),[props.request]);
 return <div className="joint-bridge-choice">
  <div className="joint-bridge-options" role="group" aria-label="Choose bridge">
   <button type="button" aria-pressed={route==='joint'} onClick={()=>setRoute('joint')}>New bridge</button>
   <button type="button" aria-pressed={route==='legacy'} onClick={()=>setRoute('legacy')}>Legacy bridge</button>
  </div>
  <p className="joint-route-note">{route==='joint'?'Default for new deposits. Existing legacy balances stay in their original bridge.':'Withdraw existing balances or finish a saved transfer.'}</p>
  <p className="joint-route-note">Legacy balances still rely on the old verifier. The new requirement for the original depositing wallet’s approval does not apply to them.</p>
  {route==='joint'?<JointWalletBridge {...props}/>:<>
   <p className="joint-route-notice">{props.network==='monero'?'Monero → Solana · legacy withdrawal':props.resumeId?'Saved legacy transfer · original deposit route':'New legacy deposits are closed. Choose Monero → Solana above to withdraw, or resume your saved transfer from the wallet.'}</p>
   {renderLegacy({...props,request,legacyWithdrawOnly:true})}
  </>}
 </div>;
}
