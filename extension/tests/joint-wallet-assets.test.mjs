import test from 'node:test';
import assert from 'node:assert/strict';
import {walletBridgeAssets,hasBridgeRecovery} from '../../engine/shared/joint-wallet-assets.js';
import {XMR20_MINT,XCAT_MINT} from '../../engine/shared/joint-bridge-assets.js';
const extra='11111111111111111111111111111111';

test('only positive Solana or new-bridge Monero holdings enter discovery; metadata never adds tokens',()=>{
 const assets=walletBridgeAssets([
  {network:'solana',mint:XCAT_MINT,amountRaw:'12'},
  {network:'monero',bridge:'joint-v3',mint:extra,amountRaw:'1',ticker:'Other'},
  {network:'monero',mint:XMR20_MINT,amountRaw:'500'},
  {network:'solana',mint:XMR20_MINT,amountRaw:'0'},
  {network:'solana',mint:XMR20_MINT,amountRaw:'1e6'},
 ],{metadata:[{mint:XMR20_MINT,name:'Catalog only'}]});
 assert.deepEqual(assets.map(a=>a.mint),[XCAT_MINT,extra]);assert.equal(walletBridgeAssets([]).length,0);
});
test('pending recovery and an already active selection survive a zero balance',()=>{
 const assets=walletBridgeAssets([],{recoveryMints:[XCAT_MINT],selectedMint:extra});
 assert.deepEqual(assets.map(a=>a.mint),[XCAT_MINT,extra]);
});
test('completed return receipts do not add a token but unresolved native or Solana approvals do',()=>{
 const receipt={proofs:{a:{envelope:{record:{op:'burn'}}}},operations:{a:{proposal:{operation:'release',nonce:'a'},phase:'finalized'}}};
 assert.equal(hasBridgeRecovery(receipt),false);receipt.operations.a.phase='submission-unknown';assert.equal(hasBridgeRecovery(receipt),true);
 delete receipt.operations.a;assert.equal(hasBridgeRecovery(receipt),true);
 assert.equal(hasBridgeRecovery({operations:{a:{proposal:{operation:'register'},phase:'finalized',background:{phase:'complete'}}}}),false);
 assert.equal(hasBridgeRecovery({operations:{a:{proposal:{operation:'deposit'},phase:'finalized',background:{phase:'monero-pending'}}}}),true);
});
test('catalog fills a generic owned label but cannot replace a known holding name or add another mint',()=>{
 const metadata=[{mint:extra,ticker:'COVERT',name:'Covert'},{mint:XMR20_MINT}];
 const generic=walletBridgeAssets([{mint:extra,network:'solana',amountRaw:'5',ticker:'Token'}],{metadata});
 assert.equal(generic.length,1);assert.equal(generic[0].symbol,'COVERT');
 const named=walletBridgeAssets([{mint:extra,network:'solana',amountRaw:'5',ticker:'Held',name:'Owned name'}],{metadata});
 assert.equal(named[0].symbol,'Held');assert.equal(named[0].name,'Owned name');
});
