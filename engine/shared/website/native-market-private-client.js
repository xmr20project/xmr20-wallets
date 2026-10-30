// The page gets typed market operations, never arbitrary worker callbacks,
// native spend masks, signing keys, or a choice of signer module/configuration.
import {moneroWalletIdentity} from '../native-market/wallet/identity.mjs';
export function createPrivateMarketClient({context, provider, assertCurrent,
  onProgress = () => {}, vault,
  workerFactory = () => new Worker('/market/native-wallet/worker.js'), timeoutMs = 120000} = {}) {
  if (!vault || typeof vault.load !== 'function' || !context || context.network !== 'mainnet' || typeof assertCurrent !== 'function') throw Error('Monero wallet required.');
  const pinned = Object.freeze({...context});
  const nativeIdentity=pinned.owner===moneroWalletIdentity(pinned.address,pinned.network);
  let worker, disposed = false, busy = false, pending = null, unlocked = false, retryWait = null;
  function current() {
    if (disposed) throw Error('Native market wallet is locked.');
    try {
      assertCurrent(); provider?.assertCurrent?.();
      if (nativeIdentity ? provider?.getMoneroAddress?.()!==pinned.address : provider?.publicKey?.toBase58()!==pinned.owner) throw Error('Connected wallet changed.');
    } catch (error) { dispose(); throw error; }
  }
  function dispose() {
    if (disposed) return; disposed = true; unlocked = false;
    worker?.terminate();
    if (pending) { clearTimeout(pending.timer); pending.reject(Error('Native market wallet is locked.')); pending = null; }
    if (retryWait) { clearTimeout(retryWait.timer); retryWait.reject(Error('Native market wallet is locked.')); retryWait = null; }
  }
  function start() {
    if (worker) return;
    worker = workerFactory();
    worker.onerror = () => dispose(); worker.onmessageerror = () => dispose();
    worker.onmessage = ({data}) => {
      if (!pending || data?.id !== pending.id) return;
      try { current(); } catch { dispose(); return; }
      if (typeof data.progress === 'string') { onProgress(data.progress); return; }
      const request = pending; pending = null; clearTimeout(request.timer);
      if (data.error) {
        const resumable = request.action === 'sync' && ['sync-interrupted', 'sync-connection-interrupted'].includes(data.code);
        if (!resumable) unlocked = false;
        const error = Error(data.error);
        if (resumable && data.code === 'sync-connection-interrupted') error.code = 'sync-connection-interrupted';
        request.reject(error);
      }
      else request.resolve(data.result);
    };
  }
  function send(action, args = {}) {
    current(); start();
    if (pending) throw Error('Native market wallet is busy.');
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pending = {id, action, resolve, reject, timer: setTimeout(dispose, timeoutMs)};
      try { worker.postMessage({id, action, args}); }
      catch { dispose(); }
    });
  }
  async function operation(action, args = {}) {
    if (busy) throw Error('Native market wallet is busy.');
    busy = true;
    try {
      for (let attempt = 0; ; attempt++) {
        current(); await provider?.checkCurrent?.(); current();
        if (!unlocked) throw Error('Unlock your Monero wallet first.');
        let result;
        try { result = await send(action, args); }
        catch (error) {
          // Only a fixed worker's transport code, with a coherent retained
          // checkpoint, may retry. Never replay a signature or a validation
          // failure; keep this operation single-flight through the backoff.
          if (action !== 'sync' || error.code !== 'sync-connection-interrupted' || attempt >= 2) throw error;
          current(); onProgress('Reconnecting to Monero history…'); current();
          await new Promise((resolve, reject) => {
            retryWait = {reject, timer: setTimeout(() => { retryWait = null; resolve(); }, 250 * (attempt + 1))};
          });
          current(); continue;
        }
        await provider?.checkCurrent?.(); current(); return result;
      }
    }
    finally { busy = false; }
  }
  return Object.freeze({
    async capabilities() {
      if (busy) throw Error('Native market wallet is busy.');
      busy = true; try { return await send('capabilities'); } finally { busy = false; }
    },
    async unlock() {
      if (busy) throw Error('Native market wallet is busy.');
      busy = true; let seed = '';
      try {
        current(); await provider?.checkCurrent?.(); current(); if (unlocked) return {address: pinned.address};
        const capabilities = await send('capabilities'); current();
        if (!capabilities.available) throw Error(capabilities.reason);
        // The installed host provides its own account-bound vault adapter.
        // No transaction or general-purpose signing callback is accepted here.
        seed = await vault.load(pinned, provider, {onProgress}); current();
        const result = await send('open', {context: pinned, seed}); current();
        if (result.address !== pinned.address) { dispose(); throw Error('Monero wallet changed.'); }
        unlocked = true; return result;
      } finally { seed = ''; busy = false; }
    },
    sync: () => operation('sync'),
    inventory: () => operation('inventory'),
    feeFundingStatus: () => operation('feeFundingStatus'),
    nativeRedemptionReceipts: () => operation('nativeRedemptionReceipts'),
    constructRedemption: args => operation('constructRedemption', args),
    signRedemption: args => operation('signRedemption', args),
    assembleRedemption: args => operation('assembleRedemption', args),
    recoverRedemption: args => operation('recoverRedemption', args),
    nativeSendReceipts: () => operation('nativeSendReceipts'),
    constructPeerSend: args => operation('constructPeerSend', args),
    signPeerSend: args => operation('signPeerSend', args),
    assemblePeerSend: args => operation('assemblePeerSend', args),
    recoverPeerSend: args => operation('recoverPeerSend', args),
    exportRecovery: () => operation('exportRecovery'),
    importRecovery: args => operation('importRecovery', args),
    authorizeOffer: args => operation('authorizeOffer', args),
    authorizeOfferAction: args => operation('authorizeOfferAction', args),
    prepareSaleContribution: args => operation('prepareSaleContribution', args),
    constructSale: args => operation('constructSale', args),
    replaceConstructionData: args => operation('replaceConstructionData', args),
    proposedRecipient: args => operation('proposedRecipient', args),
    authorizeTokenProof: args => operation('authorizeTokenProof', args),
    authorizeConversionRecipient: args => operation('authorizeConversionRecipient', args),
    reviewConversion: args => operation('reviewConversion', args),
    prepareConversion: args => operation('prepareConversion', args),
    prepareOperatorCredit: args => operation('prepareOperatorCredit', args),
    operatorCreditPreparations: () => operation('operatorCreditPreparations'),
    recoverOperatorCreditPreparation: args => operation('recoverOperatorCreditPreparation', args),
    constructOperatorIssuedCredit: args => operation('constructOperatorIssuedCredit', args),
    completeOperatorRefund: args => operation('completeOperatorRefund', args),
    cancelOperatorCreditPreparation: args => operation('cancelOperatorCreditPreparation', args),
    discardCarrierReview: args => operation('discardCarrierReview', args),
    prepareCancellationRetry: args => operation('prepareCancellationRetry', args),
    conversionPreparations: () => operation('conversionPreparations'),
    recoverConversionPreparation: args => operation('recoverConversionPreparation', args),
    authorizePreparedConversion: args => operation('authorizePreparedConversion', args),
    authorizePreparedCancellation: args => operation('authorizePreparedCancellation', args),
    constructPreparedCarrier: args => operation('constructPreparedCarrier', args),
    reviewConversionRecovery: args => operation('reviewConversionRecovery', args),
    conversionRecoveryStatus: args => operation('conversionRecoveryStatus', args),
    constructCarrier: args => operation('constructCarrier', args),
    reviewCarrier: args => operation('reviewCarrier', args),
    signCarrier: args => operation('signCarrier', args),
    assembleCarrier: args => operation('assembleCarrier', args),
    recoverCarrier: args => operation('recoverCarrier', args),
    recoverPreparedCarrier: args => operation('recoverPreparedCarrier', args),
    completeConversionPreparation: args => operation('completeConversionPreparation', args),
    reviewConstructedSale: args => operation('reviewConstructedSale', args),
    reviewSellerSale: args => operation('reviewSellerSale', args),
    signConstructedSale: args => operation('signConstructedSale', args),
    assembleConstructedSale: args => operation('assembleConstructedSale', args),
    recoveryStatus: args => operation('recoveryStatus', args),
    recoverSaleSignature: args => operation('recoverSaleSignature', args),
    recoverSaleRelease: args => operation('recoverSaleRelease', args),
    assembleRecoveredSale: args => operation('assembleRecoveredSale', args),
    isDisposed: () => disposed,
    dispose
  });
}
