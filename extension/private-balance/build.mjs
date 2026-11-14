// Rebuilds private-balance.js, the private transfers of the Chrome extension (the screens in src/ and Helius's Solana Privacy
// Rings SDK in one ES module, which the popup loads only when needed), with the settings of extension 0.1.142–0.1.143, and
// compares it with the file the extension build uses, ../prebuilt/private-balance.js.
//   npm run build:private-balance        (from the repository folder: installs this folder's dependencies, then runs this)
// This folder has its own package.json and package-lock.json and is not an npm workspace. The SDK needs @noble/curves 2.x
// while the rest of the wallets use 1.9.7; installed on its own, every library is one copy in the bundle, as in the release.
import {readFile,mkdir} from 'node:fs/promises';import {createHash} from 'node:crypto';import {join} from 'node:path';import {createRequire} from 'node:module';
const here=import.meta.dirname,sha=b=>createHash('sha256').update(b).digest('hex');
// The XMR20 gateway that adds the Helius key server-side (the popup never holds it), mainnet, Solscan links, and token discovery
// (any Solana token the address holds can be moved in, sent and withdrawn).
export const config={endpoint:'https://api.xmr20.org/api/private-balance/',network:'mainnet',testMint:null,explorer:'https://solscan.io/tx/{sig}',discover:true};
export const options={bundle:true,format:'esm',platform:'browser',target:'chrome120',minify:true,legalComments:'none',logLevel:'warning',
 define:{__XMR20_PRIVATE_BALANCE__:JSON.stringify(config)},entryPoints:[join(here,'src/private-screens.js')]};
export async function buildPrivateBalance({outfile=join(here,'dist/private-balance.js')}={}){
 // esbuild of the extension workspace (the same version the extension build uses).
 const {build}=createRequire(join(here,'../package.json'))('esbuild');
 await mkdir(join(outfile,'..'),{recursive:true});await build({...options,outfile});
 const built=sha(await readFile(outfile)),prebuilt=sha(await readFile(join(here,'../prebuilt/private-balance.js')));
 return {outfile,sha256:built,sameAsPrebuilt:built===prebuilt};
}
if(process.argv[1]===import.meta.filename){const r=await buildPrivateBalance();
 console.log(r.sameAsPrebuilt?`private-balance.js rebuilt in ${r.outfile}: byte-identical to extension/prebuilt/private-balance.js (${r.sha256.slice(0,16)}…).`
  :`private-balance.js rebuilt in ${r.outfile} (${r.sha256.slice(0,16)}…) DIFFERS from extension/prebuilt/private-balance.js.`);
 if(!r.sameAsPrebuilt)process.exitCode=1;}
