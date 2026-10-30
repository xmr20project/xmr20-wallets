import {PublicKey} from '@solana/web3.js';
import {validateWalletMessage} from './pilot-transaction.js';
// Only addresses actually referenced by the reviewed message enter its signed ticket.
export function compactWalletTables(message,records){
 return message.addressTableLookups.map(ref=>{
  const record=records.find(t=>t.key===ref.accountKey.toBase58());if(!record)throw Error('Missing reviewed address table.');
  const addresses={};for(const i of [...ref.writableIndexes,...ref.readonlyIndexes]){
   if(!record.addresses[i])throw Error('Missing reviewed address.');addresses[i]=record.addresses[i];
  }return {key:record.key,addresses};
 });
}
export function resolved(message,records){
 const writable=[],readonly=[];
 for(const ref of message.addressTableLookups){
  const table=records.find(t=>t.key===ref.accountKey.toBase58());if(!table)throw Error('Wallet introduced an unreviewed address table.');
  for(const [indexes,out] of [[ref.writableIndexes,writable],[ref.readonlyIndexes,readonly]])for(const i of indexes){
   if(!table.addresses[i])throw Error('Wallet introduced an unreviewed address.');out.push(new PublicKey(table.addresses[i]));
  }
 }
 const keys=[...message.staticAccountKeys,...writable,...readonly];
 for(const ix of message.compiledInstructions)for(const i of [ix.programIdIndex,...ix.accountKeyIndexes])if(!keys[i])throw Error('Invalid compiled account index.');
 return {version:message.version,header:message.header,recentBlockhash:message.recentBlockhash,staticAccountKeys:keys,compiledInstructions:message.compiledInstructions,addressTableLookups:[],isAccountSigner:i=>message.isAccountSigner(i),isAccountWritable:i=>message.isAccountWritable(i),serialize:()=>message.serialize()};
}
export function validateResolvedWalletMessage(before,after,records){return validateWalletMessage(resolved(before,records),resolved(after,records));}
