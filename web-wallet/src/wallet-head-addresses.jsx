// 28 Oct 2026 (owner: "on the monero wallet tab, can we show the private wallet at the top right … label it normal and private
// above the wallet address, so you hover over it to copy and paste"): the wallet header's Monero address and, once Sync has
// opened the token wallet, its private address (xmr20p1…), side by side. Each is copied with a click; Copy shows on hover.
import React,{useState} from 'react';
import {Copy,Check} from 'lucide-react';

function HeadAddress({label,value,short,pending}){
 const [copied,setCopied]=useState(false);
 if(!value)return <span className="wallet-head-col pending"><span className="wallet-kicker">{label}</span><span className="wallet-head-value">{pending}</span></span>;
 return <button type="button" className="wallet-head-col" title={value} aria-label={`Copy ${label.toLowerCase()} address`} onClick={()=>void navigator.clipboard.writeText(value).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1600);}).catch(()=>{})}>
  <span className="wallet-kicker">{label}<em>{copied?<Check aria-hidden="true"/>:<Copy aria-hidden="true"/>}{copied?'Copied':'Copy'}</em></span><span className="wallet-head-value">{short(value)}</span></button>;
}

// privateAddress: the xmr20p1… address, or null; opening: the token wallet is opening for this Monero wallet.
export default function WalletHeadAddresses({address,privateAddress,opening}){
 return <h2 className="wallet-head-pair"><HeadAddress label="Normal" value={address} short={a=>a.slice(0,5)+'…'+a.slice(-5)}/>
  <HeadAddress label="Private" value={privateAddress} short={a=>a.slice(0,7)+'…'+a.slice(-5)} pending={opening?'Opening…':'Sync to show'}/></h2>;
}
