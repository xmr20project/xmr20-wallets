// Authenticate node-provided extra against the owned transaction hash. A node's
// as_json / tx_hash labels are not evidence. V1 and historical RingCT base
// layouts are authenticated against the wallet's already known transaction ID.
// A pruned prefix requires its proof commitment; unknown layouts fail closed.
import {inspectTransactionBytes,inspectPrunedTransactionBytes} from '../../engine/shared/native-market/xn1/transaction-bytes.mjs';
export function verifiedCarrierExtra(entry,expected){
 if(!/^[a-f0-9]{64}$/.test(expected)||entry?.tx_hash!==expected)throw Error('Canonical transaction identity required');
 const complete=entry.as_hex||(entry.pruned_as_hex&&entry.prunable_as_hex?entry.pruned_as_hex+entry.prunable_as_hex:null);
 const tx=complete?inspectTransactionBytes(complete):inspectPrunedTransactionBytes(entry.pruned_as_hex,entry.prunable_hash);
 if(tx.txid!==expected)throw Error('Node transaction hash mismatch');
 return new Uint8Array(tx.extra);
}
if(typeof self!=='undefined')self.XMR20CarrierVerifier=Object.freeze({verifiedCarrierExtra});
