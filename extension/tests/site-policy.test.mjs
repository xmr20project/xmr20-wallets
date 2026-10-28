import test from 'node:test';import assert from 'node:assert/strict';
import {siteSender,signInMessage,publicAccount,vaultUnlockMessage} from '../src/site-policy.js';
const source={url:'https://xmr20.org/index',origin:'https://xmr20.org',frameId:0,tab:{id:8},documentId:'document-a'};
const now=Date.now(),wallet='11111111111111111111111111111111';
const message=`Sign in to XMR20\nWebsite: https://xmr20.org\nWallet: ${wallet}\nNonce: 00000000-0000-0000-0000-000000000000\nIssued: ${new Date(now).toISOString()}\nExpires: ${new Date(now+300000).toISOString()}\nThis signature proves wallet ownership. It does not authorize a transaction.`;
test('website requests require exact HTTPS origin and top-level document',()=>{assert.equal(siteSender(source).tabId,8);for(const bad of [{...source,url:'https://xmr20.org.evil.test/'},{...source,url:'http://xmr20.org/'},{...source,origin:'https://evil.test'},{...source,frameId:2},{...source,id:'extension'},{...source,documentId:null}])assert.throws(()=>siteSender(bad));});
test('only bounded, fresh, account-bound sign-in text can be signed',()=>{assert.equal(signInMessage(message,wallet,now),message);for(const bad of [message+'\nPay someone',message.replace(wallet,'other'),message.replace('https://xmr20.org','https://evil.test'),message.replace('Sign in','Transfer tokens'),message.replace('Nonce: ','Nonce: BAD'),message.replace('Expires: ','ExpiresX ')])assert.throws(()=>signInMessage(bad,wallet,now));assert.throws(()=>signInMessage(message,wallet,now+300001));assert.throws(()=>signInMessage(message,wallet,now-60000));});
test('site-visible account objects never contain secrets or vault metadata',()=>{const result=publicAccount({id:'a',name:'Account',sol:wallet,xmr:'public-monero',solSecret:'SECRET',xmrSeed:'SEED',password:'PASSWORD',height:123});assert.deepEqual(Object.keys(result),['id','name','solana','monero','canSign']);assert.ok(!JSON.stringify(result).includes('SECRET'));});
test('local sign-in review origin is allowed only on port 8893 and never shares the production scope',()=>{
 const local='http://127.0.0.1:8893',sender={...source,url:local+'/',origin:local};assert.equal(siteSender(sender).origin,local);
 const localMessage=message.replace('https://xmr20.org',local);
 assert.equal(signInMessage(localMessage,wallet,now,local),localMessage);
 assert.throws(()=>signInMessage(localMessage,wallet,now,'https://xmr20.org'));
 assert.throws(()=>signInMessage(message,wallet,now,local));
 for(const origin of ['http://127.0.0.1:8894','http://localhost:8893','http://192.168.1.1:8893'])assert.throws(()=>siteSender({...sender,url:origin+'/',origin}));
});
test('market port permits a top-level connection but cannot use sign-in signatures',()=>{
 const origin='http://127.0.0.1:8897';assert.equal(siteSender({...source,url:origin+'/market/',origin}).origin,origin);
 assert.throws(()=>signInMessage(message.replace('https://xmr20.org',origin),wallet,now,origin));
 for(const wrong of ['http://localhost:8897','http://127.0.0.1:8898'])assert.throws(()=>siteSender({...source,url:wrong+'/market/',origin:wrong}));
});

const monero='4AMg1kDaXkWckE3uyd1YqoBKvn4z8ATxmWQVdtjF6aGU4sT278XoyhUV1Ve88ZMCXNXQJpjW2553NWERfMZcNsBtCkMLiNM';
const unlock=`XMR20: unlock my saved Monero wallet\n\nThis approval unlocks Monero signing keys stored on this device. Only approve on https://xmr20.org. Never share this signature.\n\nWallet: ${wallet}\nMonero address: ${monero}\nNetwork: mainnet\nBackup ID: ${btoa('a'.repeat(32))}\nVersion: 1`;
test('vault unlock binds exact origin owner linked address network version and canonical backup salt',()=>{
 const a={solana:wallet,monero};assert.equal(vaultUnlockMessage(unlock,a).address,monero);
 for(const bad of [unlock+'\n',unlock.replace('Version: 1','Version: 2'),unlock.replace('mainnet','stagenet'),unlock.replace('https://xmr20.org','https://evil.test'),unlock.replace(monero,monero.slice(0,-1)+'1'),unlock.replace(btoa('a'.repeat(32)),btoa('a'.repeat(31))),unlock.replace(wallet,'wrong'),unlock.replace('Backup ID: ','Backup ID: !'),unlock.replace('Never share this signature.','Please send funds.')])assert.throws(()=>vaultUnlockMessage(bad,a));
 assert.throws(()=>vaultUnlockMessage(unlock,{...a,monero:'other'}));assert.throws(()=>vaultUnlockMessage(unlock,a,'http://127.0.0.1:8897'));
});
