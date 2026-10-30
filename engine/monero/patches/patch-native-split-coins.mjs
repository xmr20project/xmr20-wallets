// Native worker: Split into N coins (owner, 28 Oct 2026: "the split button should be to split the monero balance into smaller amounts,
// so that they can be used for private transfers … from 2 to 20 slots (or however many they are able to) but require a minimum
// balance"; "to allow people to use their monero balance for multiple smaller transactions at once, rather than waiting 10
// confirmations"). prepareSplit takes `coins` (2..16: Monero allows 16 outputs per transaction): coins-1 equal payments to this
// wallet's own address plus the change, behind the same guards; it never relays. Without `coins` it makes 3, as before ("Enable
// private transfers"). Applied after patch-native-split.mjs to the website copy and to the extension's vendor/native.worker.js;
// fails unless each anchor appears exactly once.
import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import assert from 'node:assert/strict';
export async function patchNativeSplitCoins(dir){
 const file=join(dir,'native.worker.js');let s=await readFile(file,'utf8');
 if(s.includes('Choose between 2 and 16 coins.'))return 'already';
 const edit=(old,neu)=>{assert.equal(s.split(old).length,2,'native.worker.js: anchor not found exactly once');s=s.replace(old,neu);};
 edit("   const unlocked=BigInt(await wallet.getUnlockedBalance()),part=unlocked/3n;\n   if(part<200000000n){const error=Error('You need at least 0.0006 unlocked XMR to make 3 coins. Receive more XMR, or wait until incoming XMR unlocks (10 confirmations).');error.code='split-too-small';throw error;}\n   const tx=await wallet.createTx({accountIndex:0,destinations:[{address:own,amount:part},{address:own,amount:part}],relay:false});",
`   // 28 Oct 2026: \`coins\` (2..16) = coins-1 equal payments to this wallet plus the change; 3 when omitted.
   const coins=data.coins===undefined?3:data.coins;
   if(!Number.isInteger(coins)||coins<2||coins>16){const error=Error('Choose between 2 and 16 coins.');error.code='split-coins';throw error;}
   const unlocked=BigInt(await wallet.getUnlockedBalance()),part=unlocked/BigInt(coins);
   if(part<200000000n){const need=(Number(200000000n*BigInt(coins))/1e12).toFixed(4).replace(/0+$/,'').replace(/\\.$/,'');const error=Error('You need at least '+need+' unlocked XMR to make '+coins+' coins. Receive more XMR, or wait until incoming XMR unlocks (10 confirmations).');error.code='split-too-small';throw error;}
   const tx=await wallet.createTx({accountIndex:0,destinations:Array.from({length:coins-1},()=>({address:own,amount:part})),relay:false});`);
 edit("   if(destinations.length!==2||destinations.some(d=>d.getAddress()!==own||BigInt(d.getAmount())!==part)||tx.getIsRelayed())throw Error('Transfer mismatch');\n   const feeRaw=String(tx.getFee()),hash=tx.getHash(),amountRaw=String(part*2n);",
      "   if(destinations.length!==coins-1||destinations.some(d=>d.getAddress()!==own||BigInt(d.getAmount())!==part)||tx.getIsRelayed())throw Error('Transfer mismatch');\n   const feeRaw=String(tx.getFee()),hash=tx.getHash(),amountRaw=String(part*BigInt(coins-1));");
 edit("   result={id,to:own,amountRaw,partRaw:String(part),coins:3,unlockedRaw:String(unlocked),feeRaw,hash,expires:pending.expires};",
      "   result={id,to:own,amountRaw,partRaw:String(part),coins,unlockedRaw:String(unlocked),feeRaw,hash,expires:pending.expires};");
 edit("  if(error?.code==='split-too-small'){post({id:data.id,error:error.message,code:error.code})",
      "  if(error?.code==='split-too-small'||error?.code==='split-coins'){post({id:data.id,error:error.message,code:error.code})");
 await writeFile(file,s);return 'patched';
}
