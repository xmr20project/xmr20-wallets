// Builds the Chrome extension into extension/dist/ (load that folder in chrome://extensions → Load unpacked).
//   node extension/build.mjs        (or: npm run build:extension, from the repository folder)
// Same recipe as the wallet releases 0.1.103–0.1.121: start from the previous release's files (prebuilt/), then rebuild
//   app.js                  from extension/src/app.js (with engine/token and engine/shared)
//   vendor/                 the engine files (engine/build.mjs: token workers, holder.wasm, Monero worker)
//   style.css               engine/shared/extension-style.css + engine/token/private-format.css
//   manifest.json           extension/manifest.json
import {readFile,writeFile,mkdir,cp,rm,readdir,copyFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {join} from 'node:path';import {createRequire} from 'node:module';
import {buildEngine} from '../engine/build.mjs';
import {operatorConfigurationPlugin} from '../engine/shared/build-tools/operator-configuration.mjs';
const here=import.meta.dirname,engineDir=join(here,'../engine'),dist=join(here,'dist'),require=createRequire(join(here,'package.json'));
const sha=b=>createHash('sha256').update(b).digest('hex');
// Build flags of the installed releases (operations recipe 0.1.95 → 0.1.121): operator-native bridge on, Monero Market off by
// the server, the real private bridge at api.xmr20.org with lazy registration and the XMR20 bridge mint.
export const define={__XMR20_NATIVE_COIN_SWAPS__:'true',__XMR20_OPERATOR_NATIVE__:'true',__XMR20_NATIVE_MARKET__:'true',__XMR20_NATIVE_SPEND_PROTECTION__:'true',__XMR20_FAST_SEND__:'true',
 __XMR20_UNIVERSAL_LINK__:'true',__XMR20_JOINT_PREVIEW__:'false',__XMR20_JOINT_MAINNET_REVIEW__:'true',__XMR20_JOINT_TRANSFERABLE_REVIEW__:'true',__XMR20_JOINT_PRIVATE_TEST__:'true',__XMR20_JOINT_WALLET_TEST__:'true',
 __XMR20_PRIVATE_FORMAT_TEST__:'true',__XMR20_PRIVATE_ENDPOINT__:JSON.stringify('https://api.xmr20.org/api/private-bridge'),__XMR20_PRIVATE_NODE__:JSON.stringify('https://api.xmr20.org/api/private-node'),
 __XMR20_PRIVATE_LAZY_REGISTER__:'true',__XMR20_PRIVATE_BRIDGE_MINT__:JSON.stringify('Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR')};
export const appOptions={bundle:true,format:'esm',platform:'browser',target:'chrome120',minify:true,inject:[join(engineDir,'shared/polyfill.js')],define,
 entryPoints:[join(here,'src/app.js')],plugins:[operatorConfigurationPlugin(true)],logLevel:'warning'};
async function hashes(directory,prefix=''){const out={};for(const e of await readdir(join(directory,prefix),{withFileTypes:true})){const name=join(prefix,e.name);if(e.isDirectory())Object.assign(out,await hashes(directory,name));else out[name]=sha(await readFile(join(directory,name)));}return out;}
export async function buildExtension({out=dist,quiet=false}={}){
 await rm(out,{recursive:true,force:true});await cp(join(here,'prebuilt'),out,{recursive:true});
 await copyFile(join(here,'manifest.json'),join(out,'manifest.json'));
 await require('esbuild').build({...appOptions,outfile:join(out,'app.js')});
 const tmp=join(out,'.engine-tmp'),engine=await buildEngine({out:tmp,quiet:true});await mkdir(join(out,'vendor'),{recursive:true});
 for(const f of Object.keys(engine.files))await copyFile(join(tmp,f),join(out,'vendor',f));await rm(tmp,{recursive:true,force:true});
 await writeFile(join(out,'style.css'),(await readFile(join(engineDir,'shared/extension-style.css'),'utf8'))+(await readFile(join(engineDir,'token/private-format.css'),'utf8')));
 const files=await hashes(out),version=JSON.parse(await readFile(join(out,'manifest.json'),'utf8')).version;
 if(!quiet)console.log(`XMR20 Wallet ${version} built in ${out} (${Object.keys(files).length} files, app.js ${files['app.js'].slice(0,16)}…). Load it in chrome://extensions with Developer mode → Load unpacked.`+(engine.differs.length?` Engine files that differ from 0.1.117: ${engine.differs.join(', ')}.`:''));
 return {version,files,engineDiffers:engine.differs};
}
if(process.argv[1]===import.meta.filename)await buildExtension();
