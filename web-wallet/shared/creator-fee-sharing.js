import {PublicKey} from '@solana/web3.js';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {checkMoneroAddress} from './bridge/monero.js';

// The percentage is always a fraction of the creator's allocation, not total fees.
export function creatorFeeSharing(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(k => !['network','address','addresses','bps'].includes(k)))
    throw Error('Invalid creator fee sharing settings.');
  const {network, address, bps} = value;
  if (!Number.isInteger(bps) || bps < 1 || bps > 10000)
    throw Error('Choose between 0.01% and 100% of your creator fees to share.');
  if (Object.hasOwn(value,'addresses')) {
    if (network !== 'monero' || Object.hasOwn(value,'address') || !Array.isArray(value.addresses) || value.addresses.length !== 2)
      throw Error('Choose two different Monero recipients.');
    const addresses = value.addresses.map(recipient => {
      if (typeof recipient !== 'string' || recipient !== recipient.trim() || !checkMoneroAddress(recipient).valid)
        throw Error('Enter valid mainnet Monero addresses.');
      return recipient;
    }).sort();
    if (addresses[0] === addresses[1]) throw Error('Choose two different Monero recipients.');
    return {network,addresses,bps};
  }
  if (typeof address !== 'string' || address !== address.trim())
    throw Error('Enter a recipient wallet address.');
  if (network === 'solana') {
    const key = new PublicKey(address);
    if (!PublicKey.isOnCurve(key.toBytes()) || key.toBase58() !== address)
      throw Error('Enter a Solana wallet address.');
  } else if (network === 'monero') {
    if (!checkMoneroAddress(address).valid) throw Error('Enter a valid mainnet Monero address.');
  } else throw Error('Choose Solana (wXMR) or Monero (XMR).');
  return {network,address,bps};
}

export function creatorShareHash(value) {
  const share = creatorFeeSharing(value);
  if (!share) throw Error('Fee sharing is off.');
  if (share.addresses) return bytesToHex(sha256(new TextEncoder().encode(`xmr20/creator-share/v2\nmonero\nequal\n${share.addresses.join('\n')}\n${share.bps}`)));
  return bytesToHex(sha256(new TextEncoder().encode(`xmr20/creator-share/v1\n${share.network}\n${share.address}\n${share.bps}`)));
}

// Named charity presets remain in the website; payout routing accepts committed addresses.
export function creatorDonationAddresses(value) {
  const share = creatorFeeSharing(value);
  if (share?.network !== 'monero') throw Error('Monero donation settings required.');
  return share.addresses || [share.address];
}

export function splitCreatorReceipt(received, shareBps = 0) {
  received = BigInt(received);
  if (received < 0n || !Number.isInteger(shareBps) || shareBps < 0 || shareBps > 10000)
    throw Error('Invalid creator fee amount or percentage.');
  const shared = received * BigInt(shareBps) / 10000n;
  return {creator: received - shared, shared};
}
