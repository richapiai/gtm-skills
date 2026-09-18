# Metrics

What this pack measures, where it is stored, and what it is allowed to conclude.

Three things live here: the **empty-column tripwire** (does a paid call deliver
anything?), the **activation metrics**, and the **kill/scale bands**.
None of them makes a network call.

---

## 1. The empty-column tripwire

**The failure it exists to catch.** `RESPONSE_MAPS` in `_lib/client.mjs` was
**spec-derived, not live-verified** until the 2026-08-31 capture, and that capture is
one sample per endpoint. The last time these field maps were inferred from the spec, `enrich_profile` and `enrich_company` delivered
**zero columns** while the user paid full price for every call. The
downstream "is this row already enriched?" predicate keys on `title` and
`company_name`, so it could never become true, and every row re-enriched forever.
The failure was **silent, paid, and on the first run**.

`RESPONSE_MAP_STATUS` reads `live_captured_2026_08_31_single_sample`. One sample is not
a guarantee, and an API that renames a key reopens the same failure. This is not a
historical note; it is the live risk.

### The distinction the tripwire turns on

A zero-column response has two completely different causes, and conflating them
hides the bug forever:

| | What happened | Verdict |
|---|---|---|
| **genuine not-found** | The API answered and had no data — `{}`, `{data: null}`, `{email: null}`, meta keys only | correct; not an error |
| **mapping failure** | The API answered **with** data and the field map failed to read it | a bug, billable, loud |

The test is on the **response body**, not on the column count:

> A 2xx whose body carries at least one **data-bearing, non-envelope** key and
> produces **zero** output columns is a mapping failure.

*Data-bearing* excludes `null`, `''`, `[]` and `{}`. *Envelope* keys
(`success`, `message`, `credits_charged`, `request_id`, …) are listed in
`ENVELOPE_META_KEYS`, with one override that matters: **a key the endpoint's own map
claims is never envelope noise**. `email_verifier` maps `status`, so `{status:
"valid"}` is real data there; `enrich_profile` does not, so the same key is noise
there. Getting this backwards yields either a false alarm on every not-found or a
missed failure on every verify.

A fourth case: an endpoint with **no map at all** that returns data is
`no_response_map`. Corrected 2026-09-17: this is **not** a mapping failure. The runtime
delivers the raw body, so nothing is lost; it is a coverage gap, reported calmly as
`DELIVERED UNMAPPED (raw body, N keys)` with the key names needed to write the map. It
was counted as a failure until six of eleven live runs printed the "delivered zero
columns" alarm for endpoints that had simply never been mapped.

### Where it lives

| Piece | File |
|---|---|
| Classify one response | `_lib/client.mjs` → `inspectResponse(endpoint, body)` |
| Accumulate a run | `_lib/mapping-audit.mjs` → `createMappingAudit()` |
| Render the alarm | `_lib/mapping-audit.mjs` → `renderMappingAlert(summary)` |
| Render the coverage note | `_lib/mapping-audit.mjs` → `renderUnmappedNote(summary)` |
| Surface it | `_lib/receipt.mjs` → `buildReceipt({ mapping })`, `renderReceipt` |
| Guard it | `_lib/receipt.mjs` → `assertMappingSurfaced(receipt, summary)` |
| Wire it | `_lib/enrich.mjs` → every `call` and `callBulk` |

`mapResponse` is unchanged and still returns columns only; `inspectResponse` is its
diagnostic sibling and returns the columns plus the classification.

### The evidence, and why it is the point

Every mapping failure records **the raw response key set**. Without it the next
debugger is guessing at camelCase versus snake_case all over again, which is exactly
how the zero-column failure survived. Key sets are deduplicated and capped at
`MAX_KEY_SETS_PER_ENDPOINT` (3) per endpoint, so a 500-row run cannot grow the
summary without bound.

**Law 7 holds.** The evidence is **key names only** — never a value. A key set fixes
the map; a value is a contact.

### What the user sees

The alert renders **above** the spend line in the receipt, because a user who paid
for a run and got nothing needs to read that before the endpoint table:

```
!!! MAPPING FAILURE — THIS RUN PAID FOR CALLS AND DELIVERED ZERO COLUMNS !!!
    42 call(s) were billed. 0 output columns were produced.
    This is NOT a not-found. The API answered WITH data and the field map failed to read it.
    Do not treat these rows as enriched: the "already enriched" check keys on the missing
    columns, so they will be re-bought on every subsequent run.

  enrich_profile  —  42/42 call(s) unreadable
      the response carried 3 data-bearing key(s) and NONE are in the field map ...
      map expects : firstname, lastname, currentTitle, currentCompany, ...
      API returned: credits_charged, jobTitle, organisation   x42
      map provenance: spec_documented_keys_not_live_verified
```

A clean run grows **no** warning section at all — a banner that is always there stops
being read.

`buildReceipt` called without a `mapping` summary reports `columns_delivered: null`,
not `0`: **not measured is not the same as clean**, and the receipt must not imply a
green result it did not observe.

`assertMappingSurfaced` recomputes from the audit's raw per-endpoint counters rather
than from the fields `buildReceipt` already derived. A guard that compares a value with
itself can never fire, and one here once did exactly that.

---

## 2. Activation instrumentation

`_lib/activation.mjs`. **Local only. It makes no network call, ever** — the module
imports `node:fs`, `node:path`, `node:crypto` and `_lib/ledger.mjs` (for the state
dir) and nothing else, and the test suite asserts that at the source level as well as
at runtime.

| Metric | Definition |
|---|---|
| **A** | install → first run |
| **B** | first run → second run |

The activation path itself already exists: `richapi enrich <list> --dry-run` is free
(zero calls, by construction), and a small real run is cheap — the plan's own figure
comes from the generated catalog, never from this page (law 1).

### Where the store lives, and why not in `gtm/`

`~/.richapi-skills/activation.json`, overridable with `richapi_SKILLS_HOME` — the
same state dir the balance cache uses. **Deliberately not under `gtm/`:**

- `gtm/` is PII: TTL-swept and erasable. An install metric that `/comply erase`
  deletes cannot measure install → first run at all.
- `gtm/` is per project. One install across three projects would count as three.

### What it stores (law 7)

Counts, timestamps, a local install UUID, and the pack version. **Nothing else** — no
list names, no file paths, no row ids, no contact values. A test walks every leaf of
the store and fails on any string that is not an ISO timestamp, a run-mode name, the
install id, or the version.

```
installed_at · first_run_at · first_run_mode · second_run_at · last_run_at
runs_total · runs_by_mode · paid_runs_total · first_paid_run_at
outputs_written · first_output_at
```

`installed_at` is written **once** and never moved — otherwise an upgrade resets the
clock and install → first run always looks instant.

"Ran the CLI" and "got the thing" are counted separately. A dry run, a blocked run
and a declined run are all runs (the user showed up) but none is a **paid** run, and
the activation event proper is `outputs_written` — **a file**, not a command.

### It can never break a run

Every write goes through `createActivationRecorder`, which swallows failures onto
`recorder.errors` and returns `null`. Telemetry that can fail a paid enrichment is
worse than no telemetry.

### Turning it off

- `richapi_NO_ACTIVATION_METRICS=1`
- `NODE_TEST_CONTEXT` (set by `node --test`) — the suite must never write into a
  developer's real state dir, and a test run counted as a first run would poison the
  only metric this file produces.
- Pass `activation: nullActivationRecorder()` to `runEnrich`.

---

## 3. Kill/scale bands

`_lib/activation.mjs` → `bandFor`, `evaluateBands`, `localCohort`.

| Metric | Green | Yellow | Red | Minimum n |
|---|---|---|---|---|
| **A** install → first run | ≥ green_min | between | < yellow_min | min_n |
| **B** first → second run within the window | ≥ green_min | between | < yellow_min | min_n |

**No number appears in that table on purpose.** Law 1: a threshold is never typed by
hand into a doc, and a kill/scale band is the most consequential number in the pack —
it decides whether the project continues. The bands are read from `gates.yaml` by key:

```
activation.metric_a_install_to_first_run.green_min_pct
activation.metric_a_install_to_first_run.yellow_min_pct
activation.metric_a_install_to_first_run.min_n
activation.metric_b_first_to_second_run.green_min_pct
activation.metric_b_first_to_second_run.yellow_min_pct
activation.metric_b_first_to_second_run.min_n
activation.metric_b_first_to_second_run.window_days
```

`GATE_KEYS` in `_lib/activation.mjs` is the authoritative list, and every verdict
carries the keys it was computed from.

### Instrumentation dark reads YELLOW, never RED

Law 5 says a missing gate key fails closed. For a **spend** gate, closed means STOP.
For a kill/scale band there is no call to stop, and failing to RED would read "we
have not configured the thresholds yet" as "kill the project". So the closed position
here is **YELLOW**, stated on the verdict, with **no number substituted**:

1. **Thresholds absent from `gates.yaml`** → YELLOW, `thresholds_configured: false`.
2. **n = 0** → YELLOW, "instrumentation dark".
3. **n below `min_n`** → YELLOW, "too small to support a kill decision".

Nothing below `min_n` can be RED. That is asserted as a property, over every n from
0 to `min_n`, not as three examples.

### The denominator is honest

`localCohort()` reads one machine, so n is 1 and both bands are YELLOW by
construction. Real numbers need an aggregation across installs that **does not exist
and is not built here** — building it means a network client and an explicit consent
toggle, which is a separate decision. Until then the shape of a fleet cohort is
written down (`{ installs, first_runs, second_runs_within_window }`) and
`evaluateBands` accepts one from wherever it eventually comes from.

Measurement point: **6 weeks after the repository goes public.**

---

## 4. Running CI locally

`scripts/ci-local.sh` runs every step of `.github/workflows/validate.yml`'s
`validate` job, in order, and stops at the first failure. No git, no remote, no push,
no publish; `npm ci` is forced `--offline`.

Two things it cannot reproduce and says so instead of papering over:

- the **Node version matrix** (20, 22, 24) — one runtime per machine;
- `actions/checkout` — it tests the working tree, not a clean checkout.

The schedule-only `absorb-spec` job is deliberately not run: it fetches a live spec
and ends in `git push`.

```bash
bash scripts/ci-local.sh              # everything
bash scripts/ci-local.sh --skip-install
```

`tests/activation/ci-local.test.mjs` parses `validate.yml` and fails if the script drifts
from the workflow, so a green here keeps meaning something.

---

## Tests

`tests/activation/`

| File | Covers |
|---|---|
| `mapping-tripwire.test.mjs` | the empty-column tripwire, end to end, including the reproduction |
| `activation.test.mjs` | activation counters, the no-network guarantee, kill/scale bands |
| `ci-local.test.mjs` | workflow/script drift, fail-fast, `npm pack` vs `files:` |
