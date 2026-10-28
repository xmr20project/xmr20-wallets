// Shared transport for bridge actions and public balance reads. Local review
// profiles remain explicit; the installable all-token build uses the hosted gateway.
export const HOSTED_BRIDGE='https://api.xmr20.org';
export function jointService({privateTest=false,walletTest=false,endpoint}={}){
 const base=endpoint??(walletTest?HOSTED_BRIDGE:privateTest?'http://127.0.0.1:8933':'http://127.0.0.1:8928');
 return {endpoint:base,rpcEndpoint:base+(base===HOSTED_BRIDGE?'/api/bridge-solana-read':'/api/solana-read')};
}
export function bridgeConnectionMessage(error){
 if(error?.message==='Registered recipient required.')return 'Recipient setup required. Check the recipient’s wallet link and token account. If their wallet link is already confirmed, prepare their account for this token; they do not need to link again.';
 if(error?.name==='TimeoutError')return 'The bridge took too long to respond. Your saved approvals are kept. Check status before approving again.';
 if(error?.message==='Transferable service unavailable. Keep the public recovery receipt.')return 'The bridge service could not finish this request. Your saved approvals are kept. Check status before approving again.';
 if(error?.name==='TypeError'&&/fetch|network/i.test(error.message))return 'The wallet could not reach the bridge service. Your saved approvals are kept. Reconnect to check their status before approving again.';
 return error?.message||'The bridge request could not finish. Your saved approvals are kept.';
}
