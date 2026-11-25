# Parameters

`mainnet-v1/` holds what fixes the mainnet ledger:

- `manifest.json` (format `XMR20-PARAMS-2`, SHA-256
  `1b1a27dcb1c4b3d93e4b38963c0b32595e44362a86296aa9445f468a51f1841b`): the network and its
  genesis block, the first block a reader reads, the ledger domain, the issuer's public key,
  and Penumbra's two verifying keys with their key ids;
- `parameters.json`: the same configuration as the programs read it. The manifest states its
  SHA-256, and a program refuses the pair when they differ.

A reader needs nothing else. It verifies proofs; it makes none.

`test-v2/` is the same pair for the offline test chain the tests use.

## Proving keys

Making a shielded transfer, and the core's tests that do so, need Penumbra's proving keys.
They are large and are not kept in this repository:

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `spend_pk.bin` | 21,673,392 | `87eca85bef562803fb9684c56c0a6db84aa6d0791b1c00b909e6f2a5c2cff452` |
| `output_pk.bin` | 7,257,360 | `c9e97866edd6c815a7bcb2f3b5493713794369692bb96e5a2e682613c330e4a8` |

They are the files `src/gen/spend_pk.bin` and `src/gen/output_pk.bin` of
`penumbra-sdk-proof-params` 2.1.1, stored as git-lfs objects in
`github.com/penumbra-zone/penumbra`. Put them in `test-v2/` (and, for the tests of
`core/src/tests.rs`, the crate's `src/gen/` folder as `penumbra-2.1.1/`). Every program checks
a key file against the manifest before using it.

These keys come from Penumbra's setup ceremony. XMR20 ran no setup of its own and changed no
circuit. The ceremony's transcript was not verified independently by this project; the key
ids are the ones Penumbra's crate pins.
