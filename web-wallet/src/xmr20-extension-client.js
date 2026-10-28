// Connection, bounded sign-in, and opening the extension's bridge or market.
// This provider deliberately offers no generic remote transaction signing.
import bs58 from 'bs58';
export const XMR20_EXTENSION_ID='jigbpnljnmbbkebaopbnnhmiafgnofla';
export function createXmr20ExtensionClient({runtime=globalThis.chrome?.runtime,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 let account=null,connected=false;
 async function call(action,data={}){if(!runtime?.sendMessage)throw Error('Open in Chrome with XMR20 Wallet installed.');let r;try{r=await runtime.sendMessage(XMR20_EXTENSION_ID,{channel:'xmr20-site',action,...data});}catch{throw Error('XMR20 Wallet is unavailable. Install or reload the extension and retry.');}if(r?.error)throw Error(r.error);if(!r||!Object.hasOwn(r,'value'))throw Error('Wallet did not return a valid reply.');return r.value;}
 async function approval(action,data){const start=await call(action,data);if(typeof start?.requestId!=='string')throw Error('Wallet approval did not open.');const deadline=Date.now()+300000;while(Date.now()<deadline){const r=await call('result',{requestId:start.requestId});if(r.done)return r.value;await sleep(500);}throw Error('Wallet request expired. Reconnect and try again.');}
 const p={kind:'xmr20',name:'XMR20 Wallet',get isConnected(){return connected;},get publicKey(){return account?.solana?{toBase58:()=>account.solana}:null;},get account(){return account;},
  async connect(){const r=await approval('connect');if(!r?.account?.solana||!r.account.canSign)throw Error('Choose an account with a Solana key.');account=r.account;connected=true;return {publicKey:p.publicKey};},
  async connectMonero(){const r=await approval('connectMonero');if(!r?.account?.monero||!r.account.canSignMonero||r.account.solana!==null||r.account.canSign!==false)throw Error('Choose a Monero wallet in XMR20 Wallet.');account=r.account;connected=true;return {address:account.monero};},
  assertCurrent(){if(!connected||!account)throw Error('Reconnect XMR20 Wallet.');},
  async checkCurrent(){p.assertCurrent();const r=await call('status');if(r?.account?.id!==account.id||r.account.solana!==account.solana||r.account.monero!==account.monero){connected=false;throw Error('Wallet locked or connection changed. Connect again.');}},
  async disconnect(){await call('disconnect');connected=false;account=null;},
  async signMessage(bytes){await p.checkCurrent();if(!account.solana||!account.canSign)throw Error('This Monero connection cannot sign Solana messages.');const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),r=await approval('signIn',{message:text});return {signature:bs58.decode(r.signature),publicKey:p.publicKey};},
  async openBridge(bridge){await p.checkCurrent();if(!account.solana||!account.canSign)throw Error('Open the bridge separately in XMR20 Wallet.');const info=await call('ping');if(info.jointBridge!==true)throw Error('This wallet needs the joint bridge update. Your existing legacy withdrawals remain available in the extension.');return approval('openBridge',{bridge});},
  async marketCapabilities(){await p.checkCurrent();const info=await call('ping');return {walletMarket:info.nativeMarket===true};},
  async openMarket(market){await p.checkCurrent();const info=await call('ping');if(info.nativeMarket!==true)throw Error('This XMR20 Wallet build does not include market approvals yet. Keep your current wallet installed.');const result=await call('openMarket',{market});await p.checkCurrent();if(result?.opened!==true||result.account?.id!==account.id||result.account?.monero!==account.monero||result.account?.solana!==account.solana)throw Error('Market opened with an unexpected wallet.');return result;},
  async signTransaction(){throw Error('Review this bridge in XMR20 Wallet. Arbitrary website transactions are not supported.');}
 };return p;
}
