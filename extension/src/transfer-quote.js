const rawAmount = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(value);
export function checkTransferAmount(raw) {
  if (!rawAmount(raw) || BigInt(raw) <= 0n) throw Error('Enter a valid token amount.');
  if (BigInt(raw) > 50000000000000n) throw Error('The maximum per transfer is 50,000,000 tokens.');
}

// A public holdings row may be delayed. Only the authenticated service quote
// verifies spendable balance, including reservations for pending transfers/burns.
export function validateTransferQuote(quote, account, row, to, raw) {
  checkTransferAmount(raw);
  if (!quote || row.network !== 'monero' || quote.launchId !== row.id ||
      !/^[a-f0-9]{64}$/.test(row.deployment) || quote.token !== row.deployment ||
      quote.network !== 'mainnet' || quote.from !== account.xmr ||
      quote.to !== to || quote.amountRaw !== raw) {
    throw Error('The quote does not match this transfer. Nothing signed.');
  }
  if (!rawAmount(quote.balanceRaw) || !rawAmount(quote.availableRaw) ||
      BigInt(quote.availableRaw) > BigInt(quote.balanceRaw) ||
      !Number.isSafeInteger(quote.height) || quote.height <= 0) {
    throw Error('Could not verify the available balance. Please retry.');
  }
  if (BigInt(raw) > BigInt(quote.availableRaw)) {
    throw Object.assign(Error('Insufficient available balance. Pending transfers and burns are already reserved.'),{code:'MONERO_INSUFFICIENT_BALANCE',balanceRaw:quote.balanceRaw,availableRaw:quote.availableRaw});
  }
  return quote;
}
