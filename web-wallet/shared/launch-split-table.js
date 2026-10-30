import {AddressLookupTableAccount,PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {WXMR,PLATFORM} from './fund-client.js';
import {GLOBAL} from './fund-tax-client.js';
export const SPLIT_LOOKUP_KEYS=[WXMR,GLOBAL,PLATFORM,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID].map(k=>k.toBase58());
export function splitLookupTables(records){
 if(!Array.isArray(records)||records.length!==1||JSON.stringify(records[0].addresses)!==JSON.stringify(SPLIT_LOOKUP_KEYS))throw Error('Unrecognized launch address table');
 return records.map(r=>new AddressLookupTableAccount({key:new PublicKey(r.key),state:{deactivationSlot:18446744073709551615n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,authority:undefined,addresses:r.addresses.map(k=>new PublicKey(k))}}));
}
