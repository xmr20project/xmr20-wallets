// Starts the CLI's private engine: a loopback web server that serves only the engine files in .engine/, and a headless
// Chromium (Playwright) whose page runs them. Network access is limited to network.mjs's list. The browser profile (scan
// progress, proving-parameter cache) and the loopback port belong to the wallet folder, so saved progress is found again.
import {createServer} from 'node:http';import {readFile,lstat} from 'node:fs/promises';import {join,extname} from 'node:path';import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright';
import {privateDirectory,privateRead,atomicWrite} from './store.mjs';
import {need,UserError,safeText} from './errors.mjs';
import {moneroRequest,forwardRequest} from './network.mjs';
const ROOT=join(import.meta.dirname,'../.engine');
const CSP="default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; worker-src 'self'; connect-src 'self' https://api.xmr20.org https://xmr-node.cakewallet.com:18081 https://node.sethforprivacy.com; frame-ancestors 'none'";
const TYPES={'.wasm':'application/wasm','.html':'text/html; charset=utf-8','.json':'application/json','.js':'text/javascript','.txt':'text/plain'};
async function bounded(response,limit){if(!response.body)return Buffer.alloc(0);const parts=[];let size=0;for await(const c of response.body){size+=c.length;if(size>limit)throw Error('Reply too large');parts.push(c);}return Buffer.concat(parts);}
// Why the private browser did not start. Ubuntu 23.10 and newer (AppArmor) block the user namespaces Chromium's sandbox
// needs, and Chromium then stops with "No usable sandbox!". The CLI keeps the sandbox on; cli/README.md "Linux: Ubuntu 24.04
// and newer" allows it for the downloaded browser only.
export function startFailure(error,platform=process.platform){
 if(error?.code==='EADDRINUSE')return 'Another program is using this wallet\'s engine port. Close the other xmr20 window and try again.';
 if(platform==='linux'&&/No usable sandbox/.test(String(error?.message)))return 'The browser engine could not start its security sandbox: this Linux system blocks it (Ubuntu 24.04 and newer do). The CLI only runs with that sandbox. Allow it once with the steps under "Linux: Ubuntu 24.04 and newer" in the CLI\'s README.md, then try again.';
 return 'Could not start the CLI engine. In the cli folder run "npm run setup" (it downloads the browser engine), then try again.';
}
export async function ensureBuilt(){try{await lstat(join(ROOT,'host.js'));await lstat(join(ROOT,'engine/private-holder.worker.js'));}catch{const {buildCli}=await import('../build.mjs');await buildCli({quiet:true});}}
// onRelay(kind) is told before any transaction leaves for a Monero node, so the terminal can say so; returning false blocks it.
export async function startEngine(dir,{onProgress=()=>{},onRelay=()=>{},fetcher=fetch}={}){
 await ensureBuilt();await privateDirectory(dir);await privateDirectory(join(dir,'journal'));
 let saved;try{saved=JSON.parse(await privateRead(join(dir,'engine.json'),4096));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(saved)need(saved.version===1&&Number.isInteger(saved.port)&&saved.port>1024&&saved.port<65536,'The engine settings in this folder are damaged. Keep the folder and see cli/README.md (doctor).');
 let origin,context,page,closed=false;
 const server=createServer(async(req,res)=>{
  const answer=(status,body,type='application/json')=>{if(!res.headersSent)res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':CSP});res.end(body);};
  try{
   if(req.headers.host!==new URL(origin).host||req.headers['sec-fetch-site']==='cross-site')return answer(403,'{}');
   const url=new URL(req.url,origin);if(url.search||url.hash||/%|\.\./.test(req.url))return answer(404,'{}');
   const fwd=forwardRequest(url.pathname,req.method);
   if(fwd){let body;if(req.method==='POST'){const parts=[];let size=0;for await(const c of req){size+=c.length;if(size>4*1024*1024)return answer(413,'{}');parts.push(c);}body=Buffer.concat(parts);}
    if(fwd.relay&&onRelay('xmr20')===false)return answer(403,'{}');
    // No Origin, cookies or referrer: the same request a program makes. The reply is passed back unchanged.
    const r=await fetcher(fwd.url,{method:req.method,body,headers:body?{'content-type':req.headers['content-type']||'application/json'}:{},redirect:'error',signal:AbortSignal.timeout(fwd.kind==='parameters'?900000:240000)});
    const data=await bounded(r,fwd.kind==='parameters'?512*1024*1024:64*1024*1024);
    res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/octet-stream','content-length':data.length,'cache-control':'no-store'});return res.end(data);}
   if(req.method!=='GET'||!/^\/(?:host\.(?:html|js)|engine\/[A-Za-z0-9_.-]+)$/.test(url.pathname))return answer(404,'{}');
   const file=join(ROOT,url.pathname);return answer(200,await readFile(file),TYPES[extname(file)]||'application/octet-stream');
  }catch{return answer(502,JSON.stringify({error:'Network request failed. Try again.'}));}
 });
 try{
  await new Promise((yes,no)=>{server.once('error',no);server.listen(saved?.port||0,'127.0.0.1',yes);});
  origin=`http://127.0.0.1:${server.address().port}`;
  if(!saved){saved={version:1,port:server.address().port,created:new Date().toISOString(),identity:randomBytes(16).toString('hex')};await atomicWrite(join(dir,'engine.json'),JSON.stringify(saved),{exclusive:true});}
  await privateDirectory(join(dir,'browser-profile'));
  context=await chromium.launchPersistentContext(join(dir,'browser-profile'),{headless:true,chromiumSandbox:true,serviceWorkers:'block',acceptDownloads:false,
   args:['--disable-extensions','--disable-background-networking','--disable-sync']});
  // The page and its workers reach only the loopback server and the Monero nodes' allowed paths; every other request is blocked.
  await context.route('**/*',async route=>{const request=route.request(),url=request.url();
   if(url.startsWith(origin+'/'))return route.continue();
   const m=moneroRequest(url,request.method());if(!m)return route.abort('blockedbyclient');
   if(m.relay&&onRelay('xmr')===false)return route.abort('blockedbyclient');
   try{const body=request.postDataBuffer();
    const r=await fetcher(url,{method:request.method(),body:body||undefined,headers:body?{'content-type':request.headers()['content-type']||'application/json'}:{},redirect:'error',signal:AbortSignal.timeout(120000)});
    await route.fulfill({status:r.status,body:await bounded(r,64*1024*1024),headers:{'content-type':r.headers.get('content-type')||'application/octet-stream','access-control-allow-origin':origin}});
   }catch{await route.fulfill({status:503,body:'{}',headers:{'access-control-allow-origin':origin}}).catch(()=>{});}});
  page=context.pages()[0]||await context.newPage();
  await page.exposeFunction('cliProgress',text=>onProgress(safeText(text)));
  await page.exposeFunction('cliStoreGet',async key=>{need(/^[A-Za-z0-9_-]{1,80}$/.test(key),'bad key');try{return String(await privateRead(join(dir,'journal',key+'.json'),64*1024*1024));}catch(e){if(e.code==='ENOENT')return null;throw e;}});
  await page.exposeFunction('cliStoreSet',async(key,value)=>{need(/^[A-Za-z0-9_-]{1,80}$/.test(key)&&typeof value==='string'&&value.length<64*1024*1024,'bad value');await atomicWrite(join(dir,'journal',key+'.json'),value);return true;});
  await page.exposeFunction('cliSaveCheckpoint',async(base64,height)=>{if(typeof base64!=='string'||base64.length>256*1024*1024)return false;await atomicWrite(join(dir,'xmr-scan-cache.b64'),base64);await atomicWrite(join(dir,'xmr-scan-height.json'),JSON.stringify({height}));return true;});
  await page.goto(origin+'/host.html');await page.waitForFunction(()=>window.cliReady===true,null,{timeout:60000});
 }catch(e){await context?.close().catch(()=>{});server.closeAllConnections?.();await new Promise(r=>server.close(r));
  throw new UserError(startFailure(e));}
 return {
  origin,
  async call(name,...args){need(!closed,'The engine is closed.');let answer;
   try{answer=await page.evaluate(async({name,args})=>{try{const parts=name.split('.');const fn=parts.reduce((o,k)=>o?.[k],window);return {ok:true,value:await fn(...args)};}catch(error){return {ok:false,error:String(error?.message||error),code:error?.code||null};}},{name,args});}
   catch{throw new UserError('The CLI engine stopped. Your saved operations are kept; run the command again.');}
   if(!answer.ok){const error=new UserError(safeText(answer.error));error.code=answer.code;throw error;}return answer.value;},
  async savedCache(){try{return String(await privateRead(join(dir,'xmr-scan-cache.b64'),256*1024*1024));}catch(e){if(e.code==='ENOENT')return null;throw e;}},
  async close(){if(closed)return;closed=true;try{await page?.evaluate(()=>window.cli?.close()).catch(()=>{});await context.close();}finally{server.closeAllConnections?.();await new Promise(r=>server.close(r));}}
 };
}
