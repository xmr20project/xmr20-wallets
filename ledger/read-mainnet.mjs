#!/usr/bin/env node
// Reads the XMR20 token ledger of Monero mainnet from a Monero node, with the reader built from this folder, and prints
// what it finds: the record list hash and the ledger state hash at every 720th block, and the state hash and the ledger
// summary at the newest block.
//
//   cargo build --release --manifest-path indexer/Cargo.toml
//   node read-mainnet.mjs --node http://127.0.0.1:18081 --state ./xmr20-state [--bin <reader binary>] [--once]
//
// Nothing but the node is asked. The values that make this the mainnet ledger are in params/mainnet-v1/manifest.json
// (pinned below by its SHA-256) and in the core's source (the blocks from which each rule applies). The state folder
// keeps what was read, so a second run continues where the first stopped. Without --once it keeps following the chain.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';

const ROOT=import.meta.dirname,PARAMS=join(ROOT,'params/mainnet-v1'),MANIFEST=join(PARAMS,'manifest.json');
export const MANIFEST_SHA256='1b1a27dcb1c4b3d93e4b38963c0b32595e44362a86296aa9445f468a51f1841b',EVERY=720;
const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?null:process.argv[i+1];},has=name=>process.argv.includes('--'+name);

async function main(){
 const node=arg('node'),state=arg('state'),bin=arg('bin')||join(ROOT,'indexer/target/release/xmr20-indexer-open');
 if(!node||!state){console.error('Usage: node read-mainnet.mjs --node <monero node url> --state <folder> [--bin <reader binary>] [--once]');process.exit(2);}
 if(!/^https?:\/\//.test(node)){console.error('--node is a URL that begins with http:// or https://');process.exit(2);}
 if(!existsSync(bin)){console.error(`No reader at ${bin}. Build it first: cargo build --release --manifest-path indexer/Cargo.toml`);process.exit(2);}
 if(createHash('sha256').update(readFileSync(MANIFEST)).digest('hex')!==MANIFEST_SHA256){console.error('params/mainnet-v1/manifest.json is not the mainnet manifest (its SHA-256 differs).');process.exit(1);}
 // The reader answers one line of JSON for each line it is given.
 const child=spawn(bin,[PARAMS,'--trusted-manifest',MANIFEST,'--state',state],{stdio:['pipe','pipe','inherit'],
  env:{PATH:process.env.PATH,XMR20_INDEXER_SERVICE:'1',XMR20_MAINNET_PILOT:'I-UNDERSTAND',XMR20_INTEGRATION_RPC_URL:node,XMR20_TRUSTED_MANIFEST_SHA256:MANIFEST_SHA256}});
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
 const next=async()=>{const r=await lines.next();if(r.done)throw Error('The reader stopped.');return JSON.parse(r.value);};
 const ask=async q=>{child.stdin.write(JSON.stringify(q)+'\n');const a=await next();if(a.error)throw Error(a.error);return a.result;};
 try{
  const ready=await next();if(!ready.ready)throw Error('The reader did not start: '+JSON.stringify(ready).slice(0,300));
  console.error(`XMR20 mainnet ledger ${ready.domain}; state at block ${ready.state.tip??'(none)'}`);
  let shown=0;
  for(;;){
   // Read until a pass adds nothing: the reader is at the node's newest block.
   for(let before=null,tip=(await ask({op:'status'})).tip??-1;tip!==before;){before=tip;await ask({op:'sync',maxBlocks:500});const s=await ask({op:'status'});tip=s.tip??-1;
    if(tip!==before)console.error(`read to block ${tip} (${s.records} records)`);
    for(let h=Math.max(shown+EVERY,Math.ceil((s.startHeight||0)/EVERY)*EVERY);h<=tip;h+=EVERY){
     try{const c=await ask({op:'checkpoint',height:h});console.log(JSON.stringify({height:c.height,blockHash:c.blockHash,records:c.records,listHash:c.listHash,...(c.stateHash?{stateHash:c.stateHash}:{})}));}catch{}
     shown=h;}}
   const s=await ask({op:'status'}),sum=await ask({op:'summary'});
   console.log(JSON.stringify({tip:s.tip,tipHash:s.tipHash,records:s.records,invariant:s.invariant?.ok,...(sum.stateHash?{stateHash:sum.stateHash}:{}),summary:sum.state}));
   if(has('once'))break;
   await new Promise(done=>setTimeout(done,30000));}
 }finally{try{child.stdin.write('{"op":"close"}\n');child.stdin.end();}catch{}}
}
if(process.argv[1]===import.meta.filename)main().catch(e=>{console.error(String(e?.message||e));process.exit(1);});
