---
name: local-business-prospecting
version: 1.0.0
description: >
  Sources brick-and-mortar and SMB prospects from maps and directories rather than from
  LinkedIn — "what and where" instead of "title and industry". Google Maps by keyword or
  by a Maps URL, Yellow Pages for the long tail, and review mining for the outreach hook.
  Every one of its endpoints is billed per result and none of them reports its charge, so
  the plan is the only place the bill is ever visible. Use when asked "find all dentists
  in Austin", "list of restaurants near", "local business list", "scrape Google Maps
  for", "businesses in <city> with <criterion>", or "SMBs with no website".
  (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write
triggers:
  - find all <category> in <location>
  - list of <category> near <location>
  - local business list
  - scrape google maps for
  - hyperlocal prospects
  - businesses in <city> with
  - smbs with no website
  - local lead list
---

# Prospect the high street, and price every page before you buy it

You are sourcing businesses that have an address and a phone before they have a
LinkedIn page. That changes the query — "dentists in Austin", not "VP Engineering at
501-1000" — and it changes the cost model completely. Every endpoint this skill owns is
billed **per result**, and **not one of them reports its charge back**. The plan is the
only place the bill is ever visible; after the call there is nothing to reconcile
against, forever.

So the discipline here is not "spend carefully". It is: **decide the number of results
before the request, tell the plan that number, and never let a request field
pre-multiply itself behind the gate.** Two specific ways that goes wrong are measured
below and both are refused.

## When this skill, and when the LinkedIn one

| The request | Skill |
|---|---|
| Carries a job title, seniority or function | [`/build-prospect-list`](../build-prospect-list/SKILL.md) |
| Carries a LinkedIn or Sales Navigator URL | [`/build-prospect-list`](../build-prospect-list/SKILL.md) |
| Is `<category>` in `<place>` with no people component | **this skill** |
| Wants rating, review count, hours or street address as evidence | **this skill** |
| Asks how big the local market is, rather than who is in it | [`/tam-map`](../tam-map/SKILL.md) |

If both apply ("dentists in Austin and their office managers") run this skill to
source the businesses, then hand the domains to `/build-prospect-list` for the people
layer. Sourcing accounts and sourcing people are separately planned and separately
approved spends.

The overlap with `/tam-map` is real and the split is by question, not by endpoint.
`/tam-map` asks *how many are there* and reads a total; this skill asks *who are they*
and buys rows. A count and a list are different purchases, and the same Maps endpoint
answers only the second one honestly — see the sample-is-not-a-market rule below.

## Inference mode — local only, zero LLM hops

**Mode: local inference. This skill never calls `ai_enrich`.**

Everything it reasons about is reading and sorting text that is already in context:
deciding that "Dr. Sarah Chen DDS" contains a person name and "Smile Bright Dental"
does not, spotting that three listings share a phone number and are one chain, reading
twenty reviews and naming the two complaints that repeat. The pack runs inside a model
that does all of that for free, and `ai_enrich` is not in this skill's endpoint set.

Neither of the two conditions that justify the paid hop arises. **Perplexity web
grounding** answers a question with no endpoint behind it; every fact here came from a
Maps or directory response with a source line attached. **Batch scale** is the one that
could plausibly arise (a review corpus large enough not to fit in one context) and
the honest answer is that the corpus is capped long before that point by the review
caps below, and that a genuinely list-scale freeform question belongs to
`/research-agent`, which owns that hop and the dual contract that validates its output.

## Before anything else

```bash
richapi-skills-preflight
```

Stop and fix before continuing if:

- `CATALOG_OK: no` — regenerate with `richapi catalog gen`. Every price in every plan
  below is read out of the generated catalog at plan time. No price is written into
  this document, and an earlier version of this skill carried four of them; all
  four were wrong by the time anybody checked.
- `API_KEY_SET: no` — a dry run still works, still makes zero calls, and still shows
  the whole plan. Offer that.
- `SUPPRESSION: STOP` — no readable do-not-contact store. This skill writes a contact
  list, and a list it cannot suppress is a list it does not write. Run
  `./setup --root <the user's project>` from the pack checkout; `setup` is a file in the
  pack root and takes the project as `--root`, so a bare `./setup` inside the project
  fails with "No such file or directory".

`BALANCE: unknown` is normal and not a blocker.
The balance comes only from a background probe of `GET /usage`.

## The four endpoints, and the one thing they all have in common

This skill owns the pack's maps-and-directories group and nothing else.

| Endpoint | Priced on | Bounded by | Charge in the response? | Spec |
|---|---|---|---|---|
| `google_maps_places_scraper_keyword()` | per result | `limit` in the request | **No** | `openapi.yaml:1934-1937` |
| `google_maps_places_scraper_sync_using_url()` | per result | `limit` in the request | **No** | `openapi.yaml:2059-2062` |
| `google_maps_reviews_scraper_sync()` | per result | `limit` in the request | **No** | `openapi.yaml:2117-2120` |
| `directory_yellowpages()` | per result | **nothing** — `page` walks | **No** | `openapi.yaml:880-887` |

Read the fourth column down. Every row says No. That is not a coincidence of this
table; it is what the generated catalog records for all four, and it has three
consequences that shape the rest of this page:

- **Every ledger line this skill writes is `estimated_unverifiable`** (law 4). The
  pre-call estimate is the only figure that will ever exist for these calls. It cannot
  be reconciled later, by anyone, ever.
- **The plan is the control, not the receipt.** On an endpoint that reports its charge
  you can be sloppy at plan time and correct afterwards. Here you cannot, so the plan
  is where the discipline has to live.
- **A range stays a range in the report.** Never round an unverifiable estimate into a
  confident actual because it reads better in a summary.

Three of the four are priced on `_list_count`, which is the length of the list the call
returned — a page, or a `limit` you chose. It is not a market size. Reporting it as one
is reporting your own request parameter back as a finding.

### The owners file has not caught up yet, and saying so is cheaper than drifting

`_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for which
endpoint, and today it does not mention this skill at all. It assigns
`directory_yellowpages`, `google_maps_places_scraper_keyword` and
`google_maps_places_scraper_sync_using_url` to `/tam-map`, and
`google_maps_reviews_scraper_sync` to `/account-research` by capability group — both
written before this skill existed. Those four are the whole
`maps_directories` group and this skill is the one built for them, so the transfer is
requested rather than assumed: the owners file is edited deliberately, not in passing, and a skill
that silently calls an endpoint it does not own is exactly the drift that file exists
to prevent.

Until the transfer lands, read the split by question. `/tam-map` uses the two Maps
endpoints to characterise a market and refuses to size one with them;
`/account-research` uses the reviews endpoint on a single named account. This skill
buys rows for a prospect list. Nothing here calls an endpoint outside those four.

## Trap 1 — `max_pages` is a page gate switched off from inside the request body

`directory_yellowpages()` is the cheapest row in the set and the only one with no bound
of any kind, which is exactly the combination that empties a budget quietly.

It takes **two** pagination fields (`openapi.yaml:880-887`):

- `page` — the page number, one page per request.
- `max_pages` — *"Maximum number of pages to scrape"*, applied **inside a single
  request**.

The runtime's page gate counts **requests**. One request with `max_pages` raised
scrapes an arbitrary number of pages while
`gates.yaml:unbounded_endpoints.pages_before_confirm` fires exactly once and
`gates.yaml:unbounded_endpoints.hard_page_ceiling` counts that whole walk as one. The
per-page human confirmation — which for a page-only endpoint is the *only* real ceiling
there is — never happens.

So, without exception:

- **`max_pages` stays at its default of one page per request.** No depth setting, no
  "just this once", no flag in this skill raises it.
- **Paginate with `page`, one request per page**, and let the gate see every page.
- **Stop when a page comes back short.** A short page is the end of the result set;
  the next request buys nothing and is still billed.

The pack holds this clamp as a value. `_lib/gates.yaml` carries
`gates.yaml:skills.tam_map.directory_max_pages_per_request` for the identical reason on
the identical endpoint; that key is scoped to `/tam-map`, so this skill reads its own,
`gates.yaml:skills.local_business_prospecting.directory_max_pages_per_request`.
**A missing gate key reads
as STOP, never as "no gate"** (law 5) — so if a runtime clamp ever refuses a Yellow
Pages request because a key did not resolve, that is the system working and the fix is
the key.

```bash
# One page. One request. The gate sees it.
richapi search directory_yellowpages \
  --param search_query="plumber" --param location="Austin, TX" \
  --pages 1 --dry-run
```

Two more things about this endpoint that the plan should say out loud:

- Its documented example nests the rows at `data.businesses` (`openapi.yaml:898-900`)
  rather than as a top-level array. Recorded fixtures, not the spec, are the authority
  on the live shape — but if the live shape matches the example, the runtime cannot
  read the page as a list of results and will report that the page was paid for and
  unreadable. The charge is then estimated from
  `gates.yaml:unbounded_endpoints.assumed_results_per_page` and the ledger row is
  `estimated_unverifiable`. Pass that through exactly as the receipt states it.
- There is no per-run page ceiling scoped to this skill yet, so
  `gates.yaml:unbounded_endpoints.hard_page_ceiling` is currently the only ceiling and
  it is per endpoint rather than per run. Keep the running page count in front of the
  user in the same breath as the running spend.

## Trap 2 — the bill scales with `limit`, and the plan does not know that

The three Maps endpoints have **no `page` field at all**. There is nothing to walk;
`limit` is the whole control, and the bill is `limit` multiplied by the per-result
price. That sounds safe. It is not, because of how the plan is priced.

A per-result endpoint cannot be priced without a result count, and when the caller
gives no hint the runtime uses
`gates.yaml:unbounded_endpoints.assumed_results_per_page` as its stated basis. The
runtime infers a count from the request only when the request itself *carries the list
being charged for* — an array of identifiers. `limit` is a scalar, so it is **not**
inferred. A Maps call with a large `limit` and no hint is therefore planned at the
assumption and billed at the limit, and the error is in the direction that hides it:
the plan the user approved is smaller than the invoice.

The fix is one flag, on every Maps call, every time:

```bash
richapi call google_maps_places_scraper_keyword \
  --param search_query="dental clinic" --param location_query="Austin, TX" \
  --param limit=50 --expect 50 --dry-run

richapi call google_maps_places_scraper_sync_using_url \
  --param google_map_search_url="<the user's own filtered Maps URL>" \
  --param limit=50 --expect 50 --dry-run
```

**`--expect` must equal `limit`.** Not a guess at the hit rate, not the number of rows
you hope to keep after filtering — the number the endpoint is allowed to return, which
is the number you will be charged for whether you keep them or not. Filtering happens
after the money is spent.

Two consequences worth saying to the user before they pick a number:

- **`limit` is a spending dial, not a quality dial.** Doubling it doubles the bill and
  does not improve the top of the list; Maps returns its own ordering either way.
- **What comes back is your parameter, not the market.** You asked for that many places
  and you got that many places. If the question was "how many dentists are there in
  Austin", this skill cannot answer it and `/tam-map` explains why.

Route these through `richapi call`, never `richapi search`. There is no page parameter,
so a paged search over them is a fabricated page walk.

## Step 1 — fill the slots, ask only for what is missing

| Slot | Example | Required | Where it goes |
|---|---|---|---|
| category | `dentist`, `coffee shop`, `law firm` | yes | `search_query` |
| place | `Austin, TX`, `Brooklyn, NY`, a ZIP | yes | `location_query` / `location` |
| how many | the number of listings to buy | yes — it is the bill | `limit` / pages |
| a Maps URL the user built | a zoomed, filtered Maps search URL | no | switches to the URL endpoint |
| quality filter | min rating, min review count, "no website" | no | applied free, after |
| language / country | | no | Maps honours it in the query text |

Two rules about the slots:

- **"How many" is not optional and has no default in this skill.** It is the only slot
  that is a spending decision, so it is asked rather than assumed. A skill that
  defaults it is a skill that spends a number nobody chose.
- **A pasted Maps URL beats a keyword.** If the user has already zoomed, sorted and
  filtered in the Maps UI, `google_maps_places_scraper_sync_using_url()` preserves
  exactly that; re-deriving it from a keyword throws their filtering away and pays for
  a different set of rows.

## Step 2 — dry-run the whole sourcing plan, then take one approval

Never make the first call the first action. Every paid call goes through the gated
runtime, which prices the plan from the catalog, evaluates the gates against the plan,
journals before and after each call, writes a ledger line, and reads the cache first.
`--dry-run` makes **zero calls**.

Read the plan with the user, and say four things:

- **The result count, per source, and that it is what is billed.** Not the row count
  they will keep after filtering.
- **Which totals are exact and which are a basis.** A Maps call with `--expect` equal
  to `limit` has an exact planned total. A Yellow Pages walk is a per-page estimate
  built on `gates.yaml:unbounded_endpoints.assumed_results_per_page`, and the honest
  phrasing is a range with the basis named.
- **That none of these four lines can ever be verified afterwards.** Mark them on the
  plan, not in the receipt.
- **What the cache already covers.** Maps and directory results resolve through
  `gates.yaml:cache_ttl.capability_groups.maps_directories`, which is one of the longer
  classes in the file — a high street does not turn over weekly. A second pass over the
  same city inside that window is largely a cache read and the plan shows it as skipped
  and not charged. An endpoint with no cache entry resolves to the shortest TTL, never
  the longest.

Then take **one approval for the whole plan**, not a nod per call. The gates still fire
inside the run and cannot be pre-approved away: the page gate on Yellow Pages, the
cumulative fractions at `gates.yaml:session_budget.fractions.confirm` and
`gates.yaml:session_budget.fractions.stop`, and a single call large enough to cross
`gates.yaml:session_budget.fractions.single_call_confirm` asking on its own however
little the session has spent. That last one is the one that catches a mistyped `limit`
on call number one.

## Step 3 — filter and dedupe for free, before anything else is bought

Everything in this step costs nothing and every credit it saves is a credit not spent
on a row that was never going to be contacted. Do it before any enrichment is planned.

- **Dedupe on phone, then on street address.** A chain lists every branch separately,
  and a list padded with the same business eleven times is not a bigger market. Company
  *names* are not a key — "Acme Inc.", "Acme, Inc" and "ACME" are three rows in a naive
  join.
- **Apply the quality filter the campaign actually implies.** High rating plus a real
  review count for a normal SMB play; the *inverse* (low rating) when the pitch is
  "we can fix your reviews", where an unhappy business is the target rather than the
  noise. Say which direction was applied.
- **`website` empty is a segment, not a defect.** It is the entire prospect list for a
  web-design or SEO offer, and it is the segment that will cost most to enrich.
- **Say how many rows each filter removed.** Never drop rows silently. A user who
  approved a plan for a number of listings and receives a fraction of that needs to see
  where the rest went, or the next plan gets sized wrong.

Domain and phone normalisation are real dependencies of this step and they belong to
[`/list-hygiene`](../list-hygiene/SKILL.md), which owns those utility endpoints. Hand
the file over rather than re-implementing them here, and never call them from this
skill.

## Step 4 — review mining, which is where a local budget actually dies

`google_maps_reviews_scraper_sync()` is the most useful thing in this skill and the
easiest way to spend everything. It bills per review returned, and the multiplier is
the one people forget: **reviews per place times number of places.** A modest-looking
per-place cap across a whole sourced list is a different order of magnitude from what
the operator has in their head.

So it is planned as a second, separate, explicitly approved pass:

1. **Never on the full list.** Reviews run on a shortlist the user picked from the
   sourced rows, and the shortlist is named before the number of reviews is chosen.
   An earlier version of this skill defaulted to running reviews across every place; that
   is the single most expensive mistake available on this page.
2. **Both caps are the operator's, and both are shown in the plan** — reviews per
   place (`gates.yaml:skills.local_business_prospecting.max_reviews_per_place`) and how
   many places (`gates.yaml:skills.local_business_prospecting.max_places_per_run`). The
   bill is the PRODUCT of the two, so the plan shows the product, never one factor. Both
   are ceilings the operator may lower and never silently raise, and neither is ever
   inferred from the sourced row count. A cap that nobody approved is not a cap.
3. **`--expect` equals `limit` here too**, and `limit` is per place, so the plan shows
   the product and not the per-call figure.
4. **Sort deliberately.** `review_sort` takes exactly `mostRelevant`, `newest`,
   `highestRanking` or `lowestRanking` (`openapi.yaml:2121-2125`). For a "we can fix
   this" pitch, `lowestRanking` first — the complaints are the hook. For credible
   flattery, one small `highestRanking` pass. Two passes over the same place are two
   bills.

**5. Use the `url` the listing gave you, and probe it before you buy a pass.**
Two live trials disagreed about which URL shape this endpoint answers, so it was
settled by measurement on 2026-09-17, one review per probe:

| URL passed as `google_map_review_url` | Answer |
| --- | --- |
| the listing's own `url` (`/maps/search/?api=1&query=<name>&query_place_id=<id>`) | HTTP 201, **1 review** |
| `/maps/search/?q=place_id:<placeId>` | HTTP 201, **empty array** |
| `/maps/place/<Name>/@lat,lng` | HTTP 201, **empty array** |

So pass the listing's `url` straight through. The failure mode that matters is the
silent one: a wrong shape answers **HTTP 201 with an empty array** — zero reviews, no
error, no warning, and a bill. Nothing tells you whether it was the URL or a business
with no reviews.

**Probe one review before buying the pass.** `limit=1` costs a single result and
answers the only question that matters: does this URL return anything at all? A place
that answers zero on the probe is either genuinely reviewless or wrongly addressed, and
either way the full pass would spend on nothing.

```bash
richapi call google_maps_reviews_scraper_sync \
  --param google_map_review_url="<the listing's url column>" \
  --param limit=1 --expect 1 --dry-run
```

Then the real pass, once the probe came back with a review:

```bash
richapi call google_maps_reviews_scraper_sync \
  --param google_map_review_url="<the listing's url column>" \
  --param limit=25 --param review_sort=lowestRanking \
  --expect 25 --dry-run
```

The listing also carries `placeId` (`ChIJ…`, recorded in
`tests/fixtures/live/google_maps_places_scraper_keyword.json`), which Step 6 writes into
the output as provenance. It identifies the place; it is not what this endpoint reads.

A row with no `placeId` cannot be review-mined at all. Say so and skip it, rather than
sending its `url` and paying for an empty answer.

What to take out of the reviews, per place: the complaints that repeat, one specific
thing the business is praised for, and whether the owner replies. That last one is the
strongest signal in the set (an owner who answers reviews answers vendors), and it is
free once the reviews are bought.

## Step 5 — hand off everything that is not a map or a directory

The rows that come back carry a name, an address, a phone, a category, a rating and
sometimes a website. Everything past that is another skill's endpoint and another
skill's approved spend. Naming the dependency is required; calling it from here is not
allowed.

- **A missing website, resolved from the business name** — enrichment, and it belongs
  to [`/enrich-waterfall`](../enrich-waterfall/SKILL.md). Pay for it only on the rows
  that arrived without one.
- **Emails, verification and email-type classification** —
  [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) and
  [`/list-hygiene`](../list-hygiene/SKILL.md).
- **Tech stack and what the site says** —
  [`/account-research`](../account-research/SKILL.md).
- **Phone and domain normalisation** — [`/list-hygiene`](../list-hygiene/SKILL.md).
- **Ranking the rows once they are enriched** —
  [`/evidence-score`](../evidence-score/SKILL.md).

**Personal email addresses are not part of local outreach here.** A local business
publishes a business address on purpose; reaching past it to a personal inbox is a
consent question this skill does not answer and an endpoint it does not own. If a user
asks, route them to [`/comply`](../comply/SKILL.md) and let that skill decide.

## Step 6 — write the list, and write it suppressed

Output is `gtm/lists/local/<category>-<place>.csv`, alongside a short
`gtm/lists/local/<category>-<place>.md` that says how it was built.

- **The suppression store filters at write time.** A suppressed record never reaches an
  output file (law 5), and if the store is unreadable this skill writes nothing.
- **`gtm/` is PII** (law 7) — gitignored, TTL-swept, erasable. That applies here even
  though most of these fields are business contact details, because for a sole trader
  the business phone *is* a personal phone and this skill cannot tell the difference.
- **Every row carries its source.** The place id (`placeId`) and the source URL go in
  the file, in their own columns. `placeId` is not decoration: it is the only input the
  reviews endpoint accepts (Step 4), so a row that loses it cannot be review-mined
  later. A wrong row is debuggable and a stale row is detectable. A row whose provenance was
  dropped is a claim with no source line behind it (law 6).
- **A gap is written, never omitted.** `not_found` when the call ran and the field was
  not there, `not_verifiable` when something came back that nothing can confirm,
  `not_applicable` when the question does not apply to that business. Those three, and
  no synonyms — they are the explicit null enum the pack validates against. A field
  silently left out reads as "not checked", and the operator cannot tell that from
  "checked and empty".

## Step 7 — report honestly

Read the receipt the runtime prints and pass on what it says.

- **Every line in this run is an estimate.** All four endpoints omit the billing field,
  so the receipt gives a range and the range is what you report. Never average it,
  never round to the ceiling, never call the ceiling "roughly what it cost".
- **Report the funnel, not just the survivors.** Listings bought, rows kept after
  dedupe, rows kept after filtering, rows with a usable website. The drop from the
  first to the last is what tells the user whether the next city is worth sourcing.
- **Compare the usable fraction against
  `gates.yaml:quality_stops.coverage_min_pct`** and say plainly when the list is too
  thin to carry into enrichment. Stopping there is cheaper than discovering it after
  the waterfall has run.
- **Say what was not bought.** Pages left unwalked, places left un-reviewed, and what
  continuing would cost. A list that stopped at a gate is not a finished list and must
  not read like one.
- **Say what a second pass would cost.** Usually much less, because of the directory
  cache TTL. That sentence is what turns a one-off city into a repeatable motion.

## What this skill will not do

- **It will not raise `max_pages` on `directory_yellowpages()`.** Scraping several
  pages inside one request is a page-gated endpoint with its page gate switched off
  from inside the request body, and no setting in this skill turns that on. It
  paginates with `page`, one request per page.
- **It will not call a per-result Maps endpoint without `--expect`.** An unhinted
  per-result call is priced at an assumption and billed at the `limit`, and the error
  hides itself by making the approved plan smaller than the invoice.
- **It will not present a bounded sample as a market size.** What comes back is the
  `limit` that was requested. Sizing the market is `/tam-map`, and it explains why
  these endpoints cannot do it.
- **It will not run review mining across a whole sourced list.** Reviews are a second
  pass over a named shortlist with both caps shown and approved. This is the most
  expensive mistake on the page and it is refused rather than warned about.
- **It will not default the number of listings.** The one slot that is a spending
  decision is asked, never assumed.
- **It will not fabricate an actual.** None of its four endpoints reports its charge,
  every ledger row is `estimated_unverifiable`, and that word reaches the user
  unchanged.
- **It will not enrich, verify or normalise.** Websites, emails, phone formatting,
  domain cleaning, tech stack and scoring belong to the skills that own those
  endpoints, each with its own plan and its own approval.
- **It will not reach for a personal email address.** Local outreach uses the address
  the business published. Consent and lawful basis are `/comply`'s question, not this
  skill's.
- **It will not find people.** No titles, no seniority, no committee. It stops at the
  business.
- **It will not write a list it cannot suppress.** No readable suppression store means
  no output file.
- **It will not send, dial, SMS or touch LinkedIn.** Sending execution, LinkedIn
  actions, dialing and direct mail are outside this pack permanently — which matters
  more here than almost anywhere, because local outreach is where somebody will ask for
  the dialer.

## Recipes

Ready-made chains of this pack's skills for a common job. A recipe only names the
skills and their order; each skill still runs its own dry run, gates and approval, so
no step is priced here.

### local-business-outbound

```yaml recipe
name: local-business-outbound
job: >-
  A business type and a place in; a ranked list of local businesses with the contact
  details the listings actually carry, and a pitch grounded in their reviews, out
input: maps_query
steps:
  - local-business-prospecting
  - list-hygiene
  - enrich-waterfall
  - evidence-score
ends: deliverable
```

**What this costs.** The listing walk is charged per page, and the review pass is
charged per business you mine, so the floor is one page and the rest is a choice. The
waterfall's address hops bill on the attempt, not on the find, which on a list of
businesses is exactly where money goes missing. Price all three from the catalog at plan
time, on the row count you actually intend to keep.

**This recipe does not reach a send, and it used to claim it did.** A maps listing
carries a name, an address, a phone number and sometimes a website. It carries **no
email address and no named person**, and a live run proved the consequence: the chain
ran to `/launch` and had nothing to export. `/enrich-waterfall` looks up *people* — its
email lookup needs a LinkedIn profile URL, or a first and last name plus a company
domain — and a listing row has neither, so the dry run shows that lookup as not
attempted on every row. Review mining is opt-in and priced like every other pass.

What the waterfall can do for these rows is two things, and **only one of them is a
`richapi enrich` hop**:

1. **Verify an address the listing already published** — a row that arrived with an
   `email` column goes through the verifier, inside `richapi enrich`, in the plan.
2. **Scrape the addresses a business publishes on its own website** — `web_emails`,
   which is a **direct `richapi call`, not a waterfall hop**. `richapi enrich` has no
   such step and `--dry-run` will never plan one; a live run looked for it and found
   nothing. [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) owns the endpoint and
   now documents the call, including that it is flat-priced per call and billed on the
   empty answer it frequently returns. Run it per row, on the rows that carry a
   `website`, and approve it separately from the enrich plan.

Both miss often, and neither invents a named contact. What `web_emails` finds is a
business inbox (`info@`, `bookings@`) not a person.

So the deliverable is a ranked list of businesses with the channels that exist — phone,
address, website — and the hand-off is explicit, not implied:

- **A generic published address is a business inbox, not a person.** It can be
  sequenced, but it is a different message and a different consent question; hand it to
  [`/comply`](../comply/SKILL.md) (`CHANNEL=email`) before anyone writes to it. A US
  row needs a `sender_postal_address` column to clear that channel (CAN-SPAM
  15 U.S.C. 7704(a)(5)); it is a precondition, so fill it and re-run.
- **To reach a named person at these businesses, the list goes through
  [`/build-prospect-list`](../build-prospect-list/SKILL.md) first.** Once rows carry a
  person and a domain, they re-enter the pack as an ordinary contact list and run the
  full gate chain — `/personalize`, `/sequence-builder`, `/comply`, `/campaign-review`,
  `/launch` — with its own approval.
- **Otherwise the honest use of this deliverable is a call list**, and it gets its own
  clearance. The phone number is the channel the listing actually gave you, so run
  [`/comply`](../comply/SKILL.md) with `CHANNEL=phone`: the e-mail preconditions — a
  working unsubscribe, a physical postal address — are not in play, and a verdict that
  clears `phone` says so. Until this was per-channel, a call list could not clear
  anything, because it was being asked for the footer of an email nobody was sending.
  Two things follow, and both are the point rather than a caveat:
  - **A US call list still stops**, on `no_rule_set_for_channel:phone`. CAN-SPAM is an
    e-mail statute and this pack ships no TCPA, DNC or telemarketing rule set. The fix
    is not a column; it is a rule set, or a human who owns that call.
  - **A phone clearance cannot become a sender export.** `/launch` writes e-mail files
    and refuses it. That is the gate working, not a bug to route around.
  Say that rather than shipping a send sequence with nothing to send to.

## Related

- [`/build-prospect-list`](../build-prospect-list/SKILL.md) — the people inside these
  businesses, and every people-search endpoint. Source here, escalate there.
- [`/tam-map`](../tam-map/SKILL.md) — how many are there, rather than who they are. It
  owns the counted source and shares the `max_pages` refusal above.
- [`/list-hygiene`](../list-hygiene/SKILL.md) — phone and domain normalisation, dead
  domains, and the suppression pass this skill's output must survive.
- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — verification of published
  addresses, and email lookup for rows that carry a named person.
- [`/evidence-score`](../evidence-score/SKILL.md) — ranking the rows once the reviews
  and the web signals are in.
- [`/comply`](../comply/SKILL.md) — lawful basis, consent records and erasure for a
  list of small businesses.
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router, and the session-end receipt
  read from the real ledger.
- Ownership of every endpoint named here:
  [`_lib/endpoint-owners.yaml`](../../_lib/endpoint-owners.yaml). If an endpoint you
  want is owned by another skill, route to that skill rather than calling it here.
- Every threshold and the key it came from: `richapi gates`.
