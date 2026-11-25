// Differential cases for the open deploy rule: the JavaScript verdict on many contents and whole records, written to
// JSON files that core/src/review_text_tests.rs replays against the Rust implementation.
//   node gen.mjs <folder of the xmr721 repository, with its dependencies installed>
// Throwaway keys only (rules/tests/helpers.mjs). Deterministic: a fixed-seed generator, fixed signature nonces.
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
if(!process.argv[2]){console.error('Usage: node gen.mjs <folder of the xmr721 repository>');process.exit(2);}
const X=resolve(process.argv[2]),from=f=>import(pathToFileURL(resolve(X,f)).href),dep=n=>import(pathToFileURL(createRequire(resolve(X,'package.json')).resolve(n)).href);
const {sha256}=await dep('@noble/hashes/sha256');
const {ed25519}=await dep('@noble/curves/ed25519');
const {wallet,DOMAIN}=await from('rules/tests/helpers.mjs');
const {decodeRecord,renderText,recordId,OP,SUFFIX,MAX_RECORD}=await from('rules/lib/records.mjs');
const {signWithSpendKey,verifySpendSignature,parseSignature,encodeAddress,hex,unhex,concat,leBytes,le}=await from('rules/lib/monero.mjs');
const {unframe}=await from('reader/lib/transport.mjs');
const {openDeployText,readOpenDeploy,openDeployOf,tickerField,tokenLabel}=await from('xmr20-tokens/lib/open.mjs');

const enc=t=>new TextEncoder().encode(t);
const out=(name,v)=>writeFileSync(new URL('./'+name,import.meta.url),JSON.stringify(v));
// xorshift32
let seed=0x9e3779b9;const rnd=()=>{seed^=seed<<13;seed>>>=0;seed^=seed>>>17;seed^=seed<<5;seed>>>=0;return seed;};
const pick=a=>a[rnd()%a.length],chance=n=>rnd()%n===0;
// UTF-8 of any code point, surrogates included (those bytes are not UTF-8; both sides must refuse them).
const utf8=cp=>cp<0x80?[cp]:cp<0x800?[0xc0|cp>>6,0x80|cp&63]:cp<0x10000?[0xe0|cp>>12,0x80|cp>>6&63,0x80|cp&63]:[0xf0|cp>>18,0x80|cp>>12&63,0x80|cp>>6&63,0x80|cp&63];

// ------------------------------------------------------------------ 1. every code point, in five places
const HEAD=enc('{"p":"xmr20","op":"deploy","tick":"'),TAIL=enc('","max":"5","dec":"6","mode":"open","lim":"1"}');
const NHEAD=enc('{"p":"xmr20","op":"deploy","tick":"T","name":"');
const shapes=[c=>[HEAD,c,TAIL],c=>[HEAD,[0x61],c,TAIL],c=>[HEAD,c,[0x61],TAIL],c=>[HEAD,[0x61],c,[0x61],TAIL],c=>[NHEAD,c,TAIL]];
const maps=shapes.map(()=>new Uint8Array(0x110000/8));let allowed=0;
for(let cp=0;cp<0x110000;cp++){const c=utf8(cp);shapes.forEach((s,i)=>{if(readOpenDeploy(concat(...s(c).map(x=>Uint8Array.from(x)))))maps[i][cp>>3]|=1<<(cp&7);});if(maps[0][cp>>3]>>(cp&7)&1)allowed++;}
out('codepoints.json',{maps:maps.map(hex),allowed});
console.error('code points allowed alone in a ticker:',allowed);

// ------------------------------------------------------------------ 2. contents
const contents=new Map();
const addC=b=>{const u=b instanceof Uint8Array?b:typeof b==='string'?enc(b):Uint8Array.from(b);const k=hex(u);if(!contents.has(k)){const d=readOpenDeploy(u);contents.set(k,d?{ok:true,tick:d.tick,field:tickerField(d.tick)}:{ok:false});}return u;};
const plain='{"p":"xmr20","op":"deploy","tick":"PEPE","max":"21000000","dec":"6","mode":"open","lim":"1000"}';
const full='{"p":"xmr20","op":"deploy","tick":"PEPE","name":"Pepe","max":"21000000","dec":"6","mode":"open","col":"'+'ab'.repeat(32)+'","lim":"1000","pre":"5"}';
const allPre='{"p":"xmr20","op":"deploy","tick":"MINE","max":"1000","dec":"6","mode":"open","pre":"1000"}';
const T=(tick,rest='"max":"5","dec":"6","mode":"open","lim":"1"')=>`{"p":"xmr20","op":"deploy","tick":${tick},${rest}}`;
const hand=[plain,full,allPre,
 // escapes
 T('"\\u0041"'),T('"A"'),T('"\\/"'),T('"/"'),T('"\\ud83d\\ude00"'),T('"😀"'),T('"\\ud800"'),T('"\\udc00"'),T('"\\ud800x"'),T('"\\u0000"'),T('"a\\u0000b"'),T('"\\""'),T('"\\\\"'),T('"\\u0022"'),T('"\\u005c"'),T('"\\u005C"'),
 T('"\\n"'),T('"\\t"'),T('"\\b"'),T('"\\f"'),T('"\\r"'),T('"\\x41"'),T('"\\a"'),T('"\\u00e9"'),T('"é"'),T('"\\u2028"'),T('"\u2028"'),T('"\\u007f"'),T('"\x7f"'),T('"\\U0041"'),T('"\\u004"'),T('"a\\"b\\\\c"'),T('"\\"\\""'),
 T('"\\\\u0041"'),T("'A'"),T('"A'),T('A'),T('""'),T('" "'),T('" A"'),T('"A "'),T('"A B"'),T('"A  B"'),T('"\tA"'),T('"A\n"'),
 // duplicate keys, order, odd keys
 plain.replace('"lim":"1000"','"lim":"1","lim":"1000"'),plain.replace('"lim":"1000"','"lim":"1000","lim":"1000"'),plain.replace('{','{"p":"xmr20",'),plain.replace('{','{"p":"x",'),
 '{"op":"deploy","p":"xmr20","tick":"PEPE","max":"21000000","dec":"6","mode":"open","lim":"1000"}',
 '{"p":"xmr20","op":"deploy","tick":"PEPE","max":"21000000","dec":"6","mode":"open","pre":"5","lim":"1000"}',
 '{"p":"xmr20","op":"deploy","name":"N","tick":"PEPE","max":"21000000","dec":"6","mode":"open","lim":"1000"}',
 '{"p":"xmr20","op":"deploy","tick":"PEPE","max":"21000000","dec":"6","mode":"open","lim":"1000","col":"'+'ab'.repeat(32)+'"}',
 ...['__proto__','constructor','toString','hasOwnProperty','','0','1','x','P','Tick','mint','pair','valueOf','length','$serde_json::private::Number','$serde_json::private::RawValue'].flatMap(k=>[plain.replace('}',`,"${k}":"1"}`),plain.replace('{',`{"${k}":"1",`),plain.replace('}',`,"${k}":{"p":"xmr20"}}`),`{"${k}":${plain}}`,`{"${k}":"5"}`]),
 '{"__proto__":{"p":"xmr20","op":"deploy","tick":"PEPE","max":"21000000","dec":"6","mode":"open","lim":"1000"}}',
 '{"p":"xmr20","op":"deploy","tick":"PEPE","max":{"$serde_json::private::Number":"21000000"},"dec":"6","mode":"open","lim":"1000"}',
 // numbers and strings, nesting, other types
 ...['21000000','21000000.0','2.1e7','"21000000"x','null','true','["21000000"]','{"a":"21000000"}','[]','{}','-1','0','1e999','1E400','18446744073709','18446744073709551616','99999999999999999999999999999999999999999'].map(v=>plain.replace('"max":"21000000"','"max":'+v)),
 ...['"p":"xmr20"','"op":"deploy"','"tick":"PEPE"','"dec":"6"','"mode":"open"','"lim":"1000"'].flatMap(f=>{const [k]=f.split(':');return ['null','6','true','[]','{}','["x"]','""'].map(v=>plain.replace(f,k+':'+v));}),
 plain.replace('"dec":"6"','"dec":6'),plain.replace('"dec":"6"','"dec":"06"'),plain.replace('"dec":"6"','"dec":"6.0"'),plain.replace('"dec":"6"','"dec":"8"'),plain.replace('"dec":"6",',''),plain.replace('"mode":"open"','"mode":"Open"'),plain.replace('"mode":"open"','"mode":"open "'),plain.replace(',"mode":"open"',''),
 plain.replace('"p":"xmr20"','"p":"XMR20"'),plain.replace('"p":"xmr20",',''),plain.replace('"op":"deploy",',''),plain.replace('"tick":"PEPE",',''),plain.replace('"max":"21000000",',''),
 'null','true','1','"x"','[]','{}','[{}]','['+plain+']','"'+plain.replaceAll('"','\\"')+'"',
 // whitespace, BOM, trailing data
 ' '+plain,plain+' ',plain+'\n',plain+'\r\n',plain+'\t',plain.replace(',',', '),plain.replace(':',': '),plain.replace('{','{ '),plain.replace('}',' }'),plain+plain,plain+'x',plain+'\0',plain+',',plain.slice(0,-1),plain.slice(1),plain+'}',plain.replace('}',',}'),
 plain+'//x',plain+'/**/','\ufeff'+plain,plain+'\ufeff',
 // deep nesting (serde_json stops at 128 levels, JSON.parse does not)
 ...[1,5,127,128,129,200,280].flatMap(n=>['{"p":'+'['.repeat(n)+']'.repeat(n)+'}',plain.replace('"lim":"1000"','"lim":'+'['.repeat(n)+']'.repeat(n)),'['.repeat(n)+plain+']'.repeat(n),plain.replace('"max":"21000000"','"max":'+'{"a":'.repeat(Math.min(n,110))+'1'+'}'.repeat(Math.min(n,110)))]),
 // numbers in max / lim / pre
 ...['0','1','9','00','01','1.0','1e3','+1',' 1','1 ','-1','१','１','١٢','0x10','1_000','1,000','18446744073708','18446744073709','18446744073710','99999999999999','100000000000000','184467440737090','018446744073709','1844674407370955161','18446744073709551615','18446744073709551616',''].flatMap(v=>[
  T('"A"',`"max":"${v}","dec":"6","mode":"open","lim":"1"`),T('"A"',`"max":"${v}","dec":"6","mode":"open","pre":"${v}"`),T('"A"',`"max":"18446744073709","dec":"6","mode":"open","lim":"${v}"`),
  T('"A"',`"max":"18446744073709","dec":"6","mode":"open","lim":"1","pre":"${v}"`),T('"A"',`"max":"18446744073709","dec":"6","mode":"open","pre":"${v}"`)]),
 ...[['10','10',null],['10','11',null],['10','1','9'],['10','1','10'],['10','1','11'],['10',null,'10'],['10',null,'9'],['10',null,null],['10','10','9'],['10','9','9'],['1','1',null],['1',null,'1'],['1','1','1'],['10','0',null],['10','1','0'],['10',null,'0'],['10','0','10'],['10','11','10'],['10','x','10']]
  .map(([m,l,p])=>T('"A"',`"max":"${m}","dec":"6","mode":"open"`+(l===null?'':`,"lim":"${l}"`)+(p===null?'':`,"pre":"${p}"`))),
 // col
 ...['ab'.repeat(32),'AB'.repeat(32),'ab'.repeat(31),'ab'.repeat(33),'ab'.repeat(31)+'ag','ab'.repeat(31)+'a ','0'.repeat(64),'ab'.repeat(31)+'a\\u0062','','ａ'.repeat(64),'ab'.repeat(32)+'\\n'].flatMap(c=>[T('"A"',`"max":"5","dec":"6","mode":"open","col":"${c}","lim":"1"`),T('"A"',`"max":"5","dec":"6","mode":"open","col":"${c}","pre":"5"`)]),
 T('"A"','"max":"5","dec":"6","mode":"open","col":5,"lim":"1"'),T('"A"','"max":"5","dec":"6","mode":"open","col":null,"lim":"1"'),
];
hand.forEach(addC);
// invalid UTF-8, overlong forms, surrogate bytes, noncharacters, in ticker and name
const wrap=(b,name)=>concat(name?NHEAD:HEAD,Uint8Array.from(b),TAIL);
for(const b of [[0xc0,0x80],[0xc1,0x81],[0xe0,0x80,0x80],[0xe0,0x9f,0xbf],[0xf0,0x80,0x80,0x80],[0xf0,0x8f,0xbf,0xbf],[0xed,0xa0,0x80],[0xed,0xbf,0xbf],[0xed,0xa0,0xbd,0xed,0xb8,0x80],[0xf4,0x90,0x80,0x80],[0xf5,0x80,0x80,0x80],[0xf8,0x88,0x80,0x80,0x80],
 [0x80],[0xbf],[0xff],[0xfe],[0xc2],[0xe2,0x82],[0xf0,0x9f,0x98],[0x41,0x80],[0xc2,0x41],[0xef,0xbb,0xbf],[0xef,0xbb,0xbf,0x41],[0x41,0xef,0xbb,0xbf],[0xef,0xbf,0xbd],[0xef,0xbf,0xbe],[0xef,0xb7,0x90],[0xc2,0x85],[0xc2,0xa0],[0xc2,0xa1],[0x7f],[0x7e],[0x00],[0x1f],[0x09],
 [0x41,0xcc,0x81],[0xcc,0x81],[0xcc,0x81,0x41],[0xe2,0x80,0x8d],[0xf0,0x9f,0x91,0xa8,0xe2,0x80,0x8d,0xf0,0x9f,0x91,0xa9],[0xf0,0x9f,0x87,0xba,0xf0,0x9f,0x87,0xb8],[0xef,0xb8,0x8f],[0xe2,0x9d,0xa4,0xef,0xb8,0x8f],[0xf3,0xa0,0x80,0x81],[0xf3,0xa0,0x84,0x80],[0xf0,0x90,0x80,0x80]])
 {addC(wrap(b));addC(wrap(b,true));}
addC(Uint8Array.of(0xef,0xbb,0xbf,...enc(plain)));addC(Uint8Array.of(...enc(plain),0xef,0xbb,0xbf));addC(Uint8Array.of(0xff,0xfe,...enc(plain)));addC(new Uint8Array(0));
// UTF-16 of the plain text
addC(Uint8Array.from([...plain].flatMap(c=>[c.charCodeAt(0),0])));addC(Uint8Array.from([0xff,0xfe,...[...plain].flatMap(c=>[c.charCodeAt(0),0])]));
// character counts: 32 / 33 in the ticker, 64 / 65 in the name, for characters of 1, 2, 3 and 4 bytes, with and without escapes
for(const ch of ['A','é','ペ','😀','𝔸','\\"','\\\\','e\u0301','👨‍👩‍👧','🇺🇸'])for(const n of [1,2,16,31,32,33,63,64,65,66,100]){addC(T('"'+ch.repeat(n)+'"'));addC(T('"T","name":"'+ch.repeat(n)+'"'));addC(T('"'+ch.repeat(Math.min(n,32))+'","name":"'+ch.repeat(n)+'"'));}
// the 600 byte limit: the longest texts there are, with names that put them just under, at and over it
{const big=(tick,nameChars)=>`{"p":"xmr20","op":"deploy","tick":"${tick}","name":"${nameChars}","max":"18446744073709","dec":"6","mode":"open","col":"${'ab'.repeat(32)}","lim":"18446744073709","pre":"18446744073708"}`;
 const units=['😀','\\"','ペ','é','A','\\\\'];
 for(const tick of ['😀'.repeat(32),'\\"'.repeat(32),'\\\\'.repeat(32),'ペ'.repeat(32),'A'.repeat(32)])for(const u of units)for(const v of units)for(let n=0;n<=64;n++){const t=big(tick,u.repeat(n)+v.repeat(64-n)),len=enc(t).length;if(len>=594&&len<=606)addC(t);}}
const sizes={};let over=0;for(const [k,v] of contents){const n=k.length/2;if(v.ok&&n>=596)sizes[n]=(sizes[n]||0)+1;if(n>600)over++;}
console.error('accepted texts by size near the limit:',JSON.stringify(sizes),'cases over the limit:',over);

// random structured texts: fields from pools of odd values, written raw
const ticks=['PEPE','A','ペペ','a\\"b','a\\\\b','\\"','😀','A B',' A','A ','','A'.repeat(32),'A'.repeat(33),'😀'.repeat(32),'😀'.repeat(33),'a\\u0041','\u200b','A\u200d','\u00a0A','é','e\u0301','İ','ǅ','ß','\ufeffA','A\u0085','\\ud800','\u{1f600}\ufe0f','\u{e0001}','A\tB','A\\tB','A/B','A\\/B','<script>','\u0600','\u115f','\u3164','\uffa0','\u2800','\ue000','\uf8ff','\uf900','\ufdd0','\ufdcf','\ufdf0','\ufffd','\ufff9','\u{10000}','\u{1fffd}','\u{1fffe}','\u{e0fff}','\u{e1000}','\u{effff}','\u{f0000}','\u{10ffff}','\u00ad','\u034f','\u061c','\u180e','\u2060','\u206f','\u2070','\u202e','\u2027','\u2030','\u205e'];
const nums=['1','2','5','9','10','11','1000','21000000','18446744073708','18446744073709','18446744073710','0','01','1.0','','-1','1e1','999999999999999'];
const vals=(k)=>k==='p'?pick(['xmr20','xmr20','xmr20','xmr20','XMR20','brc-20','']):k==='op'?pick(['deploy','deploy','deploy','deploy','mint','']):k==='tick'||k==='name'?pick(ticks):k==='dec'?pick(['6','6','6','6','8','06','']):k==='mode'?pick(['open','open','open','open','monero-curve','']):k==='col'?pick(['ab'.repeat(32),'0'.repeat(64),'AB'.repeat(32),'ab'.repeat(31)]):pick(nums);
const ORDER=['p','op','tick','name','max','dec','mode','col','lim','pre'];
for(let i=0;i<6000;i++){let ks=ORDER.filter(k=>['name','col','lim','pre'].includes(k)?chance(2):!chance(40));
 if(chance(12)){const a=rnd()%ks.length,b=rnd()%ks.length;[ks[a],ks[b]]=[ks[b],ks[a]];}if(chance(25))ks.push(pick(ORDER));if(chance(40))ks.push(pick(['mint','pair','x','__proto__']));
 let t='{'+ks.map(k=>`"${k}":`+(chance(30)?pick(['5','null','[]','{}','true']):`"${vals(k)}"`)).join(',')+'}';
 if(chance(30))t=t.replace(',',pick([', ',',\n',' ,']));addC(t);}
// consistent numbers, so that many random texts are accepted: max, then lim / pre around it
for(let i=0;i<4000;i++){const m=BigInt(pick(['1','2','10','1000','21000000','18446744073709'])),near=()=>String([1n,m-1n,m,m+1n,m/2n,0n][rnd()%6]),withPre=chance(2),pre=near(),withLim=withPre?(BigInt(pre)<m)!==chance(8):!chance(8);
 addC(`{"p":"xmr20","op":"deploy","tick":"${pick(ticks)}"`+(chance(3)?`,"name":"${pick(ticks)}"`:'')+`,"max":"${m}","dec":"6","mode":"open"`+(chance(4)?`,"col":"${'cd'.repeat(32)}"`:'')+(withLim?`,"lim":"${near()}"`:'')+(withPre?`,"pre":"${pre}"`:'')+'}');}
// byte mutations of valid texts
const bases=[plain,full,allPre,T('"ペペ"'),T('"a\\"b\\\\c"'),T('"😀"','"name":"é😀","max":"5","dec":"6","mode":"open","lim":"1"')].map(enc);
const odd=[0x00,0x09,0x0a,0x0d,0x20,0x22,0x2c,0x2f,0x30,0x31,0x39,0x3a,0x5c,0x5b,0x5d,0x7b,0x7d,0x7f,0x80,0xbf,0xc2,0xe2,0xef,0xf0,0xff,0x41,0x61,0x75];
for(const b of bases){for(let i=0;i<b.length;i++){const d=concat(b.subarray(0,i),b.subarray(i+1));addC(d);for(const x of [0x20,0x22,0x5c,0x30,0x00,0xff]){const c=b.slice();if(c[i]!==x){c[i]=x;addC(c);}addC(concat(b.subarray(0,i),Uint8Array.of(x),b.subarray(i)));}addC(b.slice(0,i));}
 for(let i=0;i<2500;i++){let c=Array.from(b);for(let k=1+rnd()%3;k>0;k--){const at=rnd()%(c.length+1),how=rnd()%4;if(how===0)c.splice(at,1);else if(how===1)c.splice(at,0,pick(odd));else if(how===2&&at<c.length)c[at]=pick(odd);else if(at<c.length)c[at]^=1<<(rnd()%8);}addC(c);}}
out('contents.json',[...contents].map(([h,v])=>({h,...v})));
console.error('contents:',contents.size,'accepted:',[...contents.values()].filter(v=>v.ok).length);

// ------------------------------------------------------------------ 3. ticker fields and labels
const names=['PEPE','ABCDEFGHIJKL','ABCDEFGHIJKLM','','a','z9','A B','a-b','a_b','ペペ','é','１２','٣','PEPE\n','\nPEPE','PEPE\r','İ','ı','K','ſ','TOKEN','token','0','000000000000','0000000000000','😀','A😀','aé','Ａ','a\u0301','A"','A\\','AZaz09','@','[','`','{','/',':','G','g'];
out('labels.json',names.map(t=>{const id=hex(sha256(enc(t)));return {t,id,field:tickerField(t),label:tokenLabel(t,id)};}));

// ------------------------------------------------------------------ 4. whole records
const alice=wallet('parity alice'),bob=wallet('parity bob'),sub=alice.sub(5);
const L=ed25519.CURVE.n,P=2n**255n-19n,Pt=ed25519.ExtendedPoint;
const secretOf=w=>w.kind==='sub'?leBytes((le(w.spendSecret)+w.subScalar)%L):w.spendSecret;
let nonce=0;
// Record bytes written field by field with no checks, so that shapes the library would not write can be made.
function body({who=alice,collection=new Uint8Array(32),edition=[0,0,0,0],kind,spend,view,flags=0,to=[],name=[],type=6,content,len,after=[]}){
 const c=content instanceof Uint8Array?content:enc(content),n=len??c.length;
 return concat(Uint8Array.of(0x4d,0x44,0x31,0xfe,8),collection,Uint8Array.from(edition),Uint8Array.of(kind??(who.kind==='sub'?1:0)),spend??who.spend,view??who.view,Uint8Array.of(flags),Uint8Array.from(to),Uint8Array.of(name.length),Uint8Array.from(name),Uint8Array.of(type,n&255,n>>8),c,Uint8Array.from(after));}
// The text a reader would rebuild for a plain mint of this body, signed by `who` whatever the record's other bytes say.
function sealed(o,{ending=0,variant=ending,signer,textOf,sigEdit}={}){
 const who=o.who??alice,b=body(o),c=o.content instanceof Uint8Array?o.content:enc(o.content),kind=(o.kind??(who.kind==='sub'?1:0))===1?'sub':'main';
 const address=encodeAddress({spend:o.spend??who.spend,view:o.view??who.view,kind}),id=recordId(DOMAIN,b);
 let text=`XMR721 mint: one NFT in no collection; ${c.length} bytes of type ${o.type??6}, SHA-256 ${hex(sha256(c))}; first owner ${address}; code ${id.slice(0,32)}`;
 if(textOf)text=textOf(text,{address,id,c});
 const s=signer??who,sd=sha256(enc('parity nonce '+(nonce++)));
 let sig;try{sig=parseSignature(signWithSpendKey(text+SUFFIX[ending],{spend:o.spend??s.spend,view:o.view??s.view},secretOf(s),()=>concat(sd,sd)));}catch{sig={c:new Uint8Array(32).fill(1),r:new Uint8Array(32).fill(2)};}
 if(sigEdit)sig=sigEdit(sig);
 return concat(b,Uint8Array.of(variant),sig.c,sig.r);}
// What this repository's rules make of a record: section 4 of OPEN.md, as the XMR721 ledger checks a mint (ledger.mjs validate).
function verdict(bytes){
 let d;try{d=decodeRecord(bytes,'mainnet');}catch{return {ok:false,why:'decode'};}
 if(bytes.length>MAX_RECORD)return {ok:false,why:'size'};
 const f=openDeployOf(d);if(!f)return {ok:false,why:'shape'};
 const text=renderText(OP.mint,d.body,d.bodyBytes,{domain:DOMAIN,collectionName:null});
 if(!verifySpendSignature(text+SUFFIX[d.proof.variant],d.body.creator,{c:d.proof.c,r:d.proof.r},'mainnet'))return {ok:false,why:'signature'};
 const id=recordId(DOMAIN,d.bodyBytes);
 return {ok:true,id,text,creator:d.body.creator,tick:f.tick,field:tickerField(f.tick),label:tokenLabel(f.tick,id)};}
const records=new Map();
const addR=(note,bytes)=>{const k=hex(bytes);if(!records.has(k))records.set(k,{note,...verdict(bytes)});return bytes;};

const good=[plain,full,allPre,T('"ペペ"'),T('"a\\"b\\\\c"'),openDeployText({tick:'A-very-long-ticker_with.signs!',max:'18446744073709',col:'ab'.repeat(32),lim:'18446744073709'})];
const baseRecords=[];
for(const who of [alice,bob,sub])for(const content of good)for(const ending of [0,1,2]){const r=addR('valid',sealed({who,content},{ending}));baseRecords.push({who,content,ending,r});if(!records.get(hex(r)).ok)throw Error('a valid record is refused by the JavaScript rules');}
// the longest deploys there are (597 bytes: the 600 byte limit is never what refuses a text)
{const longest=Math.max(...[...contents].filter(([,v])=>v.ok).map(([k])=>k.length/2)),t=[...contents].filter(([k,v])=>v.ok&&k.length/2>=longest-1).map(([k])=>unhex(k));console.error('longest accepted text:',longest,'bytes');
 for(const c of t.slice(0,6))for(const who of [alice,sub])addR('longest',sealed({who,content:c}));}
// every accepted content of part 2 and a share of the refused ones, in a signed record
{let i=0;for(const [k,v] of contents){if(!k.length)continue;if(v.ok||i++%6===0)addR('content',sealed({who:pick([alice,bob,sub]),content:unhex(k)},{ending:rnd()%3}));}}
// variants and endings that do not match
for(const b of baseRecords.filter((x,i)=>i%6===0)){for(let v=0;v<6;v++)for(let e=0;e<3;e++)addR('variant',sealed({who:b.who,content:b.content},{ending:e,variant:v}));
 for(const v of [0x80,0xfe,0xff])addR('variant',sealed({who:b.who,content:b.content},{variant:v}));}
// shape: every header field moved off its one value, with a signature over the text a reader would rebuild
for(const who of [alice,sub]){const o={who,content:plain};
 for(let i=0;i<32;i++){const c=new Uint8Array(32);c[i]=1;addR('collection',sealed({...o,collection:c}));}
 for(const e of [[1,0,0,0],[0,1,0,0],[0,0,0,1],[255,255,255,255]])addR('edition',sealed({...o,edition:e}));
 for(let k=0;k<256;k++)addR('kind',sealed({...o,kind:k}));
 for(let f=1;f<256;f++)addR('flags',sealed({...o,flags:f}));
 const party=w=>[w.kind==='sub'?1:0,...w.spend,...w.view];
 for(const f of [1,3])for(const w of [who,bob,sub,alice])addR('to',sealed({...o,flags:f,to:party(w)}));
 addR('to with flags 0',sealed({...o,flags:0,to:party(bob)}));
 for(const f of [2,3])addR('origin',sealed({...o,flags:f,to:f&1?party(bob):[],after:[1,36,...new Uint8Array(36)]}));
 addR('origin bytes with flags 0',sealed({...o,after:[1,1,0]}));addR('spare byte',sealed({...o,after:[0]}));
 for(const n of [[0x50],[0x50,0x45,0x50,0x45],[0x20],[0x22],[0]])addR('name',sealed({...o,name:n}));
 for(let t=0;t<256;t++)if(t!==6)addR('type',sealed({...o,type:t}));
 for(const d of [-2,-1,1,2,256,65535-plain.length])addR('content length',sealed({...o,len:plain.length+d}));
 addR('no content',sealed({...o,content:new Uint8Array(0)}));
 // text variations a reader does not rebuild
 for(const f of [t=>t+' ',t=>t.replace('one NFT','one  NFT'),t=>t.replace('type 6','type 06'),t=>t.toUpperCase(),t=>t.replace(/code .*/,'code '+'0'.repeat(32)),t=>t.replace('first owner','first owner '),(t,{id})=>t.replace(/code .*/,'code '+id),(t,{id})=>t.replace(/code .*/,'code '+id.slice(0,16))])
  addR('another text',sealed(o,{textOf:f}));
 addR('signed by another wallet',sealed(o,{signer:bob}));}
// keys: the spend key cannot be changed and still sign, the view key can
const small=['0100000000000000000000000000000000000000000000000000000000000000','0100000000000000000000000000000000000000000000000000000000000080','ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f','ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
 '0000000000000000000000000000000000000000000000000000000000000000','0000000000000000000000000000000000000000000000000000000000000080','26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05','26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a','c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa'].map(unhex);
const noncanon=[];for(let y=0n;y<19n;y++)for(const s of [0,1]){const b=leBytes(y+P);b[31]|=s<<7;noncanon.push(b);}
const tiny=[];for(let y=0n;y<40n;y++)for(const s of [0,1]){const b=leBytes(y);b[31]|=s<<7;tiny.push(b);}
const nearP=[];for(let d=1n;d<40n;d++)for(const s of [0,1]){const b=leBytes(P-d);b[31]|=s<<7;nearP.push(b);}
// points with a small-order part added (on the curve, outside the main group), and good points with the sign bit turned
const T8=Pt.fromHex('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',true),mixed=[];
for(let k=1;k<8;k++){mixed.push(Pt.fromHex(hex(alice.view)).add(T8.multiply(BigInt(k))).toRawBytes());mixed.push(Pt.fromHex(hex(alice.spend)).add(T8.multiply(BigInt(k))).toRawBytes());}
const flipped=[alice.view,bob.view,bob.spend,sub.view].map(v=>{const b=v.slice();b[31]^=0x80;return b;});
const randomKeys=[];for(let i=0;i<400;i++)randomKeys.push(sha256(enc('parity key '+i)));
const keys=[...small,...noncanon,...tiny,...nearP,...mixed,...flipped,...randomKeys,bob.view,bob.spend,sub.view,alice.spend,Pt.BASE.toRawBytes(),new Uint8Array(32).fill(0xff),unhex('ff'.repeat(31)+'7f')];
for(const who of [alice,sub])for(const k of keys){addR('view key',sealed({who,content:plain,view:k}));addR('spend key',sealed({who,content:plain,spend:k}));}
for(const k of [...small,...noncanon.slice(0,6)])addR('both keys',sealed({content:plain,spend:k,view:k}));
// signature scalars
const le32=n=>leBytes(n);
for(const b of baseRecords.filter((x,i)=>i%9===0)){const o={who:b.who,content:b.content};
 for(const f of [s=>({c:new Uint8Array(32),r:s.r}),s=>({c:s.c,r:new Uint8Array(32)}),s=>({c:new Uint8Array(32),r:new Uint8Array(32)}),s=>({c:le32(le(s.c)+L),r:s.r}),s=>({c:s.c,r:le32(le(s.r)+L)}),s=>({c:le32(le(s.c)+L),r:le32(le(s.r)+L)}),
  s=>({c:le32(L),r:s.r}),s=>({c:le32(L-1n),r:s.r}),s=>({c:s.c,r:le32(L)}),s=>({c:s.c,r:le32(L-1n)}),s=>({c:le32(L-le(s.c)),r:s.r}),s=>({c:s.c,r:le32(L-le(s.r))}),s=>({c:s.r,r:s.c}),s=>({c:le32(le(s.c)+8n*L),r:s.r}),s=>({c:s.c,r:le32(le(s.r)+8n*L)}),
  s=>({c:new Uint8Array(32).fill(0xff),r:s.r}),s=>({c:s.c,r:new Uint8Array(32).fill(0xff)}),s=>{const c=s.c.slice();c[31]|=0x80;return {c,r:s.r};},s=>{const r=s.r.slice();r[31]|=0x80;return {c:s.c,r};},s=>({c:le32(1n),r:s.r}),s=>({c:s.c,r:le32(1n)})])
  addR('signature scalar',sealed(o,{ending:b.ending,sigEdit:f}));}
// every byte of valid records changed after signing; cuts and added bytes
for(const b of [baseRecords[0],baseRecords[22],baseRecords[40],baseRecords[53]]){const r=b.r;
 for(let i=0;i<r.length;i++){for(const x of [1,0x80]){const c=r.slice();c[i]^=x;addR('byte changed',c);}for(const x of [0,0xff]){if(r[i]!==x){const c=r.slice();c[i]=x;addR('byte set',c);}}}
 for(let i=0;i<r.length;i+=(i<120||i>r.length-70)?1:7)addR('cut',r.slice(0,i));
 for(const extra of [[0],[0xff],[0,0],new Array(65).fill(0),new Array(1000-r.length).fill(0),new Array(1001-r.length).fill(0)])addR('added bytes',concat(r,Uint8Array.from(extra)));
 addR('twice',concat(r,r));}
// the largest records: content of other types up to and over 1,000 bytes in all
for(const n of [600,601,700,824,825,826,2000])for(const type of [6,5])addR('large',sealed({content:new Uint8Array(n).fill(0x41),type}));
// not an MD1 mint at all
for(const h of ['','4d','4d4431fe','4d4431fe08','4d4431fe07','584f31fe','4d4431ff08'+'00'.repeat(200)])addR('other',unhex(h));
out('records.json',{domain:DOMAIN,cases:[...records].map(([h,v])=>({h,...v}))});
const why={};for(const v of records.values())why[v.ok?'deploy':v.why]=(why[v.ok?'deploy':v.why]||0)+1;
console.error('records:',records.size,JSON.stringify(why));

// ------------------------------------------------------------------ 5. the transaction field that carries the record
// tx_extra written in ways a wallet would not write it. A token exists for the JavaScript side when the XMR721 reader
// takes a record out of the field (reader/lib/transport.mjs unframe) and the record is an open deploy.
{const extras=new Map(),pub=sha256(enc('parity tx key')),pid=Uint8Array.of(2,9,1,1,2,3,4,5,6,7,8),K=Uint8Array.of(1,...pub);
 const chunk=c=>{const l=c.length+1;return Uint8Array.of(2,...(l<128?[l]:[(l&127)|128,l>>7]),127,...c);};
 const cut=(r,n=254)=>{const o=[];for(let i=0;i<r.length;i+=n)o.push(chunk(r.subarray(i,i+n)));return o;};
 const addE=(note,...parts)=>{const e=concat(...parts.flat()),k=hex(e);if(extras.has(k))return;const r=unframe(e),v=r?verdict(r):{ok:false};extras.set(k,{note,record:Boolean(r),ok:v.ok,...(v.ok?{id:v.id}:{})});};
 const longest=[...records].filter(([,v])=>v.note==='longest'&&v.ok).map(([k])=>unhex(k))[0];
 for(const r of [baseRecords[0].r,baseRecords[4].r,longest]){const c=cut(r);
  addE('as written',K,c);addE('as written, payment id',K,pid,c);
  addE('order: key last',c,K);addE('order: key after the payment id',pid,K,c);addE('order: payment id last',K,c,pid);addE('order: payment id first, key last',pid,c,K);
  if(c.length>1){addE('order: key between chunks',c[0],K,c.slice(1));addE('order: payment id between chunks',K,c[0],pid,c.slice(1));addE('chunks in another order',K,[...c].reverse());}
  addE('no key',c);addE('two keys',K,K,c);addE('two keys around',K,c,K);addE('two payment ids',K,pid,pid,c);addE('payment id of 32 bytes',K,Uint8Array.of(2,33,0,...pub),c);addE('another nonce',K,Uint8Array.of(2,2,0x55,0),c);
  addE('padding after',K,c,[Uint8Array.of(0)]);addE('padding after, long',K,c,[new Uint8Array(20)]);addE('additional keys field',K,Uint8Array.of(4,1,...pub),c);addE('merge mining field',K,Uint8Array.of(3,2,0,0),c);addE('unknown field',K,c,[Uint8Array.of(0xde,1,0)]);
  addE('empty chunk after',K,c,[Uint8Array.of(2,1,127)]);addE('empty chunk before',K,[Uint8Array.of(2,1,127)],c);
  for(const n of [1,100,127,128,253,255])addE('chunks of '+n,K,cut(r,n));
  addE('one byte moved to a new chunk',K,cut(r.subarray(0,r.length-1)),[chunk(r.subarray(r.length-1))]);
  // length written with a second byte it does not need, and with a marker other than 7f
  addE('long length form',K,c.map(x=>x[1]<128?concat(Uint8Array.of(2,x[1]|128,0),x.subarray(2)):x));
  addE('other marker',K,c.map(x=>{const y=x.slice();y[x[1]<128?2:3]=0x7e;return y;}));
  addE('key cut short',K.subarray(0,32),c);addE('record cut short',K,c.map((x,i)=>i===c.length-1?x.subarray(0,x.length-1):x));addE('nothing',[]);addE('key only',K);}
 // sizes at the two limits (1,000 bytes for the XMR721 reader, 1,011 for the token ledger): never a deploy, by its size
 for(const n of [824,825,835,836])addE('large',K,cut(sealed({content:new Uint8Array(n).fill(0x41),type:5})));
 out('extras.json',{domain:DOMAIN,cases:[...extras].map(([h,v])=>({h,...v}))});
 console.error('extras:',extras.size,'records for the XMR721 reader:',[...extras.values()].filter(v=>v.record).length,'deploys:',[...extras.values()].filter(v=>v.ok).length);}
