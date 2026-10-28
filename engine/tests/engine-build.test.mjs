// The engine build reproduces the files installed in XMR20 Wallet 0.1.118 byte for byte (both token workers, the holder
// engine, the parameter manifest, the Monero worker and the Monero library), so this source is what that wallet runs.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {buildEngine,INSTALLED} from '../build.mjs';
test('engine build is byte-identical to the installed wallet',{timeout:120000},async()=>{
 const out=await mkdtemp(join(tmpdir(),'xmr20-engine-'));
 try{const {files,differs}=await buildEngine({out,quiet:true});assert.deepEqual(differs,[]);assert.deepEqual(Object.keys(files).sort(),Object.keys(INSTALLED).sort());}
 finally{await rm(out,{recursive:true,force:true});}
});
