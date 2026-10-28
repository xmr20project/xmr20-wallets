// The BURN redemption ID commits to these terms. The signature authenticates
// the operator's durable quote before a wallet irreversibly consumes a token.
import {Buffer} from 'buffer';
import {ed25519} from '@noble/curves/ed25519';
import {PublicKey} from '@solana/web3.js';
import {operatorPolicy} from './operator-policy.mjs';
import {exact,hex,hash,need} from './xn1/bytes.mjs';

const fields=['schema','manifest','policy','amount','destination','maximumTokenFee','observedTokenFee','nonce','createdAt'];
const number=(value,positive=false)=>{
 need(typeof value==='string'&&/^(0|[1-9][0-9]{0,13})$/.test(value),'Exact bounded redemption quote amount required');
 const n=BigInt(value);need(n<=50000000000000n&&(!positive||n>0n),'Redemption quote amount outside bounds');return n;
};
export function redemptionQuoteMessage(terms,configuration){
 exact(terms,fields);const p=operatorPolicy(configuration);
 need(terms.schema==='xmr20-operator-redemption-quote-v1'&&terms.manifest===p.id&&terms.policy===p.policy,'Redemption quote scope changed');
 const gross=number(terms.amount,true),maximum=number(terms.maximumTokenFee),observed=number(terms.observedTokenFee);
 need(observed<=maximum&&maximum<gross,'Approved token fee must leave a positive payout');
 need(new PublicKey(terms.destination).toBase58()===terms.destination,'Canonical Solana destination required');
 hex(terms.nonce);need(terms.nonce!=='00'.repeat(32),'Unique redemption quote nonce required');
 need(Number.isSafeInteger(terms.createdAt)&&terms.createdAt>=0,'Redemption quote time required');
 return Buffer.concat([Buffer.from('XMR20-OPERATOR-REDEMPTION-QUOTE-V1\n'),Buffer.from(JSON.stringify(fields.map(k=>terms[k])))]);
}
export function redemptionQuoteId(terms,configuration){return hash(redemptionQuoteMessage(terms,configuration)).toString('hex');}
export function validateRedemptionQuote(quote,configuration,{now=Date.now(),fresh=false}={}){
 exact(quote,['terms','redemption','signature']);const message=redemptionQuoteMessage(quote.terms,configuration);
 need(quote.redemption===hash(message).toString('hex'),'Redemption ID does not bind the approved fee');
 need(ed25519.verify(hex(quote.signature,64),message,hex(operatorPolicy(configuration).manifest.issuers[0]),{zip215:false}),'Invalid operator redemption quote signature');
 if(fresh)need(Number.isSafeInteger(now)&&now>=quote.terms.createdAt&&now-quote.terms.createdAt<=300000,'Bridge quote expired; review the fee again before burning');
 return quote.terms;
}
export function validateRedemptionApproval(value,configuration,{now=Date.now(),fresh=true}={}){
 const terms=validateRedemptionQuote(value.bridgeQuote,configuration,{now,fresh});
 need(value.offerId===value.bridgeQuote.redemption&&value.quantity===terms.amount&&
  value.recipient===new PublicKey(terms.destination).toBuffer().toString('hex'),'Native burn differs from approved bridge terms');
 return terms;
}
