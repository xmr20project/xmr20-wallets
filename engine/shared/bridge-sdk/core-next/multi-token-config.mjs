import {XCAT_MINT,XMR20_MINT,supportedMint} from './mint-policy.mjs';
import {MULTI_TOKEN_CANDIDATE_HASH,MULTI_TOKEN_CANDIDATE_SIZE,MAINNET_GENESIS} from './deployment-policy.mjs';
// Public prepared identity only. No deployment or service activation is implied.
// One program serves protocol-compatible mints. The service must separately
// verify launch evidence; constructing a manifest cannot enable deposits.
export function multiTokenManifest(mint){if(!supportedMint(mint))throw Error('Invalid token mint.');return Object.freeze({network:'mainnet-beta',genesisHash:MAINNET_GENESIS,program:'5zgFkzqQPPsXV27xQkx6WuK4ZdjvZxotGoauG7x9MVuY',verifier:'G3SQSCg3UiQpyFz23jRT4LZG87kkzjYGpBikG2xa2qkc',mint,profile:'multi-token',binaryHash:MULTI_TOKEN_CANDIDATE_HASH,binarySize:MULTI_TOKEN_CANDIDATE_SIZE});}
export const xmr20Manifest=multiTokenManifest(XMR20_MINT);
export const xcatManifest=multiTokenManifest(XCAT_MINT);
