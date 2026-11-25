# Vendored crates

Two published crates are built from the copies in this folder, because the programs here need
a few functions the published versions keep private. No rule of the ledger and no circuit is
changed by them. Each difference from the published crate is listed in full; `diff -ru` of a
copy against the crate from crates.io shows the same and nothing more.

## penumbra-sdk-shielded-pool 2.1.1 (MIT OR Apache-2.0)

- `src/output/proof.rs`: `OutputCircuit::new` is made `pub`.
- `src/spend/proof.rs`: a public constructor `SpendCircuit::from_parts(public, private)` is
  added.

Both only let a caller build the circuit's inputs. The constraints are Penumbra's, and a
reader checks proofs against Penumbra's published verifying keys, whose ids are pinned in the
parameters manifest.

## monero-wallet 0.2.0 (MIT)

Three functions are added, used only by programs that build transactions on a local test
chain. The reader calls none of them.

- `src/decoys.rs`: `from_local_ring`, an input with a ring named by the caller.
- `src/scan.rs`: `scan_proposed`, scanning a transaction that is not in a block yet.
- `src/send/mod.rs`: `unsigned_transaction_with_mask_sum`.

The crate's own `tests/` folder is left out.
