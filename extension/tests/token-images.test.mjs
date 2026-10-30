import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {createTokenImageClient,tokenImage} from '../../engine/shared/token-display.js';
import {createPriceClient} from '../../engine/shared/prices.js';
const mint=()=>Keypair.generate().publicKey.toBase58();
const png=Buffer.from('89504e470d0a1a0a00000000','hex');
test('LaunchLab exact-mint images become safe inline raster URLs without changing CSP or host permissions',async()=>{
 const m=mint(),url='https://xmr20.org/tweet-wallet/assets/'+'ab'.repeat(32)+'.png';let calls=0;
 const client=createTokenImageClient({fetcher:async(u,o)=>{calls++;assert.equal(u,url);assert.equal(o.credentials,'omit');assert.equal(o.redirect,'error');return new Response(png,{headers:{'Content-Type':'image/png'}});}});
 await client.load([{mint:m,imgUrl:url}]);assert.equal(tokenImage(m),'data:image/png;base64,'+png.toString('base64'));await client.load([{mint:m,imgUrl:url}]);assert.equal(calls,1);
});
test('arbitrary hosts, local URLs, credentials, SVG, MIME mismatches and oversized responses never become images',async()=>{
 for(const url of ['https://unrelated.example/tracker','http://127.0.0.1/private','https://user:pass@xmr20.org/image']){let calls=0;const m=mint();await createTokenImageClient({fetcher:async()=>{calls++;}}).load([{mint:m,imgUrl:url}]);assert.equal(calls,0);assert.equal(tokenImage(m),null);}
 for(const [body,mime] of [['<svg/>','image/svg+xml'],['html','image/png'],[Buffer.alloc(512001),'image/png']]){const m=mint();await createTokenImageClient({fetcher:async()=>new Response(body,{headers:{'Content-Type':mime}})}).load([{mint:m,imgUrl:'https://xmr20.org/image.png'}]);assert.equal(tokenImage(m),null);}
});
test('failed artwork is throttled and cannot suppress token balances or prices',async()=>{
 const m=mint();let calls=0;const client=createTokenImageClient({fetcher:async()=>{calls++;throw Error('offline');}});await client.load([{mint:m,imgUrl:'https://xmr20.org/art.png'}]);await client.load([{mint:m,imgUrl:'https://xmr20.org/art.png'}]);assert.equal(calls,1);assert.equal(tokenImage(m),null);
});
test('price discovery supplies artwork only for exact requested mints and rejects duplicate or unrelated rows',async()=>{
 const m=mint(),seen=[];
 const good=createPriceClient({onMetadata:rows=>seen.push(...rows),fetcher:async()=>Response.json({success:true,data:{rows:[{mint:m,imgUrl:'https://xmr20.org/art.png'}]}})});
 await good.load([m]);assert.equal(seen.length,1);assert.equal(seen[0].mint,m);
 for(const rows of [[{mint:mint()}],[{mint:m},{mint:m}]]){let called=false;await createPriceClient({onMetadata:()=>called=true,fetcher:async()=>Response.json({success:true,data:{rows}})}).load([m]);assert.equal(called,false);}
});
