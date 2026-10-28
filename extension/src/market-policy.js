// Website requests only open a packaged wallet surface. They never authorize
// a signature, select executable code/endpoints, or return private material.
export const MARKET_ORIGIN = typeof __XMR20_OPERATOR_NATIVE__!=='undefined'&&__XMR20_OPERATOR_NATIVE__?'https://xmr20.org':'http://127.0.0.1:18941';
export const WALLET_EXTENSION_ORIGIN = 'chrome-extension://jigbpnljnmbbkebaopbnnhmiafgnofla';
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype &&
  Object.keys(v).sort().join(',') === keys.sort().join(',');
const amount = v => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v) && BigInt(v) <= 0xffffffffffffffffn;
export function marketLaunch(value) {
  if (exact(value, ['view']) && value.view === 'list') return {view: 'list'};
  if (exact(value, ['view', 'quantity', 'total']) && value.view === 'list' && amount(value.quantity) && amount(value.total))
    return {view: 'list', quantity: value.quantity, total: value.total};
  if (exact(value, ['view', 'listingId']) && value.view === 'buy' && /^[a-f0-9]{64}$/.test(value.listingId))
    return {view: 'buy', listingId: value.listingId};
  throw Error('Choose an XMR20 listing or an exact listing quantity and total.');
}
export function createMarketFetch({fetchImpl = globalThis.fetch, origin = MARKET_ORIGIN} = {}) {
  if (origin !== MARKET_ORIGIN) throw Error('Fixed market service required.');
  return (input, options = {}) => {
    if (typeof input !== 'string') throw Error('Explicit market API path required.');
    const url = new URL(input, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/api/native-market/') || url.username || url.password || url.hash)
      throw Error('Only the configured market API is available.');
    return fetchImpl(url.href, {...options, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'});
  };
}
