// Local preview of the website wallet: http://127.0.0.1:5180/wallet/wallet.html (Vite dev server, live source).
//   npm run dev:web   (from the repository folder)       add -- --live to allow real transactions
// The wallet's /api/* requests are forwarded to api.xmr20.org the way xmr20.org forwards them, with Origin https://xmr20.org
// (api.xmr20.org serves those routes to xmr20.org). The private bridge and its Monero node (/api/private-bridge/*,
// /api/private-node/*) are forwarded without a browser Origin, as programs call them.
// By default the page stays REVIEW-ONLY on 127.0.0.1 (it shows reviews but does not send). With --live it says
// "Local preview · Mainnet wallet. Transactions you approve use real tokens." and every transaction still needs your
// Phantom/Solflare approval. Browser data is per site: a wallet set up here is not on xmr20.org (and the other way round).
import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const here=import.meta.dirname,live=process.argv.includes('--live');
Object.assign(process.env,{XMR20_OPERATOR_NATIVE_CANDIDATE:'1',XMR20_FAST_SEND:'1',XMR20_UNIVERSAL_LINK:'1',VITE_XMR20_PUBLIC_LAUNCH:'1',VITE_XMR20_DESIGN_PREVIEW:'1'});
if(live)process.env.VITE_XMR20_LOCAL_WALLET_LIVE='1';
const prep=spawnSync(process.execPath,[join(here,'prepare-public.mjs')],{stdio:'inherit'});if(prep.status!==0)process.exit(prep.status||1);
const {createServer}=await import('vite');
// The xmr20.org rewrites the wallet uses (public api.xmr20.org routes and the two public Monero nodes' heights).
const ROUTES=[['^/api/native-market/(.*)$','https://api.xmr20.org','/api/native-market/$1'],['^/api/wallet-identity/([^/?]+)$','https://api.xmr20.org','/api/wallet-identity/$1'],
 ['^/api/joint-transferable/([^/?]+)/([^/?]+)$','https://api.xmr20.org','/api/joint-transferable/$1/$2'],['^/api/bridge-solana-read$','https://api.xmr20.org','/api/bridge-solana-read'],
 ['^/api/wallet$','https://api.xmr20.org','/api/wallet'],['^/api/wallet-auth$','https://api.xmr20.org','/api/wallet-auth'],['^/api/wallet-holdings$','https://api.xmr20.org','/api/wallet-holdings'],
 ['^/api/legacy-launch$','https://api.xmr20.org','/api/legacy-launch'],['^/api/legacy-launch-auth$','https://api.xmr20.org','/api/legacy-launch-auth'],
 ['^/api/xmr20/tokens$','https://api.xmr20.org','/api/xmr20/tokens'],['^/api/xmr20/tokens/([^/?]+)/holders$','https://api.xmr20.org','/api/xmr20/tokens/$1/holders'],
 ['^/api/monero-height/0$','https://xmr-node.cakewallet.com:18081','/get_info'],['^/api/monero-height/1$','https://node.sethforprivacy.com','/get_info']];
const proxy={};
const siteOrigin=p=>p.on('proxyReq',req=>{req.setHeader('origin','https://xmr20.org');req.setHeader('referer','https://xmr20.org/');});
const noOrigin=p=>p.on('proxyReq',req=>{req.removeHeader('origin');req.removeHeader('referer');req.removeHeader('cookie');});
for(const [pattern,target,to] of ROUTES)proxy[pattern]={target,changeOrigin:true,secure:true,configure:siteOrigin,rewrite:path=>{const [p,q='']=path.split('?');return p.replace(new RegExp(pattern),to)+(q?'?'+q:'');}};
for(const prefix of ['/api/private-bridge','/api/private-node'])proxy['^'+prefix+'/']={target:'https://api.xmr20.org',changeOrigin:true,secure:true,configure:noOrigin};
// The older bridge's native engine ("Previously bridged tokens") is served by xmr20.org at /market/native-wallet/.
proxy['^/market/native-wallet/']={target:'https://xmr20.org',changeOrigin:true,secure:true,configure:siteOrigin};
const port=Number(process.env.PORT||5180);
const server=await createServer({configFile:join(here,'vite.config.js'),root:here,configLoader:'native',server:{host:'127.0.0.1',port,strictPort:true,proxy}});
await server.listen();
console.log(`XMR20 website wallet (local preview${live?', LIVE: real transactions':', review only'}): http://127.0.0.1:${port}/wallet/wallet.html`);
