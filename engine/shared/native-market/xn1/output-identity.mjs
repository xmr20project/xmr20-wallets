import {offlineRecipients} from './records.mjs';
import {publicPoint,verifyRecipient} from './proofs.mjs';
export const UNREVEALED_IMAGE='00'.repeat(32);
export function deferredRecipient(manifest,allocation){
 return offlineRecipients(manifest.profile)&&allocation.image===UNREVEALED_IMAGE&&
  allocation.c===UNREVEALED_IMAGE&&allocation.s===UNREVEALED_IMAGE;
}
export function authorizedRecipient(manifest,args){
 // Even deferred receiving binds a valid, unique native output key. The
 // spending proof later binds its actual key image to this exact public key.
 try{publicPoint(args.outputKey);return deferredRecipient(manifest,args.allocation)||verifyRecipient(args);}catch{return false;}
}
export function lotAcceptsImage(manifest,lot,image){
 try{publicPoint(image);return lot.image===image||offlineRecipients(manifest.profile)&&lot.image===UNREVEALED_IMAGE;}catch{return false;}
}
