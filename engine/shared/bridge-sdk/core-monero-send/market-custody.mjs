// LOCAL integration candidate, not a live issuer or an RPC proof verifier.
// Custody accounts must come from a caller's independently authenticated,
// genesis/program-pinned finalized Solana reads. Native blocks must come from
// complete authenticated confirmed Monero history. No serialized "verified"
// flag substitutes for either boundary. No wallet signing is performed here.
import {PublicKey} from '@solana/web3.js';
import {bridgePolicy, decodePolicy, decodeBridgeReceipt} from './bridge-sdk.mjs';
import {custodyPolicyIdentity} from './custody-policy.mjs';
import {bytes, domain, hash, hex, need, uint} from '../../native-market/xn1/bytes.mjs';
import {decodeManifest, encodeManifest, manifestId, circulatingSupply,validCreditEpoch} from '../../native-market/xn1/records.mjs';
import {authorizedRecipient} from '../../native-market/xn1/output-identity.mjs';
import {decodeCarrier, inspectCarrier} from '../../native-market/xn1/carrier.mjs';
import {creditMessage, verifyCredit, verifyRecipient} from '../../native-market/xn1/proofs.mjs';
import {PrototypeIndex} from '../../native-market/xn1/replay.mjs';

const key = value => new PublicKey(value);
const digest = (...parts) => hash(...parts).toString('hex');

export function marketBridgeDomain(config) {
  need(config.nativeCustodyMode === undefined || ['quorum-draft-v1','operator-verified-v1'].includes(config.nativeCustodyMode), 'Unknown native custody mode');
  return digest(domain(config.nativeCustodyMode==='operator-verified-v1'?'XN1-J3-OPERATOR-CUSTODY-V1':'XN1-J3-CUSTODY-DRAFT-V1'), key(config.program).toBuffer(),
    key(config.mint).toBuffer(), key(config.verifier).toBuffer());
}

export function marketPolicy(config, manifest) {
  const m = decodeManifest(encodeManifest(manifest));
  const operator=config.nativeCustodyMode==='operator-verified-v1';
  need(operator ? m.threshold===1&&m.issuers.length===1&&m.issuers[0]===key(config.verifier).toBuffer().toString('hex')&&circulatingSupply(m.profile) :
    m.threshold === 2 && [2, 3].includes(m.issuers.length), operator?'Exact operator-verified native policy required':'Two configured custody authorities required');
  need(m.depth >= 10 && m.decimals === 6, 'Ten confirmations and exact XMR20 precision required');
  need(m.asset === key(config.mint).toBuffer().toString('hex') && m.bridgeDomain === marketBridgeDomain(config),
    'Native market manifest must bind this exact custody program, mint and verifier');
  const options={manifest: manifestId(m), signers: m.issuers.map(k => key(hex(k)).toBase58()),mode:operator?'operator-verified-v1':'quorum-draft-v1'};
  return config.owner?bridgePolicy(config,options):custodyPolicyIdentity(config,options);
}

// The receipt PDA is known before signing a deposit/conversion. Its unique lock
// can therefore be included in the recipient's proposed native CREDIT first.
export function marketReceiptIdentity(config, manifest, receiptAddress) {
  const a = marketPolicy(config, manifest), receipt = key(receiptAddress);
  const lock = digest(domain('XN1-J3-LOCK-DRAFT-V1'), a.program.toBuffer(), a.policy.toBuffer(),
    hex(a.manifest), receipt.toBuffer());
  return {lock, issuance: digest(domain('XN1-J3-ISSUANCE-DRAFT-V1'), hex(lock))};
}

function creditTarget(config, manifest, transaction) {
  const a = marketPolicy(config, manifest), tx = inspectCarrier(bytes(transaction)), decoded = decodeCarrier(tx);
  need(decoded?.record.op === 'CREDIT' && decoded.record.manifest === a.manifest, 'Exact native market CREDIT required');
  const {record, context} = decoded, output = tx.outputs[record.vout];
  need(validCreditEpoch(manifest,record.epoch) && output && record.amount <= manifest.cap, 'Invalid native credit destination or amount');
  need(authorizedRecipient(manifest,{manifest: a.manifest, context, allocation: record, outputKey: output.key}),
    'Recipient must authorize the exact native output, amount and transaction');
  // Context excludes proof/signature scalars only; it binds the native inputs,
  // outputs, fees and overlay fields. Issuer signatures can be added afterwards.
  const binding = digest(domain('XN1-J3-OUTPUT-DRAFT-V1'), hex(a.manifest), hex(context),
    hex(record.lock), hex(record.issuance), uint(record.vout, 2), uint(record.amount, 8),
    hex(output.key), hex(record.image));
  return {a, tx, record, context, output, binding};
}

export function marketCreditBinding({config, manifest, transaction}) {
  return creditTarget(config, manifest, transaction).binding;
}

function accountData(account, expected, program) {
  need(account?.address === expected.toBase58() && account.owner === program.toBase58() && account.executable === false,
    'Authenticated program-owned custody account required');
  return bytes(account.data);
}

export function marketCreditFromFinalizedReceipt({config, manifest, transaction, policyAccount, receiptAccount}) {
  const {a, tx, record, context, output, binding} = creditTarget(config, manifest, transaction);
  const policy = decodePolicy(accountData(policyAccount, a.policy, a.program));
  need(policy.mint === a.mint.toBase58() && policy.verifier === a.verifier.toBase58() &&
    policy.manifest === a.manifest && policy.mode===a.mode && policy.requiredSignatures===a.requiredSignatures && policy.signers.join(',') === a.signers.map(s => s.toBase58()).join(','),
  'Exact immutable market custody policy required');
  need(receiptAccount?.owner === a.program.toBase58() && receiptAccount.executable === false,
    'Authenticated program-owned custody receipt required');
  const receipt = decodeBridgeReceipt(receiptAccount.data);
  need([10, 12].includes(receipt.kind) && receipt.to === a.policy.toBase58(), 'Native output deposit/conversion receipt required');
  need(receipt.kind !== 10 || receipt.from === a.policy.toBase58(), 'Deposit belongs to another custody policy');
  const receiptAddress = PublicKey.findProgramAddressSync([
    Buffer.from('joint-v3-receipt'), key(receipt.from).toBuffer(), hex(receipt.nonce)], a.program)[0];
  accountData(receiptAccount, receiptAddress, a.program);
  const identity = marketReceiptIdentity(config, manifest, receiptAddress);
  need(record.lock === identity.lock && record.issuance === identity.issuance, 'Credit must use the exact custody receipt once');
  need(receipt.binding === binding, 'Custody receipt does not authorize this native credit destination');
  const gross = BigInt(receipt.gross), net = BigInt(receipt.net), fee = BigInt(receipt.fee);
  need(gross === net + fee && net === record.amount && net > 0n, 'Custody and native credit exact amounts disagree');
  need(receipt.kind !== 12 || fee === 0n, 'Conversion cannot deduct another token fee');
  // Historical credits remain valid after later redemptions reduce the reserve.
  // Never confuse the current reserve with proof that this immutable lock existed.
  return {manifest: a.manifest, ...identity, amount: net.toString(), binding,
    receipt: receiptAddress.toBase58(), txid: tx.txid, context,
    issuerMessage: creditMessage(record, context, output.key).toString('hex')};
}

// Native ownership rules are the SAME PrototypeIndex used by the market, not
// the parallel account-ledger prototype. Only CREDIT admission reads custody.
// MOVE/BURN use native claims/recipient proofs and need no Solana account/link.
export function createMarketCustodyLedger({config, manifest, readFinalizedReceipt}) {
  config = structuredClone(config);
  manifest = decodeManifest(encodeManifest(manifest));
  marketPolicy(config, manifest);
  need(typeof readFinalizedReceipt === 'function', 'Independent finalized receipt reader required');
  const index = new PrototypeIndex(manifest);
  const view=new Proxy(Object.create(PrototypeIndex.prototype),{
    get(_target,property){if(!['id','manifest','snapshot','accountingSummary','checkpoint','stateHash','canonicalState','displaySnapshot','previewTransaction'].includes(property))return undefined;
      if(property==='previewTransaction')return transaction=>{const result=index.previewTransaction(transaction);need(result.record.op!=='CREDIT','Credit requires finalized custody admission');return result;};
      const value=index[property];return typeof value==='function'?value.bind(index):value;},
    set(){throw Error('Custody replay view is read-only');},defineProperty(){throw Error('Custody replay view is read-only');},deleteProperty(){throw Error('Custody replay view is read-only');}
  });
  return Object.freeze({
    id: index.id,
    readOnlyIndex:()=>view,
    snapshot: () => ({...index.snapshot(), manifest: index.id}),
    stateHash: () => index.stateHash(),
    rewind: ({height, hash}) => index.rewind(height, hash),
    previewTransaction: transaction => {
      const result = index.previewTransaction(transaction);
      need(result.record.op !== 'CREDIT', 'Credit preview also requires finalized custody receipt admission');
      return result;
    },
    async prepareCredit(transaction) {
      // Issuance is the bridge boundary. Keep this capability separate from
      // ordinary MOVE/BURN preview so a caller cannot skip custody admission.
      const bytesCopy=Buffer.from(bytes(transaction)),before=index.stateHash();
      const preview=index.previewTransaction(bytesCopy),decoded=decodeCarrier(inspectCarrier(bytesCopy));
      need(decoded?.record.op==='CREDIT','Native credit required');
      const evidence=await readFinalizedReceipt({lock:decoded.record.lock,issuance:decoded.record.issuance});
      marketCreditFromFinalizedReceipt({config,manifest,transaction:bytesCopy,...evidence});
      const assertCurrent=()=>{
        need(index.stateHash()===before,'Native replay changed during credit admission');
        need(index.previewTransaction(bytesCopy).signatureHash===preview.signatureHash,'Native credit changed');
      };
      assertCurrent();return Object.freeze({preview,assertCurrent});
    },
    applyBlock: block => index.applyBlockWithPolicy(block, {
      beforeTransaction: async () => {},
      authorizeRecord: async ({tx, decoded}) => {
        if (decoded.record.manifest !== index.id || decoded.record.op !== 'CREDIT') return true;
        const output = tx.outputs[decoded.record.vout];
        // Public garbage must not turn into a backing-reader failure and halt
        // every wallet. Only authenticated issuer credits reach that reader.
        if (!output || !verifyCredit(decoded.record, decoded.context, output.key, manifest) ||
          !authorizedRecipient(manifest,{manifest: index.id, context: decoded.context, allocation: decoded.record, outputKey: output.key})) return false;
        const evidence = await readFinalizedReceipt({lock: decoded.record.lock, issuance: decoded.record.issuance});
        // Reader outages/invalid backing abort the block atomically; an issuer
        // quorum alone never authorizes an unbacked mint in this composition.
        marketCreditFromFinalizedReceipt({config, manifest, transaction: tx.data,
          policyAccount: evidence?.policyAccount, receiptAccount: evidence?.receiptAccount});
        return true;
      },
      afterTransaction: async () => {}
    })
  });
}

export function marketRedemptionNonce(manifest,redemption){
  return digest(domain('XN1-J3-REDEMPTION-DRAFT-V1'),hex(manifest),hex(redemption));
}
export function marketRedemptionFromConfirmedReplay({config, manifest, snapshot, checkpoint, redemption, fee, now = Date.now()}) {
  const a = marketPolicy(config, manifest);
  hex(redemption);
  // checkpoint is supplied by an authenticated complete-history reader. This
  // consistency/depth check does not authenticate a caller-provided checkpoint.
  need(snapshot?.manifest === a.manifest && snapshot.height === checkpoint?.height && snapshot.blockHash === checkpoint?.hash &&
    typeof checkpoint?.observedHeight === 'bigint' && checkpoint.observedHeight >= checkpoint.height &&
    checkpoint.observedHeight - checkpoint.height + 1n >= BigInt(manifest.depth) &&
    Number.isSafeInteger(now) && Number.isSafeInteger(checkpoint.checkedAt) && checkpoint.checkedAt <= now &&
    now - checkpoint.checkedAt <= 30000,
  'Fresh complete confirmed native replay required');
  const burn = snapshot.burns.get(redemption);
  need(burn && snapshot.transactions.has(burn.txid) && snapshot.transactions.get(burn.txid) <= snapshot.height,
    'Accepted native market burn required');
  need(typeof fee === 'bigint' && fee >= 0n && fee < burn.amount, 'Fresh exact redemption fee required');
  return {kind: 'redeem', amount: burn.amount.toString(), fee: fee.toString(),
    destination: key(hex(burn.recipient)).toBase58(),
    nonce: marketRedemptionNonce(a.manifest,redemption)};
}
