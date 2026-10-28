// The form is the approval surface. These are ceilings, never extra charges.
// Construction and signing still independently verify the exact native transaction.
export const NATIVE_FEE_LIMIT='100000000';
export const NATIVE_CARRIER='1000000';
export const NATIVE_FEE_COPY='Up to 0.0001 XMR';
export function checkNativeFee(review,maximum=NATIVE_FEE_LIMIT){
 if(!/^(0|[1-9][0-9]*)$/.test(review?.fee??'')||BigInt(review.fee)>BigInt(maximum))throw Error('The network fee changed. Nothing was signed; check the fee and try again.');
}
export function checkNativeSend(review,{amount,recipient}){
 checkNativeFee(review);
 if(review.quantity!==amount||review.recipientAddress!==recipient)throw Error('The send details changed. Nothing was signed; reopen this send.');
}
export function checkNativeRedemption(review,{amount,recipient}){
 checkNativeFee(review);
 if(review.quantity!==amount||review.recipient!==recipient)throw Error('The bridge details changed. Nothing was signed; reopen this bridge.');
}
export function checkConversionPreparation(prepared,{kind,owner,amount,fee}){
 const p=prepared?.plan,q=prepared?.quote;
 if(p?.request?.kind!==kind||p.request.owner!==owner||p.request.amount!==amount||p.request.fee!==fee||p.record.amount!==String(BigInt(amount)-BigInt(fee)))throw Error('The bridge amount or fee changed. Nothing was signed; reopen the saved bridge.');
 checkNativeFee({fee:q?.nativeFee});
}
