// Unit tests (no network, no browser): command parsing, amounts, the encrypted wallet file and the network allowlist.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {parse,walletId} from '../src/cli.mjs';
import {checkAmount,formatUnits} from '../src/amount.mjs';
import {seal,unseal,saveWallet,loadWallet,SCHEMA,checkWallet} from '../src/store.mjs';
import {moneroRequest,forwardRequest} from '../src/network.mjs';
const sample={schema:SCHEMA,id:'cli-'+'0'.repeat(24),xmr:{address:'4'+'1'.repeat(94),seed:Array(25).fill('abbey').join(' '),restoreHeight:3772610},sol:{address:'11111111111111111111111111111111',secret:'sample-not-a-key'}};
test('commands need their options and never take secrets as arguments',()=>{
 assert.equal(parse(['balance']).command,'balance');
 assert.deepEqual(parse(['send','--token','XMR20','--to','4abc','--amount','1.5','--private']).options.private,true);
 assert.throws(()=>parse(['send','--token','XMR20','--amount','1']),/--to/);
 assert.throws(()=>parse(['send','--to','x','--amount','1']),/--token/);
 assert.throws(()=>parse(['send-xmr','--to','x']),/--amount/);
 assert.throws(()=>parse(['send-xmr','--to','x','--amount','1','--max']),/--amount/);
 assert.throws(()=>parse(['import','--seed','abbey abbey']),/Never put/);
 assert.throws(()=>parse(['balance','--amount','1']),/does not apply/);
 assert.throws(()=>parse(['make-private','--token','XMR20','--amount','1e5']),/plain number/);
 assert.equal(parse(['wallet','create']).command,'create');assert.equal(parse(['wallet','seed']).command,'phrase');
 assert.deepEqual(parse(['pending','publish','abc','--token','XMR20']).args,['abc']);
 assert.equal(parse(['enable-private','--token','XMR20']).command,'enable-private');
});
test('amounts are exact',()=>{
 assert.equal(checkAmount('0.000000000001',12),'1');assert.equal(checkAmount('1.5',12),'1500000000000');
 assert.throws(()=>checkAmount('0',12),/greater than zero/);assert.throws(()=>checkAmount('0.0000000000001',12),/plain number/);assert.throws(()=>checkAmount('0.0000001',6),/decimal places/);
 assert.equal(checkAmount('10'),'10');assert.equal(formatUnits('1234567890',6),'1,234.56789');assert.equal(formatUnits('5',12),'0.000000000005');
});
test('wallet ids depend only on the two public addresses',()=>{assert.equal(walletId('a','b'),walletId('a','b'));assert.notEqual(walletId('a','b'),walletId('a','c'));assert.match(walletId('a','b'),/^cli-[0-9a-f]{24}$/);});
test('the wallet file is encrypted, private and rejects a wrong password',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'xmr20-cli-test-'));
 try{await saveWallet(dir,sample,'correct horse battery',{exclusive:true});const raw=await readFile(join(dir,'wallet.json'),'utf8');
  assert.ok(!raw.includes('abbey')&&!raw.includes('sample-not-a-key'));if(process.platform!=='win32')assert.equal((await stat(join(dir,'wallet.json'))).mode&0o777,0o600);
  assert.deepEqual(await loadWallet(dir,'correct horse battery'),sample);
  await assert.rejects(loadWallet(dir,'wrong password!!'),/Could not unlock/);
  await assert.rejects(saveWallet(dir,sample,'correct horse battery',{exclusive:true}));
 }finally{await rm(dir,{recursive:true,force:true});}
 await assert.rejects(seal({},'short'),/12/);assert.throws(()=>checkWallet({...sample,xmr:{...sample.xmr,seed:'too few'}}),/Unsupported/);
 assert.deepEqual(await unseal(await seal({a:1},'twelve chars!'),'twelve chars!'),{a:1});
});
test('the private browser reaches only the allowed Monero and api.xmr20.org paths',()=>{
 assert.ok(moneroRequest('https://xmr-node.cakewallet.com:18081/get_info','GET'));assert.equal(moneroRequest('https://xmr-node.cakewallet.com:18081/send_raw_transaction','POST').relay,true);
 assert.equal(moneroRequest('https://xmr-node.cakewallet.com:18081/stop_daemon','POST'),null);assert.equal(moneroRequest('https://example.com/get_info','GET'),null);
 assert.equal(moneroRequest('https://api.xmr20.org/api/wallet','POST'),null);
 assert.equal(forwardRequest('/api/private-bridge/action/state','POST').url,'https://api.xmr20.org/api/private-bridge/action/state');
 assert.equal(forwardRequest('/api/private-bridge/action/state','GET'),null);assert.equal(forwardRequest('/api/private-bridge/action/mine','POST'),null);
 assert.equal(forwardRequest('/api/private-bridge/params/mainnet-v1/spend_pk.bin','GET').kind,'parameters');assert.equal(forwardRequest('/api/private-bridge/../x','GET'),null);
 assert.equal(forwardRequest('/api/private-node/json_rpc','POST').kind,'node');assert.equal(forwardRequest('/api/private-node/stop_daemon','POST'),null);
 assert.equal(forwardRequest('/api/wallet','POST'),null);
});
