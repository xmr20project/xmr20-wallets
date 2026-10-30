import bs58 from 'bs58';
import {Keypair,PublicKey,SystemProgram,Transaction,Connection} from '@solana/web3.js';
export {checkMoneroAddress} from './address.js';
export {loadWalletHoldings,validateWalletHoldings,tokenAmount} from './holdings.js';
export {Keypair,PublicKey,bs58};
const enc=new TextEncoder(),dec=new TextDecoder();
const b64=a=>btoa(String.fromCharCode(...new Uint8Array(a)));
const un64=s=>Uint8Array.from(atob(s),x=>x.charCodeAt(0));
export function units(value,decimals){
 if(typeof value!=='string'||!new RegExp('^(?:0|[1-9][0-9]{0,12})(?:\\.[0-9]{1,'+decimals+'})?$').test(value))throw Error('Enter a valid amount with up to '+decimals+' decimal places.');
 const [whole,fraction='']=value.split('.');const n=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0'));
 if(n<=0n)throw Error('Amount must be greater than zero.');return n;
}
export function amount(raw,decimals=6){if(raw==null)return '—';const n=BigInt(raw),base=10n**BigInt(decimals),f=String(n%base).padStart(decimals,'0').replace(/0+$/,'');return (n/base).toLocaleString('en-US')+(f?'.'+f:'');}
export function solAddress(address){try{return new PublicKey(address).toBase58()===address;}catch{return false;}}
export function importSol(secret){try{const input=secret.trim();const bytes=input.startsWith('[')?Uint8Array.from(JSON.parse(input)):bs58.decode(input);if(bytes.length!==64)throw Error();return Keypair.fromSecretKey(bytes);}catch{throw Error('Enter a Solana private key in base58 or a 64-byte JSON array.');}}
async function derive(password,salt,usages){const material=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',iterations:600000,salt},material,{name:'AES-GCM',length:256},false,usages);}
export async function encryptVault(data,password){
 if(password.length<8)throw Error('Use at least 8 characters for your password.');
 const salt=crypto.getRandomValues(new Uint8Array(32)),iv=crypto.getRandomValues(new Uint8Array(12));const key=await derive(password,salt,['encrypt']);const plain=enc.encode(JSON.stringify(data));
 try{return {version:1,kdf:'PBKDF2-SHA256',iterations:600000,salt:b64(salt),iv:b64(iv),ciphertext:b64(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode('XMR20-extension-v1')},key,plain))};}finally{plain.fill(0);}
}
export async function decryptVault(box,password){
 try{if(box.version!==1||box.kdf!=='PBKDF2-SHA256'||box.iterations!==600000||box.ciphertext.length>2000000||un64(box.salt).length!==32||un64(box.iv).length!==12)throw Error();const key=await derive(password,un64(box.salt),['decrypt']);const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(box.iv),additionalData:enc.encode('XMR20-extension-v1')},key,un64(box.ciphertext));try{const d=JSON.parse(dec.decode(plain));if(!Array.isArray(d.accounts)||d.accounts.length>100)throw Error();return d;}finally{new Uint8Array(plain).fill(0);}}catch{throw Error('Could not unlock. Check your password and backup file.');}
}
export const RPC='https://solana-rpc.publicnode.com';
export const connection=new Connection(RPC,'confirmed');
export async function prepareSolSend(account,to,input){
 const from=new PublicKey(account.sol),recipient=new PublicKey(to),lamports=units(input,9);
 if(from.equals(recipient))throw Error('Choose a different recipient.');
 const latest=await connection.getLatestBlockhash('confirmed');
 const tx=new Transaction({feePayer:from,...latest}).add(SystemProgram.transfer({fromPubkey:from,toPubkey:recipient,lamports}));
 const fee=await connection.getFeeForMessage(tx.compileMessage(),'confirmed');if(fee.value===null)throw Error('Fee unavailable. Try again.');
 const balance=await connection.getBalance(from,'confirmed');if(!Number.isSafeInteger(balance)||lamports+BigInt(fee.value)>BigInt(balance))throw Error('Insufficient SOL for this amount and network fee.');
 return {tx,to,amountRaw:String(lamports),feeRaw:String(fee.value),expires:Date.now()+45000,...latest};
}
export function signSolSend(prepared,secret){if(Date.now()>prepared.expires)throw Error('Review expired. Review the amount and fee again.');const key=importSol(secret);try{prepared.tx.sign(key);return {bytes:prepared.tx.serialize(),hash:bs58.encode(prepared.tx.signature)};}finally{key.secretKey.fill(0);}}
export async function sendSolSigned(bytes){return connection.sendRawTransaction(bytes,{skipPreflight:false,maxRetries:2,preflightCommitment:'confirmed'});}
export async function jsonFetch(url,body,{timeout=25000}={}){const r=await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(timeout)});const d=await r.json();if(!r.ok||d.error){const error=Error(r.status===403?'This extension has not yet been enabled by the XMR20 transfer service.':typeof d.error==='string'?d.error:'Service unavailable. Please retry.');error.status=r.status;if(typeof d.code==='string'&&/^[A-Z_]{1,80}$/.test(d.code))error.code=d.code;throw error;}return d;}
export async function login(account){
 const key=importSol(account.solSecret);
 try{const c=await jsonFetch('https://xmr20.org/api/wallet-auth',{action:'challenge',wallet:account.sol});
 const origin=location.origin;const prefix='Sign in to XMR20\nWebsite: '+origin+'\nWallet: '+account.sol+'\n';
 if(typeof c.message!=='string'||c.message.length>1000||!c.message.startsWith(prefix)||!c.message.endsWith('This signature proves wallet ownership. It does not authorize a transaction.'))throw Error('Unexpected sign-in request.');
 const {ed25519}=await import('@noble/curves/ed25519');const signature=bs58.encode(ed25519.sign(enc.encode(c.message),key.secretKey.slice(0,32)));
 const result=await jsonFetch('https://xmr20.org/api/wallet-auth',{action:'signin',challenge:c.challenge,signature});if(result.wallet!==account.sol)throw Error('Sign-in account mismatch.');return result.token;
 }finally{key.secretKey.fill(0);}
}
export const walletRequest=(token,action,data={})=>jsonFetch('https://xmr20.org/api/wallet',{action,token,...data},{timeout:120000}).catch(error=>{if(['TimeoutError','AbortError'].includes(error.name))throw Error(['moneroTransferQuote','account'].includes(action)?'The service is taking too long to verify balances. Your funds have not moved. Please retry.':'The service has not replied yet. Check Activity before trying again; the transfer may still be processing.');throw error;});
export function validateTransfer(t,account,row,to,raw){
 const prefix='MOUSE-ROAD-XMR20-MAINNET-TRANSFER-V1\n';
 if(t.owner!==account.sol||t.moneroAddress!==account.xmr||t.recipient!==to||t.amountRaw!==raw||t.state!=='reserved'||!t.signingMessage?.startsWith(prefix))throw Error('Transfer details changed. Nothing signed.');
 const r=JSON.parse(t.signingMessage.slice(prefix.length)),canonical='{'+Object.keys(r).sort().map(k=>JSON.stringify(k)+':'+JSON.stringify(r[k])).join(',')+'}';
 if(Object.keys(r).sort().join(',')!=='amount,net,nonce,op,owner,p,to,token,v'||prefix+canonical!==t.signingMessage||r.p!=='xmr20'||r.v!==1||r.net!=='mainnet'||r.op!=='transfer'||r.owner!==account.xmr||r.to!==to||r.amount!==raw||r.token!==row.deployment||r.nonce!==t.nonce||!/^[a-f0-9]{32}$/.test(r.nonce)||BigInt(raw)>50000000000000n)throw Error('Invalid inscription signing request.');
 return {network:'mainnet',address:account.xmr,destination:to,token:row.deployment,nonce:r.nonce,amountRaw:raw,message:t.signingMessage};
}
export {normalizePreferences,idleExpired,AUTO_LOCK_OPTIONS,timeoutLabel} from './preferences.js';
export {loadPending,validatePending,pendingGroups} from './pending.js';
export {createPriceClient,launchPrice,tokenUsd,tokenPortfolio,usd} from './prices.js';

// Link an existing key, never generate one or silently replace an address.
// Return a new vault so a failed encrypted write cannot mutate the live account.
export function linkSolanaKey(data,targetId,secret){
 const matches=data.accounts.filter(a=>a.id===targetId);
 if(matches.length!==1||!matches[0].xmr||!matches[0].xmrSeed)throw Error('Choose the Monero account you imported first.');
 const target=matches[0],key=importSol(secret);
 try{
  const sol=key.publicKey.toBase58();
  if(target.sol&&target.sol!==sol)throw Error('This account already has a different Solana address. Use the key for its existing address.');
  const linked={...target,sol,solSecret:bs58.encode(key.secretKey),watch:false};
  return {...data,accounts:data.accounts.map(a=>a.id===targetId?linked:a)};
 }finally{key.secretKey.fill(0);}
}
