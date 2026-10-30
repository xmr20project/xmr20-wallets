import {validateRecord,message,canonical,digest,payload} from './records.mjs';
import {moneroOwner} from '../core-next/records.mjs';
import {identityAddresses} from './sdk.mjs';
// Called only inside an offline one-shot worker after explicit identity review.
// No financial fields, generic message signing, seed export or token-link reuse.
export function checkedIdentityReview(review, context){
 const r=validateRecord(review?.record),c=context?.config;
 if(!c||c.network!=='mainnet-beta'||context.schema!=='wallet-identity-review-v1'
   ||review.message!==message(r)||r.owner!==context.moneroOwner
   ||c.binding!==digest(r.owner)||r.registry!==c.program||r.verifier!==c.verifier
   ||r.to!==c.owner||canonical(r)!==canonical(context.expectedRecord))
   throw Error('Identity differs from the selected wallets and visible review.');
 identityAddresses(c);
 return r;
}
export async function signIdentityRecord({loadNative,seed,review,context}){
 const r=checkedIdentityReview(review,context);if(typeof seed!=='string'||seed.length>500||seed.trim().split(/\s+/).length!==25)throw Error('Saved Monero wallet is unavailable.');let m,p;
 try{m=await loadNative();p=await new Promise((resolve,reject)=>m.create_full_wallet(JSON.stringify({networkType:0,seed:seed.trim().toLowerCase().replace(/\s+/g,' '),seedOffset:'',path:'',password:'',restoreHeight:0}),'joint-identity-offline',value=>typeof value==='number'&&value>0?resolve(value):reject(Error('Owner approval failed.'))));seed='';
  if(m.get_address(p,0,0)!==r.owner)throw Error('Owner approval failed.');const signature=m.sign_message(p,review.message,0,0,0),v=JSON.parse(m.verify_message(p,review.message,r.owner,signature));if(!v.isGood||v.isOld||v.version!==2||v.signatureType!=='spend')throw Error('Owner approval failed.');payload({record:r,signature});return {signature};
 }catch{throw Error('Monero approval failed. Check the saved wallet and reviewed identity.');}finally{seed='';if(m&&p)await new Promise(resolve=>m.close(p,false,0,resolve));}
}
export async function verifyIdentityRecord({loadNative,text,address,signature}){
 moneroOwner(address);if(typeof text!=='string'||text.length>2000||typeof signature!=='string'||signature.length>120)return {good:false};const at=text.indexOf('\n');if(at<0)return {good:false};let r;try{r=validateRecord(JSON.parse(text.slice(at+1)));if(message(r)!==text||r.owner!==address)return {good:false};}catch{return {good:false};}
 let m,k,p;try{m=await loadNative();const handle=fn=>new Promise((resolve,reject)=>fn(v=>typeof v==='number'&&v>0?resolve(v):reject(Error('Verification unavailable.'))));k=await handle(cb=>m.create_keys_wallet_random(JSON.stringify({networkType:0,language:'English',seedOffset:''}),cb));try{p=await handle(cb=>m.create_full_wallet(JSON.stringify({networkType:0,seed:m.get_seed(k),seedOffset:'',path:'',password:'',restoreHeight:0}),'joint-identity-verification',cb));}finally{await new Promise(resolve=>m.close(k,false,0,resolve));k=null;}const v=JSON.parse(m.verify_message(p,text,address,signature));return {good:v.isGood===true&&v.isOld===false&&v.version===2&&v.signatureType==='spend'};}catch{return {good:false};}finally{if(m&&p)await new Promise(resolve=>m.close(p,false,0,resolve));}
}
