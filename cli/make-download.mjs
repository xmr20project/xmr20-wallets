// Makes the ready-to-run CLI download, cli/dist/xmr20-cli-<version>.zip (npm run download:cli, from the repository folder).
// It holds the CLI with its engine files already built (.engine/), so people who download it need neither this repository
// nor the engine build: unzip, `npm install`, `npm run setup` (downloads Playwright's Chromium), `./xmr20`.
//   bin/ src/ xmr20 .engine/   the CLI as it runs here after `npm run setup` (.engine/ is built by cli/build.mjs)
//   package.json               the CLI's own, with `setup` reduced to the browser download, plus the repository's overrides
//   package-lock.json          taken from the repository's lock file: the same dependency versions the tests here use
//   README.md, START-HERE.txt, LICENSE
// Stops if the engine files differ from the installed wallet's, or if the lock file misses a dependency.
import {cp,mkdir,rm,readFile,writeFile,copyFile,chmod,utimes,readdir} from 'node:fs/promises';import {join} from 'node:path';
import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {buildCli} from './build.mjs';
const here=import.meta.dirname,root=join(here,'..'),dist=join(here,'dist');
const pkg=JSON.parse(await readFile(join(here,'package.json'),'utf8')),rootPkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const name=`xmr20-cli-${pkg.version}`,stage=join(dist,name);
const engine=await buildCli({quiet:true});
if(engine.differs.length)throw Error('Engine files differ from the installed wallet: '+engine.differs.join(', '));
await rm(dist,{recursive:true,force:true});await mkdir(stage,{recursive:true});
for(const d of ['bin','src','.engine'])await cp(join(here,d),join(stage,d),{recursive:true});
await copyFile(join(here,'xmr20'),join(stage,'xmr20'));await chmod(join(stage,'xmr20'),0o755);
await copyFile(join(here,'README.md'),join(stage,'README.md'));await copyFile(join(root,'LICENSE'),join(stage,'LICENSE'));
const {scripts,...fields}=pkg;
const manifest={...fields,scripts:{setup:'playwright install chromium',start:'node bin/xmr20.mjs'},overrides:rootPkg.overrides};
await writeFile(join(stage,'package.json'),JSON.stringify(manifest,null,2)+'\n');
// Lock file: every package the CLI's dependencies reach, resolved the way Node does over the repository's lock file.
const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8')),all=lock.packages,picked={};
const resolve=(from,dep)=>{for(let base=from;;){const key=(base?base+'/':'')+'node_modules/'+dep;if(all[key])return key;if(!base)return null;const i=base.lastIndexOf('/node_modules/');base=i<0?'':base.slice(0,i);}};
const visit=(from,deps,optional)=>{for(const dep of Object.keys(deps||{})){const key=resolve(from,dep);
 if(!key){if(optional)continue;throw Error(`The repository's lock file has no ${dep} (needed by ${from||'the CLI'})`);}
 if(picked[key])continue;const {dev,devOptional,...entry}=all[key];picked[key]=entry;
 visit(key,entry.dependencies);visit(key,entry.optionalDependencies,true);visit(key,entry.peerDependencies,true);}};
visit('cli',pkg.dependencies);
const top={name:pkg.name,version:pkg.version,license:pkg.license,dependencies:pkg.dependencies,bin:pkg.bin,engines:pkg.engines};
await writeFile(join(stage,'package-lock.json'),JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,
 packages:{'':top,...Object.fromEntries(Object.keys(picked).sort().map(k=>[k,picked[k]]))}},null,2)+'\n');
await writeFile(join(stage,'START-HERE.txt'),`XMR20 terminal wallet (CLI) ${pkg.version} - ready-to-run download
=====================================================

Experimental software, real funds on Monero and Solana mainnet, no independent
security review. Use small amounts you can afford to lose.

The engine files are already built (the hidden .engine folder), so you don't
need the xmr20-wallets repository. You need Node.js 22.12 or newer from
https://nodejs.org (the "LTS" download).

1. Unzip this folder somewhere you will keep.
2. Open a terminal in it.
   Mac: open Terminal, type "cd " (with a space), drag the folder into the
   window, and press Enter.
   Windows: open the folder, click the address bar, type cmd, and press Enter.
3. Install its parts, once:              npm install
4. Download its browser engine, once:    npm run setup
   On Ubuntu 24.04 or newer, also allow its sandbox once: see
   "Linux: Ubuntu 24.04 and newer" in README.md.
5. Use it:                               ./xmr20 --help
                                         ./xmr20 create    (or ./xmr20 import)
                                         ./xmr20 balance
   On Windows, type  node bin/xmr20.mjs  instead of  ./xmr20

Your wallet is saved in ~/.xmr20-wallet, not in this folder, so you can replace
this folder with a newer download later. Every command is explained in
README.md (the same file as cli/README.md in
https://github.com/xmr20project/xmr20-wallets).

Never type your recovery phrase or Solana key into a command: the CLI asks for
them in hidden prompts.
`);
// Same timestamp on every file, so the zip only changes when its contents do.
const when=new Date('2026-10-28T00:00:00Z');
const stamp=async dir=>{for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await stamp(p);await utimes(p,when,when);}};
await stamp(stage);await utimes(stage,when,when);
const zip=join(dist,name+'.zip');execFileSync('zip',['-qrX',zip,name],{cwd:dist,env:{...process.env,TZ:'UTC'}});
const sha=createHash('sha256').update(await readFile(zip)).digest('hex');
console.log(`${zip}\nsha256 ${sha}\n${Object.keys(picked).length} locked packages; engine files identical to XMR20 Wallet 0.1.119.`);
