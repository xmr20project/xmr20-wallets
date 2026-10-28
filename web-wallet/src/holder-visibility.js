// Website ordering only. Existing on-chain identities and ledger records are unchanged.
const GENESIS_ID='52f787ff-fe1d-4067-a492-0586d0d44010';
const GENESIS_MINT='Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR';
const GENESIS_OWNER='6WSAHauyYVefgV5YZCNkAEQ8swt2dgRKi8p6a2EY3Wgq';
const TRIAL_OWNER='HXAYJj7g4Dn8bmcGDJmcH1rwS9tEbNjLWizJo2EeFx2y';
// Owner-requested test launch exclusion. Keep its ledger and bridge records intact.
const UNLISTED_TEST_ID='5d2b9b2d-234c-4972-b1ae-00550e2c393a';
const UNLISTED_TEST_MINT='3FyCsVxQJwKhV6Gia9N9PpsrdPNALfhoetJSWxqNXXMR';
const verified=t=>t.id!==UNLISTED_TEST_ID&&t.mint!==UNLISTED_TEST_MINT&&!t.hidden&&!t.halted&&!t.cancelledAt&&t.proofVerified===true&&Number.isSafeInteger(t.confirmations)&&t.confirmations>=10&&/^[a-f0-9]{64}$/.test(t.moneroTxid||'')&&t.solanaFinalized===true&&t.state==='Launched';
export function publicLaunches(tokens){
 const first=tokens.find(t=>t.id===GENESIS_ID&&t.mint===GENESIS_MINT&&t.owner===GENESIS_OWNER&&verified(t));
 const trial=tokens.filter(t=>t.owner===TRIAL_OWNER&&t.publicIndex===2&&t.mint!==GENESIS_MINT&&verified(t));
 // Duplicate ordinals are an index error; keep original token positions stable.
 const seen=new Map();for(const t of tokens){if(Number.isSafeInteger(t.publicIndex)&&t.publicIndex>=3)seen.set(t.publicIndex,(seen.get(t.publicIndex)||0)+1);}
 const future=tokens.filter(t=>Number.isSafeInteger(t.publicIndex)&&t.publicIndex>=3&&seen.get(t.publicIndex)===1&&t.escrowPolicy==='platform-auto-v3'&&t.bridgeVersion===3&&t.bridgeReady===true&&t.mint!==GENESIS_MINT&&verified(t)).sort((a,b)=>a.publicIndex-b.publicIndex);
 return [...(first?[{...first,publicIndex:1}]:[]),...(trial.length===1?[trial[0]]:[]),...future];
}
