// Linking is explicit, and must never replace an account's existing Monero wallet.
export async function linkImportedWallet(address,{checkPair,savePair,assertCurrent}){
 assertCurrent();
 const saved=await checkPair();
 assertCurrent();
 if(saved&&saved.address!==address)throw Error('Your existing linked wallet cannot be replaced.');
 const linked=saved||await savePair(address);
 assertCurrent();
 if(linked?.address!==address)throw Error('Wallet linking could not be verified. Please retry.');
 return linked;
}

export async function resolveBridgePair({pair,address,isMonero,onLink,assertCurrent}){
 assertCurrent();
 let linked=pair;
 if(!linked?.address&&isMonero&&onLink)linked=await onLink(address);
 assertCurrent();
 if(!linked?.address)throw Error('Link a Monero wallet before bridging.');
 if(isMonero&&address!==linked.address)throw Error('The bridge returns tokens from your linked Monero wallet. Select that wallet.');
 return linked;
}
