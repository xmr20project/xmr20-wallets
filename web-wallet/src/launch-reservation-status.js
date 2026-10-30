const SHORT_REQUESTS=new Set(['catalog','account','pair','launchBalance','uploadImage','reserve','prepareLaunchFee']);
export const shortLaunchRequest=action=>SHORT_REQUESTS.has(action);
export const launchRequestTimeoutMs=action=>shortLaunchRequest(action)?30000:110000;

export function reservationFailureMessage(error){
 const message=String(error?.message||error||'Launch request failed.');
 if(/not ready for this wallet|restricted to an approved wallet|not invited/i.test(message))
  return 'This wallet is not invited to the launch test. Connect the invited Solana wallet.';
 if(/public launches are paused|automatic escrow and bridge are ready|public launch route is not ready/i.test(message))
  return 'Launches are temporarily unavailable. Refresh launch status and retry when ready.';
 if(/timed out|temporarily unavailable|service unavailable|could not complete this request|failed to fetch|networkerror|network request failed|rate.limit|429/i.test(message))
  return 'The launch service did not respond. Your token details remain here; refresh status and retry.';
 return message;
}

export function reservationFailure(error){
 const failure=new Error(reservationFailureMessage(error));
 if(error?.code)failure.code=error.code;
 if(error?.diagnostic)failure.diagnostic=error.diagnostic;
 return failure;
}
