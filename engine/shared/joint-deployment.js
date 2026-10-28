import {transferableManifest,universalTransferableManifest,fastTransferableManifest,operatorTransferableManifest} from './bridge-sdk/core-transferable/mainnet-config.mjs';
import {NATIVE_MARKET_CONFIGURATION} from './website/native-market-config.js';
import {identityRegistry,operatorIdentityRegistry} from './bridge-sdk/core-universal-link/mainnet-config.mjs';
// Default remains legacy. Only the coordinated release build may select this pin.
export const universalLinkEnabled=typeof __XMR20_UNIVERSAL_LINK__!=='undefined'&&__XMR20_UNIVERSAL_LINK__;
export const fastSendEnabled=universalLinkEnabled&&typeof __XMR20_FAST_SEND__!=='undefined'&&__XMR20_FAST_SEND__;
const operator=typeof __XMR20_NATIVE_MARKET__!=='undefined'&&__XMR20_NATIVE_MARKET__&&NATIVE_MARKET_CONFIGURATION?.backing;
export const walletIdentityRegistry=operator?operatorIdentityRegistry():identityRegistry;
export const walletManifest=operator?(mint=>operatorTransferableManifest(mint,mint===operator.mint?{
 mode:operator.mode,manifest:operator.manifest,policy:operator.policy}:undefined)):fastSendEnabled?fastTransferableManifest:universalLinkEnabled?universalTransferableManifest:transferableManifest;
