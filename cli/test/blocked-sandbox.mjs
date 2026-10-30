// Linux only, run by the GitHub workflow BEFORE Chromium's sandbox is allowed: on Ubuntu 24.04, where AppArmor blocks the
// user namespaces the sandbox needs, starting the engine must stop with the sandbox explanation, not "npm run setup".
// Elsewhere it has nothing to check. Offline: sends nothing.
import assert from 'node:assert/strict';import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {startEngine} from '../src/engine.mjs';
const blocked=await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns','utf8').then(v=>v.trim()==='1',()=>false);
if(!blocked){console.log('This system does not block the sandbox; nothing to check.');process.exit(0);}
const dir=await mkdtemp(join(tmpdir(),'xmr20-cli-sandbox-'));
try{await assert.rejects(startEngine(join(dir,'w'),{fetcher:async()=>{throw Error('offline test');}}),/security sandbox.*Linux: Ubuntu 24\.04 and newer/);
 console.log('The blocked sandbox is explained.');}
finally{await rm(dir,{recursive:true,force:true});}
