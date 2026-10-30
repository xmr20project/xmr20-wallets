import React,{useEffect,useRef,useState} from 'react';
import {Connection} from '@solana/web3.js';
import {createJointTransferableUI} from '../../engine/shared/joint-transferable-ui.js';
import {solanaTokenMaximum} from '../../engine/shared/solana-max.js';
import {moneroWalletVault} from './monero-wallet-vault.js';
import {oneShotJointWorker} from './joint-mainnet-signing.js';
import {websiteBridgeProvider,websiteMoneroSigner} from './transferable-wallet-adapter.js';
import WalletImport from './wallet-import.jsx';
import '../../engine/shared/joint-transferable.css';
import './transferable-wallet.css';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export default function TransferableWalletBridge({owner,provider,pair,row,network,kind='bridge',bridgeRows=[],refreshHoldings,onClose,onLegacy}){
 const target=useRef(null),controller=useRef(null),live=useRef(null),[revision,setRevision]=useState(0),[recover,setRecover]=useState(false);
 live.current={owner,address:pair?.address,bridgeRows,refreshHoldings,onLegacy,onClose};
 const address=pair?.address,hasKey=!!address&&moneroWalletVault().has({owner,network:'mainnet',address});
 useEffect(()=>{
  if(!hasKey||recover||!target.current)return;let active=true,busy=0;const host=target.current,modal={open:true},account={id:owner+':'+address,sol:owner,xmr:address};
  const assert=()=>{if(!active||!modal.open||!host.isConnected)throw Error('Bridge closed. Your saved approvals are kept.');provider.assertCurrent?.();if(provider.publicKey?.toBase58()!==owner)throw Error('Wallet changed. Reconnect the original account.');};
  const rpc=new Connection(location.origin+'/api/bridge-solana-read','finalized');
  const ui=createJointTransferableUI({modal,externalWallet:true,esc,account:()=>account,canSign:()=>active&&hasKey,same:assert,rows:()=>live.current.owner===owner&&live.current.address===address?live.current.bridgeRows:[],refreshHoldings:()=>{assert();return live.current.refreshHoldings?.();},rpcEndpoint:location.origin+'/api/bridge-solana-read',tokenBalance:(o,m)=>solanaTokenMaximum(o,m,{rpc}),provider:guard=>websiteBridgeProvider(provider,owner,guard),signMonero:websiteMoneroSigner({provider,owner,address,assert}),oneShot:(_file,action,args)=>oneShotJointWorker(action,args,{workerFactory:()=>new Worker('/wallet/monero-wallet/joint-transferable.worker.js')}),isBusy:()=>busy>0,
   getElement:id=>host.querySelector('#'+id),show:(_title,html)=>{if(active)host.innerHTML=html;},on:(id,fn)=>{const element=host.querySelector('#'+id);if(element)element.onclick=fn;},run:async fn=>{busy++;try{await fn(0);}catch(e){if(active){const p=document.createElement('p');p.setAttribute('role','alert');p.textContent=e.message;host.append(p);}}finally{busy--;}}
  },{walletTest:true,endpoint:'',snapshotShareKey:location.origin,legacy:()=>{
   if(row?.mint){live.current.onLegacy?.();return;}
   if(!active)return;host.innerHTML='<p>To withdraw an earlier balance, open the Monero tab and choose Bridge beside that token.</p><button type="button" id="legacy-wallet-back">Back to wallet</button>';
   host.querySelector('#legacy-wallet-back').onclick=()=>live.current.onClose?.();
  }});
  controller.current=ui;
  void ui.open({mint:row?.mint,rows:row?.mint?[{...row,network}]:[],direction:row?.mint?(kind==='send'?'xmr-to-xmr':network==='monero'?'xmr-to-sol':'sol-to-xmr'):undefined});
  const changed=()=>{active=false;modal.open=false;ui.clear();};provider.on?.('accountChanged',changed);provider.on?.('disconnect',changed);
  return()=>{changed();if(controller.current===ui)controller.current=null;provider.removeListener?.('accountChanged',changed);provider.removeListener?.('disconnect',changed);};
 },[owner,address,provider,row?.mint,hasKey,recover,revision,network,kind]);
 // Portfolio updates change choices in-place; they must not reopen the flow,
 // discard an entered amount or cancel a saved approval being reconciled.
 useEffect(()=>{controller.current?.refreshAssets();},[bridgeRows]);
 return <section className="wallet-action-sheet website-transferable" aria-label="Bridge"><div className="wallet-action-head"><strong>Bridge</strong><button type="button" aria-label="Close bridge" onClick={onClose}>×</button></div>
 {!address?<p>Set up your Monero wallet in the Monero tab, then open Bridge again.</p>:!hasKey||recover?<><p>Recover your linked Monero wallet on this browser to approve bridge records. Solana approvals stay in your connected wallet.</p><code className="address">{address}</code><WalletImport owner={owner} provider={provider} onImport={r=>{if(r.address!==address)throw Error('Import the linked Monero wallet shown above.');setRecover(false);setRevision(n=>n+1);}} onClose={onClose}/></>:<div ref={target}/>}
 </section>;
}
