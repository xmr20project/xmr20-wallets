// Builds the engine's browser files into engine/dist/. The extension, the website wallet and the CLI all copy their engine
// files from here, so all three run the same bytes.
//   node engine/build.mjs            (or: npm run build:engine, from the repository folder)
// dist/ gets:
//   private-holder.worker.js, private-claim.worker.js   built from engine/token/ (the token engine's two workers)
//   holder.wasm, parameters-manifest.json                the holder engine and its mainnet parameter manifest
//   native.worker.js and its three helpers, keys.worker.js   the Monero worker, copied from engine/monero/runtime/
//   monero-0.11.16.js, monero-full-0.11.16.js             the Monero library (npm package monero-ts 0.11.16)
// It then compares every file with the one installed in XMR20 Wallet 0.1.128 and writes dist/HASHES.json.
import {readFile,writeFile,mkdir,copyFile,rm} from 'node:fs/promises';import {createHash} from 'node:crypto';import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
const here=import.meta.dirname,dist=join(here,'dist'),require=createRequire(join(here,'package.json'));
const sha=b=>createHash('sha256').update(b).digest('hex');
// The files installed in XMR20 Wallet 0.1.128 (extension folder vendor/), 31 Oct 2026: holder.wasm is the Monero Market engine
// (xmr20-holder-wasm 0.0.6-market-experimental, built with the mainnet market start block 3,796,100) and private-holder.worker.js
// the token worker with the market operations (built with marketDefine below; it resumes scan progress saved by the 0.0.3 and 0.0.4
// engines); native.worker.js is from 0.1.120 (prepareSplit takes `coins`, 2..16); the others are unchanged since 0.1.117.
export const INSTALLED={
 'private-holder.worker.js':'a1e756fb8b88a8764f19d9c99323aee20611f2999ced3d4331ce53cfbddb0ec4',
 'private-claim.worker.js':'d896b51fe12fa19612c6b95377ebf9a497de3e458a4c2637ac50c126a78ead79',
 'holder.wasm':'5b5998187b49e22d92f90cd26c18997d954cae999f5174d3506b9eaaae5ec43a',
 'parameters-manifest.json':'1b1a27dcb1c4b3d93e4b38963c0b32595e44362a86296aa9445f468a51f1841b',
 'native.worker.js':'4cf3b221e2aff69559510c5e990fe5ab804c0f12c6c33d2d33d119f7706c3036',
 'native-carrier-guard.js':'09e80298b80ea4dc646dbac64eedd00db323a0634bb3e4932ec7da915fc2aa19',
 'market-ordinary-guard.js':'64102da38aaf61f9b8a8a61490f79d4ef60d9e2f89ab70a1beb8df58013a033e',
 'native-carrier-transaction.js':'de9b9e92118d5abb66cc1d893364d3fcab4dbb9d7ab5220088cc100e6991d2b3',
 'keys.worker.js':'2caf4ffb60863f01109c8340e5217d00a921c992b74db357507f11274c8aca63',
 'monero-0.11.16.js':'f54e18d60fd582ad4b65d1d17c88a8300e0b3d4f556d43fe23adff67a491a5a2',
 'monero-full-0.11.16.js':'2e53c27e4518c5e59ae9f6378550cd00c68bb0221d8ee751bd0a12cc39263c3e',
 'LICENSE.txt':'1ff271e3025cb8284c3ae3091ba19ee1dd1610cd984fddb98b582776de960127',
 'monero.worker.js.LICENSE.txt':'b56b6cbccbd5a0370d840ea4000f0267499febfdf00897d50e948aceb71d5d87'};
// The worker build settings of the 0.1.112–0.1.128 release recipe.
export const workerOptions={bundle:true,format:'iife',platform:'browser',target:'chrome120',minify:true,logLevel:'warning'};
// Monero Market (31 Oct 2026; experimental): the market page and order book the wallets talk to, the XMR20 asset on Monero, and the
// node and parameter routes, as the 0.1.126–0.1.128 extension and xmr20.org wallet builds set them.
export const marketDefine={__XMR20_MONERO_MARKET__:JSON.stringify('https://xmr20.org'),__XMR20_MONERO_MARKET_API__:JSON.stringify('https://api.xmr20.org/market'),
 __XMR20_MONERO_MARKET_ASSET__:JSON.stringify('3cacb211956f6de017c01ff1e67176c4cd14ceca1b956a7fa59101c7408f480f'),__XMR20_MONERO_MARKET_NODE__:JSON.stringify('https://api.xmr20.org/api/private-node'),
 __XMR20_MONERO_MARKET_PARAMS__:JSON.stringify('https://api.xmr20.org/api/private-bridge')};
export async function holderDefine(){const manifest=await readFile(join(here,'token/parameters-manifest.json'));
 return {__PARAMS_MANIFEST_SHA256__:JSON.stringify(sha(manifest)),__XMR20_MAINNET_PILOT__:'true',__XMR20_SCAN_LOOKAHEAD__:'12',...marketDefine};}
export async function buildEngine({out=dist,quiet=false}={}){
 const {build}=require('esbuild');
 await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
 await build({...workerOptions,entryPoints:[join(here,'token/private-holder.worker.js')],outfile:join(out,'private-holder.worker.js'),define:await holderDefine()});
 await build({...workerOptions,entryPoints:[join(here,'token/private-claim.worker.js')],outfile:join(out,'private-claim.worker.js')});
 await copyFile(join(here,'holder-wasm/holder.wasm'),join(out,'holder.wasm'));
 await copyFile(join(here,'token/parameters-manifest.json'),join(out,'parameters-manifest.json'));
 for(const f of ['native.worker.js','native-carrier-guard.js','market-ordinary-guard.js','native-carrier-transaction.js','keys.worker.js','LICENSE.txt','monero.worker.js.LICENSE.txt'])
  await copyFile(join(here,'monero/runtime',f),join(out,f));
 const monero=dirname(require.resolve('monero-ts/package.json'));
 await copyFile(join(monero,'dist/monero.js'),join(out,'monero-0.11.16.js'));
 await copyFile(join(monero,'dist/monero.worker.js'),join(out,'monero-full-0.11.16.js'));
 const files={},differs=[];
 // The token worker imports the market's CommonJS codec (market-mapcodec.cjs). engine/ is an ES-module package, so esbuild adds its
 // Node-mode interop flag to that one import (`__toESM(x(),1)`); the release build (outside such a package) has none. Same
 // behaviour: the codec has no __esModule marker. Without that one flag the file must be byte-identical to the installed one.
 const interop=[];
 for(const f of Object.keys(INSTALLED)){const b=await readFile(join(out,f));files[f]=sha(b);if(files[f]===INSTALLED[f])continue;
  if(f==='private-holder.worker.js'&&sha(b.toString('utf8').replace(/(\w+)\((\w+)\(\),1\)/,'$1($2())'))===INSTALLED[f]){interop.push(f);continue;}
  differs.push(f);}
 await writeFile(join(out,'HASHES.json'),JSON.stringify({sameAsInstalled:differs.length===0,differs,sameApartFromInteropFlag:interop,files},null,1)+'\n');
 if(!quiet)console.log(differs.length?`Engine built in ${out}. These files differ from XMR20 Wallet 0.1.128: ${differs.join(', ')}`:`Engine built in ${out}. All ${Object.keys(files).length} files match XMR20 Wallet 0.1.128`+(interop.length?` (${interop.join(', ')}: identical apart from esbuild's interop flag).`:' byte for byte.'));
 return {files,differs};
}
if(process.argv[1]===import.meta.filename)await buildEngine();
