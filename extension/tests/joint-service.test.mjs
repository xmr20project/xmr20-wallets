import test from 'node:test';
import assert from 'node:assert/strict';
import {jointService,bridgeConnectionMessage} from '../../engine/shared/joint-service.js';
test('installable bridge profile uses hosted HTTPS for actions and finalized reads',()=>{
 assert.deepEqual(jointService({walletTest:true,privateTest:true}),{endpoint:'https://api.xmr20.org',rpcEndpoint:'https://api.xmr20.org/api/bridge-solana-read'});
});
test('private and local reviews retain their explicit local services',()=>{
 assert.equal(jointService({privateTest:true}).endpoint,'http://127.0.0.1:8933');
 assert.equal(jointService().rpcEndpoint,'http://127.0.0.1:8928/api/solana-read');
});
test('website adapter retains its explicit same-origin endpoint',()=>{
 assert.equal(jointService({walletTest:true,endpoint:''}).endpoint,'');
});
test('network errors explain recovery without hiding protocol validation failures',()=>{
 assert.match(bridgeConnectionMessage(new TypeError('Failed to fetch')),/saved approvals are kept/);
 assert.equal(bridgeConnectionMessage(new Error('Changed bridge deployment.')),'Changed bridge deployment.');
});
test('an unlinked Monero recipient explains how to become eligible without claiming a submission',()=>{
 const message=bridgeConnectionMessage(Error('Registered recipient required.'));
 assert.match(message,/Check the recipient’s wallet link and token account/);
 assert.match(message,/they do not need to link again/);
 assert.doesNotMatch(message,/submitted|network error|try again/);
 assert.equal(bridgeConnectionMessage(Error('Choose a different linked Monero wallet.')),'Choose a different linked Monero wallet.');
});
test('service verification failures and timeouts are not described as connection failures',()=>{
 const service=bridgeConnectionMessage(new Error('Transferable service unavailable. Keep the public recovery receipt.'));
 assert.match(service,/could not finish this request/);assert.doesNotMatch(service,/could not reach/);
 const timeout=bridgeConnectionMessage(new DOMException('SYNTHETIC_PRIVATE_DETAIL','TimeoutError'));
 assert.match(timeout,/took too long to respond/);assert.match(timeout,/Check status before approving again/);assert.doesNotMatch(timeout,/PRIVATE|Nothing was submitted/);
 const verification='The bridge could not verify this request. Your saved approvals are kept. Check status before approving again.';
 assert.equal(bridgeConnectionMessage(Object.assign(Error(verification),{code:'bridge-verification-unavailable'})),verification);
});
