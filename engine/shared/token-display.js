import {Buffer} from 'buffer';
// Exact mint identities from LaunchLab. Downloaded raster images are displayed
// as data URLs, keeping the existing self/data-only image CSP unchanged.
const images=Object.freeze({
 'Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR':'icons/tokens/xmr20.png',
 '8zWcEgUZvQKcHgtUoYTnaC6AHX7FmtWVV9WeM4kPuXMR':'icons/tokens/covert.png'
});
const downloaded=new Map();
export const tokenImage=mint=>downloaded.get(mint)|| (Object.hasOwn(images,mint)?images[mint]:null);
export function createTokenImageClient({fetcher=fetch,now=Date.now}={}){
 const attempts=new Map(),pending=new Map();
 async function read(row){
  const mint=row?.mint;if(typeof mint!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)||downloaded.has(mint)||Object.hasOwn(images,mint))return;
  let url;try{url=new URL(row.imgUrl);}catch{return;}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||!['xmr20.org','api.xmr20.org','launch-mint-v1.raydium.io'].includes(url.host))return;
  if(attempts.has(mint)&&now()-attempts.get(mint)<60000)return;attempts.set(mint,now());
  try{
   const r=await fetcher(url.href,{credentials:'omit',redirect:'error',cache:'force-cache',signal:AbortSignal.timeout(6000)});
   if(!r.ok||r.redirected||!r.body?.getReader)return;
   const reader=r.body.getReader(),parts=[];let length=0;
   try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>512000)return;parts.push(Buffer.from(next.value));}}finally{await reader.cancel().catch(()=>{});}
   const data=Buffer.concat(parts),mime=r.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
   const valid=mime==='image/png'&&data.subarray(0,8).toString('hex')==='89504e470d0a1a0a'||mime==='image/jpeg'&&data.subarray(0,3).toString('hex')==='ffd8ff'||mime==='image/webp'&&data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP';
   if(!valid)return;downloaded.set(mint,'data:'+mime+';base64,'+data.toString('base64'));
   if(downloaded.size>32)downloaded.delete(downloaded.keys().next().value);
  }catch{/* Artwork is optional and never delays or changes a token balance. */}
 }
 return {async load(rows){
  // The caller has already matched LaunchLab rows to requested wallet mints.
  const queue=rows.slice(0,1000);await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{while(queue.length){const row=queue.shift();if(pending.has(row.mint)){await pending.get(row.mint);continue;}const task=read(row).finally(()=>pending.delete(row.mint));pending.set(row.mint,task);await task;}}));
 }};
}
export function tokenGroups(rows){return [['monero','MONERO'],['solana','SOLANA']].map(([network,title])=>({network,title,items:rows.map((row,index)=>({row,index})).filter(({row})=>row.network===network)})).filter(group=>group.items.length);}

// Balance and bridge display labels only. Exact atomic quantities stay in the holding row and
// continue to feed USD estimates, details, Max and transaction reviews.
export function compactTokenBalance(raw,decimals=6){
 if(raw===null||raw===undefined)return '—';
 if(typeof raw!=='string'||!/^\d{1,40}$/.test(raw)||!Number.isInteger(decimals)||decimals<0||decimals>18)return '—';
 const n=BigInt(raw),base=10n**BigInt(decimals);
 if(n>0n&&n*100n<base)return '<0.01';
 const suffixes=['','K','M','B','T'];let tier=0,scale=base;
 while(tier<suffixes.length-1&&n>=scale*1000n){tier++;scale*=1000n;}
 let hundredths=(n*100n+scale/2n)/scale;
 // Rounding may cross the next display tier:999.999K becomes1.00M.
 if(hundredths>=100000n&&tier<suffixes.length-1){tier++;scale*=1000n;hundredths=(n*100n+scale/2n)/scale;}
 const whole=(hundredths/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');
 return whole+'.'+(hundredths%100n).toString().padStart(2,'0')+suffixes[tier];
}
