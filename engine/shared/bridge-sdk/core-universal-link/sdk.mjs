// Offline candidate only. No transport, key access or production imports this module.
import {PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction} from '@solana/web3.js';
import {createAssociatedTokenAccountIdempotentInstruction, TOKEN_2022_PROGRAM_ID as TOKEN} from '@solana/spl-token';
import {addresses} from '../core-transferable/sdk.mjs';
const key = value => new PublicKey(value);
const need = (value, message) => { if (!value) throw Error(message); };
const hash = value => {
  need(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value), 'A nonzero canonical hash is required.');
  return Buffer.from(value, 'hex');
};
const meta = (pubkey, isWritable = false, isSigner = false) => ({pubkey: key(pubkey), isWritable, isSigner});

export function identityAddresses(config) {
  const program = key(config.program), owner = key(config.owner), verifier = key(config.verifier), binding = hash(config.binding);
  need(PublicKey.isOnCurve(owner.toBytes()) && !owner.equals(verifier) && !verifier.equals(PublicKey.default), 'Distinct owner/verifier required.');
  return {
    identity: PublicKey.findProgramAddressSync([Buffer.from('xmr20-identity-v1'), verifier.toBuffer(), owner.toBuffer()], program)[0],
    reverse: PublicKey.findProgramAddressSync([Buffer.from('xmr20-identity-xmr-v1'), verifier.toBuffer(), binding], program)[0],
  };
}

function compile(config, payer, blockhash, instructions) {
  need(typeof blockhash === 'string', 'A fresh caller-provided blockhash is required.');
  return new VersionedTransaction(new TransactionMessage({payerKey: key(payer), recentBlockhash: blockhash, instructions}).compileToV0Message());
}

export function registerIdentity(config, {commitment, blockhash}) {
  const a = identityAddresses(config);
  const ix = new TransactionInstruction({programId: key(config.program),
    keys: [meta(config.owner, true, true), meta(config.verifier, false, true), meta(a.identity, true), meta(a.reverse, true), meta(SystemProgram.programId)],
    data: Buffer.concat([Buffer.from([6]), hash(config.binding), hash(commitment)]),
  });
  return compile(config, config.owner, blockhash, [ix]);
}

export function activateAsset(config, {payer, blockhash}) {
  const identity = identityAddresses(config), a = addresses(config);
  const ix = new TransactionInstruction({programId: key(config.program),
    keys: [meta(payer, true, true), meta(config.verifier, false, true), meta(identity.identity), meta(identity.reverse),
      meta(a.position, true), meta(a.link, true), meta(a.pool, true), meta(a.mint), meta(a.vault), meta(TOKEN), meta(SystemProgram.programId)],
    data: Buffer.from([7]),
  });
  // Receiver does not sign or fund activation. Existing positions and balances stay intact.
  return compile(config, payer, blockhash, [
    createAssociatedTokenAccountIdempotentInstruction(key(payer), a.vault, a.pool, a.mint, TOKEN),
    createAssociatedTokenAccountIdempotentInstruction(key(payer), a.ata, a.owner, a.mint, TOKEN), ix,
  ]);
}

export function decodeIdentity(data) {
  const value = Buffer.from(data);
  need(value.length === 129 && value[0] === 1, 'Invalid universal identity account.');
  const result = {owner: new PublicKey(value.subarray(1,33)).toBase58(), verifier: new PublicKey(value.subarray(33,65)).toBase58(),
    binding: value.subarray(65,97).toString('hex'), commitment: value.subarray(97,129).toString('hex')};
  hash(result.binding); hash(result.commitment);
  return result;
}
