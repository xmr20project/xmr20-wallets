// Read-only mainnet check with a THROWAWAY test account: imports it into a temporary wallet folder, syncs XMR and XMR20 with
// the shared engine, and prints the balances. It never approves, signs or sends anything, and never prints keys.
// (Opening the token wallet publishes the account's signed address-book entry to the bridge, as every wallet open does.)
//   node test/readonly-scan.mjs /path/to/test-account.json [result.json]
// The account file holds {"T":{"seed":"25 words","solSecret":"base58","height":3792000}} (height optional).
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
import {Keypair} from '@solana/web3.js';import bs58 from 'bs58';
import {startEngine} from '../src/engine.mjs';import {saveWallet,SCHEMA} from '../src/store.mjs';import {walletId} from '../src/cli.mjs';import {formatUnits} from '../src/amount.mjs';
const [file,resultFile]=process.argv.slice(2);if(!file)throw Error('Give the test account file.');
const T=JSON.parse(await readFile(file,'utf8')).T;const dir=await mkdtemp(join(tmpdir(),'xmr20-cli-readonly-'));const started=Date.now();const result={startedAt:new Date().toISOString(),stages:{}};
const lap=name=>{result.stages[name]=Math.round((Date.now()-started)/1000);};
let engine;
try{engine=await startEngine(join(dir,'w'),{onProgress:t=>process.stderr.write('  … '+t+'\n'),onRelay:()=>{result.relayAttempted=true;return false;}});
 const keys=await engine.call('cli.keys','restore',T.seed);lap('keys');
 const key=Keypair.fromSecretKey(bs58.decode(T.solSecret));
 const wallet={schema:SCHEMA,id:walletId(key.publicKey.toBase58(),keys.address),created:new Date().toISOString(),xmr:{address:keys.address,seed:keys.seed,restoreHeight:Number(T.height)||3792000},sol:{address:key.publicKey.toBase58(),secret:bs58.encode(key.secretKey)}};
 await saveWallet(join(dir,'w'),wallet,randomBytes(18).toString('hex'),{exclusive:true});
 const opened=await engine.call('cli.open',{wallet,cache:null});result.addressMatches=opened.address===wallet.xmr.address;lap('open');
 const xmr=await engine.call('cli.xmrSync',{first:true});lap('xmrSync');
 const tokens=await engine.call('cli.tokensSync');lap('tokensSync');
 Object.assign(result,{ok:!tokens.error&&tokens.ready&&!result.relayAttempted,xmr:{balance:formatUnits(xmr.balanceRaw,12),unlocked:formatUnits(xmr.unlockedRaw??xmr.balanceRaw,12)},
  tokens:{error:tokens.error,tip:tokens.tip,network:tokens.network,bridgeTokens:tokens.tokens.length,held:tokens.tokens.filter(t=>BigInt(t.open)+BigInt(t.private)>0n).map(t=>({symbol:t.symbol,open:formatUnits(t.open,t.decimals),private:formatUnits(t.private,t.decimals)})),
   privateAddressPrefix:(tokens.privateAddress||'').slice(0,7),feeCoins:tokens.xmrForFees?.coins??null,pending:tokens.pending.length}});
}catch(e){result.ok=false;result.error=String(e?.message||e).slice(0,300);process.exitCode=1;}
finally{await engine?.close().catch(()=>{});await rm(dir,{recursive:true,force:true});result.seconds=Math.round((Date.now()-started)/1000);
 if(resultFile)await writeFile(resultFile,JSON.stringify(result,null,1)+'\n');console.log(JSON.stringify(result,null,1));}
