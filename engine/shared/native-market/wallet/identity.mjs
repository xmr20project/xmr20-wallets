// Public identity only. The private worker independently derives and checks the
// actual address from the unlocked wallet; this string confers no spend rights.
export function moneroWalletIdentity(address,network='mainnet') {
  if(network!=='mainnet'||typeof address!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{95}$/.test(address))throw Error('Monero wallet address required.');
  return `monero:${network}:${address}`;
}
