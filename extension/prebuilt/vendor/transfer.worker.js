/* Offline native Monero signing. No RPC, storage, telemetry or generic signing.
 * Worker HTTP CSP permits local scripts/WASM and denies network connections.
 */
'use strict';
let running=false;
const fail=()=>{throw Error('Approval failed');};
const canonical=r=>'{'+Object.keys(r).sort().map(k=>JSON.stringify(k)+':'+JSON.stringify(r[k])).join(',')+'}';
self.onmessage=async({data})=>{
  if(running||typeof data?.id!=='string')return;
  running=true;
  let m,p;
  try{
    if(!self.isSecureContext||!self.crypto?.getRandomValues||data.action!=='signTransfer')fail();
    const {review}=data;
    if(!review||review.network!=='mainnet'||typeof review.message!=='string'||review.message.length>2000)fail();
    const prefix='MOUSE-ROAD-XMR20-MAINNET-TRANSFER-V1\n';
    if(!review.message.startsWith(prefix))fail();
    const r=JSON.parse(review.message.slice(prefix.length));
    if(Object.keys(r).sort().join(',')!=='amount,net,nonce,op,owner,p,to,token,v'||prefix+canonical(r)!==review.message||r.v!==1||r.op!=='transfer'||r.net!==review.network||r.p!==(review.network==='mainnet'?'xmr20':'xmr20-bridge-test')||r.owner!==review.address||r.to!==review.destination||r.amount!==review.amountRaw||r.token!==review.token||r.nonce!==review.nonce||!/^([a-f0-9]{64})$/.test(r.token)||!/^([a-f0-9]{32})$/.test(r.nonce)||!/^([1-9][0-9]{0,15})$/.test(r.amount)||BigInt(r.amount)>50000000000000n||!/^4[1-9A-HJ-NP-Za-km-z]{94}$/.test(r.to)||r.to===r.owner)fail();
    if(typeof data.seed!=='string'||data.seed.length>500||data.seed.trim().split(/\s+/).length!==25)fail();
    importScripts('./monero-0.11.16.js');
    m=await monero_ts({print:()=>{},printErr:()=>{}});
    p=await new Promise((resolve,reject)=>m.create_full_wallet(JSON.stringify({networkType:review.network==='mainnet'?0:2,seed:data.seed.trim().toLowerCase().replace(/\s+/g,' '),seedOffset:'',path:'',password:'',restoreHeight:0}), 'offline-transfer', value=>typeof value==='number'&&value>0?resolve(value):reject(Error('Restore failed'))));
    data.seed='';
    if(m.get_address(p,0,0)!==review.address) {self.postMessage({id:data.id,error:'wrong_wallet'});return;}
    const signature=m.sign_message(p,review.message,0,0,0);
    const proof=JSON.parse(m.verify_message(p,review.message,review.address,signature));
    if(!/^SigV2[1-9A-HJ-NP-Za-km-z]{80,110}$/.test(signature)||!proof.isGood||proof.isOld||proof.version!==2||proof.signatureType!=='spend')fail();
    self.postMessage({id:data.id,result:{signature}});
  }catch{
    // Native errors can contain recovery material. Never expose them.
    self.postMessage({id:data.id,error:'sign_failed'});
  }finally{
    data.seed='';
    if(m&&p)await new Promise(resolve=>m.close(p,false,0,()=>resolve()));
    self.close?.();
  }
};
