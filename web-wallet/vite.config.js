import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {operatorConfigurationVitePlugin} from '../engine/shared/build-tools/operator-configuration.mjs';

// The standalone xmr20.org wallet (wallet.html → src/wallet-entry.jsx). Same settings as the live release build
// (main repository: website/frontend/vite.wallet.config.js plus the release's token-engine defines and dedupe list).
export default defineConfig({
 plugins:[operatorConfigurationVitePlugin(),react()],
 base:'/wallet/',
 // The standalone wallet always uses public wallet auth, regardless of shell env.
 define:{__XMR20_NATIVE_MARKET__:JSON.stringify(process.env.XMR20_OPERATOR_NATIVE_CANDIDATE==='1'),__XMR20_FAST_SEND__:JSON.stringify(process.env.XMR20_FAST_SEND==='1'),__XMR20_UNIVERSAL_LINK__:JSON.stringify(process.env.XMR20_UNIVERSAL_LINK==='1'),'import.meta.env.VITE_XMR20_WALLET_ONLY':JSON.stringify('1'),
  __XMR20_PRIVATE_LAZY_REGISTER__:'true',__XMR20_PRIVATE_BRIDGE_MINT__:JSON.stringify('Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR')},
 build:{outDir:'dist',emptyOutDir:true,rollupOptions:{input:'wallet.html'}},
 resolve:{dedupe:['react','react-dom','@solana/web3.js','@noble/hashes','@noble/curves','bs58'],alias:{buffer:'buffer'}},
 server:{fs:{allow:['..']}}
});
