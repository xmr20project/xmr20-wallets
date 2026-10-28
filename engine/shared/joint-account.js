import {importSol} from './core.js';
// Keep keys in the existing unlocked account. Never retain a copied secret in
// a bridge session; re-check selection immediately before and after signing.
export function jointAccountProvider({account,assert}){
 const owner=account().sol;
 return Object.freeze({publicKey:{toBase58:()=>owner},assertCurrent:assert,
  async signTransaction(tx){assert();const key=importSol(account().solSecret);try{if(key.publicKey.toBase58()!==owner)throw Error('Solana key does not match the selected account.');tx.sign([key]);assert();return tx;}finally{key.secretKey.fill(0);}}
 });
}
