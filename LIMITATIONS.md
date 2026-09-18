# Limitations

What this pack cannot do, cannot verify, or does not yet know — stated before you point
it at money. Everything below was measured against the code in this repository, not
remembered. Where a claim has a number in it, the number came from
`_lib/api-catalog.json`, `_lib/gates.yaml` or the file named beside it.

This is a companion to [`ROADMAP.md`](ROADMAP.md) (what is built and what is next) and
[`SECURITY.md`](SECURITY.md) (threat model and controls). The README's
[Where this actually stands](README.md#where-this-actually-stands) is the short version;
this is the long one.

---

## 1. Two capture runs have happened. The first found a defect that had shipped

On **2026-08-31** the capture harness ran against the live API with a real key and
recorded **55 responses**, 35 of them a usable `200`. Before that date this section read
"the pack has never made a real authenticated call, end to end. Not once." That is no
longer true, and what the run found is the reason this section now leads the file.

**The response maps were wrong, and they were wrong where it cost the most.** Every one
had been derived from the spec's documented 200 examples. Against the recordings:

| endpoint | price | columns delivered | what was lost |
|---|---|---|---|
| `email_finder` | 5cr | 1 of 3 | **the email address** |
| `email_verifier` | 2cr | 0 of 5 | everything |
| `phone_finder` | **25cr** | 0 of 2 | **the phone number** |
| `enrich_profile` | 1cr | 4 of 11 | title, company, url, location |
| `enrich_company` | — | 4 of 10 | industry, size, HQ, founded |
| `identify_email_type` | — | 1 of 2 | the classification |

The default waterfall — profile → email → verify, ~8 credits a contact — returned the
email in **zero** cases. Three causes: the finder endpoints wrap their payload in
`result` and the reader unwrapped only `data`; the LinkedIn scrapers answer different key
names from the ones the spec documents; and the empty-column tripwire tested for *zero*
columns, so `email_finder` producing one incidental column read as success.

All three are fixed (`_lib/client.mjs`, 2026-09-02). Maps are now dotted paths taken from
the recordings, `tests/response-maps` replays each recording on every build, and a partial read
is a distinct loud status (`MAP_PARTIAL`) rather than a silent pass.

**The second run, 2026-09-17,** re-recorded the surface against the re-pinned spec. 65
endpoints answered `2xx` (the scrapers answer `201` with the full, billed result), two
answered `403` because this team is not allowed to call them, and `slack_channel_members`
has no capture input. It also settled facts the spec does
not state:

- `enrich_profiles_bulk` does **not** answer in request order (§3).
- `post_activities` engager rows carry `commenter.headline` and `commenter.entityUrn`,
  and no job title or company. Its page numbers are zero-based and `totalPages` is
  present.
- `search_bing` needs `page` of at least 1; `0` or an absent `page` is a `422`.
- `youtube_video` returns a `captions` field that came back `null` even with
  `include_captions=true`.

**What is still unverified.** Each capture is one sample per endpoint. Timeouts,
rate-limit behaviour under load, error bodies, partial responses, and any response shape
that varies by input or by upstream provider remain unverified. Five endpoints still have
no usable recorded success shape (§2). Assume the next live run finds something too.

## 2. Almost all of the surface is recorded. Five endpoints are still the spec's guess

`field_map` is `null` on **68 of 68** catalog endpoints, and that is by design rather
than by omission: the catalog publishes the *observed shape* of a response, and the
mapping from that shape to output columns lives in one place instead of two
(`RESPONSE_MAPS` in [`_lib/client.mjs`](_lib/client.mjs)).

What the catalog carries per endpoint is a path list, and the status says where it came
from:

- **63 of 68** report `field_map_status: live_fixture` — dotted scalar paths read off a
  recorded `2xx` response, with `field_map_keys_source: live_capture`. This is real
  evidence about what the server sends.
- **5 of 68** report `field_map_status: keys_from_spec_example` — top-level key names
  lifted from the spec's own `200` example, with nothing recorded to check them against.
  **Treat these exactly as §1 says: the spec was wrong about six endpoints out of six
  that got checked.** They are `geo_id_search` (the sample found nothing),
  `google_ad_transparency_scraper_sync` and `linkedin_ad_search` (`403`, access
  restricted for the capturing team), `google_maps_reviews_scraper_sync` (an empty
  object) and `slack_channel_members` (no capture input).
- **0 of 68** report `TODO_no_usable_example`. The three the spec leaves blank —
  `enrich_profiles_bulk`, `enrich_companies_bulk`, `google_maps_places_scraper_keyword` —
  are now recorded.

The waterfall hops are all in the first group. `linkedin_ad_search` is invoked by three
skills and its shape is still the spec's guess, so read its output with that in mind.
See [`ROADMAP.md`](ROADMAP.md#next).

**An endpoint with no `RESPONSE_MAPS` entry is delivered raw, not normalised.** `richapi
call --out` writes the whole response body on every row — `response` in JSONL,
`response_json` (a JSON string) in CSV — with `response_mapped: false`, and the run
reports `unmapped_rows`. Mapped endpoints also carry `response` in JSONL. Before
2026-09-17 an unmapped endpoint wrote only the input columns (CSV) or `{}` (JSONL) after
billing the call.

**29 of 68 endpoints are mapped**, up from 8 on the morning of 2026-09-17. The 21 added
that day were all endpoints the skills already call and whose answers had been arriving
raw. The rest stay raw for a stated reason, each checked by a test in
`tests/response-maps/new-maps-2026-09-17.test.mjs` rather than left as a comment:

- **a top-level array body** (`enrich_profiles_bulk`, `enrich_companies_bulk`,
  `similarweb_scraper_sync`, both `google_maps_places_*`, `google_search_scraper_sync`,
  `crunchbase_company_scraper_sync`, `meta_ads_library_scraper_sync`). `mapResponse`
  maps one object to one row; these answer N rows, which is the batch path's job.
- **the only recording is a miss** (`find_website_by_company_name`,
  `find_linkedin_url_by_email`, `web_social_links`, `web_emails`). Mapping the
  not-found envelope would be inventing the hit shape — the 2026-09-02 defect again.
- **no usable recording** (`geo_id_search`, `linkedin_ad_search`,
  `google_ad_transparency_scraper_sync`, `google_maps_reviews_scraper_sync`,
  `slack_channel_members`).
- **not row-shaped** (`search_reference_data`, a reference taxonomy).

**Raw delivery is not a mapping failure, and the receipt no longer says it is.** Six of
the eleven live runs on 2026-09-17 printed `MAPPING FAILURE — THIS RUN PAID FOR CALLS
AND DELIVERED ZERO COLUMNS` for endpoints that simply had no map, while the whole body
was being handed to the caller. A missing map now reads `DELIVERED UNMAPPED (raw body,
N keys)` in the body of the receipt, with the key names needed to write the map. The
loud banner is kept for what it was written for: a MAPPED endpoint whose response
carried data that the map read none of, which is a paid response nobody can read.

## 3. Bulk batching ships off, and turning it on is not a config decision

`runtime.batch.auto` is `false` in [`_lib/gates.yaml`](_lib/gates.yaml). This is a
correctness decision, not a cost one — batching is credit-neutral, so the only thing it
buys is latency and fewer 429s.

The bulk endpoints do **not** answer in request order. Recorded on 2026-09-17:
`enrich_profiles_bulk` was sent three profiles A, B, C and answered B, C, A. Matching by
position would have attached one contact's data to another contact's row, silently, at up
to 50 rows a call.

So the runtime no longer matches by position. `alignBulkRows` in
[`_lib/batch.mjs`](_lib/batch.mjs) joins each result to its row by identity — the
`entityUrn` a profile carries, the `objectUrn` a company carries — and a row the response
does not name fails as `bulk_unmatched` instead of borrowing another row's data.

`--batch` exists on `richapi enrich` as an explicit opt-in. The default stays off until
one real batched run through the runtime has been checked end to end; the join is
covered by tests, and flipping the switch is a separate decision.

There is a second, separate reason the bulk person path is usually unreachable anyway:
the bulk endpoints take LinkedIn URNs where the single-row endpoints take URLs, and
nothing in the API converts one to the other.

## 4. No endpoint tells you what it charged

Measured 2026-09-17 across all **65** recorded 2xx bodies in `tests/fixtures/live/`:
**zero** carry a charge. Not a `credits_charged`, not a `credits_used`, not a `cost`, at
any depth. The only `price` keys in the whole corpus are product prices inside business
data.

So this is not a property of eleven awkward endpoints. It is a property of the API:
**every credit figure this pack reports is an estimate**, computed before the call from
the catalog price, and nothing ever reconciles it against a charge.

Until 2026-09-17 the catalog said otherwise. `pricing.billing_field_present_in_response`
was derived from the *spec's* response example for a metered endpoint and set to `true`
by construction for every flat one, so 57 of 68 rows claimed the charge came back —
while [`_lib/ledger.mjs`](_lib/ledger.mjs) wrote `cost_status: "estimated_unverifiable"`
on every one of those calls, because `resolveActual` has always refused to promote a
flat catalog price to an actual. Six of the eleven live runs that day printed both
statements. The flag is now derived from the recordings, so it reads `false` for all 68
rows, which is the true fact.

For every line, the ledger writes `cost_status: "estimated_unverifiable"` with
`credits_actual: null`, and it will keep doing so — not until a fix lands, but for as
long as the response carries no charge. The pack will not fabricate an actual it cannot
read. A run total is an honest *ceiling*, not a receipt, and every report says so in
those words.

A flat price is still *exact* in the sense that matters before the call: one call, one
known price, no result count to multiply it. "Exact" and "verified" are different
claims, and conflating them is what produced the contradiction above.

This is on the API's roadmap, and nothing here needs rewriting when it lands. The
resolver in [`_lib/ledger.mjs`](_lib/ledger.mjs) already reads `credits_charged` off the
response body and promotes that line from `estimated_unverifiable` to a verified actual,
whatever the catalog claims; `billingFieldPresentInRecording` in
[`_lib/catalog/extract.mjs`](_lib/catalog/extract.mjs) flips the catalog flag off a
recording alone. So the sequence is: the field ships, a fixture is recorded, the catalog
is regenerated, and receipts become exact. Until then this section stands as written.

## 5. There is no reconciliation against the provider's own usage record

`Ledger#reconcile()` exists and is tested, but no run feeds it anything. The re-pinned
spec now documents `GET /api/v1/usage` — team-wide credit consumption and
`credits_remaining` — and `GET /api/v1/my-endpoints`. The catalog generator reads `POST`
operations only, so neither is in the catalog, and the pack does not fetch `/usage` for a
run. Reconciliation therefore degrades to `status: "unreconciled"` and prints:

```
GET /usage: unavailable — NOT reconciled. The ledger total above is our own arithmetic.
```

That is the honest answer. It also means the ledger is unaudited: if the pack's
arithmetic and the provider's billing disagree, nothing here will detect it.

Relatedly, **`BALANCE` is often `unknown`.** `bin/richapi-skills-preflight` probes
`/api/v1/usage` in the background when a key, `curl` and `jq` are all present, and caches
the first balance-shaped number it finds (`credits_remaining` among them). Preflight
answers from that cache, so the first run after install says `unknown`, and so does any
run without a key. Because `/usage` is not in the catalog, a change to its shape is not
drift the catalog diff can catch. The pack will not guess a balance and will not upsell
against a number it does not have.

## 6. One checkout is one book of business

State isolation is **per-directory**, and that is the whole model. A run writes into a
`gtm/` tree under the working directory (or the tree named by `--dir`). There is no
tenant, no client, no workspace concept anywhere in the code. Two clients' data in one
checkout share a suppression list, a ledger, a cache and a journal. Run separate
checkouts, or separate directories, per book of business.

The one place this used to be dangerous is now closed. A compliance sweep — erase,
retention — that is pointed at the wrong tree touches nothing and reports success, which
for an erase produces a tombstone recording a deletion that never happened.
`resolveStateTree()` in [`_lib/pii.mjs`](_lib/pii.mjs) now **refuses** instead:

- omit `--dir` while another state tree exists beside the default `gtm/` → throws
  `StateTreeMismatchError` (verdict `STOP`), naming every candidate tree it found;
- name a `--dir` that does not exist while others do → the same refusal, on the grounds
  that a mistyped `--dir` is the same mistake typed out loud.

Ambiguity is a stop, never a guess. But nothing partitions the trees for you.

## 7. Six skills can still execute arbitrary code

Until 2026-09-02 all 33 skills declared a bare `Bash`, which is a grant over every
command on the machine. They are now scoped: each skill's shell grants are derived from
the commands its own runnable fences invoke, and a bare `Bash` fails the build.

The hole that remains is `Bash(node:*)`. Ten skills — `campaign-review`, `comply`, `cost-optimizer`, `crm-export`, `crm-sync-expert`, `gtm-retro`, `launch`, `learn`, `measure`, `scheduled-workflow` — run a generated
script through `node --input-type=module -e`, and `node -e` is arbitrary execution. For
those ten the grant is a formality; for the other 23 it is a real reduction, because they
cannot reach `curl`, `ssh`, a package manager or a shell.

None of the five skills that ingest attacker-authored text (`/reply-triage`, `/inbound`,
`/call-intel`, `/research-agent`, `/signal-watch`) holds `Bash(node:*)`.

[`SECURITY.md`](SECURITY.md#the-narrowed-grant-and-the-hole-it-does-not-close) has the
threat model and the controls that do exist. Read it before running this against
untrusted input.

## 8. CI has never passed on a runner

The workflows are written and the gates are wired, and the repository has a (private)
GitHub remote, but no run has finished green there. The runs of 2026-09-02 hung until
they were cancelled, and `validate.yml` is now manual-only. The whole matrix — Node 18.20.8, 20.19.0, 22.0.0,
24.5.0 — has instead been executed by hand, locally, via `scripts/ci-local.sh`.

That distinction is not pedantry: running the matrix by hand is how a packaging bug was
found that a floating `"20"` matrix row would have hidden. Every executable in `bin/` was
extensionless, which Node cannot load as ESM before 20.10, so the pack was broken on Node
18 and on 20.0–20.9 while a green CI badge would have certified an engine floor that was
never true. The rows are pinned to exact versions for that reason.

Treat "the suite is green" as "green on the maintainer's machine, on four pinned Node
versions" until the first green run of `validate.yml` on GitHub.

## 9. `jq` is a hard dependency, and without it three checks cannot run

[`bin/richapi-skills-preflight`](bin/richapi-skills-preflight) — the health contract every
skill runs before it does anything — uses `jq` for every check that reads JSON. Each call
is guarded by `command -v jq`, so the script never crashes.

Until 2026-09-02 it **degraded into a lie**: a missing `jq` produced `CATALOG_OK: no` and
`CATALOG_TOOLS: 0` on a perfectly valid 68-endpoint catalog, and every `SKILL.md` reads
`CATALOG_OK: no` as "regenerate the catalog" — a fix that cannot work, because nothing
was wrong with the catalog.

It now reports the fact on its own key and marks the gated checks **unmeasured** rather
than failed, because a check that could not run is not a failing check:

| Without `jq` | Meaning |
|---|---|
| `JQ_MISSING: yes` | the real cause, on its own line |
| `CATALOG_OK: unknown` | nothing looked; the catalog is probably fine |
| `CATALOG_TOOLS: unknown` | same |
| `FILTERS_OK: unknown` | same |

`richapi doctor` says it in a sentence and names the install command. The dependency
itself has not gone away — install `jq` before you debug anything else. `curl` is needed
for the balance probe on the same terms.

## 10. Status of the package itself

`2.0.0-alpha.0`, unpublished, clone-only. There is no npm package and no stable
interface promise; see [`SECURITY.md`](SECURITY.md#what-200-alpha0-promises) for what the
alpha does and does not commit to.
