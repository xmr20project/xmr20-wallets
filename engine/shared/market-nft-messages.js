// MONERO MARKET candidate (29 Oct 2026): the off-chain NFT listing and withdrawal messages the order book accepts
// (research/monero-market-20261029/nft/protocol.mjs), here with WebCrypto for the extension. The message is the domain
// line plus the SHA-256 of the canonical JSON (sorted keys) of the listing; it is signed with the account's Monero spend
// key INSIDE the token worker (engine op marketSignMessage), never in this page.
export const LISTING_DOMAIN='XMR20-MARKET-NFT-LISTING-V1\n',WITHDRAW_DOMAIN='XMR20-MARKET-NFT-WITHDRAW-V1\n';
const enc=new TextEncoder();
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
export const sha256hex=async s=>hex(await crypto.subtle.digest('SHA-256',enc.encode(s)));
export function canonical(x){
 if(x===null||typeof x==='boolean'||typeof x==='string')return JSON.stringify(x);
 if(typeof x==='number'){if(!Number.isSafeInteger(x))throw Error('Unsafe number');return String(x);}
 if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
 if(typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
 throw Error('Unsupported value');
}
const hex64=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x),dec=x=>typeof x==='string'&&/^[1-9][0-9]{0,19}$/.test(x);
export function validateListing(l){
 const keys=['v','genesis','token','last','owner','pricePiconero','created','expires','nonce'];
 if(!l||typeof l!=='object'||Object.keys(l).sort().join()!==keys.slice().sort().join())throw Error('Unexpected listing fields');
 if(l.v!==1||!hex64(l.genesis)||!hex64(l.token)||!hex64(l.last)||typeof l.owner!=='string'||l.owner.length!==95||!dec(l.pricePiconero)||!/^[0-9a-f]{32}$/.test(l.nonce))throw Error('Invalid listing');
 if(!(Number.isSafeInteger(l.created)&&Number.isSafeInteger(l.expires)&&l.expires>l.created&&l.expires-l.created<=7*86400))throw Error('Listing window must be positive and at most seven days');
 return l;
}
export const listingMessage=async l=>LISTING_DOMAIN+await sha256hex(canonical(validateListing(l)));
export const listingId=async l=>sha256hex(await listingMessage(l));
export const withdrawMessage=async w=>WITHDRAW_DOMAIN+await sha256hex(canonical({v:1,listing:w.listing,owner:w.owner,created:w.created}));
