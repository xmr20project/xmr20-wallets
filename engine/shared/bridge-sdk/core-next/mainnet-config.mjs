import {CANDIDATE_HASH,CANDIDATE_SIZE,MAINNET_GENESIS} from './deployment-policy.mjs';
// Proposed public identity, NOT a deployment certificate. Both client and
// service independently verify the finalized program and immutable binary.
export const manifest=Object.freeze({network:'mainnet-beta',genesisHash:MAINNET_GENESIS,program:'7U5xdrAJ5DRQmNfhe1cyUCycGm4WXuzR1vSu6DBehq1x',verifier:'G3SQSCg3UiQpyFz23jRT4LZG87kkzjYGpBikG2xa2qkc',binaryHash:CANDIDATE_HASH,binarySize:CANDIDATE_SIZE});
export const deployer='4x5FpZshEW9j5Nqs49k7oaAkJDYbe2edKaJD2kwmsRt3';
export const MAINNET_WALLET_ORIGIN='http://127.0.0.1:8925';
