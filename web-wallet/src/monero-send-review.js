import {checkMoneroAddress} from '../shared/xmr20/address.js';

export const SAME_MONERO_RECIPIENT='Enter a different Monero address. You cannot send tokens to the same wallet.';
const localError=message=>Object.assign(Error(message),{localValidation:true});
const errors=new Map([
 ['Choose a different recipient wallet.',SAME_MONERO_RECIPIENT],
 [SAME_MONERO_RECIPIENT,SAME_MONERO_RECIPIENT],
 ['Insufficient available Monero balance after pending transfers and burns.','This amount exceeds your available balance after pending sends and bridges. Check those transfers or enter a smaller amount.'],
 ['Escrow backing is unavailable or below Monero balances.','Token backing could not be verified. Please retry shortly. Nothing was sent.'],
 ['The token is not ready for Monero transfers.','This token is not ready to send on Monero yet. Please retry shortly. Nothing was sent.'],
 ['Connection timed out. Please retry. Your saved wallet and receipts are unchanged.','The balance check timed out. Please retry. Nothing was sent.'],
 ['Wallet service unavailable. Please retry. Your existing wallet is unchanged.','The balance check is temporarily unavailable. Please retry. Nothing was sent.'],
]);
// These are the gateway's exact public validation messages, never arbitrary
// upstream text. Keep both versions while older clients/gateways are active.
for(const message of [
 'Enter a primary Monero mainnet address.',
 'This amount exceeds your available Monero token balance. Pending transfers and burns are already reserved.',
 'This token is not ready for Monero transfers yet. Please retry shortly.',
 'Token backing could not be verified. Please retry shortly.',
 'Your wallet sign-in has expired. Disconnect and reconnect your wallet, then retry. Your saved wallet and receipts are unchanged.',
])errors.set(message,message);

export async function reviewMoneroTokenSend({request,launchId,from,to,amountRaw}){
 const recipient=typeof to==='string'?to.trim():'';
 const check=checkMoneroAddress(recipient,'mainnet');
 if(!check.valid||check.kind!=='standard')throw localError('Enter a primary Monero mainnet address.');
 // Reject locally before authentication, network requests or balance lookups.
 if(recipient===from)throw localError(SAME_MONERO_RECIPIENT);
 try{return await request('moneroTransferQuote',{launchId,from,to:recipient,amountRaw});}
 catch(error){
  const message=errors.get(error?.message)||(error?.status===401?'Reconnect your Solana wallet, then review the send again.':'Could not check this send. Please retry. Nothing was sent.');
  throw Error(message);
 }
}
