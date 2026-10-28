// Public coordinated-release candidate. Importing this file activates nothing.
// The installed runtime still uses native-market-config.js until release gates pass.
import {PublicKey} from '@solana/web3.js';
import {hash,domain} from './xn1/bytes.mjs';
import {manifestId,EXPIRING_CREDIT_PROFILE} from './xn1/records.mjs';
import {operatorPolicy} from './operator-policy.mjs';
import {custodyPolicyIdentity} from '../bridge-sdk/core-monero-send/custody-policy.mjs';
import {fastTransferableManifest} from '../bridge-sdk/core-transferable/mainnet-config.mjs';
import {WALLET_TEST_POLICY} from '../bridge-sdk/core-transferable/private-test.mjs';
import {BINARY_HASH,BINARY_SIZE,CUSTODY_CAPABILITY} from '../bridge-sdk/core-monero-send/deployment-policy.mjs';
const mint='9MwJfFGc3jNkAKLwma4kkUYivs19yJsWXuPD15RegXMR';
export const operatorDeployment=Object.freeze({...fastTransferableManifest(mint),
 binaryHash:BINARY_HASH,binarySize:BINARY_SIZE,custodyCapability:CUSTODY_CAPABILITY});
const {program,verifier}=operatorDeployment,pub=s=>new PublicKey(s).toBuffer();
const manifest={
 genesis:'418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3',
 asset:pub(mint).toString('hex'),height:3788009n,
 blockHash:'2f12e4df5cf35ecadb026d5245cc04b17945b58785677f4c232e295350a7789f',
 decimals:6,cap:1000000000000000n,depth:10,profile:EXPIRING_CREDIT_PROFILE,
 issuerScheme:1,threshold:1,issuers:[pub(verifier).toString('hex')],recovery:0,identity:0xfc,
 bridgeDomain:hash(domain('XN1-J3-OPERATOR-CUSTODY-V1'),pub(program),pub(mint),pub(verifier)).toString('hex')
};
const id=manifestId(manifest),backing={mode:'operator-verified-v1',program,mint,verifier,
 manifest:id,claimPolicy:'explicit-conversion-v1'};
backing.policy=custodyPolicyIdentity(backing,{manifest:id,mode:backing.mode,signers:[verifier]}).policy.toBase58();
export const NATIVE_MARKET_CONFIGURATION=Object.freeze({
 manifest,manifestId:id,chainGenesis:manifest.genesis,depth:10,maxSyncBlocks:32,backed:true,backing,
 endpoints:['/api/native-market/node/0','/api/native-market/node/1'],
 operatorDeployment,operatorTestPolicy:WALLET_TEST_POLICY,
 display:{mint,name:'Monero Extremist',symbol:'EXTREMIST'}
});
operatorPolicy(NATIVE_MARKET_CONFIGURATION);
