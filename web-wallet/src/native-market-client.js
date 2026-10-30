import {moneroWalletVault} from './monero-wallet-vault.js';
import {createPrivateMarketClient} from '../../engine/shared/website/native-market-private-client.js';

// Website compatibility adapter. The extension uses its own local vault loader.
export function createNativeMarketWalletClient(options = {}) {
  return createPrivateMarketClient({...options, vault: options.vault ?? moneroWalletVault()});
}
