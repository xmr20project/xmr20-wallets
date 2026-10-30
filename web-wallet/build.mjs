// Production build of the website wallet into web-wallet/dist/ (served at /wallet/ on xmr20.org).
//   npm run build:web   (from the repository folder)
// Release flags of the live xmr20.org wallet. The local-preview banner and the design preview stay off.
import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const here=import.meta.dirname;
for(const k of ['VITE_XMR20_DESIGN_PREVIEW','VITE_XMR20_LOCAL_WALLET_LIVE'])delete process.env[k];
Object.assign(process.env,{XMR20_OPERATOR_NATIVE_CANDIDATE:'1',VITE_XMR20_PUBLIC_LAUNCH:'1',XMR20_UNIVERSAL_LINK:'1',XMR20_FAST_SEND:'1'});
const prep=spawnSync(process.execPath,[join(here,'prepare-public.mjs')],{stdio:'inherit'});if(prep.status!==0)process.exit(prep.status||1);
process.chdir(here);
const {build}=await import('vite');
await build({root:here,configFile:join(here,'vite.config.js'),configLoader:'native',envFile:false});
console.log('Website wallet built in web-wallet/dist/ (open it through a web server at /wallet/wallet.html).');
