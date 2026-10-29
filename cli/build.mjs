// Prepares the CLI's private browser page in cli/.engine/ (run by `npm run setup`, and automatically when it is missing):
//   .engine/engine/   the engine files, built by engine/build.mjs (the same bytes the extension and xmr20.org use)
//   .engine/host.js   browser/host.js bundled with the token module and the Monero worker client
//   .engine/host.html the page that loads it
import {writeFile,mkdir,rm} from 'node:fs/promises';import {join} from 'node:path';import {createRequire} from 'node:module';
import {buildEngine} from '../engine/build.mjs';
const here=import.meta.dirname,out=join(here,'.engine'),require=createRequire(join(here,'package.json'));
// The token module's build settings, as in the extension and the website wallet (lazy bridge registration, the XMR20 mint).
export const define={__XMR20_PRIVATE_LAZY_REGISTER__:'true',__XMR20_PRIVATE_BRIDGE_MINT__:JSON.stringify('Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR'),
 __XMR20_NATIVE_COIN_SWAPS__:'false',__XMR20_OPERATOR_NATIVE__:'true',__XMR20_NATIVE_MARKET__:'false',__XMR20_NATIVE_SPEND_PROTECTION__:'true',__XMR20_FAST_SEND__:'false',
 __XMR20_UNIVERSAL_LINK__:'false',__XMR20_JOINT_PREVIEW__:'false',__XMR20_JOINT_MAINNET_REVIEW__:'false',__XMR20_JOINT_TRANSFERABLE_REVIEW__:'false',__XMR20_JOINT_PRIVATE_TEST__:'false',__XMR20_JOINT_WALLET_TEST__:'false'};
export async function buildCli({quiet=false}={}){
 await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
 const engine=await buildEngine({out:join(out,'engine'),quiet:true});
 await require('esbuild').build({entryPoints:[join(here,'browser/host.js')],outfile:join(out,'host.js'),bundle:true,format:'esm',platform:'browser',target:'chrome120',minify:true,
  define,inject:[join(here,'../engine/shared/polyfill.js')],logLevel:'warning'});
 await writeFile(join(out,'host.html'),'<!doctype html><html><head><meta charset="utf-8"><title>XMR20 CLI engine</title></head><body><script type="module" src="/host.js"></script></body></html>\n');
 if(!quiet)console.log(`CLI engine ready in ${out}${engine.differs.length?' (engine files differ from wallet 0.1.121: '+engine.differs.join(', ')+')':' (engine files identical to XMR20 Wallet 0.1.121)'}.`);
 return engine;
}
if(process.argv[1]===import.meta.filename)await buildCli();
