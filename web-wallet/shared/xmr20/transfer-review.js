import {canonical,rawAmount} from './protocol.js';
import {checkMoneroAddress} from './address.js';
export const TRANSFER_DOMAIN='MOUSE-ROAD-XMR20-MAINNET-TRANSFER-V1\n';
export function transferReview(t,{owner,token}={}){
  if(t?.owner!==owner||t.state!=='reserved'||typeof t.signingMessage!=='string'||!t.signingMessage.startsWith(TRANSFER_DOMAIN))throw Error('This transfer is not awaiting your approval.');
  const r=JSON.parse(t.signingMessage.slice(TRANSFER_DOMAIN.length));
  if(Object.keys(r).sort().join(',')!=='amount,net,nonce,op,owner,p,to,token,v'||TRANSFER_DOMAIN+canonical(r)!==t.signingMessage||r.p!=='xmr20'||r.v!==1||r.net!=='mainnet'||r.op!=='transfer'||r.owner!==t.moneroAddress||r.to!==t.recipient||r.token!==token||r.amount!==t.amountRaw||r.nonce!==t.nonce||!/^([a-f0-9]{64})$/.test(r.token)||!/^([a-f0-9]{32})$/.test(r.nonce))throw Error('The transfer approval does not match the saved request.');
  for(const a of [r.owner,r.to]){const c=checkMoneroAddress(a,'mainnet');if(!c.valid||c.kind!=='standard')throw Error('Use primary Monero mainnet addresses.');}
  if(r.owner===r.to)throw Error('Choose a different recipient wallet.');rawAmount(r.amount);
  return {network:'mainnet',address:r.owner,destination:r.to,token:r.token,nonce:r.nonce,amountRaw:r.amount,message:t.signingMessage};
}
