// Private SOL / wXMR balances for the XMR20 wallet, on Helius Solana Privacy Rings (default ring).
// Used by the extension popup through private-screens.js (private-balance.js in the extension). The network is set by the
// build (mainnet in the extension); the devnet settings stay for testing.
//
// What a private balance hides: which token and how much. What it does not hide: the sending and receiving
// Solana addresses. Moving in shows the source, token and amount; moving out shows the destination, token
// and amount.
//
// Rules this file enforces:
//   - The prover is always reached through the attested, encrypted channel (proverTee). A config without it is
//     refused, even for a local address, so the local key-adding proxy never sees what is being proved.
//   - Tokens that charge a transfer fee (XMR20, XCAT, launch tokens) are refused before anything is signed:
//     the privacy program rejects their deposits (vault must gain exactly the amount sent).
//   - A private send goes only to an address that already has a private balance. Anything else is refused with
//     NOT_PRIVATE; the wallet offers "Move out" for public payments instead, never silently.
//   - Every action is prepare (build, prove, price) then approve (sign, send, confirm). The review states the
//     exact SOL the payer loses beyond the amount itself, and the XMR20 send fee separately.
//   - A private send to an address listed in `feeFree` (the XMR20 trading service, whose trades carry their own fee) pays
//     no XMR20 send fee. A review can also be signed first and sent after (`sign`), so its transaction can be named before
//     it is on chain (the trading service takes an order for a payment before the payment is sent). The signed transaction
//     comes with the last block height it can land in, and `paymentState` asks the chain what became of it: a caller that
//     lost the answer to a send learns from the chain, not from a timer, whether it landed or never will.
import {createSprClient,initializePoseidon,ShieldedKeypair,SigningKey,Wallet,syncWallet,SOL_MINT,MergeEncryptionScheme,
 buildDepositTransaction,buildTransferTransaction,buildWithdrawalTransaction,SPL_TOKEN_2022_PROGRAM_ID,SPL_TOKEN_PROGRAM_ID} from '@heliuslabs/spr';
import {LocalKeys,SignedTeePolicy} from '@heliuslabs/spr/client';
import {isWalletRegistered} from '@heliuslabs/spr/wallet';
import {AssetRegistry,LocalShieldedKeys} from '@heliuslabs/spr/transaction';
import {getRegisterInstructionAsync,getSetMergeEncryptionInstructionAsync} from '@heliuslabs/spr/instructions';
import {address as toAddress,appendTransactionMessageInstructions,createTransactionMessage,pipe,setTransactionMessageFeePayerSigner,
 setTransactionMessageLifetimeUsingBlockhash,setTransactionMessageConfig,signTransactionMessageWithSigners,signTransactionWithSigners,
 getBase64EncodedWireTransaction,getSignatureFromTransaction,compileTransaction,getCompiledTransactionMessageDecoder,decompileTransactionMessage,
 appendTransactionMessageInstruction} from '@solana/kit';
import {getTransferSolInstruction} from '@solana-program/system';
import {ed25519} from '@noble/curves/ed25519.js';

export const NETWORKS=Object.freeze({devnet:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',mainnet:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'});
// XMR20 fee on every private send: a plain SOL payment in the same transaction, so it is paid only if the send lands.
// It is public (like the sender and recipient in this ring) and marks the send as made from the XMR20 wallet.
export const SEND_FEE=Object.freeze({address:'73oJGXX2MygxWsYeFz7U66NgoiSepKoBcEcffkkojfrR',lamports:4_000_000n});
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,RAW=/^[1-9][0-9]{0,19}$/;
const fail=(code,message)=>Object.assign(Error(message),{code});

// Base58 decoding for the wallet's stored 64-byte Solana secret (the extension keeps it as base58).
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function decodeSecret(text){
 if(typeof text!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(text))throw fail('BAD_KEY','Solana key unavailable.');
 let n=0n;for(const c of text)n=n*58n+BigInt(B58.indexOf(c));const out=new Uint8Array(64);
 for(let i=63;i>=0;i--){out[i]=Number(n&255n);n>>=8n;}if(n!==0n)throw fail('BAD_KEY','Solana key unavailable.');
 // Base58 keeps each leading zero byte as one '1': both counts must agree.
 let lead=0;for(const c of text){if(c!=='1')break;lead++;}let zeros=0;while(zeros<64&&out[zeros]===0)zeros++;
 if(lead!==zeros)throw fail('BAD_KEY','Solana key unavailable.');return out;}

// The shielded keypair for a Solana key. Deterministic (Helius derivation "TSPP/derive/v1"), so any wallet that
// follows the standard reaches the same private balance with the same Solana key.
export function shieldedFromSecret(secret64){
 const seed=secret64.slice(0,32);
 try{const shielded=ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed));
  return shielded;}finally{seed.fill(0);}}

// Assets the prototype offers. `decimals` is display only; amounts move as raw integer strings.
export function assetList(network,{testMint}={}){
 const list=[{mint:SOL_MINT,symbol:'SOL',name:'Solana',decimals:9,program:null}];
 if(network==='devnet'&&testMint)list.push({mint:testMint,symbol:'wXMR',name:'wXMR (devnet stand-in)',decimals:12,program:SPL_TOKEN_PROGRAM_ID});
 if(network==='mainnet')list.push({mint:'WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp',symbol:'wXMR',name:'Wrapped Monero',decimals:12,program:SPL_TOKEN_PROGRAM_ID});
 return Object.freeze(list.map(Object.freeze));}

// Plain words for the activity list.
export function activityLabel(kind,direction){
 if(kind==='deposit')return direction==='inbound'?'Moved in':'Moved in (to another address)';
 if(kind==='publicWithdrawal')return 'Moved out';
 if(kind==='privateTransfer')return direction==='inbound'?'Received privately':direction==='outbound'?'Sent privately':'Moved between own pieces';
 if(kind==='split'||kind==='merge')return 'Rearranged (no change in total)';
 return 'Other';}
export function formatRaw(raw,decimals){const v=BigInt(raw),s=v.toString().padStart(decimals+1,'0');const whole=s.slice(0,-decimals)||'0',frac=s.slice(-decimals).replace(/0+$/,'');return frac?whole+'.'+frac:whole;}
export function parseAmount(text,decimals){
 const t=String(text??'').trim();if(!/^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]+)?$/.test(t))throw fail('BAD_AMOUNT','Enter an amount.');
 const [w,f='']=t.split('.');if(f.length>decimals)throw fail('BAD_AMOUNT','Too many decimals.');
 const raw=BigInt(w)*10n**BigInt(decimals)+BigInt((f+'0'.repeat(decimals)).slice(0,decimals)||'0');if(raw<=0n)throw fail('BAD_AMOUNT','Enter an amount.');return raw;}

// Reads a mint and refuses fee-charging tokens. Returns the token program for the deposit.
// The ticker a token gives itself (Token-2022 metadata kept in its mint), for a token this wallet has no name for: [symbol,
// name]. It is used only if it is a plain short ticker that cannot be taken for a token the wallet names itself or for a major
// coin; otherwise the shortened mint stands. The mint is always part of the name.
const RESERVED=new Set(['SOL','WSOL','XMR','WXMR','XMR20','XCAT','USDC','USDT','USD','USDS','PYUSD','BTC','WBTC','ETH','WETH','JUP','JTO','BONK','WIF','RAY','ORCA','PYTH','HNT','RENDER','MSOL','JITOSOL']);
export function ownSymbol(info,mint){
 const short=mint.slice(0,4)+'…'+mint.slice(-4),meta=(info?.data?.parsed?.info?.extensions||[]).find(e=>e.extension==='tokenMetadata')?.state;
 const symbol=typeof meta?.symbol==='string'?meta.symbol.trim():'';
 if(!/^[A-Za-z0-9]{2,10}$/.test(symbol)||RESERVED.has(symbol.toUpperCase()))return [short,'Token '+short];
 const name=typeof meta.name==='string'?meta.name.replace(/[^\x20-\x7E]/g,'').trim().slice(0,24):'';
 return [symbol,(name||symbol)+' ('+short+')'];}
export async function checkMint(rpc,mint){
 if(mint===SOL_MINT)return null;
 const info=(await rpc.getAccountInfo(toAddress(mint),{encoding:'jsonParsed',commitment:'confirmed'}).send()).value;
 if(!info)throw fail('NO_MINT','Token not found on this network.');
 const program=String(info.owner);if(program!==SPL_TOKEN_PROGRAM_ID&&program!==SPL_TOKEN_2022_PROGRAM_ID)throw fail('NO_MINT','Not a token mint.');
 const ext=info.data?.parsed?.info?.extensions||[];
 const fee=ext.find(e=>e.extension==='transferFeeConfig');
 const bps=fee?Math.max(Number(fee.state?.newerTransferFee?.transferFeeBasisPoints||0),Number(fee.state?.olderTransferFee?.transferFeeBasisPoints||0)):0;
 if(bps>0)throw fail('FEE_TOKEN','This token charges a '+(bps/100)+'% transfer fee, so it cannot be held in a private balance.');
 if(ext.some(e=>e.extension==='transferHook'))throw fail('FEE_TOKEN','This token runs a transfer hook, so it cannot be held in a private balance.');
 return program;}

export async function createPrivateBalance({rpcUrl,network,proverTee,fetchImpl,testMint,sendFee=SEND_FEE,discover=false,feeFree=[]}){
 if(sendFee&&(!ADDRESS.test(sendFee.address)||typeof sendFee.lamports!=='bigint'||sendFee.lamports<0n))throw fail('CONFIG','Send fee is misconfigured.');
 if(!Array.isArray(feeFree)||feeFree.some(a=>!ADDRESS.test(String(a))))throw fail('CONFIG','The addresses without a send fee are misconfigured.');
 const noFee=new Set(feeFree.map(String));
 if(!NETWORKS[network])throw fail('NETWORK','Unknown network.');
 if(!proverTee)throw fail('CONFIG','The prover must be reached through its attested channel.');
 await initializePoseidon();
 // The gateway serves the Helius privacy services under /v1/spr, like a Helius RPC host does.
 const spr=String(rpcUrl).replace(/\/+$/,'')+'/v1/spr';// keeps a gateway path prefix
 const client=await createSprClient({solanaRpcUrl:rpcUrl,indexerUrl:spr,proverUrl:spr,proverTee,proofDataSource:'prover',commitment:'confirmed',...(fetchImpl?{fetch:fetchImpl}:{})});
 const genesis=await client.solanaRpc.getGenesisHash().send();
 if(genesis!==NETWORKS[network])throw fail('NETWORK','The RPC is not on '+network+'.');
 // With `discover`, any other SPL or Token-2022 token found at the address or in its private balance joins the list, unless
 // it charges a transfer fee or runs a hook (checkMint). Names: a few well-known mints, otherwise the shortened mint.
 const assets=[...assetList(network,{testMint})],unsupported=new Set();
 const KNOWN={EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:['USDC','USD Coin'],Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB:['USDT','Tether USD']};
 async function learn(mint,decimals,program){
  if(assets.some(a=>a.mint===mint)||unsupported.has(mint))return;
  try{const checked=await checkMint(client.solanaRpc,mint);
   const info=(await client.solanaRpc.getAccountInfo(toAddress(mint),{encoding:'jsonParsed',commitment:'confirmed'}).send()).value;
   if(decimals==null)decimals=Number(info?.data?.parsed?.info?.decimals);
   if(!Number.isInteger(decimals)||decimals<0||decimals>18)throw fail('NO_MINT','Token decimals unavailable.');
   const [symbol,name]=KNOWN[mint]||ownSymbol(info,mint);
   if(assets.some(a=>a.mint===mint))return;                                 // two readings at once both get here: list it once
   assets.push(Object.freeze({mint,symbol,name,decimals,program:program||checked}));}
  catch(e){if(e?.code==='FEE_TOKEN'||e?.code==='NO_MINT')unsupported.add(mint);else throw e;}}
 const assetBy=mint=>{const a=assets.find(x=>x.mint===mint);if(!a)throw fail('ASSET','Token not offered for private balances.');return a;};

 // Exact SOL the payer loses when this transaction lands, minus `spent` (the amount moved in, for a SOL deposit).
 async function cost(tx,payer,spent=0n){
  const wire=getBase64EncodedWireTransaction(tx);
  const before=BigInt((await client.solanaRpc.getBalance(payer,{commitment:'confirmed'}).send()).value);
  const sim=(await client.solanaRpc.simulateTransaction(wire,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:false,commitment:'confirmed',accounts:{addresses:[payer],encoding:'base64'}}).send()).value;
  if(sim.err){const err=JSON.stringify(sim.err,(k,v)=>typeof v==='bigint'?String(v):v);
   if(/AccountNotFound|InsufficientFunds|insufficient/i.test(err))throw fail('SOL','Not enough SOL in this address for the fee. Add a little SOL and review again.');
   throw fail('SIMULATION','The network refused this transaction in a test run: '+err);}
  const after=BigInt(sim.accounts?.[0]?.lamports??-1);if(after<0n)throw fail('SIMULATION','Fee check unavailable.');
  const fee=before-after-spent;if(fee<0n)throw fail('SIMULATION','Fee check gave an impossible result.');
  return {before,fee,unitsConsumed:sim.unitsConsumed==null?null:String(sim.unitsConsumed)};}

 // Appends one SOL payment to a built transaction (the SDK returns it compiled; no lookup tables are used).
 function withPayment(tx,signer,to,lamports){
  const message=decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
  return compileTransaction(appendTransactionMessageInstruction(getTransferSolInstruction({source:signer,destination:toAddress(to),amount:lamports}),setTransactionMessageFeePayerSigner(signer,message)));}

 async function send(tx,signer){
  const signed=await signTransactionWithSigners([signer],tx);
  const signature=getSignatureFromTransaction(signed);
  await client.solanaRpc.sendTransaction(getBase64EncodedWireTransaction(signed),{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed'}).send();
  const slot=await client.confirmTransaction(signature);return {signature,slot:String(slot)};}

 async function compile(instructions,signer){
  const {value:lifetime}=await client.solanaRpc.getLatestBlockhash({commitment:'confirmed'}).send();
  return compileTransaction(pipe(createTransactionMessage({version:1}),m=>setTransactionMessageFeePayerSigner(signer,m),m=>setTransactionMessageLifetimeUsingBlockhash(lifetime,m),
   m=>setTransactionMessageConfig({computeUnitLimit:200_000,loadedAccountsDataSizeLimit:64*1024*1024},m),m=>appendTransactionMessageInstructions(instructions,m)));}

 // One open account. `secret` is the wallet's base58 64-byte Solana secret; it is decoded here and wiped.
 function open(secretText){
  // The Solana key's 32-byte seed is kept for signing texts (orders for the trading service); close() wipes it.
  const secret=decodeSecret(secretText);let shielded,textKey;try{shielded=shieldedFromSecret(secret);textKey=secret.slice(0,32);}finally{secret.fill(0);}
  const signer=shielded.toSolanaSigner(),identity=shielded.shieldedAddress(),owner=signer.address;
  let wallet=null;
  // After close() nothing more is read, built or signed with this account.
  const live=()=>{if(!shielded)throw fail('CLOSED','This private address was closed. Open it again.');};
  const keys=()=>LocalKeys.fromKeypair(shielded,client.proofService);
  async function sync(){
   live();
   const fresh=new Wallet({identity,registry:new AssetRegistry()});
   await syncWallet({wallet:fresh,keys:LocalShieldedKeys.fromKeypair(shielded),client,config:{pageLimit:200}});wallet=fresh;
   if(discover)for(const b of fresh.balances())if(b.amount>0n)await learn(String(b.mint),null,null);
   const balances=assets.map(a=>{let b={amount:0n,utxos:[]};try{b=fresh.balance(a.mint);}catch{}return {mint:a.mint,symbol:a.symbol,decimals:a.decimals,amountRaw:String(b.amount),pieces:b.utxos.length};});
   const history=fresh.privateTransactions().map(t=>({kind:t.kind,direction:t.direction,mint:t.asset,amountRaw:String(t.amount),signature:t.id?.signature??null})).reverse();
   return {balances,history};}
  async function status(){
   live();
   const registered=await isWalletRegistered({rpc:client,owner});
   const publicSol=String((await client.solanaRpc.getBalance(owner,{commitment:'confirmed'}).send()).value);
   // Public balances, for Move in and its Max. SPL: the sum of this address's accounts for the mint.
   const publicRaw={[SOL_MINT]:publicSol};
   if(discover){for(const program of [SPL_TOKEN_PROGRAM_ID,SPL_TOKEN_2022_PROGRAM_ID]){
     const r=(await client.solanaRpc.getTokenAccountsByOwner(owner,{programId:toAddress(program)},{encoding:'jsonParsed',commitment:'confirmed'}).send()).value;
     for(const v of r){const i=v.account.data.parsed.info,raw=BigInt(i.tokenAmount.amount);publicRaw[i.mint]=String(BigInt(publicRaw[i.mint]||'0')+raw);if(raw>0n)await learn(i.mint,Number(i.tokenAmount.decimals),program);}}
    for(const x of assets)publicRaw[x.mint]??='0';}
   else for(const x of assets)if(x.mint!==SOL_MINT){const r=(await client.solanaRpc.getTokenAccountsByOwner(owner,{mint:toAddress(x.mint)},{encoding:'jsonParsed',commitment:'confirmed'}).send()).value;
    publicRaw[x.mint]=String(r.reduce((sum,v)=>sum+BigInt(v.account.data.parsed.info.tokenAmount.amount),0n));}
   return {address:owner,registered,publicSolRaw:publicSol,publicRaw,...(registered?await sync():{balances:assets.map(a=>({mint:a.mint,symbol:a.symbol,decimals:a.decimals,amountRaw:'0',pieces:0})),history:[]})};}
  // A review: what will happen, the exact SOL fee, and approve() which signs and sends only before it expires. sign() signs
  // without sending and gives the transaction's signature with a send() for it, for a caller that must name the transaction
  // before it is on chain.
  const review=(fields,tx,price)=>{const r={...fields,feeRaw:String(price.fee),feeSymbol:'SOL',expires:Date.now()+60_000};
   const fresh=()=>{live();if(Date.now()>r.expires)throw fail('EXPIRED','Review expired. Review again; nothing was sent.');};
   r.approve=async()=>{fresh();return send(tx,signer);};
   r.sign=async()=>{fresh();const signed=await signTransactionWithSigners([signer],tx),signature=getSignatureFromTransaction(signed);let sent=false;
    // The last block height it can land in: the transaction's own, or (when the built transaction does not carry it) one
    // that is never earlier.
    let lastValid=Number(tx.lifetimeConstraint?.lastValidBlockHeight??signed.lifetimeConstraint?.lastValidBlockHeight??NaN);
    if(!Number.isSafeInteger(lastValid)||lastValid<=0)lastValid=Number((await client.solanaRpc.getEpochInfo({commitment:'confirmed'}).send()).blockHeight)+150;
    return {signature,lastValid,send:async()=>{fresh();if(sent)throw fail('SENT','Already sent.');sent=true;
     await client.solanaRpc.sendTransaction(getBase64EncodedWireTransaction(signed),{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed'}).send();
     const slot=await client.confirmTransaction(signature);return {signature,slot:String(slot)};}};};
   return r;};
  // What became of a transaction this address signed, as the chain has it: 'landed', 'failed' (on chain, and it moved
  // nothing), 'gone' (not on chain, and the chain is past the last block it could land in: it never will be) or 'pending'.
  async function paymentState({signature,lastValid}){
   live();
   const seen=async()=>{const st=(await client.solanaRpc.getSignatureStatuses([signature],{searchTransactionHistory:true}).send()).value[0];
    return !st?null:st.err?'failed':['confirmed','finalized'].includes(st.confirmationStatus)?'landed':'pending';};
   const first=await seen();if(first)return first;
   if(!Number.isSafeInteger(lastValid)||lastValid<=0)return 'pending';
   const height=Number((await client.solanaRpc.getEpochInfo({commitment:'finalized'}).send()).blockHeight);   // a call the wallet's gateway lets through
   if(!Number.isSafeInteger(height)||height<=lastValid)return 'pending';
   return await seen()??'gone';}   // looked up once more, now that it can no longer land
  // This address's own signature of a text (its UTF-8 bytes), 64 bytes as hex: how it files an order with the trading service.
  async function signText(text){
   if(typeof text!=='string'||!text||text.length>2000)throw fail('BAD_TEXT','Nothing to sign.');
   live();if(!textKey)throw fail('SIGN','This account is closed.');
   const message=new TextEncoder().encode(text),bytes=ed25519.sign(message,textKey);
   if(bytes.length!==64||!ed25519.verify(bytes,message,ed25519.getPublicKey(textKey)))throw fail('SIGN','Signing failed.');
   return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}

  // Turn on the private balance: publishes this address's encryption keys so others can pay it privately.
  async function prepareRegister(){
   live();
   if(await isWalletRegistered({rpc:client,owner}))throw fail('DONE','Private balance is already on.');
   const tx=await compile([await getRegisterInstructionAsync({owner:signer,nullifierPublicKey:identity.nullifierPublicKey,viewingPublicKey:identity.viewingPublicKey.toBytes()}),
    await getSetMergeEncryptionInstructionAsync({owner:signer,scheme:MergeEncryptionScheme.PoseidonCtrV1})],signer);
   return review({kind:'register'},tx,await cost(tx,owner));}

  async function prepareDeposit({mint,amountRaw}){
   live();
   const a=assetBy(mint);if(!RAW.test(String(amountRaw)))throw fail('BAD_AMOUNT','Enter an amount.');const amount=BigInt(amountRaw);
   if(!await isWalletRegistered({rpc:client,owner}))throw fail('NOT_ON','Turn on the private balance first.');
   const program=await checkMint(client.solanaRpc,mint);
   const tx=await buildDepositTransaction({client,feePayer:owner,depositor:owner,recipient:identity,asset:toAddress(mint),amount,...(program?{splTokenProgram:toAddress(program)}:{})});
   const price=await cost(tx,owner,mint===SOL_MINT?amount:0n);
   return review({kind:'deposit',mint,symbol:a.symbol,amountRaw:String(amount)},tx,price);}

  async function spendable(mint,amount){if(!wallet)await sync();const b=wallet.balance(mint);if(b.amount<amount)throw fail('BALANCE','Not enough in the private balance.');}

  async function prepareSend({mint,amountRaw,recipient}){
   live();
   const a=assetBy(mint);if(!RAW.test(String(amountRaw)))throw fail('BAD_AMOUNT','Enter an amount.');const amount=BigInt(amountRaw);
   if(!ADDRESS.test(String(recipient)))throw fail('BAD_ADDRESS','Enter a Solana address.');if(recipient===owner)throw fail('BAD_ADDRESS','Choose another address.');
   if(!await isWalletRegistered({rpc:client,owner:toAddress(recipient)}))throw fail('NOT_PRIVATE','That address has no private balance, so a private send is not possible. Use Move out to pay it publicly.');
   await sync();await spendable(mint,amount);
   let tx=await buildTransferTransaction({client,wallet,keys:keys(),feePayer:owner,recipient:toAddress(recipient),asset:toAddress(mint),amount});
   const serviceFee=sendFee&&sendFee.address!==owner&&!noFee.has(String(recipient))?sendFee.lamports:0n;
   if(serviceFee>0n)tx=withPayment(tx,signer,sendFee.address,serviceFee);
   const price=await cost(tx,owner,serviceFee);
   if(price.before<price.fee+serviceFee)throw fail('SOL','Not enough SOL for the network fee and the XMR20 fee.');
   return review({kind:'send',mint,symbol:a.symbol,amountRaw:String(amount),recipient,serviceFeeRaw:String(serviceFee),serviceFeeAddress:serviceFee>0n?sendFee.address:null},tx,price);}

  async function prepareWithdraw({mint,amountRaw,recipient=owner}){
   live();
   const a=assetBy(mint);if(!RAW.test(String(amountRaw)))throw fail('BAD_AMOUNT','Enter an amount.');const amount=BigInt(amountRaw);
   if(!ADDRESS.test(String(recipient)))throw fail('BAD_ADDRESS','Enter a Solana address.');
   await sync();await spendable(mint,amount);const program=await checkMint(client.solanaRpc,mint);
   const tx=await buildWithdrawalTransaction({client,wallet,keys:keys(),feePayer:owner,recipient:toAddress(recipient),asset:toAddress(mint),amount,...(program?{splTokenProgram:toAddress(program)}:{})});
   // Moving SOL out to this same address pays the payer back the amount; the fee is what remains.
   const price=await cost(tx,owner,mint===SOL_MINT&&recipient===owner?-amount:0n);
   return review({kind:'withdraw',mint,symbol:a.symbol,amountRaw:String(amount),recipient},tx,price);}

  return {address:owner,status,sync,prepareRegister,prepareDeposit,prepareSend,prepareWithdraw,paymentState,signText,close(){wallet=null;shielded=null;textKey?.fill(0);textKey=null;}};}

 return {client,network,assets,sendFee,open};}

export function devnetTee(){return SignedTeePolicy.forNetwork('devnet');}
