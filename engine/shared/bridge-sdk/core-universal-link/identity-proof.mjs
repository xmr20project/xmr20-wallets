// Custody/signature verification only. This is NOT authorization to spend/activate.
// Production must additionally run independent complete native replay, ten confirmations,
// reorg/freshness gates, asset admission and exact financial review. No live caller exists.
import {identityAddresses, decodeIdentity} from './sdk.mjs';
import {commitment, digest, message} from './records.mjs';
const need = (value, text) => { if (!value) throw Error(text); };
export async function verifyIdentityCustody({config, envelope, chain, signatureVerifier}) {
  const proof = commitment(envelope), record = envelope.record;
  need(record.to === config.owner && record.registry === config.program && record.verifier === config.verifier
    && digest(record.owner) === config.binding, 'Identity differs from the selected wallet or trust domain.');
  need(await signatureVerifier.verify(message(record), record.owner, envelope.signature), 'Invalid native ownership signature.');
  await chain.verifyProgram();
  const a = identityAddresses(config);
  const rows = await Promise.all([a.identity, a.reverse].map(address => chain.readAccount(address.toBase58())));
  for (const row of rows) {
    need(row?.finalized === true && row.owner === config.program && row.executable === false, 'Independently finalized identity required.');
    const value = decodeIdentity(row.data);
    need(value.owner === config.owner && value.verifier === config.verifier && value.binding === config.binding
      && value.commitment === proof, 'Identity custody differs from its signed proof.');
  }
  return {custodyVerified: true, identity: a.identity.toBase58(), commitment: proof};
}
