import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {need} from '../xn1/bytes.mjs';

// Read-only browser adapter. Both the secret-owning worker and background
// custody signer use fixed public RPC routes, with a monotonic finalized slot.
export function createSolanaReadConnection({rpc,assertCurrent=()=>{}}){
 let slot=0;
 const account=value=>{
  if(value===null)return null;
  need(value&&typeof value.owner==='string'&&typeof value.executable==='boolean'&&Array.isArray(value.data)&&value.data.length===2&&value.data[1]==='base64'&&typeof value.data[0]==='string'&&value.data[0].length<=2*1024*1024,'Bounded raw account required');
  const data=Buffer.from(value.data[0],'base64');need(data.toString('base64')===value.data[0],'Canonical raw account required');
  return {...value,data,owner:new PublicKey(value.owner)};
 };
 async function read(key,options={}){
  const floor=Math.max(slot,options.minContextSlot??0),result=await rpc('getMultipleAccounts',[[new PublicKey(key).toBase58()],{encoding:'base64',commitment:'finalized',minContextSlot:floor,...(options.dataSlice?{dataSlice:options.dataSlice}:{})}]);assertCurrent();
  need(Number.isSafeInteger(result?.context?.slot)&&result.context.slot>=floor&&Array.isArray(result.value)&&result.value.length===1,'Fresh finalized account required');
  slot=result.context.slot;return {context:result.context,value:account(result.value[0])};
 }
 return Object.freeze({
  rpcEndpoint:'/api/native-market/solana',
  getGenesisHash:()=>rpc('getGenesisHash',[]),
  getAccountInfoAndContext:read,
  async getAccountInfo(key,options){return (await read(key,typeof options==='object'?options:{})).value;},
  getEpochInfo:async(commitment='finalized')=>{const result=await rpc('getEpochInfo',[{commitment}]);assertCurrent();return result;},
  getBlockHeight:async(commitment='finalized')=>{const result=await rpc('getBlockHeight',[{commitment}]);assertCurrent();return result;},
  isBlockhashValid:async(blockhash,{commitment='finalized'}={})=>{const result=await rpc('isBlockhashValid',[blockhash,{commitment}]);assertCurrent();return result;}
 });
}
