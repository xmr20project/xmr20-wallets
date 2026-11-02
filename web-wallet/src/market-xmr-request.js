// Monero Market (31 Oct 2026): the market page's "Use my XMR" asks the wallet to open its Monero screen on a page ('market-xmr',
// website-xmr-anchor-funds.jsx). The request waits here until the Monero row for that address is mounted, then is taken once.
let pending=null;
export function requestXmrPage(address,page,options={}){pending={address,page,options,at:Date.now()};globalThis.dispatchEvent?.(new Event('xmr20-xmr-page'));}
export function takeXmrPage(address){const p=pending;if(!p||p.address!==address||Date.now()-p.at>120000)return null;pending=null;return p;}
