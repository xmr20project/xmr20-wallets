// Builds the Chrome extension into extension/dist/ (load that folder in chrome://extensions → Load unpacked).
//   node extension/build.mjs        (or: npm run build:extension, from the repository folder)
// Same recipe as the wallet releases 0.1.103–0.1.144: start from the previous release's files (prebuilt/), then rebuild
//   app.js                  from extension/src/app.js (with engine/token, engine/shared and src/mordinals)
//   vendor/                 the engine files (engine/build.mjs: token workers, holder.wasm, Monero worker)
//   vendor/mordinals.*      the Mordinals worker (src/mordinals/mordinals.worker.js) and its engine (engine/holder-wasm/mordinals.wasm)
//   style.css               engine/shared/extension-style.css + engine/token/private-format.css, then the private transfers,
//                           Mordinals and wXMR styles (STYLES below)
//   manifest.json           extension/manifest.json
// private-balance.js (private transfers: src in private-balance/ plus Helius's SDK) is kept prebuilt; `npm run build:private-balance`
// rebuilds it from source with its own dependencies and checks it is the same file.
import {readFile,writeFile,mkdir,cp,rm,readdir,copyFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {join} from 'node:path';import {createRequire} from 'node:module';
import {buildEngine,workerOptions} from '../engine/build.mjs';
import {operatorConfigurationPlugin} from '../engine/shared/build-tools/operator-configuration.mjs';
const here=import.meta.dirname,engineDir=join(here,'../engine'),dist=join(here,'dist'),require=createRequire(join(here,'package.json'));
const sha=b=>createHash('sha256').update(b).digest('hex');
// Mordinals in the Collectibles tab (0.1.142+): the XMR721 reader, the network, the ledger's domain, the market fee address and
// the SHA-256 of the Mordinals owner list, the same settings as the xmr20.org wallet. The screens refuse a reader that serves
// anything else.
export const mordinals={endpoint:'https://api.xmr20.org/xmr721',network:'mainnet',domain:'ec7f7d26dba6725124df69417d43335c52e34557fc61c1d8d6b4736370e6ba1d',
 feeAddress:'45J4QMTbVoi61ZQoUzLVh7VkvjuRbqaaHW1AophY1Jbi9KzTzk8qoh43fT6JWYvkk6j6X1Stog7Xb9ZabzBrMr7tGzANudW',owners:'e71d340d84538c229f9e190d221271873cde6b1daab8366d9b282ff016e639ee'};
// Build flags of the installed releases (release recipe 0.1.95 → 0.1.144): operator-native bridge on, Monero Market off by
// the server, the real private bridge at api.xmr20.org with lazy registration and the XMR20 bridge mint, and the Mordinals settings.
export const define={__XMR20_NATIVE_COIN_SWAPS__:'true',__XMR20_OPERATOR_NATIVE__:'true',__XMR20_NATIVE_MARKET__:'true',__XMR20_NATIVE_SPEND_PROTECTION__:'true',__XMR20_FAST_SEND__:'true',
 __XMR20_UNIVERSAL_LINK__:'true',__XMR20_JOINT_PREVIEW__:'false',__XMR20_JOINT_MAINNET_REVIEW__:'true',__XMR20_JOINT_TRANSFERABLE_REVIEW__:'true',__XMR20_JOINT_PRIVATE_TEST__:'true',__XMR20_JOINT_WALLET_TEST__:'true',
 __XMR20_PRIVATE_FORMAT_TEST__:'true',__XMR20_PRIVATE_ENDPOINT__:JSON.stringify('https://api.xmr20.org/api/private-bridge'),__XMR20_PRIVATE_NODE__:JSON.stringify('https://api.xmr20.org/api/private-node'),
 __XMR20_PRIVATE_LAZY_REGISTER__:'true',__XMR20_PRIVATE_BRIDGE_MINT__:JSON.stringify('Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR'),
 __MORDINALS__:JSON.stringify(mordinals)};
export const appOptions={bundle:true,format:'esm',platform:'browser',target:'chrome120',minify:true,inject:[join(engineDir,'shared/polyfill.js')],define,
 entryPoints:[join(here,'src/app.js')],plugins:[operatorConfigurationPlugin(true)],logLevel:'warning'};
// style.css: the base styles, then (each after a line break) the styles added by 0.1.136 (private transfers), 0.1.142 (Mordinals)
// and 0.1.143 (wXMR, Swap on home, the profile link).
export const STYLES=[join(engineDir,'shared/extension-style.css'),join(engineDir,'token/private-format.css')];
export const ADDED_STYLES=[join(here,'private-balance/private.css'),join(here,'src/mordinals/mordinals.css'),join(here,'src/wxmr-screens.css')];
async function hashes(directory,prefix=''){const out={};for(const e of await readdir(join(directory,prefix),{withFileTypes:true})){const name=join(prefix,e.name);if(e.isDirectory())Object.assign(out,await hashes(directory,name));else out[name]=sha(await readFile(join(directory,name)));}return out;}
export async function buildExtension({out=dist,quiet=false}={}){
 await rm(out,{recursive:true,force:true});await cp(join(here,'prebuilt'),out,{recursive:true});
 await copyFile(join(here,'manifest.json'),join(out,'manifest.json'));
 await require('esbuild').build({...appOptions,outfile:join(out,'app.js')});
 const tmp=join(out,'.engine-tmp'),engine=await buildEngine({out:tmp,quiet:true});await mkdir(join(out,'vendor'),{recursive:true});
 for(const f of Object.keys(engine.files))await copyFile(join(tmp,f),join(out,'vendor',f));await rm(tmp,{recursive:true,force:true});
 await require('esbuild').build({...workerOptions,entryPoints:[join(here,'src/mordinals/mordinals.worker.js')],outfile:join(out,'vendor/mordinals.worker.js')});
 await copyFile(join(engineDir,'holder-wasm/mordinals.wasm'),join(out,'vendor/mordinals.wasm'));
 let style='';for(const f of STYLES)style+=await readFile(f,'utf8');for(const f of ADDED_STYLES)style+='\n'+await readFile(f,'utf8');
 await writeFile(join(out,'style.css'),style);
 const files=await hashes(out),version=JSON.parse(await readFile(join(out,'manifest.json'),'utf8')).version;
 if(!quiet)console.log(`XMR20 Wallet ${version} built in ${out} (${Object.keys(files).length} files, app.js ${files['app.js'].slice(0,16)}…). Load it in chrome://extensions with Developer mode → Load unpacked.`+(engine.differs.length?` Engine files that differ from the installed 0.1.143: ${engine.differs.join(', ')}.`:''));
 return {version,files,engineDiffers:engine.differs};
}
if(process.argv[1]===import.meta.filename)await buildExtension();
