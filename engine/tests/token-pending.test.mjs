// Token module (engine/token/token-format.js), 28 Oct 2026 (owner: "when i send the private transfer, the balance should go
// to 0 in the private balance"; the pending text "should be just 1 box, showcasing the transaction, just like how phantom wallet
// does it"). The real module with stand-ins: an in-memory store holding a real encrypted journal, a stand-in holder worker and
// bridge state. Nothing touches the network.
//   node --test engine/tests/token-pending.test.mjs
import test from 'node:test';import assert from 'node:assert/strict';
import {createPrivateFormat} from '../token/token-format.js';
import {createPrivateJournal} from '../token/private-journal.js';
const locks={request:(name,opts,fn)=>fn()};
if(!globalThis.navigator?.locks)Object.defineProperty(globalThis.navigator,'locks',{value:locks,configurable:true});
const TA='xmr20t1'+'q'.repeat(60),ASSET='aa'.repeat(32),MINT='Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR',OWN='4'+'1'.repeat(94),SECRET='journal test secret';
const state={registered:true,tokenAddress:TA,network:'mainnet',confirmations:10,features:{bridge:false,view:false},assets:[{asset:ASSET,mint:MINT,symbol:'XMR20',name:'XMR20',decimals:6}],rpcUrl:'https://node.invalid'};
globalThis.fetch=async url=>{assert.ok(String(url).endsWith('/action/state'),String(url));return {ok:true,json:async()=>state};};
const fmt=raw=>{const n=BigInt(raw);const f=String(n%1000000n).padStart(6,'0').replace(/0+$/,'');return String(n/1000000n)+(f?'.'+f:'');};
async function wallet({status,pending}){
 const map=new Map(),store={get:async k=>map.get(k)??null,set:async(k,v)=>{map.set(k,v);}};
 const j=createPrivateJournal({store,locks});await j.unlock(SECRET);await j.write(x=>{Object.assign(j.account(x,TA).pending,pending);});
 const shown=[],handlers={},noop=()=>{},el=()=>({onclick:null,textContent:'',innerHTML:'',hidden:false,value:'',disabled:false,style:{},dataset:{},classList:{add:noop,remove:noop,toggle:noop},addEventListener:noop,removeEventListener:noop,setAttribute:noop,querySelector:()=>null,querySelectorAll:()=>[],focus:noop});
 const calls=[];const client={call:async(op)=>{calls.push(op);if(op==='open')return {tokenAddress:TA,shieldedAddress:'penumbra1x',ownerKey:'ab'.repeat(32),nativeAddress:OWN};if(op==='sync')return status;return {};},close:noop};
 const pf=createPrivateFormat({endpoint:'https://bridge.invalid',node:'https://node.invalid',account:()=>({id:'a1',xmrSeed:'placeholder',sol:'11111111111111111111111111111112',xmr:OWN,height:0}),
  workerClient:()=>client,oneShot:async()=>({}),store,secret:()=>SECRET,show:(title,html)=>shown.push({title,html}),on:(id,fn)=>{handlers[id]=fn;},run:fn=>fn({}),toast:noop,
  esc:s=>String(s).replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';'),amount:fmt,units:s=>s,compactTokenBalance:fmt,importSol:()=>null,render:noop,same:noop,$:el,$$:()=>[],close:noop});
 await pf.refresh();pf.bind();
 const detail=()=>{handlers['asset-private-0']();return shown.at(-1).html;};return {pf,shown,calls,detail};
}
const status=({notes,balance,spent=[],records={}})=>({tip:1000,records,public:{balances:{},notes:[]},shielded:{balances:{[ASSET]:balance},notes,spent},native:{tip:1000,outputs:[],unlocked:'0',locked:'0',reserved:'0'}});
const sent=(extra={})=>({op1:{kind:'private',asset:ASSET,symbol:'XMR20',amount:'200000000',inputKind:'shielded',reserved:['c1'],status:'published',created:Date.now(),publishedAtTip:1000,
 carriers:[{txid:'1'.repeat(64),fee:'30000000',status:'published'},{txid:'2'.repeat(64),fee:'31000000',status:'published'}],...extra}});

const text=html=>html.replace(/<svg[\s\S]*?<\/svg>/g,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
test('right after a private send: private balance 0, the row says pending, one compact box',async()=>{
 const {pf,detail,calls}=await wallet({status:status({notes:[{commitment:'c1',asset:ASSET,amount:'200000000',position:1}],balance:'200000000'}),pending:sent()});
 const [t]=pf.heldTokens();assert.equal(t.private,'0');assert.equal(t.total,'0');
 const row=text(pf.rowsHTML());assert.match(row,/0 XMR20/);assert.match(row,/1 pending/);
 const html=detail(),words=text(html);
 assert.match(words,/Private 0 200 pending/);
 assert.equal((html.match(/class="pf-activity"/g)||[]).length,1);assert.equal((html.match(/class="pf-activity-item"/g)||[]).length,1);
 assert.match(words,/Sent privately Pending −200 XMR20 fee 0\.000061 XMR/);
 const box=text(html.slice(html.indexOf('<div class="pf-activity"'),html.indexOf('<div class="pf-card"')));
 assert.equal(box,'Sent privately Pending −200 XMR20 fee 0.000061 XMR');assert.doesNotMatch(words.replace(/Details[\s\S]*$/,''),/Carrier|encrypted journal|node’s pool|published ·/);
 assert.ok(!calls.includes('carrierLookup')&&!calls.includes('carrierBroadcast'),'nothing re-sent: '+calls.join(','));
});
test('mined: confirmations count up; the spent note is gone and the change counts again',async()=>{
 const st=status({notes:[{commitment:'c1',asset:ASSET,amount:'200000000',position:1,spent:true},{commitment:'c2',asset:ASSET,amount:'50000000',position:2}],balance:'50000000',spent:[{commitment:'c1'}],
  records:{r1:{status:'accepted',txid:'1'.repeat(64),height:996,confirmations:4},r2:{status:'accepted',txid:'2'.repeat(64),height:996,confirmations:4}}});
 const {pf,detail}=await wallet({status:st,pending:sent({amount:'150000000',recordIds:['r1','r2']})});
 assert.equal(pf.heldTokens()[0].private,'50000000');
 const words=text(detail());assert.match(words,/Private 50 Only you can see it/);assert.match(words,/Sent privately Confirming · 4\/10 −150 XMR20/);
});
test('proved but not sent yet: its one action stays under the box',async()=>{
 const {detail}=await wallet({status:status({notes:[{commitment:'c1',asset:ASSET,amount:'200000000',position:1}],balance:'200000000'}),
  pending:sent({status:'built',created:Date.now()-60000,carriers:[]})});
 const html=detail(),words=text(html);assert.match(words,/Sent privately Needs its network fee −200 XMR20/);assert.match(html,/data-abandon="op1"/);assert.match(words,/Cancel \(nothing was sent\)/);assert.match(words,/Private 0 200 pending/);
});
test('no pending operation: balance and tiles as before, no activity box',async()=>{
 const {pf,detail}=await wallet({status:status({notes:[{commitment:'c1',asset:ASSET,amount:'200000000',position:1}],balance:'200000000'}),pending:{}});
 assert.equal(pf.heldTokens()[0].private,'200000000');const html=detail();assert.doesNotMatch(html,/pf-activity/);assert.match(text(html),/Private 200 Only you can see it · 1 note/);
});
