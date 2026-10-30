// Finalized ABI-3 opt-in conversions remove the old linked claim exactly once.
// These receipts do not, by themselves, assert that native issuance completed.
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {sha256} from '@noble/hashes/sha256';
import {custodyPolicyIdentity} from './custody-policy.mjs';
import {decodePolicy,decodeBridgeReceipt} from './bridge-sdk.mjs';
const need=(yes,text)=>{if(!yes)throw Error(text);};
const pk=x=>new PublicKey(x),hash=x=>Buffer.from(sha256(x)).toString('hex');
const nonzero=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)&&!/^0+$/.test(x);
export function nativeConversionPolicy(manifest){
 const p=manifest.nativeCustody;
 need(p&&Object.keys(p).sort().join(',')==='manifest,mode,policy'&&p.mode==='operator-verified-v1','Pinned native conversion policy required.');
 const a=custodyPolicyIdentity(manifest,{manifest:p.manifest,mode:p.mode,signers:[manifest.verifier]});
 need(a.policy.toBase58()===p.policy,'Native conversion policy PDA differs.');return a;
}
export function finalizedConversion(manifest,key,account){
 const a=nativeConversionPolicy(manifest);
 need(account?.finalized===true&&account.owner===manifest.program&&account.executable===false&&account.data instanceof Uint8Array,'Finalized reviewed conversion receipt required.');
 const r=decodeBridgeReceipt(account.data);
 need(r.kind===12&&r.to===a.policy.toBase58()&&r.from!==r.to&&r.net===r.gross&&r.fee==='0'&&
  BigInt(r.net)>0n&&BigInt(r.net)<=50000000000000n&&nonzero(r.nonce)&&nonzero(r.binding),'Exact zero-fee native output conversion required.');
 const amount=Buffer.alloc(8);amount.writeBigUInt64LE(BigInt(r.gross));
 const expected=hash(Buffer.concat([Buffer.from('XMR20-MONERO-OUTPUT-MIGRATE-DRAFT-V1\n'),a.program.toBuffer(),a.policy.toBuffer(),pk(r.from).toBuffer(),amount,Buffer.from(r.nonce,'hex'),Buffer.from(r.binding,'hex')]));
 need(r.commitment===expected,'Conversion commitment differs from its exact terms.');
 const receipt=PublicKey.findProgramAddressSync([Buffer.from('joint-v3-receipt'),pk(r.from).toBuffer(),Buffer.from(r.nonce,'hex')],a.program)[0];
 need(receipt.toBase58()===key,'Conversion receipt PDA differs.');return r;
}
export function createNativeConversionReader({connection,manifest}){
 const a=nativeConversionPolicy(manifest);
 return async positions=>{
  need(Array.isArray(positions)&&positions.length<=2048&&new Set(positions).size===positions.length,'Bounded distinct linked positions required.');
  const raw=await connection.getAccountInfo(a.policy,'finalized');
  need(raw?.owner.equals(a.program)&&raw.executable===false,'Finalized native conversion policy required.');
  const policy=decodePolicy(raw.data);
  need(policy.mode===a.mode&&policy.manifest===a.manifest&&policy.mint===manifest.mint&&policy.verifier===manifest.verifier&&policy.signers.join(',')===manifest.verifier,'Immutable native conversion policy changed.');
  const rows=[];
  for(let i=0;i<positions.length;i+=3){
   const batch=await Promise.allSettled(positions.slice(i,i+3).map(position=>connection.getProgramAccounts(a.program,{commitment:'finalized',filters:[{dataSize:185},{memcmp:{offset:0,bytes:bs58.encode(Uint8Array.of(12))}},{memcmp:{offset:1,bytes:pk(position).toBase58()}}]})));
   const failed=batch.find(r=>r.status==='rejected');if(failed)throw failed.reason;
   for(const result of batch){need(Array.isArray(result.value),'Complete finalized conversion list required.');for(const row of result.value){
    need(row?.account&&row.pubkey,'Malformed finalized conversion account.');
    const entry={key:row.pubkey.toBase58(),account:{owner:row.account.owner.toBase58(),executable:row.account.executable,finalized:true,data:Uint8Array.from(row.account.data)}};
    finalizedConversion(manifest,entry.key,entry.account);rows.push(entry);need(rows.length<=10000,'Native conversion history limit reached.');
   }}
  }
  return rows;
 };
}
