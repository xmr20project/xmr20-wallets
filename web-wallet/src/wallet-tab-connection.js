// Restoration never asks an extension to display a prompt.
// An explicit button click is the only path that calls provider.connect() in a way that can prompt.
// 28 Oct 2026 (a user: "if I switch tabs within the website itself, it asks me to connect my wallet to the site again"): every page
// load starts with Phantom reporting "not connected", so restoring asks Phantom to reconnect only if it already trusts this site
// (connect({onlyIfTrusted:true}) never shows a prompt; an untrusted site is refused silently). Other wallets are restored only
// while they still report the connection, as before.
async function reconnectQuietly(provider) {
 if (provider.isConnected || !provider.isPhantom) return;
 try { await provider.connect({ onlyIfTrusted: true }); } catch {}
}
export async function connectForThisTab(provider, saved = null) {
 if (saved) {
  await reconnectQuietly(provider);
  const address = provider.isConnected ? provider.publicKey?.toBase58() : null;
  return address === saved.wallet ? address : null;
 }
 await provider.connect();
 return provider.publicKey.toBase58();
}
// After a "disconnect" or "accountChanged" event (for example while the tab was in the background): is this still the signed-in
// account, once Phantom has been asked to reconnect without a prompt?
export async function stillConnected(provider, address) {
 await reconnectQuietly(provider);
 return Boolean(provider.isConnected) && provider.publicKey?.toBase58() === address;
}
