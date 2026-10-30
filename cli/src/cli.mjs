// XMR20 terminal wallet: commands. The wallet itself (scanning, building, proving, signing, sending) is the shared engine
// running in the CLI's private browser (src/engine.mjs, browser/host.js); this file asks for passwords and approvals and
// prints what the engine reports.
import {parseArgs} from 'node:util';import {createHash} from 'node:crypto';import {join} from 'node:path';import {lstat} from 'node:fs/promises';
import {Keypair} from '@solana/web3.js';import bs58 from 'bs58';
import {dataDirectory,privateDirectory,lockDirectory,inspectLock,clearDeadLock,loadWallet,saveWallet,hasWallet,SCHEMA} from './store.mjs';
import {ask,password,approve} from './prompt.mjs';
import {need,UserError,safeText} from './errors.mjs';
import {startEngine} from './engine.mjs';
import {solBalance,MONERO_NODES} from './network.mjs';
import {formatUnits,checkAmount,XMR20_MONERO_START,MAX_XMR_FEE} from './amount.mjs';

export const VERSION='0.3.0';
export const HELP=`XMR20 terminal wallet ${VERSION}  (EXPERIMENTAL: real funds on mainnet, no independent security review)

Set up
  xmr20 create                      Make a new wallet (a Monero recovery phrase + a Solana key)
  xmr20 import                      Use your existing 25-word Monero phrase (and, if you like, your Solana key)
  xmr20 phrase                      Show your recovery phrase and Solana key (only in a private place)

Look
  xmr20 address                     Your Monero address, private address (xmr20p1...) and Solana address
  xmr20 balance                     Sync, then show XMR and your XMR20 tokens (Open and Private)
  xmr20 pending                     Operations that have not finished yet

Send  (each shows a review first; nothing is sent until you type yes)
  xmr20 send-xmr --to ADDRESS --amount 0.01            Send XMR (or --max)
  xmr20 send --token XMR20 --to ADDRESS --amount 10    Open transfer to a Monero address
  xmr20 send --token XMR20 --to xmr20p1... --amount 10 --private
                                                       Private transfer to a private address
  xmr20 make-private --token XMR20 --amount 10         Move Open tokens to your Private balance
  xmr20 make-open --token XMR20 --amount 10            Move Private tokens back to Open
  xmr20 enable-private --token XMR20                   Split your XMR into 3 coins (needed once)
  xmr20 bridge-in --token XMR20 --amount 10            Solana -> Monero (arrives as Open)
  xmr20 bridge-out --token XMR20 --amount 10           Monero Open balance -> your Solana address
  xmr20 pay-fee BINDING --token XMR20                  Pay a bridge payout fee that is still due
  xmr20 pending publish ID --token XMR20               Finish a saved operation (asks for its fee)
  xmr20 pending abandon ID --token XMR20               Drop a saved operation that never reached the chain

Other
  xmr20 doctor [--clear-lock]       Check this wallet folder; remove a lock left by a crash

Options: --data-dir PATH (default ~/.xmr20-wallet)   --help   --version
Secrets are only typed into hidden prompts, never put in commands.
`;
const TOKEN_COMMANDS=new Set(['send','make-private','make-open','enable-private','bridge-in','bridge-out','pay-fee','pending publish','pending abandon']);
export function parse(argv){
 let parsed;
 try{parsed=parseArgs({args:argv,allowPositionals:true,strict:true,options:{help:{type:'boolean'},version:{type:'boolean'},'data-dir':{type:'string'},to:{type:'string'},amount:{type:'string'},max:{type:'boolean'},
  token:{type:'string'},private:{type:'boolean'},'clear-lock':{type:'boolean'}}});}
 catch{throw new UserError('Unknown or invalid option. Run "xmr20 --help". Never put a phrase, key or password in a command.');}
 const {values:v,positionals:p}=parsed;
 if(v.help||v.version)return {command:v.help?'help':'version',options:v,args:[]};
 if(p[0]==='wallet'&&['create','import','seed'].includes(p[1]))p.splice(0,2,p[1]==='seed'?'phrase':p[1]);// 0.2.0 spellings
 const command=p[0]==='pending'&&['publish','abandon'].includes(p[1])?'pending '+p[1]:p[0]||'help';const args=p.slice(command.includes(' ')?2:1);
 const counts={create:0,import:0,phrase:0,address:0,balance:0,sync:0,pending:0,'pending publish':1,'pending abandon':1,'send-xmr':0,send:0,'make-private':0,'make-open':0,'enable-private':0,'bridge-in':0,'bridge-out':0,'pay-fee':1,doctor:0,help:0};
 need(Object.hasOwn(counts,command)&&args.length===counts[command],'Unknown command or extra words. Run "xmr20 --help".');
 const allowed={'send-xmr':['to','amount','max'],send:['token','to','amount','private'],'make-private':['token','amount'],'make-open':['token','amount'],'enable-private':['token'],'bridge-in':['token','amount'],'bridge-out':['token','amount'],'pay-fee':['token'],'pending publish':['token'],'pending abandon':['token'],doctor:['clear-lock']}[command]||[];
 for(const k of ['to','amount','max','token','private','clear-lock'])need(v[k]===undefined||allowed.includes(k),`--${k} does not apply to "${command}".`);
 if(command==='send-xmr')need(v.to&&Boolean(v.amount)!==Boolean(v.max),'Use: xmr20 send-xmr --to ADDRESS --amount N   (or --max instead of --amount)');
 if(TOKEN_COMMANDS.has(command))need(v.token,`Add --token (the ticker, e.g. --token XMR20, or the token's mint).`);
 if(['send','make-private','make-open','bridge-in','bridge-out'].includes(command)){need(v.amount,'Add --amount.');checkAmount(v.amount);}
 if(command==='send')need(v.to,'Add --to (a Monero address for an open transfer, or an xmr20p1... address with --private).');
 if(command==='send-xmr'&&v.amount)checkAmount(v.amount,12);
 return {command,options:v,args};
}
const out=(...lines)=>{for(const l of lines)process.stdout.write(l+'\n');};
let lastProgress='',progressAt=0;
function progress(text){const t=safeText(text);if(!t||t===lastProgress)return;const now=Date.now();if(now-progressAt<1500&&!/%$/.test(t))return;progressAt=now;lastProgress=t;process.stderr.write('  … '+t+'\n');}
const shortAddress=a=>a&&a.length>30?a.slice(0,14)+'…'+a.slice(-10):a;
export const walletId=(sol,xmr)=>'cli-'+createHash('sha256').update(sol+'|'+xmr).digest('hex').slice(0,24);

async function currentHeight(){for(const node of MONERO_NODES.slice(1)){try{const r=await fetch(node+'/get_info',{redirect:'error',signal:AbortSignal.timeout(10000)});const d=await r.json();
 if(d.status==='OK'&&d.mainnet===true&&Number.isSafeInteger(d.height)&&d.height>20)return d.height-20;}catch{}}return XMR20_MONERO_START;}

// Opens the wallet: password, folder lock, engine, Monero worker. The caller must close().
async function openWallet(dir){
 const pw=await password();const wallet=await loadWallet(dir,pw);const unlock=await lockDirectory(dir);let engine;
 const stop=async()=>{try{await engine?.close();}finally{await unlock().catch(()=>{});}};
 process.once('SIGINT',()=>{process.stderr.write('\nStopping… saved progress is kept.\n');void stop().finally(()=>process.exit(130));});
 try{let relayed=false;
  engine=await startEngine(dir,{onProgress:progress,onRelay:kind=>{if(!relayed){relayed=true;process.stderr.write(`  → Sending the approved ${kind==='xmr'?'XMR':'XMR20'} transaction to the Monero network…\n`);}}});
  progress('Opening the Monero wallet…');
  const opened=await engine.call('cli.open',{wallet,cache:await engine.savedCache()});
  need(opened.address===wallet.xmr.address,'The engine opened a different Monero address. Nothing was done.');
  return {wallet,engine,close:stop,resetRelay:()=>{relayed=false;}};
 }catch(e){await stop();throw e;}
}
async function syncAll(w,{tokens=true}={}){progress('Syncing XMR…');const xmr=await w.engine.call('cli.xmrSync',{first:true});
 if(!tokens)return {xmr};
 await w.engine.call('cli.setSolBalance',await solBalance(w.wallet.sol.address));
 progress('Syncing XMR20 tokens (the first time takes a few minutes)…');const t=await w.engine.call('cli.tokensSync');
 if(t.error)throw new UserError('XMR20 tokens are unavailable right now: '+t.error);return {xmr,tokens:t};}
function findToken(summary,wanted){const w=wanted.trim(),list=summary.tokens||[];
 const byMint=list.find(t=>t.mint===w);if(byMint)return byMint;
 const bySymbol=list.filter(t=>t.symbol.toLowerCase()===w.toLowerCase());
 need(bySymbol.length,`No token "${w}" on the XMR20 bridge. Known: ${list.map(t=>t.symbol).join(', ')||'none yet'}.`);
 need(bySymbol.length===1,`Several tokens are called ${w}. Use the mint instead: ${bySymbol.map(t=>t.mint).join(', ')}`);return bySymbol[0];}
function printReview(r){out('','  '+(r.head||'Review'));for(const [k,v] of r.rows||[])out(`    ${(k+':').padEnd(22)} ${v}`);for(const n of r.notes||[])out('    · '+n);
 if(r.details?.length){out('    Details:');for(const d of r.details)out('      '+d);}out('');}
function printDone(result,progressText){if(result){out('','  ✓ '+(result.title||'Done'));for(const [k,v] of result.rows||[])out(`    ${(k+':').padEnd(22)} ${v}`);for(const t of result.txids||[])out('    Transaction: '+t,'    https://xmrchain.net/tx/'+t);}
 if(progressText)out('',progressText);out('');}
// Drives one token operation from start to finish, asking the user at every review.
async function tokenFlow(w,name,args){let s=await w.engine.call('cli.tokenOp',name,args);
 for(;;){
  if(s.stage==='review'){printReview(s.review);const yes=await approve(s.review.button?`${s.review.button}?`:'Approve?');s=yes?await w.engine.call('cli.approve'):await w.engine.call('cli.cancel');if(!yes){out(safeText(s.error||'Cancelled. Nothing was signed or sent.'));return;}continue;}
  if(s.stage==='check-coins'){out('',safeText(s.message));if(!await approve('Check your coins with the Monero node now?')){out('Stopped. Nothing was sent.');return;}s=await w.engine.call('cli.approve');continue;}
  if(s.stage==='done'){printDone(s.result,s.progress);return;}
  throw new UserError(s.error||'The operation stopped. Nothing new was sent; run "xmr20 pending" to check saved operations.');}}

export async function main(argv){
 const {command,options,args}=parse(argv);
 if(command==='help')return out(HELP);if(command==='version')return out(VERSION);
 const dir=dataDirectory(options['data-dir']);
 if(command==='doctor'){out('Wallet folder: '+dir);out('Wallet file: '+(await hasWallet(dir)?'present (encrypted)':'none'));const lock=await inspectLock(dir).catch(()=>null);
  out('Process lock: '+(lock?`held by process ${lock.pid} (${lock.running?'still running':'no longer running'})`:'none'));
  try{await lstat(join(import.meta.dirname,'../.engine/host.js'));out('Engine files: built');}catch{out('Engine files: not built yet (they are built on first use, or run "npm run setup")');}
  if(options['clear-lock']){await clearDeadLock(dir);out('Removed the lock of the process that is no longer running.');}return;}
 if(command==='create'||command==='import'){
  await privateDirectory(dir);need(!await hasWallet(dir),'This folder already has a wallet. Use --data-dir for another one.');
  let seed='',restoreHeight,solSecret='';
  if(command==='import'){seed=(await ask('Your 25-word Monero recovery phrase (hidden): ',{secret:true})).trim().toLowerCase().replace(/\s+/g,' ');need(seed.split(' ').length===25,'Monero recovery phrases have 25 words.');
   const h=(await ask(`Restore height (the block your wallet was made at; press Enter for ${XMR20_MONERO_START.toLocaleString('en-US')}, where XMR20 began): `)).trim().replace(/[,_ ]/g,'');
   restoreHeight=h===''?XMR20_MONERO_START:Number(h);need(Number.isSafeInteger(restoreHeight)&&restoreHeight>=0&&restoreHeight<8000000,'Enter a block number.');
   solSecret=(await ask('Your Solana secret key for the bridge (hidden; press Enter to make a new one): ',{secret:true})).trim();}
  else{out('Checking the current Monero block height for your new wallet…');restoreHeight=await currentHeight();}
  const pw=await password(true);const unlock=await lockDirectory(dir);let engine;
  try{engine=await startEngine(dir,{onProgress:progress});const keys=await engine.call('cli.keys',command==='create'?'create':'restore',seed);seed='';
   let key;try{key=solSecret?Keypair.fromSecretKey(solSecret.startsWith('[')?Uint8Array.from(JSON.parse(solSecret)):bs58.decode(solSecret)):Keypair.generate();}catch{throw new UserError('That Solana key could not be read. Use the base58 secret key (or the JSON array) your Solana wallet exports.');}
   const wallet={schema:SCHEMA,id:walletId(key.publicKey.toBase58(),keys.address),created:new Date().toISOString(),xmr:{address:keys.address,seed:keys.seed,restoreHeight},sol:{address:key.publicKey.toBase58(),secret:bs58.encode(key.secretKey)}};key.secretKey.fill(0);
   if(command==='import'){out('','Monero address of this phrase: '+wallet.xmr.address);need(await approve('Is this your Monero address?'),'Stopped. Nothing was saved.');}
   await saveWallet(dir,wallet,pw,{exclusive:true});
   out('',`Wallet saved in ${dir} (encrypted with your password).`,'Monero address: '+wallet.xmr.address,'Solana address: '+wallet.sol.address,'Restore height: '+restoreHeight.toLocaleString('en-US'));
   if(command==='create'&&await approve('Write down your recovery phrase now. It is the only way to restore this wallet. Show it?'))showSecrets(wallet);
   else if(command==='create')out('Run "xmr20 phrase" later to see it.');
  }finally{await engine?.close().catch(()=>{});await unlock();}return;}
 if(command==='phrase'){const wallet=await loadWallet(dir,await password());showSecrets(wallet);return;}
 if(command==='address'){const w=await openWallet(dir);try{out('Monero address (XMR and Open XMR20):  '+w.wallet.xmr.address,'Solana address (bridge):              '+w.wallet.sol.address);
   progress('Finding your private address…');const t=await syncAll(w);out('Private address (Private XMR20 only): '+(t.tokens.privateAddress||'unavailable'));}finally{await w.close();}return;}
 if(command==='send-xmr')return sendXmr(dir,options);
 const w=await openWallet(dir);
 try{
  const {xmr,tokens}=await syncAll(w);
  if(command==='balance'||command==='sync'){printBalance(w.wallet,xmr,tokens);return;}
  if(command==='pending'){printPending(tokens);return;}
  const token=findToken(tokens,options.token),mint=token.mint;
  const ops={send:['send',{mint,to:options.to,amount:options.amount,private:Boolean(options.private)}],'make-private':['makePrivate',{mint,amount:options.amount}],'make-open':['makeOpen',{mint,amount:options.amount}],
   'enable-private':['enablePrivate',{mint}],'bridge-in':['bridgeToMonero',{mint,amount:options.amount}],'bridge-out':['bridgeToSolana',{mint,amount:options.amount}],
   'pay-fee':['payPayoutFee',{mint,binding:args[0]}],'pending publish':['publishPending',{mint,id:args[0]}],'pending abandon':['abandonPending',{mint,id:args[0]}]}[command];
  await tokenFlow(w,...ops);
 }finally{await w.close();}
}
function showSecrets(wallet){out('','  KEEP THIS SECRET. Anyone with these words can spend your funds.','',
 '  Monero recovery phrase (25 words):','  '+wallet.xmr.seed,'','  Restore height: '+wallet.xmr.restoreHeight,'','  Solana secret key (for the bridge):','  '+wallet.sol.secret,'');}
function printBalance(wallet,xmr,t){
 out('',`XMR       ${formatUnits(xmr.balanceRaw,12)} XMR`+(BigInt(xmr.unlockedRaw??xmr.balanceRaw)!==BigInt(xmr.balanceRaw)?`   (${formatUnits(xmr.unlockedRaw,12)} spendable now; the rest is confirming)`:''));
 const held=(t.tokens||[]).filter(x=>BigInt(x.open)+BigInt(x.private)>0n||x.payouts?.some(p=>p.status!=='paid'));
 out('',`XMR20 tokens on Monero   (scanned to block ${t.tip??'?'})`);
 if(!held.length)out('  none yet');
 for(const x of held)out(`  ${x.symbol.padEnd(8)} Open ${formatUnits(x.open,x.decimals)}   Private ${formatUnits(x.private,x.decimals)}`+(x.solana!=null?`   · on Solana ${formatUnits(x.solana,x.decimals)}`:''));
 const f=t.xmrForFees;if(f)out('',f.coins>=2?(f.spendableCoins>=2?'Private transfers: ready.':'Private transfers: your XMR coins are still confirming (about 20 minutes).'):
  f.coins===0?'Monero fees: send this wallet a little XMR (about 0.002) first. Every XMR20 transfer pays a small Monero fee.':'Private transfers: run "xmr20 enable-private --token XMR20" once (it splits your XMR into 3 coins).');
 if(t.pending?.length)out(`Pending operations: ${t.pending.length} (see "xmr20 pending").`);
 const due=held.flatMap(x=>(x.payouts||[]).filter(p=>p.feeDue).map(p=>[x,p]));for(const [x,p] of due)out(`Bridge payout of ${formatUnits(p.amount,x.decimals)} ${x.symbol} waits for its fee: xmr20 pay-fee ${p.binding} --token ${x.symbol}`);
 out('');}
function printPending(t){if(!t.pending?.length){out('No pending operations.');return;}
 for(const p of t.pending)out(`${p.id}  ${p.kind} ${p.symbol} ${p.amount}  ${p.status}${p.error?'  — '+p.error:''}`,...p.txids.map(x=>'    '+x));}
async function sendXmr(dir,options){const w=await openWallet(dir);
 try{const to=options.to.trim();need(/^(?:[48][1-9A-HJ-NP-Za-km-z]{94}|4[1-9A-HJ-NP-Za-km-z]{105})$/.test(to),'Enter a valid Monero mainnet address.');need(to!==w.wallet.xmr.address,'Choose a different recipient.');
  const amountRaw=options.max?null:checkAmount(options.amount,12);
  progress('Syncing XMR…');await w.engine.call('cli.xmrSync',{first:true});
  let review;
  for(let i=0;;i++){try{review=await w.engine.call('cli.xmrPrepare',{to,amountRaw,max:Boolean(options.max)});break;}
   catch(e){if(e.code==='carrier-check-unavailable'&&i===0){out('','Your coins need a check first, to protect any XMR20 tokens. This shares their transaction IDs with your Monero node; nothing is sent.');
     need(await approve('Check your coins now?'),'Stopped. Nothing was sent.');await w.engine.call('cli.xmrCheckCoins');continue;}throw e;}}
  if(BigInt(review.feeRaw)>MAX_XMR_FEE){await w.engine.call('cli.xmrCancel').catch(()=>{});throw new UserError('The Monero fee is above 0.0001 XMR. Nothing was sent; try again later.');}
  printReview({head:'Send XMR',rows:[['To',shortAddress(review.to)],['Amount',formatUnits(review.amountRaw,12)+' XMR'],['Network fee',formatUnits(review.feeRaw,12)+' XMR'],['Review valid for','2 minutes']],notes:['Monero payments cannot be reversed.']});
  if(!await approve('Send this XMR?')){await w.engine.call('cli.xmrCancel').catch(()=>{});out('Cancelled. Nothing was sent.');return;}
  need(Date.now()<review.expires,'This review expired. Run the command again; nothing was sent.');
  const sent=await w.engine.call('cli.xmrRelay',{reviewId:review.id});const hash=sent?.hash||review.hash;
  out('','  ✓ Sent','    Transaction: '+hash,'    https://xmrchain.net/tx/'+hash,'');
 }finally{await w.close();}}
