// Builds the Mordinals engine: the holder engine in ../crate plus mordinals_ops.rs (find this wallet's Mordinals on the public
// owner list, sign claims, and sign one-line Mordinals and XMR721 texts). The extension runs it as vendor/mordinals.wasm since
// 0.1.142 (the committed ../mordinals.wasm). Optional, for reviewers; needs Rust and the wasm32-unknown-unknown target.
//   node engine/holder-wasm/mordinals/build.mjs [--check]      (--check: cargo check only, no wasm file)
// The crate is copied to ./build, never edited in place. The copy gets mordinals_ops.rs, one module line in native.rs, one
// dispatch line in lib.rs, the engine info string's "mordinals":"local-candidate-2-xmr721" (what the installed engine reports),
// the package name xmr20-holder-wasm-mordinals and absolute paths for its path dependencies.
// A rebuilt file is not expected to be byte-identical to the committed one (Rust embeds source paths); from this layout the
// source was compile-checked (--check), not rebuilt and run.
import {readFile,writeFile,mkdir,rm,readdir,copyFile} from 'node:fs/promises';import {join,resolve,dirname} from 'node:path';import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';import {homedir} from 'node:os';import assert from 'node:assert/strict';
const here=import.meta.dirname,src=join(here,'../crate'),build=join(here,'build'),check=process.argv.includes('--check');
const one=(text,from,to,name)=>{assert.equal(text.split(from).length,2,name+': expected exactly one match: '+from);return text.replace(from,()=>to);};
await rm(join(build,'src'),{recursive:true,force:true});await mkdir(join(build,'src'),{recursive:true});
for(const f of await readdir(join(src,'src')))if(f.endsWith('.rs'))await copyFile(join(src,'src',f),join(build,'src',f));
await copyFile(join(here,'mordinals_ops.rs'),join(build,'src/mordinals_ops.rs'));
let toml=await readFile(join(src,'Cargo.toml'),'utf8'),n=0;
toml=toml.replace(/path = "([^"]+)"/g,(m,p)=>{n++;return `path = ${JSON.stringify(resolve(src,p))}`;});assert.equal(n,4,'Cargo.toml path dependencies');
toml=one(toml,'name = "xmr20-holder-wasm-market"','name = "xmr20-holder-wasm-mordinals"','Cargo.toml');await writeFile(join(build,'Cargo.toml'),toml);
await writeFile(join(build,'Cargo.lock'),one(await readFile(join(src,'Cargo.lock'),'utf8'),'name = "xmr20-holder-wasm-market"','name = "xmr20-holder-wasm-mordinals"','Cargo.lock'));
const nativeAt='#[path = "native_market.rs"]\npub mod market;\n';
await writeFile(join(build,'src/native.rs'),one(await readFile(join(build,'src/native.rs'),'utf8'),nativeAt,nativeAt+'#[path = "mordinals_ops.rs"]\nmod mordinals;\n','native.rs'));
const dispatchAt='            other if other.starts_with("market") => self.market_call(other, q),\n';
let lib=one(await readFile(join(build,'src/lib.rs'),'utf8'),dispatchAt,'            other if other.starts_with("mordinals") => self.native.as_ref().context("No native wallet")?.mordinals_call(other, q),\n'+dispatchAt,'lib.rs');
lib=one(lib,'"engine":"xmr20-holder-wasm 0.0.7-address-moves"','"engine":"xmr20-holder-wasm 0.0.7-address-moves","mordinals":"local-candidate-2-xmr721"','lib.rs');
await writeFile(join(build,'src/lib.rs'),lib);
// The same start blocks as holder.wasm (market, sign to move, sign to trade on mainnet). The home folder is written as /Users/user
// in the error-message paths, as in the committed files.
const env={...process.env,RUSTFLAGS:[process.env.RUSTFLAGS,'--remap-path-prefix='+homedir()+'=/Users/user'].filter(Boolean).join(' '),XMR20_MARKET_MAINNET_ACTIVATION:'3796100',XMR20_ADDRESS_MOVES_MAINNET_ACTIVATION:'3797288',XMR20_TRADES_MAINNET_ACTIVATION:'3797400'};
const r=spawnSync('cargo',[check?'check':'build','--release','--target','wasm32-unknown-unknown','--manifest-path',join(build,'Cargo.toml')],{stdio:'inherit',env});
if(r.status!==0){console.error('cargo failed');process.exit(r.status||1);}
if(check)console.log('Mordinals engine source compiles (cargo check).');
else{const out=join(process.env.CARGO_TARGET_DIR||join(build,'target'),'wasm32-unknown-unknown/release/xmr20_holder_wasm_mordinals.wasm');
 console.log(`Built ${out} (sha256 ${createHash('sha256').update(await readFile(out)).digest('hex').slice(0,16)}…).`);}
