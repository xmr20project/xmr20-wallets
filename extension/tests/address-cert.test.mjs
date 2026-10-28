import test from 'node:test';
import assert from 'node:assert/strict';
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {signCertificate,verifyCertificate,moneroSpendKey,isMoneroAddress} from '../../engine/token/address-cert.js';
// Synthetic Monero keys: a standard mainnet address from a random spend key (view key = Hs(spend), as Monero derives it).
const L=ed25519.CURVE.n,G=ed25519.ExtendedPoint.BASE;const le=b=>{let n=0n;for(let i=b.length-1;i>=0;i--)n=(n<<8n)|BigInt(b[i]);return n;};const leBytes=n=>{const o=new Uint8Array(32);for(let i=0;i<32;i++){o[i]=Number(n&255n);n>>=8n;}return o;};
const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encode(bytes){let out='';for(let i=0;i<bytes.length;i+=8){const block=bytes.slice(i,i+8);let n=0n;for(const x of block)n=(n<<8n)|BigInt(x);const size={1:2,2:3,3:5,4:6,5:7,6:9,7:10,8:11}[block.length];let s='';for(let j=0;j<size;j++){s=A[Number(n%58n)]+s;n/=58n;}out+=s;}return out;}
function account(prefix=18){const b=le(crypto.getRandomValues(new Uint8Array(64)))%L;const spend=leBytes(b);const v=le(keccak_256(spend))%L;const body=Uint8Array.from([prefix,...G.multiply(b).toRawBytes(),...G.multiply(v).toRawBytes()]);return {spend,address:encode(Uint8Array.from([...body,...keccak_256(body).slice(0,4)]))};}
const owner='ab'.repeat(32),other='cd'.repeat(32),dom='12'.repeat(32),dom2='34'.repeat(32);
test('a certificate signed by the address owner verifies; the address decodes to its spend key',()=>{const a=account();assert.equal(a.address[0],'4');assert.ok(isMoneroAddress(a.address));
 const c=signCertificate({monero:a.address,ownerKey:owner,domain:dom,spendKey:a.spend});assert.equal(verifyCertificate(c,{domain:dom}),true);assert.equal(verifyCertificate(c,{domain:dom2}),false,'another ledger');assert.equal('tokenAddress' in c||'shielded' in c,false,'no private address in a certificate');assert.equal(moneroSpendKey(a.address).length,32);});
test('another key, a changed token address or a changed Monero address is rejected',()=>{const a=account(),b=account();
 assert.throws(()=>signCertificate({monero:a.address,ownerKey:owner,domain:dom,spendKey:b.spend}),/does not belong/);
 const c=signCertificate({monero:a.address,ownerKey:owner,domain:dom,spendKey:a.spend});const v=x=>verifyCertificate(x,{domain:dom});
 assert.equal(v({...c,ownerKey:other}),false);assert.equal(v({...c,monero:b.address}),false);assert.equal(v({...c,domain:dom2}),false);
 assert.equal(v({...c,s:'00'.repeat(32)}),false);assert.equal(v({...c,c:'zz'}),false);assert.equal(v(null),false);});
test('stagenet addresses are refused on mainnet and accepted on stagenet',()=>{const s=account(24);assert.equal(s.address[0],'5');assert.equal(isMoneroAddress(s.address),false);assert.equal(isMoneroAddress(s.address,'stagenet'),true);
 const c=signCertificate({monero:s.address,ownerKey:owner,domain:dom,spendKey:s.spend,network:'stagenet'});assert.equal(verifyCertificate(c,{network:'stagenet',domain:dom}),true);assert.equal(verifyCertificate(c,{domain:dom}),false);});
test('a wrong checksum or a non-standard length is refused',()=>{const a=account();const bad=a.address.slice(0,-1)+(a.address.at(-1)==='a'?'b':'a');assert.equal(isMoneroAddress(bad),false);assert.equal(isMoneroAddress(a.address.slice(0,94)),false);});
