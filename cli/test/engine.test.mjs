// The CLI's private browser, offline: it starts, loads the shared engine, makes and restores Monero keys locally, and blocks
// a request outside its allowlist. Needs "npm run setup" once (it downloads Playwright's Chromium). Sends nothing.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {startEngine} from '../src/engine.mjs';
test('engine starts, creates and restores Monero keys locally, blocks other hosts',{timeout:240000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'xmr20-cli-engine-'));const asked=[];
 const engine=await startEngine(join(dir,'w'),{fetcher:async url=>{asked.push(String(url));throw Error('offline test');}});
 try{const made=await engine.call('cli.keys','create','');assert.equal(made.address.length,95);assert.equal(made.seed.split(' ').length,25);
  const again=await engine.call('cli.keys','restore',made.seed);assert.equal(again.address,made.address);
  await assert.rejects(engine.call('cli.keys','restore','not a phrase'),/25-word/);
  const blocked=await engine.call('fetch','https://example.com/').then(()=>'reached',e=>'blocked: '+e.message);assert.match(blocked,/^blocked/);
  assert.ok(!asked.some(u=>u.startsWith('https://example.com')),'blocked host was fetched');
 }finally{await engine.close();await rm(dir,{recursive:true,force:true});}
});
