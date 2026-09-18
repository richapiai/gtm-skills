# Shared contracts — frozen

These JSON Schemas define file shapes that more than one part of the runtime reads or
writes. They are frozen: each is content-hashed in
`tests/contracts/frozen-contracts.sha256` and checked on every test run.

**A contract may not be changed unilaterally.** Adding a field is cheap; discovering
that two components assumed different shapes — after they have both written files — is
not. The amendment procedure is in [`CONTRIBUTING.md`](../../CONTRIBUTING.md): change
the schema, the hash, and every reader in the same pull request, and say in the
description why the change is additive.

| Contract | Written by | Read by |
|---|---|---|
| `api-catalog.schema.json` | the catalog generator (`bin/richapi-catalog-gen.mjs`) | the ledger, for cost estimates; the test fixtures, for assertions |
| `journal-line.schema.json` | the run journal (`_lib/journal.mjs`) | the ledger, to cross-reference a charge; `/comply erase`, to sweep it |
| `ledger-line.schema.json` | the ledger (`_lib/ledger.mjs`) | the dry-run planner, for estimates; the receipt, for what a run cost |

Every amendment so far has been additive, and each was made because two components
computed the same predicate and disagreed — the reason the freeze exists.
