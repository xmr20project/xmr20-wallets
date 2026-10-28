// Puts the engine's browser files where the website wallet loads them (public/, not committed):
//   public/xmr20-private/   token workers, holder.wasm, parameter manifest, Monero library   (engine/token, engine/holder-wasm)
//   public/monero-native/   the Monero worker and its helpers                                (engine/monero)
//   public/monero-wallet/   Monero library + the older bridge's offline signer worker        (engine/shared)
import {mkdir,copyFile,rm} from 'node:fs/promises';import {join,dirname} from 'node:path';import {createRequire} from 'node:module';
import {buildEngine} from '../engine/build.mjs';
const here=import.meta.dirname,pub=join(here,'public'),require=createRequire(join(here,'package.json'));
const tmp=join(here,'.engine-tmp');const {differs}=await buildEngine({out:tmp,quiet:true});
const put=async(dir,files)=>{await rm(join(pub,dir),{recursive:true,force:true}).catch(()=>{});await mkdir(join(pub,dir),{recursive:true});for(const [from,to] of files)await copyFile(join(tmp,from),join(pub,dir,to||from));};
await put('xmr20-private',[['private-holder.worker.js'],['private-claim.worker.js'],['holder.wasm'],['parameters-manifest.json'],['monero-0.11.16.js']]);
await put('monero-native',[['native.worker.js'],['native-carrier-guard.js'],['market-ordinary-guard.js'],['native-carrier-transaction.js'],['monero-full-0.11.16.js'],['LICENSE.txt'],['monero.worker.js.LICENSE.txt']]);
await mkdir(join(pub,'monero-wallet'),{recursive:true});await copyFile(join(tmp,'monero-0.11.16.js'),join(pub,'monero-wallet/monero-0.11.16.js'));
await copyFile(join(dirname(require.resolve('monero-ts/package.json')),'LICENSE.txt'),join(pub,'monero-wallet/LICENSE.txt'));
await require('esbuild').build({entryPoints:[join(here,'../engine/shared/joint-transferable.worker.js')],bundle:true,format:'iife',platform:'browser',target:'es2022',
 inject:[join(here,'../engine/shared/polyfill.js')],outfile:join(pub,'monero-wallet/joint-transferable.worker.js'),logLevel:'silent'});
await rm(tmp,{recursive:true,force:true});
console.log('Engine files placed in web-wallet/public/'+(differs.length?` (differ from wallet 0.1.119: ${differs.join(', ')})`:' (identical to XMR20 Wallet 0.1.119)')+'.');
