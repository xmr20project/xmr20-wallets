/* Classic private worker bootstrap, copied verbatim to the fixed asset path.
 * The native Monero seed parser is pinned with the existing site's wallet.
 * No seed/key is sent back to the page or to a network service.
 */
'use strict';
let runtime, running = false, keysModule, requestId;
self.onmessage = async ({data}) => {
  if (!data || typeof data.id !== 'string' || data.id.length > 100) return;
  if (running) { self.postMessage({id: data.id, error: 'Native market wallet is busy.'}); return; }
  running = true;requestId=data.id;
  try {
    if (!runtime) {
      const module = await import('./runtime.js');
      const {createMarketFetch,MARKET_ORIGIN}=await import('./transport.js');
      runtime = await module.createInstalledMarketRuntime({origin:MARKET_ORIGIN,fetchImpl:createMarketFetch(),
        onProgress: progress => {if(typeof progress==='string'&&progress.length<=240)self.postMessage({id:requestId,progress});},
        loadKeys: async () => {
          if (!keysModule) {
            importScripts('./monero-0.11.16.js');
            keysModule = monero_ts({print: () => {}, printErr: () => {}});
          }
          return keysModule;
        }
      });
    }
    const result = await runtime.execute(data.action, data.args || {});
    self.postMessage({id: data.id, result});
  } catch (error) {
    // Native exception strings can contain input material. Only fixed product
    // text crosses this boundary, even if a malformed seed caused the failure.
    const resumable = data.action === 'sync' && runtime?.canResumeSync?.() === true;
    const connectionInterrupted = resumable && error?.code === 'native-history-transport';
    // Stage names originate only in the fixed private runtime. Never forward
    // exception text, stack traces, request fields or native key material.
    const failures={
      'funding-history':['M01','Monero history could not be verified. Try again to refresh it.'],
      'funding-protection':['M02','Saved coin protection could not be checked. Reopen the wallet and try again.'],
      'funding-classification':['M03','Spendable XMR could not be checked. Reopen the wallet and sync again.'],
      'bridge-terms':['M04','The bridge settings could not be verified. Reopen this token and try again.'],
      'preparation-recovery':['M05','A saved bridge record could not be verified. Your saved records are kept.'],
      'network-fee':['M06','The Monero network fee could not be checked. Try again.'],
      'transaction-build':['M07','The Monero transaction could not be prepared. Try again; your saved records are kept.'],
      'transaction-review':['M08','The prepared transaction did not pass verification. Your saved records are kept.'],
      'preparation-save':['M09','The bridge preparation could not be saved. Your existing records are kept.'],
      'credit-history':['M10','Monero history needs a refresh. Resume your saved bridge to continue.'],
      'credit-rings':['M11','Monero transaction checks could not finish. Resume your saved bridge to retry.'],
      'credit-backing':['M12','Your saved Solana approval could not be verified. Check status to retry.'],
      'credit-funding':['M13','The saved Monero fee coins could not be verified. Your saved bridge is kept.'],
      'credit-signature':['M14','The bridge service’s credit approval did not pass verification. Your saved bridge is kept.'],
      'credit-review':['M15','The Monero credit did not pass verification. Your saved bridge is kept.'],
      'credit-signing':['M16','Monero signing could not finish. Reopen Saved bridges to check the saved transaction.']
    };
    const failure=Object.hasOwn(failures,runtime?.failureStage?.())?failures[runtime.failureStage()]:null;
    if (!resumable) { runtime?.close(); runtime = null; }
    const needsXmr = error?.message === 'Add spendable XMR for the Monero network fee before bridging';
    self.postMessage({id: data.id, ...(resumable ? {code: connectionInterrupted ? 'sync-connection-interrupted' : 'sync-interrupted'} : {}), error: needsXmr
      ? 'Add spendable XMR to this Monero wallet for the network fee, then go Back and reopen the bridge. The treasury does not pay this fee.'
      : resumable
      ? 'Monero history verification was interrupted. Retry to continue from the last verified block.'
      : failure ? `${failure[1]} (${failure[0]})`
      : 'Native market operation could not be verified. Reopen the wallet and try again; saved records are kept. (M00)'});
  } finally {
    if (data.args && typeof data.args === 'object') data.args.seed = '';
    running = false;requestId=null;
  }
};
