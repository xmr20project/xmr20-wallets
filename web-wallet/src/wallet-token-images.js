let pending=null,expires=0;
// Site launches serve images from api.xmr20.org; tweet-bot (Meteora) launches from xmr20.org/tweet-wallet/assets.
export const isCatalogImage=value=>typeof value==='string'&&(/^https:\/\/api\.xmr20\.org\/(mainnet\/)?i\/[A-Za-z0-9_-]{43}$/.test(value)||/^https:\/\/xmr20\.org\/tweet-wallet\/assets\/[a-f0-9]{64}\.png$/.test(value));
export function catalogImages(tokens){
 const images=new Map();
 for(const t of tokens||[]){
  if(typeof t.mint!=='string')continue;
  if(t.mint==='H2nzua6gpe9PcTp3wvjueD4VvEkVgQMDBySrs8SvCXMR')images.set(t.mint,'https://xmr20.org/assets/tokens/anon-v1.png');
  else if(t.id==='0ef77380-c7fd-4461-85bc-b4cae9182e5a'&&t.mint==='8zWcEgUZvQKcHgtUoYTnaC6AHX7FmtWVV9WeM4kPuXMR')images.set(t.mint,'https://xmr20.org/assets/tokens/covert-v1.png');
  else if(isCatalogImage(t.image))images.set(t.mint,t.image);
 }
 return images;
}
export function loadTokenCatalog(){
 if(!pending||Date.now()>expires){expires=Date.now()+60000;pending=fetch('https://api.xmr20.org/api/xmr20/tokens',{credentials:'omit',signal:AbortSignal.timeout(8000)}).then(async r=>{
  if(!r.ok)throw Error('Index unavailable');const s=await r.json();
  if(s.schema!=='xmr20-launches-v1'||!Array.isArray(s.tokens))throw Error('Invalid index');
  return s.tokens;
 });}
 return pending;
}

export function loadTokenImages(){return loadTokenCatalog().then(catalogImages).catch(()=>new Map());}
