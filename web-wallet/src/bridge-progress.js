// Presentation only: transaction readiness still comes from verified preparation.
export function unlockProgress({state,ready=false,loading=false,error='',saved=false,busy=false,stage=''}){
 if(state==='complete')return {step:3,title:'Tokens unlocked on Solana',detail:'Your bridge is complete. Your tokens are now available in your Solana wallet.'};
 if(busy&&stage.startsWith('Waiting for approval'))return {step:1,title:'Approve in your Solana wallet',detail:'Open your Solana wallet popup and approve the transaction to unlock your tokens.',waiting:true};
 if(busy&&stage.startsWith('Submitting your signed'))return {step:2,title:'Sending your approval',detail:'Your approval is saved. Keep this bridge open while we submit it.',waiting:true};
 if(state==='destination_pending'||saved)return {step:2,title:state==='destination_pending'?'Waiting for Solana confirmation':'Checking your previous approval',detail:saved?'Your signed approval is saved. Check it below before requesting another approval.':'Your approval was submitted. We’re checking automatically; you don’t need to approve again.',waiting:state==='destination_pending'||busy,action:saved?'check':null};
 if(busy)return {step:0,title:'Checking bridge status',detail:'Your bridge is saved. Please wait while we check it.',waiting:true};
 if(error&&!loading)return {step:0,title:'Couldn’t prepare the Solana approval',detail:'Your Monero transfer is confirmed. Retry this step to continue the same bridge.',action:'retry'};
 if(!ready||loading)return {step:0,title:'Preparing Solana approval',detail:'Nothing to click yet. When ready, an approval button will appear here. You’ll then confirm in your Solana wallet.',waiting:true};
 return {step:1,title:'Ready for your approval',detail:'Click below, then approve the transaction in your Solana wallet to unlock your tokens. You’ll need SOL for the network and account fees.',action:'approve'};
}
