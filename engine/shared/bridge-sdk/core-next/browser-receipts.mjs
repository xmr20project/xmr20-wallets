import {addresses,transaction} from './sdk.mjs';import {moneroOwner,canonical,validateRecord,digest,payload} from './records.mjs';import {VersionedTransaction,PublicKey} from '@solana/web3.js';import {ed25519} from '@noble/curves/ed25519';import bs58 from 'bs58';
const need=(v,m)=>{if(!v)throw Error(m);};
const phases=['deposit-pending','deposit-expired','deposited','claim-pending','claim-confirmed','burn-pending','burn-confirmed','return-pending','complete'];
// PUBLIC signed receipts, separate from the existing encrypted Monero vault.
// Compare-and-save rejects a second tab changing the selected position.
export function publicReceiptStore({program,owner,mint,storage=globalThis.localStorage}){
 if(mint!==undefined)need(typeof mint==='string'&&new PublicKey(mint).toBase58()===mint,'Invalid receipt mint.');
 // Omitted mint preserves every historical single-mint receipt key.
 const key='xmr20-joint-public-v2:'+program+':'+owner+(mint?':'+mint:'');let observed;
 function validate(s){need(s?.schema==='joint-owner-receipt-v2'&&s.config?.program===program&&s.config.owner===owner&&(mint===undefined||s.config.mint===mint)&&s.config.network==='mainnet-beta'&&phases.includes(s.phase),'Saved bridge receipt belongs to a different wallet, token or deployment.');addresses(s.config);moneroOwner(s.moneroOwner);need(typeof s.bytes==='string'&&s.bytes.length<4000&&typeof s.depositSignature==='string','Invalid public bridge receipt.');
  const allowed=['schema','phase','config','proposal','moneroOwner','bytes','depositSignature','depositAttempts','net','envelope','recordTxid','returnResult'];need(Object.keys(s).every(k=>allowed.includes(k)),'Unexpected private or unknown receipt fields.');
  need(Object.keys(s.config).sort().join(',')==='abi,binding,id,mint,network,owner,program,verifier'&&s.config.binding===digest(s.moneroOwner),'Saved position binding changed.');
  need(Object.keys(s.proposal).sort().join(',')==='amount,blockhash,expectedFee,lastValidBlockHeight,network,nonce,operation'&&Number.isSafeInteger(s.proposal.lastValidBlockHeight)&&s.proposal.lastValidBlockHeight>0,'Saved transaction review changed.');
  need(Buffer.from(s.bytes,'base64').toString('base64')===s.bytes,'Invalid saved transaction encoding.');const tx=VersionedTransaction.deserialize(Buffer.from(s.bytes,'base64'));need(Buffer.from(tx.message.serialize()).equals(Buffer.from(transaction(s.config,s.proposal).message.serialize()))&&ed25519.verify(tx.signatures[0],tx.message.serialize(),new PublicKey(owner).toBytes()),'Saved owner approval changed.');
  need(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(s.depositSignature)&& (s.proposal.operation!=='deposit'||bs58.encode(tx.signatures[0])===s.depositSignature),'Saved deposit signature changed.');
  if(s.net)need(/^[1-9][0-9]{0,13}$/.test(s.net),'Saved exact amount changed.');if(s.envelope){const r=validateRecord(s.envelope.record);payload(s.envelope);need(r.mint===s.config.mint&&r.program===program&&r.to===owner&&r.position===addresses(s.config).position.toBase58()&&r.owner===s.moneroOwner&&r.solTx===s.depositSignature&&r.amount===s.net,'Saved public record belongs to another position.');}
  // Reject private material even inside optional diagnostic/receipt objects.
  function publicOnly(v){if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){need(!/seed|private|secret|password|mnemonic|credential|authorization/i.test(k),'Private material cannot be saved in a public receipt.');publicOnly(x);}}publicOnly(s);return s;}
 return Object.freeze({key,
  load(){const raw=storage.getItem(key);observed=raw;if(raw===null)return null;need(raw.length<18000,'Saved public receipt is too large.');return structuredClone(validate(JSON.parse(raw)));},
  save(value){validate(value);const raw=JSON.stringify(value);need(raw.length<18000,'Public receipt exceeds its limit.');need(storage.getItem(key)===observed,'Another wallet tab changed the saved receipt. Reopen and reconcile.');storage.setItem(key,raw);need(storage.getItem(key)===raw,'Could not verify the saved public receipt.');observed=raw;},
  archiveCompleted(){const s=this.load();need(s?.phase==='complete','Finish and verify the saved return before starting a new position.');const archive=key+':completed:'+s.config.id,raw=canonical(s);need(!storage.getItem(archive)||storage.getItem(archive)===raw,'Completed receipt changed.');storage.setItem(archive,raw);need(storage.getItem(archive)===raw&&storage.getItem(key)===observed,'Could not preserve the completed public receipt.');storage.removeItem(key);observed=null;return archive;}
 });
}
