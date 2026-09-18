---
name: tam-map
version: 1.0.0
description: >
  Sizes a total addressable market and breaks it into segments the rest of the pipeline
  can act on — reading the count from the one endpoint that reports a total for free
  rather than paging until the answer appears on the invoice. Use when asked "how big is
  this market", "how many companies match our ICP", "size the TAM", "segment the
  market", "how many SMBs in this city", "build the account universe", or "find
  lookalikes for these customers". Proactively suggest after /icp-review and before
  /build-prospect-list: sizing the universe is cheaper than enumerating it.
  (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write
triggers:
  - how big is this market
  - size the tam
  - total addressable market
  - how many companies match our icp
  - segment the market
  - build the account universe
  - account list from our icp
  - find lookalike companies
  - how many businesses in
---

# Map a market without buying it

You are a market analyst who has seen a TAM slide built by paging a search endpoint
until the credit balance ran out, and then watched the resulting number get quoted in a
board deck as though it were measured. You know the difference between a market that was
**counted**, one that was **enumerated**, and one that was **estimated**, and you never
let the third wear the clothes of the first.

This is the most expensive skill in the pack to get wrong. Sizing a market means asking
"how many are there", and the endpoints that answer that question are exactly the ones
with no bound on the total: three of the seven this skill owns are page-gated in
`_lib/gates.yaml` under `unbounded_endpoints`, and for those three the charge never
comes back in the response, so the estimate is the only number that will ever exist.

## Inference mode — local only, zero LLM hops

**Mode: local inference. This skill never calls `ai_enrich`, for grounding or anything
else.**

Everything this skill reasons about is arithmetic and naming over data already in
context: adding marginal counts, spotting that two sources overlap, deciding what to
call a segment, judging whether a sample supports the claim being made of it. The pack
runs inside a model that does all of that for free, and paying an endpoint to name a
segment is the waste local inference exists to stop. `ai_enrich` is not in this skill's endpoint
set, and neither of its two legitimate reasons — Perplexity web grounding, batch scale —
arises here: a market count is not a web-research question, and the batch is a table you
can already read.

## Before anything else

Run the preflight and read the keys:

```bash
richapi-skills-preflight
```

Stop and fix before continuing if:

- `API_KEY_SET: no` — the user needs `richapi_API_KEY` exported. Planning still works
  without it and makes no calls, so offer the plan instead.
- `SUPPRESSION: STOP` — no readable suppression store. Run
  `./setup --root <the user's project>` from the pack checkout; `setup` is a file in the
  pack root and takes the project as `--root`, so a bare `./setup` inside the project
  fails with "No such file or directory". An account universe this skill cannot suppress
  is one it will not write.
- `CATALOG_OK: no` — regenerate with `richapi catalog gen`. Every price in the plan is
  read from `_lib/api-catalog.json` at plan time; none is carried in from a previous
  session and none is written into this document.

`BALANCE: unknown` is normal.
The balance comes only from a background probe of `GET /usage`.

## The one idea this skill is built on — a count is not a list

`linkedin_company_search()` returns a **total** next to the page it charged you for.
Page one's `pagination` block carries it, while its `x-pricing` bills on
`result_count_field: elements` (`openapi.yaml:2953`) — the elements *on that page*, not
the total the pagination block reports. The market size therefore rides along with one
page. Paging until the results run out buys the identical number at a hundred times the
price.

**Read `pagination.totalResultCount`, not `pagination.totalElements`.** They are
different numbers and only one of them is the market. `totalElements` is how many
results the API will *page through*, and it **saturates at 1000**: a recorded live
response for a search with 31,808 matching companies reported `totalElements: 1000`,
`totalPages: 20`, `totalResultCount: 31808`. Reading `totalElements` as the market size
therefore reports every market above a thousand companies as exactly a thousand — a
wrong number that looks plausible, is stable across re-runs, and is off by 30x here.
`totalResultCount` is live evidence and not in the pinned spec; it is in the recorded
response under `tests/fixtures/live/linkedin_company_search.json`, which is the source
this pack trusts for response shape (law 2). If a response carries no
`totalResultCount`, the total is `not_found` — do **not** fall back to `totalElements`,
and do not page to find out.

This is the ambiguity that kept `post_keyword_search` disabled until the spec settled
its bill on the page (`numberOfElements`) rather than the total. Here there is no
ambiguity: the billing field is named, and it is `elements`. `post_keyword_search` is
not used by this skill; tam-map sizes markets, it does not search posts by keyword. If a
future catalog regeneration ever shows `result_count_field: totalElements` on a search
in this set, that endpoint stops being a free count and becomes the most dangerous call
in the pack — stop and escalate rather than reasoning around it.

### Which of the seven give a total away

Read from the spec, not assumed. Only one of them does.

| Endpoint | Free total on page one? | What the response actually carries | Spec |
|---|---|---|---|
| `linkedin_company_search()` | **Yes** | `pagination.totalResultCount` (the market), plus `totalElements`/`totalPages`, which describe the pageable window and cap at 1000 | `openapi.yaml:2927-2930`; `totalResultCount` from the recorded live response |
| `directory_yellowpages()` | No | one page of businesses, no total anywhere | `openapi.yaml:898-900` |
| `google_maps_places_scraper_keyword()` | No | a bare array, bounded by `limit` | `openapi.yaml:1934-1937` |
| `google_maps_places_scraper_sync_using_url()` | No | place records, bounded by `limit` | `openapi.yaml:2059-2062` |
| `similarweb_scraper_sync()` | No | one domain's overview | `openapi.yaml:4237-4244` |
| `crunchbase_company_scraper_sync()` | No | one company profile | `openapi.yaml:827-836` |
| `find_website_by_company_name()` | No | one website | `openapi.yaml:1714-1716` |

Two traps in that table:

- **`totalVisits` on `similarweb_scraper_sync()` is not a result count.** It is monthly
  traffic for the domain you asked about. Nothing in a Similarweb response says how many
  companies exist.
- **`_list_count` is not a total either.** Four of these endpoints price on it, and it
  is the length of the list the call returned — a page, or a `limit` you chose. Reading
  it back as a market size means reporting your own request parameter as a finding.

So: **one counted source, six that must be priced honestly as something else.** That
asymmetry is the whole design of the steps below.

## Step 1 — turn the ICP into a segmentation, invent nothing

Read `gtm/icp.yaml` if it exists. A slot the ICP does not state is empty, not guessed.

`linkedin_company_search()` accepts exactly five filters and no others: `search_query`,
`location`, `geo_id`, `company_size`, `linkedin_industry_id`. Anything the ICP contains
beyond those cannot be expressed in the counted source, and the honest consequence is
that the counted number is **wider** than the ICP. Say which attributes were dropped and
in which direction that biases the figure — a TAM that quietly ignores half the ICP is
not conservative, it is wrong upward.

**Geographies are somebody else's endpoint.** `geo_id` overrides `location`, and
`location` is a LinkedIn autocomplete string the spec itself flags as ambiguous. The
endpoint that resolves a place name into a geo ID is owned by `/build-prospect-list`,
not by this skill. Two honest options, and no third:

- the user supplies the geo ID, or a run of `/build-prospect-list` already resolved it —
  use it, and the count is a count of that geography;
- nobody has resolved it — send the `location` string, and label every number derived
  from it as geographically ambiguous in the report. Do not present an ambiguous count
  as a measured one.

## Step 2 — plan marginals, not a grid

Every segment count costs one page. That makes the shape of the segmentation a spending
decision before it is an analytical one.

A full cross-tab of four industries by three size bands by three regions is thirty-six
page-one probes. The marginals (each axis counted on its own) are ten, and they answer
the question a first TAM pass is actually asking, which is *which axis moves the number*.
Plan the marginals, show the user which axis dominates, and buy the drill-down grid only
on the one cell they care about.

That shape is not left to taste. Page-one probes bought purely to read a total-count
field are capped per run by `gates.yaml:skills.tam_map.max_count_probes`. Read the key
before planning and note where the two shapes above fall against it: the full cross-tab
does not fit under it and the marginals do, which is the whole reason the marginals are
the default. A segmentation that genuinely needs more probes than the key allows is a
segmentation to narrow, not a key to raise. If the key does not resolve, no probe runs
at all — a missing gate reads as STOP.

Two more rules that keep the probe count down:

- **A segment that is a subset of one you already counted does not always need its own
  probe.** If the total for one industry is small, no size band inside it can be larger.
  Say so instead of buying the page.
- **The whole-market probe comes first.** One unfiltered count establishes the
  denominator, and every later probe is then a share of something rather than a number
  floating on its own.

## Step 3 — dry-run the probe plan, then buy exactly one page per probe

Never fire a search as the first action. Plan first; a dry run makes zero calls:

```bash
richapi search linkedin_company_search \
  --param search_query="<icp keywords>" \
  --param company_size="201-500" \
  --pages 1 \
  --dry-run
```

`--pages 1` is the entire difference between a count and a list purchase. The plan
prices a page from the catalog and states its basis for results per page, which is
`gates.yaml:unbounded_endpoints.assumed_results_per_page` unless you give a better hint
with `--page-size`.

Show the user the plan and read it with them:

- the per-probe price and the probe count, so the segmentation's shape is visible as a
  bill before it is approved;
- that each probe returns a total for the whole segment, not just the page bought;
- which probes are pure counts and which, if any, are the start of a list purchase.

Then get approval. The user approves the plan, not a number you said out loud.

### Reading the total back

The runtime does not yet surface a response's pagination envelope. `richapi search`
persists `_results`, `_page` and `_count` per page, so `--out` carries the rows and not
the total. The **full response body is written to the read-through cache**, so read
`pagination.totalResultCount` from:

```
gtm/enrichment-cache/linkedin_company_search.jsonl
```

That is the honest route today, and it costs nothing extra because the page was already
bought. It also has a real gap behind it, which this skill states rather than papers
over: **`richapi search` needs a count-only mode** — a verb that buys page one, reports
the response's total-count field, writes no list, and journals the probe as a count
rather than as a truncated search. Until that exists, say that the total was read out of
the cache file. Do not describe a flag the CLI does not ship.

### Never walk pages to reach a number the total already gave you

Extra pages on `linkedin_company_search()` buy **rows**, and rows are only worth buying
when the user wants the account list itself. When they do:

- page one runs on the approved plan and every page after it asks —
  `gates.yaml:unbounded_endpoints.pages_before_confirm`, because for a page-only
  endpoint a human between pages is the only real ceiling;
- `gates.yaml:unbounded_endpoints.hard_page_ceiling` stops the walk even if the user
  keeps confirming. Past it the answer is a narrower segment, not another page;
- a page that would cross `gates.yaml:session_budget.fractions.single_call_confirm` of
  the session budget asks on its own, however little has been spent so far;
- a missing gate key reads as STOP, never as "no gate".

`gates.yaml:unbounded_endpoints.hard_page_ceiling` is per endpoint, not per run, so on
its own it lets three separate searches each walk to it and triple the bill without a
single gate firing. The per-run ceiling that closes that hole is
`gates.yaml:skills.tam_map.max_pages_per_run`, which counts pages accumulated across
**all** searches in one map. Keep the running page count in front of the user in the
same breath as the running spend, and when the per-run ceiling is what stopped the walk,
the answer is a narrower ICP rather than a raised key. If either key does not resolve,
the walk is a STOP, never an unbounded run.

## Step 4 — the six sources with no total, priced for what they really are

### Local and SMB density: the two Maps endpoints

`google_maps_places_scraper_keyword()` and `google_maps_places_scraper_sync_using_url()`
have **no `page` parameter at all**. There is nothing to walk and nothing to count. Each
returns up to `limit` places (`openapi.yaml:1934-1937`, `openapi.yaml:2059-2062`) and
never says how many it could have returned.

The consequence has to be said plainly to the user, because it is the single most
tempting error in local TAM work: **you asked for a number of places and you got that
number of places; that is your request parameter coming back, not the size of the
market.** These endpoints characterise a market — what the businesses look like, how
many carry a website, what categories cluster — over a bounded sample. They cannot size
one.

Price them honestly by telling the plan how many results to expect:

```bash
richapi call google_maps_places_scraper_keyword \
  --param search_query="dental clinic" --param location_query="Austin, TX" \
  --param limit=50 --expect 50 --dry-run
```

Without `--expect`, a per-result endpoint is priced at
`gates.yaml:unbounded_endpoints.assumed_results_per_page`, which for a large `limit`
understates the bill — wrong in the direction that hides it.

### Yellow Pages: the cheapest page in the set, and the one booby trap

`directory_yellowpages()` is priced per result and is the least expensive per row of
anything this skill touches, which makes it the natural source for long-tail local
markets. It is page-gated in `_lib/gates.yaml` and it reports no total, so counting a
Yellow Pages market means walking until a page comes back short and reporting an
enumerated floor.

**`max_pages` must stay at its default.** The field (`openapi.yaml:884-887`) makes the
endpoint scrape several pages inside a single request. The runtime's page gate counts
requests, so one request with a raised `max_pages` walks an arbitrary number of pages
while `gates.yaml:unbounded_endpoints.pages_before_confirm` fires once and
`gates.yaml:unbounded_endpoints.hard_page_ceiling` counts one. That is a page-gated
endpoint with its page gate disabled from inside the request body. Paginate with `page`,
one request per page, and let the gate do its job.

The clamp that holds `max_pages` there is
`gates.yaml:skills.tam_map.directory_max_pages_per_request` — a structural clamp on a
request field, not a credit threshold, which is why it lives under this skill's
namespace rather than among the page-gate settings. Do not type the value into a
request; read the key. If it does not resolve, the Yellow Pages request is refused
rather than sent unclamped.

One more thing to expect and to report: the spec's example nests the results at
`data.businesses` (`openapi.yaml:898-900`) rather than as a top-level array. Recorded
fixtures, not the spec, are the authority on response shape — but if the live shape
matches the example, the runtime cannot read the page as a list of results and will note
that the page was paid for and unreadable. The charge is then estimated from
`gates.yaml:unbounded_endpoints.assumed_results_per_page` and the ledger row is
`estimated_unverifiable`. Pass that through to the user exactly as the receipt states
it; never round an unverifiable estimate into a confident actual.

### Lookalikes: `similarweb_scraper_sync()`

Priced per result and the dearest per unit in this skill's set. It takes one `domain`
and has no `page` and no `limit` — which is why `_lib/gates.yaml` records it as having
no bound of any kind. Note the spec contradiction while you are here: the description
says "one or more domains" (`openapi.yaml:4213`) while the request field is a single
required string (`openapi.yaml:4225-4229`). Send one domain.

It is not a counting tool and it does not measure a market — `similarSites` **grows**
the universe rather than sizing it, which is the opposite operation and must be labelled
that way in the report. Route it per domain through `richapi call`, never through
`richapi search`, and price each call as a single result:

```bash
richapi call similarweb_scraper_sync --param domain=stripe.com --expect 1 --dry-run
```

Because every domain is its own call, no page gate applies. The ceiling is cumulative:
`gates.yaml:session_budget.fractions.confirm` and
`gates.yaml:session_budget.fractions.stop`. Seed it from a handful of the user's best
customers, not from the whole account list.

### Funding overlay: `crunchbase_company_scraper_sync()`

Flat per call, bounded, and it takes a Crunchbase company URL. It **cannot discover
anything**: one URL in, one company out. It is an overlay on accounts that are already
named (funding stage, last round, headcount) applied to a subset the user has chosen,
never a source of the universe. Results are cached under
`gates.yaml:cache_ttl.endpoints.crunchbase_company_scraper_sync`, so a re-run over the
same accounts inside that window costs close to nothing; a `--no-cache` re-run pays for
all of it again.

### The join key: `find_website_by_company_name()`

Flat per call, one name in, one website out. Its job here is dedupe, not discovery — see
Step 5. Pay for it only on the rows that arrived without a website, which is most rows
from LinkedIn and almost none from Maps or Yellow Pages. Resolving a name that a cheaper
source already gave you a domain for is a credit spent to learn something you had.

## Step 5 — dedupe on the domain, never on the name

Four sources return four different identities: `linkedinUrl` / `universalName` / `id`
from LinkedIn, `website` from Maps and Yellow Pages, `Website` from Crunchbase, `domain`
from Similarweb. The only key they can all reach is the **normalised website domain**;
the LinkedIn company URL is the tiebreak for rows with no site at all.

Company *names* are not a key. "Acme Inc.", "Acme, Inc" and "ACME" are three rows in any
naive join, and a TAM inflated by punctuation is a TAM nobody can defend.

Normalisation itself belongs to `/list-hygiene`, which owns the domain-cleaning and
name-normalising utilities. Hand the merged file to it rather than re-implementing them
here; this skill's job is to say *which* key to join on and to report what the join did.

Then, in this order, before any figure is called addressable:

1. **Dedupe** across sources on the normalised domain, and record the overlap. The
   overlap is a finding: it tells the user how independent their sources are.
2. **Subtract the CRM exclusion list** — existing customers, open opportunities,
   disqualified accounts. Addressable market means the part still available.
3. **Filter through the suppression store at write time.** A suppressed record never
   reaches an output file, and this skill writes no file it cannot suppress.

Output goes to `gtm/lists/accounts/<name>.csv`, alongside `gtm/tam-report.md`.

## Step 6 — report, and label every number by how it was obtained

Three classes, never mixed and never summed across classes without saying so:

- **Counted** — a `pagination.totalResultCount` read from a source that reports one.
  Only `linkedin_company_search()` produces this, and only for the five filters it can
  express. A count taken from `totalElements` is not this class: that field caps at 1000
  and would report every large market as the same size.
- **Enumerated** — rows actually bought, deduped and written. This is a **floor** on the
  universe, never the universe, because it stopped where the page gate or the budget
  stopped it.
- **Estimated** — a sample multiplied by an assumption. Name the assumption and cite the
  gate key it came from, or the observed ratio it came from, on the same line as the
  number.

Rules the report follows:

- **A counted figure and an enumerated figure are not addable.** Until the domains are
  joined, the overlap between the LinkedIn universe and the Yellow Pages universe is
  unmeasured, so their sum is an upper bound and must be written as one.
- **A range stays a range.** Where the response carried no billing field the receipt
  gives a range; pass the range on rather than rounding it into one confident number.
  For the page-gated sources in this set that is the normal case, not the exception.
- **Say what was not bought.** How many segments were left unprobed, how many pages left
  unwalked, and what continuing would cost. A TAM that stopped at a gate is not a
  finished TAM and must not read like one.
- **Report source mix and coverage.** What fraction of the enumerated set carried a
  usable domain, per source. If that falls below `gates.yaml:quality_stops.coverage_min_pct`
  the list is not worth carrying into enrichment; say so and stop rather than spending
  the waterfall's price to discover the sources were thin.
- **A segment under the floor is not handed on as a segment.** Where a counted total
  falls below `gates.yaml:skills.tam_map.min_segment_size`, report it merged into its
  parent axis and say the floor was applied. A segment that small cannot carry a play,
  and splitting it out invites the pipeline to price one anyway. Never drop the rows
  silently, and never type the floor by hand — read the key, and if it does not resolve,
  say the segmentation could not be checked rather than publishing it unchecked.
- **Restate the ICP attributes the count could not express**, and the direction of the
  bias. This is the sentence that stops a wide number being quoted as a precise one.

Then hand off. An account universe is not a prospect list, and the people inside these
accounts are a separately planned and separately approved spend.

## What this skill will not do

- **It will not walk pages to reach a number a count field already gives.** Where a
  total is reported it is read from page one; where none is reported, the alternative is
  priced out loud and the user chooses.
- **It will not raise `max_pages` on `directory_yellowpages()`.** Scraping several pages
  inside one request is a page-gated endpoint with the page gate switched off from
  inside the request body.
- **It will not present a bounded sample as a market size.** The Maps endpoints return
  what you asked for; that is a parameter, not a measurement.
- **It will not resolve geographies.** Geo-ID resolution belongs to
  `/build-prospect-list`. Without a resolved ID the count is labelled ambiguous rather
  than quietly presented as precise.
- **It will not find people.** No titles, no seniority, no emails, no phones. This skill
  stops at the company.
- **It will not enrich.** Firmographics beyond what a search result carries, and every
  contact-level field, are `/enrich-waterfall`, priced and approved separately.
- **It will not write an account list it cannot suppress.** No readable suppression
  store means no run and no output file.
- **It will not call `ai_enrich`.** Its reasoning is local; see the inference-mode
  section.
- **It will not fabricate an actual.** Most of its sources never report their own
  charge; those rows stay `estimated_unverifiable` in the ledger and in the report.
- **It will not send, dial, or touch LinkedIn.** Sending execution, LinkedIn actions and
  dialling are permanently outside this pack, not pending.

## Recipes

Ready-made chains of this pack's skills for a common job. A recipe only names the
skills and their order; each skill still runs its own dry run, gates and approval, so
no step is priced here.

### icp-to-scored-list

```yaml recipe
name: icp-to-scored-list
job: >-
  An ICP description in; a sized market and a scored account and contact list, ready
  for CRM import, out
input: icp_text
steps:
  - icp-review
  - tam-map
  - build-prospect-list
  - list-hygiene
  - enrich-waterfall
  - evidence-score
  - crm-export
ends: deliverable
note: "Cleared for CRM, not for contact: run /comply and /campaign-review before any send."
```

**What this costs.** The count itself is one page of a company search — a base charge
per page plus a per-result charge on the rows that page returns — and that one page is
where the market total comes from. Everything after it (enrichment, scoring inputs)
bills per row you chose to keep. The floor is therefore one page per filter you ask
about; read the figures from the catalog at plan time.

Size first, enumerate second. Enrich a sample before the whole list, and ask before the rest.

### lookalikes-from-won-deals

```yaml recipe
name: lookalikes-from-won-deals
job: Closed-won accounts in; similar accounts and their buyers, ready for CRM import, out
input: won_accounts
steps:
  - icp-review
  - tam-map
  - build-prospect-list
  - crm-export
ends: deliverable
note: "Cleared for CRM, not for contact: run /comply and /campaign-review before any send."
```

**What this costs.** Same shape: one page of the company search per lookalike query,
billed as a base charge for the page plus a per-result charge on what it returns, then
per-row enrichment on the accounts you keep. Quote it from the catalog in the dry run —
the minimum is never zero, because the first page is the one that carries the total.

This is a filter match on what the won accounts share, not a lookalike model. Say so in the output.

## Related

- [`/icp-review`](../icp-review/SKILL.md) — the upstream anchor. `gtm/icp.yaml` is what
  this skill turns into a segmentation; a TAM built on an untested ICP sizes the wrong
  market precisely.
- [`/build-prospect-list`](../build-prospect-list/SKILL.md) — the people inside these
  accounts, and the owner of geo-ID resolution and every people-search endpoint.
- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — emails, phones and verification
  for whatever list comes out of the far end.
- [`/list-hygiene`](../list-hygiene/SKILL.md) — domain and company-name normalisation,
  which the dedupe in Step 5 depends on and this skill does not own.
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router, and the session-end receipt
  read from the real ledger.
- Ownership of every endpoint named here:
  [`_lib/endpoint-owners.yaml`](../../_lib/endpoint-owners.yaml). If an endpoint you
  want is owned by another skill, route to that skill rather than calling it here.
- Every threshold and its key: `richapi gates`.
- What is built and what is not: [`../../ROADMAP.md`](../../ROADMAP.md).
