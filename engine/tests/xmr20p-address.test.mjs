// xmr20p1 private addresses (wallet-extension/src/token-format.js): bech32m per BIP-350 without the 90-character limit;
// penumbra1… ⇄ xmr20p1… keeps the exact address bytes; a mistyped xmr20p1… is refused.
//   node --test engine/tests/xmr20p-address.test.mjs
import test from 'node:test';import assert from 'node:assert/strict';
const m=await import('../token/token-format.js');
// Penumbra's own example addresses (embedded in penumbra-sdk-keys).
const PENUMBRA=['penumbra147mfall0zr6am5r45qkwht7xqqrdsp50czde7empv7yq2nk3z8yyfh9k9520ddgswkmzar22vhz9dwtuem7uxw0qytfpv7lk3q9dp8ccaw2fn5c838rfackazmgf3ahh09cxmz',
 'penumbra1vmmz304hjlkjq6xv4al5dqumvgk3ek82rneagj07vdqkudjvl6y7zxzr5k6qq24yc7yyyekpu9qm7ef3acg2u8p950hs6hu3e73guq5pfmmvm63qudfx4qmg8h7fdweyw3ektn'];
test('BIP-350 bech32m vectors',()=>{
 for(const v of ['a1lqfn3a','abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx','split1checkupstagehandshakeupstreamerranterredcaperredlc445v','?1v759aa'])assert.ok(m.bech32mDecode(v),v);
 assert.equal(m.bech32mDecode('a1lqfn3b'),null);// wrong checksum
 assert.equal(m.bech32mDecode('abc1rzg'),null);// too short
 const d=m.bech32mDecode('abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx');assert.equal(m.bech32mEncode(d.hrp,d.data),'abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx');
});
test('penumbra1 ⇄ xmr20p1 keeps the address bytes',()=>{
 for(const p of PENUMBRA){
  const d=m.bech32mDecode(p);assert.equal(d.hrp,'penumbra');
  const shown=m.shownPrivateAddress(p);assert.ok(shown.startsWith('xmr20p1'));assert.deepEqual(m.bech32mDecode(shown).data,d.data);
  assert.equal(m.enginePrivateAddress(shown),p);assert.equal(m.enginePrivateAddress(p),p);
 }
 assert.equal(m.shownPrivateAddress('xmr20t1abc'),'xmr20t1abc');assert.equal(m.shownPrivateAddress(''),'');
});
test('a mistyped xmr20p1 address is refused',()=>{
 const shown=m.shownPrivateAddress(PENUMBRA[0]);const typo=shown.slice(0,20)+(shown[20]==='q'?'p':'q')+shown.slice(21);
 assert.throws(()=>m.enginePrivateAddress(typo),/mistyped/);
});
