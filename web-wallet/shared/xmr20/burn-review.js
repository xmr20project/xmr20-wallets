import {canonical,DOMAIN,rawAmount} from './protocol.js';
export function burnReview(transfer,{owner,network,token}={}) {
  const message=transfer?.signingMessage;
  const prefix=network==='mainnet'?'MOUSE-ROAD-XMR20-MAINNET-BRIDGE-V1\n':DOMAIN;
  if(!['mainnet','stagenet'].includes(network)||transfer?.direction!=='xmr-to-sol'||transfer.state!=='reserved'||typeof message!=='string'||message.length>2000||!message.startsWith(prefix))throw Error('This transfer is not ready for Monero approval.');
  const r=JSON.parse(message.slice(prefix.length));
  if(Object.keys(r).sort().join(',')!=='amount,net,nonce,op,owner,p,to,token,v'||prefix+canonical(r)!==message||r.v!==1||r.op!=='burn'||r.p!==(network==='mainnet'?'xmr20':'xmr20-bridge-test')||r.net!==network||r.owner!==transfer.moneroAddress||r.to!==owner||transfer.owner!==owner||r.amount!==transfer.amountRaw||r.nonce!==transfer.nonce||r.token!==token||!/^([a-f0-9]{64})$/.test(token)||!/^([a-f0-9]{32})$/.test(r.nonce))throw Error('The bridge approval does not match this transfer. Refresh its saved status.');
  rawAmount(r.amount);
  return {network,address:r.owner,destination:r.to,amountRaw:r.amount,token:r.token,nonce:r.nonce,message};
}
