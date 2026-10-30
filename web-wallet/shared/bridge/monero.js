import { keccak_256 } from "@noble/hashes/sha3";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const blockBytes = { 2: 1, 3: 2, 5: 3, 6: 4, 7: 5, 9: 6, 10: 7, 11: 8 };
export function checkMoneroAddress(address) {
  try {
    if (typeof address !== "string" || ![95, 106].includes(address.length))
      throw Error();
    const bytes = [];
    for (let i = 0; i < address.length; i += 11) {
      const block = address.slice(i, i + 11),
        size = blockBytes[block.length];
      if (!size) throw Error();
      let n = 0n;
      for (const c of block) {
        const k = alphabet.indexOf(c);
        if (k < 0) throw Error();
        n = n * 58n + BigInt(k);
      }
      if (n >= 1n << BigInt(8 * size)) throw Error();
      const part = new Array(size);
      for (let j = size - 1; j >= 0; j--) {
        part[j] = Number(n & 255n);
        n >>= 8n;
      }
      bytes.push(...part);
    }
    const b = Uint8Array.from(bytes),
      prefix = b[0],
      integrated = prefix === 19;
    if (![18, 19, 42].includes(prefix) || b.length !== (integrated ? 77 : 69))
      throw Error();
    const hash = keccak_256(b.slice(0, -4));
    if (b.slice(-4).some((n, i) => n !== hash[i])) throw Error();
    return {
      valid: true,
      kind: integrated
        ? "integrated"
        : prefix === 42
          ? "subaddress"
          : "standard",
      message: "Valid mainnet Monero address.",
    };
  } catch {
    return {
      valid: false,
      kind: "unknown",
      message: "Enter a valid mainnet Monero address (including its checksum).",
    };
  }
}
