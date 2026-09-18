# Test fixtures

The shared fixture corpus. Read by the whole suite.

Two corpora live here, and they exist for opposite reasons:

| Directory | What it is | Why it exists |
|---|---|---|
| `spec/` | five pinned OpenAPI snapshots | **the monthly-absorption test** — proves a spec change of each severity class is caught |
| `live/` | recorded API responses + field maps | **the field-map source** — the spec is a cost-and-route source, not a schema source (law 2) |

---

## Running the tests

```bash
node --test 'tests/**/*.test.mjs'      # everything
node --test 'tests/contracts/**/*.test.mjs'
node --test 'tests/fixtures/**/*.test.mjs'
```

**Quote the glob, and do not pass a bare directory.** On Node 24.5.0
`node --test tests/contracts/` treats the directory argument as a test file and
reports `'test failed'` with no useful output. The glob form works on every
supported Node. `npm test` already uses the glob.

---

## `spec/` — the five pinned snapshots

Every one is derived from the pinned `spec/openapi.yaml`
(`sha256 4e9512f5…193778`, 68 paths). `current.yaml` holds **byte-identical
slices** of that file; the others are deltas on it. Fifteen of the 68 endpoints
were kept — enough to cover every pricing model and every known hazard, small
enough that a human can read the diff.

`manifest.json` is the machine-readable version of this table: which fixture is
the baseline, which is the candidate, what findings each must produce, and what
must block. **The catalog diff tests should read the manifest rather than
hard-coding endpoint names**, so that changing a fixture forces changing its
declared expectation in the same commit. `spec-fixtures.test.mjs` checks the
files and the manifest still agree.

### 1. `current.yaml` — the baseline

A faithful trimmed snapshot. Covers flat / per-result / base-plus-per-result
pricing; a zero-credit endpoint; the two endpoints in the whole spec with **no
response example at all** (`enrich_profiles_bulk`, `enrich_companies_bulk`); the
endpoint whose entire example is the literal string `"example"`
(`email_finder`); endpoints declaring **zero required request fields** while
costing 25 credits a call (`phone_finder`); the bulk/single pair for the bulk-over-loop check; and
the deliberately-unclaimed endpoints for the ownership check (`predict_gender`,
`post_keyword_search`).

**Breaking it means:** every other fixture is a delta on this file. Regenerate
it — never hand-edit it — if the pinned spec changes, then re-derive the
deltas. Otherwise every drift assertion in the repo measures against a baseline
nobody agreed to.

### 2. `endpoint-added.yaml` — a new endpoint appears

`baseline = current.yaml`, `candidate = endpoint-added.yaml`.

Adds `/slack_channel_members` (2 credits/call), one of the 15 endpoints that
really appeared between 2026-05 and 2026-08, as a verbatim slice.

Must produce `ADDED` (non-blocking) from the catalog diff **and fail CI as
`UNMAPPED`** from the ownership check, because the endpoint appears in neither `endpoints:` nor `unclaimed:` of
`_lib/endpoint-owners.yaml`.

**Breaking it means:** a new paid endpoint lands in the catalog with no owner
and no reviewed cost — the path by which a skill starts quoting a price nobody
checked.

### 3. `endpoint-removed.yaml` — one true removal, one rename

`baseline = current.yaml`, `candidate = endpoint-removed.yaml`.

- `/find_personal_email` is **gone**, with nothing resembling it →
  `REMOVED_UNMAPPED`, **BLOCK**.
- `/linkedin_ad_search` is gone and `/ad_search` has appeared with a
  byte-identical operation body → `RENAMED`, auto-PR. It must **not** be
  reported as `REMOVED_UNMAPPED` + `ADDED`.

Both are grounded in measured churn. Thirteen endpoints really vanished in the
window and most were renames:

| gone | successor |
|---|---|
| `ad_search` | `linkedin_ad_search` |
| `ad_details` | `linkedin_ad_details` |
| `google_search_scraper` | `google_search_scraper_sync` |
| `google_maps_places_scraper` | `google_maps_places_scraper_keyword` |
| `google_maps_places_scraper_url` | `google_maps_places_scraper_sync_using_url` |
| `google_maps_reviews_scraper` | `google_maps_reviews_scraper_sync` |

while `find_emails`, `verify_emails`, `check_email_finding`,
`check_email_verification`, `check_usage`, `person_enricher` and
`company_enricher` were real deletions with no successor.

The rename pair used here is the real `ad_search` / `linkedin_ad_search` pair
replayed in reverse, so `current.yaml` can stay a faithful snapshot of the
pinned spec. Fuzzy matching is order-independent, so the `RENAMED` path is
exercised exactly as it would have been in May.

**Breaking it means:** if the true removal stops blocking, a skill keeps routing
to an endpoint that 404s mid-run. If the rename stops being detected, the
monthly diff shows 13 blocking removals, a human switches the gate off in month
two, and the gate is worth nothing.

### 4. `price-changed.yaml` — the real repricing window

> **The diff direction is inverted on purpose.**
> `baseline = price-changed.yaml`, `candidate = current.yaml`.

This file is the **2026-05 pricing state** of the same 15 endpoints, taken from
a legacy MCP tool-list catalog. Diffing it *forward* into
`current.yaml` replays the repricing that really happened instead of inventing
numbers, while letting `current.yaml` remain a faithful snapshot. Treating it as
the candidate turns every increase into a decrease.

Severity factor is `max(new/old, old/new)`; the catalog diff puts `REPRICED_MAJOR` at `>= 2x`.

| endpoint | 2026-05 | now | factor | severity | blocks |
|---|---|---|---|---|---|
| `phone_finder` | 3 /call | 25 /call | 8.33x | `REPRICED_MAJOR` | yes |
| `email_finder` | 2 /call | 5 /call | 2.50x | `REPRICED_MAJOR` | yes — see below |
| `email_verifier` | 1 /call | 2 /call | 2.00x | `REPRICED_MAJOR` | yes (boundary) |
| `web_emails` | 3 /call | 2 /call | 1.50x | `REPRICED_MINOR` | no |
| `post_keyword_search` | 6 /call | 0.1 /result (`numberOfElements`) | — | `PRICING_SEMANTICS_CHANGED` | yes |

Three things this table is doing deliberately:

- **`email_verifier` sits exactly on the 2.0x boundary.** A diff using `>`
  instead of `>=` passes every other case here and fails only this one.
- **`post_keyword_search`'s number went down.** A naive numeric comparison reads
  6 → 0.1 as a warn-only price cut. The per-call → per-result move changes the
  formula, so every estimate built on the old one is wrong; the diff must report
  `PRICING_SEMANTICS_CHANGED` and block, not `REPRICED_MINOR`.
- **`web_emails` is the only genuinely-minor case** — the one that must warn and
  not block.

> ### Why `email_finder` blocks
>
> A 2 → 5 reprice can read as minor. It is **2.5x**, and the catalog-diff severity rule
> defines `REPRICED_MINOR` as `<2x` and `REPRICED_MAJOR` as `>=2x`, so it **blocks**.
> `web_emails` 3 → 2 is the warn-only case.

**Breaking it means:** a bot-committed price increase reaches users unreviewed —
failure mode (1) of the five the monthly-absorption test guards.

### 5. `malformed.yaml` — a truncated download

**This file is not valid YAML and must never become valid YAML.** Three
independent defects, so a parser that recovers from one still fails: truncation
mid-`requestBody`, an unterminated double-quoted scalar, and inconsistent
indentation on `tags:`.

Feeding it to `richapi-catalog-gen` must warn or exit non-zero, must **not**
write a partial `_lib/api-catalog.json`, must leave the cached catalog
byte-identical, and must never surface a stack trace.

**Breaking it means:** one bad download empties the catalog, and because the
catalog is the source of truth for cost and routing (law 1), every skill loses
its prices at once.

---

## `live/` — recorded responses and field maps

The spec cannot be used as a schema source. Measured against the pinned file:

- 36 of 68 endpoints have a 200 example in which **≥40% of leaf values are the
  literal string `"example"`**;
- `email_finder`'s entire example is
  `{confidence:"example", email:"example", provider:"example"}`;
- `enrich_profiles_bulk` and `enrich_companies_bulk` — the two the batch path
  depends on — have **no example at all**;
- `_list_count`, the billing field 10 endpoints charge from, appears in **zero**
  examples.

So field maps come from `bin/richapi-capture-fixtures.mjs`.

### What is here now

| File | State |
|---|---|
| `field-maps/email_finder.json` | `field_map_status: "TODO_no_usable_example"` |
| `field-maps/enrich_profiles_bulk.json` | `field_map_status: "TODO_no_usable_example"` |
| `field-maps/enrich_companies_bulk.json` | `field_map_status: "TODO_no_usable_example"` |
| `sample-inputs.json` | public, non-personal request bodies for the capture run |

The three placeholders are **hand-authored and deliberately empty**
(`field_map: null`). Each lists exactly what is unknown and the command that
would resolve it. Downstream work is unblocked because the file exists and the
contract accepts the status; the gap stays visible because the status says so.

**No live responses have been captured. There is no API key in this
environment.** See the capture instructions below.

### Capturing (needs a live key and real credits)

```bash
# 1. Always plan first. Zero HTTP calls, zero credits.
node bin/richapi-capture-fixtures.mjs

# 2. The three endpoints with no usable spec example only — ~7 credits.
export richapi_API_KEY='<your key>'
node bin/richapi-capture-fixtures.mjs \
  --only email_finder,enrich_profiles_bulk,enrich_companies_bulk \
  --include-unbounded --run

# 3. Full bounded sweep — ~100 credits (56 endpoints).
node bin/richapi-capture-fixtures.mjs --run
```

`--run` prints the plan, then requires you to **type the credit total** to
confirm. `--yes` skips that, for CI only. `--include-unbounded` is required for
the 11 per-result endpoints with no limit-style parameter, whose cost cannot be
bounded in advance. Endpoints the catalog marks `disabled_by_default` are excluded
too (none today); `--include-disabled` overrides.

Redacted responses (`live/<endpoint>.json`) are safe to commit. Redaction also replaces
upstream data-provider names with `provider_1`, `provider_2`… in first-seen order per
response; model providers chosen on `ai_enrich` are kept. Unredacted
bodies are only written with `--keep-raw`, to `*.raw.json`, which `.gitignore`
already excludes.

`slack_channel_members` is marked uncapturable in `sample-inputs.json`: it needs
the caller's own Slack workspace credentials, and a token does not belong in a
committed file. The harness reports it as a visible `SKIP`.
