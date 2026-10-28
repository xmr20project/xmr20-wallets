const receiptId=id=>typeof id==='string'&&/^[a-zA-Z0-9-]{8,80}$/.test(id);

// Existing wallet-menu Resume actions identify legacy service receipts. New
// joint positions have their own receipt controller and never use these IDs.
export function initialBridgeRoute({resumeId,resumeProtocol='legacy'}={}){
 if(resumeId){
  if(!receiptId(resumeId)||resumeProtocol!=='legacy')throw Error('This receipt needs its original bridge. Do not start a replacement deposit.');
  return 'legacy';
 }
 return 'joint';
}

// Retire fresh legacy deposits while preserving every existing receipt action.
// The original service still validates scope, backing and signed transactions.
export function legacyWithdrawalRequest(request){
 return (action,input)=>{
  if(['bridgeQuote','bridgeIntent'].includes(action)&&input?.direction!=='xmr-to-sol')return Promise.reject(Error('New deposits use the new bridge. The legacy bridge remains available for withdrawals and saved transfers.'));
  return request(action,input);
 };
}

export function websiteBridgeRoute({kind,network,resumeId,bridgeProtocol}={}){
 if(kind!=='bridge'&&!(kind==='send'&&bridgeProtocol==='transferable'))return 'legacy';
 if(resumeId||network==='monero'&&bridgeProtocol!=='transferable')return 'legacy';
 return 'transferable';
}
