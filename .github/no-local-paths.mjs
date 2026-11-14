// Fails if any file in the repository, text or binary, contains a home-folder path of the computer it was made on
// ("/Users/<name>/…" or "/home/<name>/…"). Rust engines write such paths into their error messages unless they are built with
// --remap-path-prefix (see engine/holder-wasm/README.md). Allowed: "/Users/user" (the cleaned engines) and "/home/web_user"
// (the Monero library's built-in default).
//   node .github/no-local-paths.mjs
import {execFileSync} from 'node:child_process';import {readFileSync} from 'node:fs';
const ALLOWED=new Set(['user','web_user']),PATH=/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g,found=[];
for(const file of execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean)){
 const text=readFileSync(file).toString('latin1');
 for(const m of text.matchAll(PATH))if(!ALLOWED.has(m[1]))found.push(`${file}: ${m[0]}`);}
if(found.length){console.error('Local home-folder paths found:\n'+[...new Set(found)].join('\n'));process.exit(1);}
console.log('No local home-folder paths in the repository files.');
