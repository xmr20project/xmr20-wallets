// Restoration never asks an extension to connect or display a prompt.
// An explicit button click is the only path that calls provider.connect().
export async function connectForThisTab(provider, saved = null) {
 if (saved) {
  const address = provider.isConnected ? provider.publicKey?.toBase58() : null;
  return address === saved.wallet ? address : null;
 }
 await provider.connect();
 return provider.publicKey.toBase58();
}
