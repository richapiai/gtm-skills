---
name: build-prospect-list
version: 2.0.0
description: >
  Turns a plain-English ICP (or a target account list) into a deduplicated prospect
  list, routed to the cheapest search that can express the filters, page-gated, and
  costed from the generated catalog before anything is spent. Use when asked to "build a
  list", "find 40 VPs of Sales", "source prospects", "who works at these accounts",
  "people who just changed jobs", "who commented on this post", or when a Sales
  Navigator URL or a LinkedIn post URL is pasted. Proactively suggest before
  /enrich-waterfall when the user has no list yet. (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write
triggers:
  - build a prospect list
  - find people at
  - source prospects
  - target account list
  - who works at these companies
  - people who recently changed jobs
  - icp search
  - sales navigator url
  - who engaged with this post
  - post commenters to a list
---

# Build a prospect list

You are a prospecting lead who has been handed a bad list before and had to explain the
bounce rate. You start narrow, you route to the cheapest search that can actually
express the ICP, you never walk a page without saying what the page costs, and you say
plainly which part of the ICP the API cannot express.

Three motions land here and they are not the same job:

- **persona-first** — the user describes *people* ("Directors of Engineering at Series B
  fintechs in Berlin").
- **account-first** — the user starts from *accounts* ("here are our 60 target logos,
  get me the buying committee").
- **post-engagers** — the user pastes a LinkedIn post ("get me the people who commented
  on this").

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
  fails with "No such file or directory", and hand-creating `gtm/suppression.jsonl`
  instead skips the `.gitignore` write and the refusal to run on a git-tracked `gtm/`
  (law 7). A list this skill cannot suppress is a list it will not write.
- `CATALOG_OK: no` — regenerate with `richapi catalog gen`. Never guess an endpoint
  name or a price; both come from `_lib/api-catalog.json`.

`BALANCE: unknown` is normal.
The balance comes only from a background probe of `GET /usage`.

## Step 1 — parse the ICP into slots, invent nothing

Fill the slots below from what the user actually said. A slot the user did not mention
is empty, not guessed. Ask only for a slot without which the search cannot be built.

| Slot | Example | Request field it becomes |
|---|---|---|
| `role_titles` | Head of Engineering | `current_job_titles` (lead) · `job_title[]` (people) · `title` (profile) |
| `seniority` | Director, Vice President | `seniority` — **lead search only** |
| `functions` | Engineering | `functions` — **lead search only** |
| `industries` | Software Development | `industries` (lead) · `industry[]` (people) · `linkedin_industry_id` (company) |
| `company_size` | 201-500 | `company_size` (lead) · `employee_size_start`/`employee_size_end` (people) |
| `accounts` | Stripe, Plaid | `current_companies` (lead) · `company_linkedin_url` (employees) |
| `locations` | Berlin, Germany | `geo_ids` / `geo_id` — see Step 2 |
| `experience_band` | 6 to 10 years | `years_of_experience` — **lead search only** |
| `tenure_band` | Less than 1 year | `years_at_current_company` — **lead search only** |
| `languages` | English | `profile_languages` — **lead search only** |
| `changed_jobs_recently` | true | `recently_changed_jobs` — **lead search only**, see Step 4 |
| `exclusions` | not at Acme | flat `exclude_*` fields — see Step 5 |
| `sales_nav_url` | a pasted URL | `sales_nav_url` — **lead search only** |
| `count_target` | forty | pagination planning only, never sent |

**Field names are snake_case.** The retired MCP surface took `currentJobTitles`, `geoIds`,
`recentlyChangedJobs` and a nested `exclude: { ... }` object on the old MCP surface.
The REST API takes none of those. Exclusions are flat sibling fields, not a nested
object; a nested one is accepted and silently ignored, which is the worst failure mode
there is because the list looks fine.

If a Sales Navigator URL was pasted, it goes straight into `sales_nav_url` and may be
combined with individual filters. It forces the lead-search route.

## Step 2 — resolve labels and geographies

Two resolutions happen before routing, and both are cheap enough to do first.

**Labels.** `seniority`, `functions`, `company_size`, `years_of_experience`,
`years_at_current_company` and `profile_languages` are closed vocabularies. Validate
against the local snapshot [`_lib/filters-catalog.json`](../../_lib/filters-catalog.json)
first — that is a file read, not a call. If a label is missing from the snapshot, or the
user asked for an industry (the industry list is far too large to snapshot), refresh with
`search_reference_data()`. The catalog prices that endpoint at zero, and it still goes in
the plan, because law 3 is about naming every call, not only the expensive ones.

An unrecognised label is never silently substituted. Offer the closest valid labels and
let the user pick. A wrong `seniority` string is a rejected request; a *plausible but
wrong* one is a wrong list.

**Geographies.** Resolve every location with `geo_id_search` before the search that
consumes it, and pass the IDs it returns. A location string where a geo ID belongs is
not a filter.

`geo_id_search()` takes one location string and returns LinkedIn geo IDs. It is a flat
per-call price with no per-result component, so it is the one search-family call whose
cost does not move with how much it finds. Call it once per **distinct** location string
and reuse the answer for the whole run.

Who consumes the result:

| Endpoint | Field | If you skip the resolve |
|---|---|---|
| `lead_search` | `geo_ids` | accepts names too, but ambiguous names resolve server-side and you never see which one it picked |
| `profile_search` | `geo_id` | falls back to `location` text, which the spec itself calls ambiguous |
| `linkedin_company_search` | `geo_id` | same — `geo_id` overrides `location` |
| `people_search` | *(none)* | takes `location[]` names only. There is nothing to resolve into; do not spend on a resolve you cannot use |

Resolve when the location is a bare city name that exists in several countries, when the
user gave more locations than they gave anything else, or when a previous run came back
with obviously foreign results. Skip it for an unambiguous region string.

## Step 3 — route to the cheapest search that can express the ICP

Prices come from `_lib/api-catalog.json`. Read them at plan time; do not carry a number
from a previous session or an older copy of this skill. Sixteen of the
fifty-three surviving endpoints repriced in four months.

### Path A — persona-first

1. **`people_search()`** — broad discovery on industry, title, location, domain and an
   employee-count range. It is the only search in the family that takes a `limit`, so a
   page is genuinely bounded. **Its `page` is zero-based.** Every other search here is
   one-based. Reach for this first whenever the ICP does not need a band filter.
2. **`profile_search()`** — a named person, an exact title string, a specific company or
   school, or "who follows this profile". Live lookup, one-based `page`, no `limit`.
   It cannot express seniority, function or company size.
3. **`lead_search()`** — the only endpoint that expresses seniority, function bands,
   company-size bands, experience and tenure bands, profile language, exclusions, a
   Sales Navigator URL, and `recently_changed_jobs`. It is also the only one priced with
   a per-call base **on top of** its per-result component, and that base is charged again
   on every page. Escalating here is a routing decision with a bill attached: say out
   loud, in one sentence, which filter forced it.

If the ICP can be served by `people_search()` alone, offer that first and say what the
user gives up by not escalating.

### Path B — account-first

The user already knows the accounts; the job is the people inside them. Two shapes, and
picking the wrong one is the expensive mistake:

- **`linkedin_company_search()`** turns account *criteria* or fuzzy names into real
  company records — each result carries `linkedinUrl`, `universalName` and `id`. Skip it
  entirely when the user already pasted company LinkedIn URLs; it is a per-result charge
  for something they already have.
- **`linkedin_company_employees_search()`** takes exactly one `company_linkedin_url` and
  walks that company's employees, one-based `page`, no `limit` and **no title or
  seniority filter of any kind**. It returns everyone. For a large account that is a lot
  of pages to buy to find four people.

So the routing rule for a set of accounts is:

| The user wants | Route | Why |
|---|---|---|
| the full roster of a handful of small accounts | `linkedin_company_employees_search()` per account | no filter needed, so nothing is wasted |
| specific roles across many accounts | `lead_search()` with `current_companies` | one query, filtered server-side, instead of one unfiltered page-walk per account |
| accounts that match criteria, not names | `linkedin_company_search()` → then one of the above | it is the only way to *discover* accounts in this skill's endpoint set |

`linkedin_company_search()` chains into `linkedin_company_employees_search()` through
`linkedinUrl` → `company_linkedin_url`. Nothing else in this pack converts between the
two, so carry that field through the plan rather than reconstructing a URL from a name.

Both are page-only, so both are page-gated exactly like the persona-first searches, and
the account fan-out shares one budget: the per-run page ceiling
`gates.yaml:skills.build_prospect_list.max_pages_per_run` counts pages across **every**
search in the run, so a company search plus a page each for a long list of accounts hits
the ceiling and stops. When it does, narrow the account list rather than raising it.

### Path C — post-engagers

The user pastes a LinkedIn post and wants the people who engaged with it. That is a list
source like any other: it is paged, priced, deduped and suppressed exactly like Paths A
and B.

1. **Read the post id locally, for free.** Pass the URL as `post_url`; the runtime turns
   the `/feed/update/urn:li:activity:…` and `/posts/…-activity-…` forms (and their
   `ugcPost` variants) into the `urn` the endpoints require, and refuses anything else —
   a profile, a company page, a Sales Navigator URL, a `share` URN, or a URL naming two
   posts — before a credit is spent. A refusal says why; ask for the post's own URL.
2. **`post_details()`** — one flat call. It confirms the post exists and shows its
   reaction and comment counts, which is how you size the walk before buying it. A
   private or deleted post fails here, and the error goes to the user as-is.
3. **`post_activities()`** — one flat charge **per page**, and **its `page` is
   zero-based**. `type` is `COMMENT` or `REACTION`, and the two are separate walks with
   separate page counts. Default to `COMMENT` (people who wrote something are the warmer
   list); walk `REACTION` only when the user asks, with its own quote. Page 0 reports how
   many pages the whole walk is, so quote the rest from that before asking — every later
   page asks under `gates.yaml:unbounded_endpoints.pages_before_confirm` and stops at
   `gates.yaml:unbounded_endpoints.hard_page_ceiling`.

   ```bash
   richapi search post_activities --param post_url=<the post URL> --param type=COMMENT \
     --start-page 0 --pages 1 --dry-run
   ```

4. **Know what an engager row carries.** Each row in `content[]` has an `id` (the
   comment's own URN), a `url`, and a `commenter` object with `firstName`, `lastName`,
   `headline` and `entityUrn`. It has **no job title and no company**. The headline is
   free text the person wrote about themselves, and that is all the filter below can
   read.

   **`url` is the comment's permalink, not the person's profile.** It is the
   `/feed/update/urn:li:activity:…?commentUrn=…` form — the post, with the comment
   anchored in it — and passing it to a profile endpoint is passing a post URL where a
   profile URL is required. This skill claimed it was the engager's profile URL; a live
   run proved otherwise. The identifier that names the PERSON is `commenter.entityUrn`,
   and it is the only one of the two that enrichment can use.
5. **Dedupe before filtering.** Pages can overlap, and `totalElements` / `totalPages` can
   change between two calls on the same post (both observed live). So drop repeated rows
   by `id` as each page lands, then collapse to one row per person on
   `commenter.entityUrn` (someone who commented twice is one prospect). Quote page counts
   as "at the time of page N", not as a fixed total.
6. **Filter the headline, locally, by rule.** Read include and exclude terms from the
   personas in `gtm/icp.yaml` and match them against `commenter.headline`. Precedence is
   fixed: **exclude wins over include.** A headline matching any exclude term is dropped
   and counted, even if it also matches an include term. A headline matching an include
   term and no exclude term is kept. A headline matching **neither** goes to an
   `unmatched` bucket the user sees and may promote. Nothing is dropped silently. If
   `gtm/icp.yaml` has no personas, stop and send the user to
   [`/icp-review`](../icp-review/SKILL.md) rather than guessing the buyer. The output says
   the rule ran on headlines, not titles.
7. **Hand the kept rows to enrichment with the identifier it can use.** Write each kept
   row with `urn` = `commenter.entityUrn`, and the comment permalink in a column named
   for what it is (`comment_url`), as provenance. That `urn` is what lets
   [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) run **bulk profile enrichment**,
   which takes URNs; it is the whole enrichment path for a Path C row.

   **Do not write the comment permalink into `linkedin_url`.** Every consumer of that
   column treats it as a profile URL: the waterfall's email lookup, `/list-hygiene`'s
   identifier rule, `/personalize`. Handed a post URL they either error or enrich the
   wrong entity, and the row looks enrichable the whole way down. A Path C row has no
   profile URL until enrichment returns one — say so rather than manufacturing one from
   the permalink, and never rebuild a profile URL out of `commenter.profileId`, which is
   an opaque id and not a vanity slug.

   **And bulk enrichment does not return a title.** A live run proved it: the bulk
   element nests its positions under `contents`, the field map does not, and every row
   came back with `title` and `company_name` empty
   (`tests/fixtures/live/enrich_profiles_bulk.json`). What bulk *does* return for a Path
   C row is the person's real **`linkedin_url`** — which is the thing the permalink
   never was. A title costs a second hop, the single `enrich_profile` on that URL,
   priced in [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) like any other. Say
   that to the user before they approve the chain: a Path C row is **two** paid profile
   calls away from a title, not one.
8. Suppress as in Step 7, then check the list size against
   `gates.yaml:skills.build_prospect_list.min_rows_to_continue` exactly as Step 8 says.
   Count the kept rows only. `unmatched` rows count once the user promotes them.

## Step 4 — the job-change play

`recently_changed_jobs` is a boolean filter on `lead_search()`, not an endpoint. Map the
slot to the filter and send it. It is the highest-intent signal the API exposes: someone who just changed jobs has budget,
a mandate, and no incumbent vendor loyalty.

Two ways to use it, and they are different plays:

- **New-buyer play** — `recently_changed_jobs` with `seniority` and `functions`. People
  who just landed in the role you sell to.
- **Champion play** — `recently_changed_jobs` with `past_companies` set to accounts that
  already bought. A champion who moved is the warmest outbound in the pack, and
  `past_companies` is the field that finds them.

Three things to say out loud when this filter is on:

- It **forces the lead-search route**, whatever else the ICP contains, because no other
  endpoint exposes it. If the rest of the ICP would have been served by
  `people_search()`, the user is paying the escalation for this one filter. That may well
  be worth it; it is not free, and it should be their call.
- It has **no exclusion counterpart** — see Step 5.
- The API documents no window for "recently" and returns no job-change date. Do not
  invent one. If the user asks "how recently", the honest answer is that the API decides
  and does not say, and the check is to spot-check a few of the returned profiles.

For continuous monitoring rather than one shot, this is the wrong skill — see
[`## Related`](#related).

## Step 5 — exclusions, and what cannot be excluded

Exclusions exist on `lead_search()` only, as flat sibling fields. These have a
counterpart: `seniority`, `industries`, `functions`, `locations`, `geo_ids`,
`current_companies`, `past_companies`, `current_job_titles`, `past_job_titles`,
`schools`, `company_headquarter_locations`.

**These have none, and there is no server-side way to express them:**

- `search_query`, `first_names`, `last_names`
- `years_of_experience`, `years_at_current_company`
- `company_size`
- `profile_languages`
- `recently_changed_jobs`

"Exclude anyone under three years of experience" and "exclude tiny companies" are
therefore client-side filters applied to rows you have **already paid for**. Say that
before the run, not after: an exclusion the user believes is narrowing the search is
actually widening the bill.

## Step 6 — write the plan before anything is spent

Never fire a search as the first action. Write the plan first — it is this skill's
dry-run, and it makes no calls at all:

```
gtm/plans/<list-name>.plan.md
```

It must name, per search:

- the endpoint, and the one-sentence reason it was chosen over the cheaper one
- the exact request body that will be sent, snake_case, with resolved geo IDs inline
- its pricing model **read from the catalog** — per-result, flat, or base-plus-per-result
- pages planned, and the estimate basis for results per page, which is
  `gates.yaml:unbounded_endpoints.assumed_results_per_page` whenever the caller gives no
  better hint
- a **floor** and a **ceiling**. The floor is what a single page costs. The ceiling is
  the page plan carried out in full. For `lead_search()` state that the per-call base
  repeats on every page, because that is the line item that surprises people.

Print the thresholds rather than restating them from memory:

```bash
richapi gates
```

## Step 7 — get approval, then walk pages one at a time

The user approves the plan, not a number you said out loud.

Then execute, and gate every page:

- The first page runs on the approved plan. Every page after it asks — that is
  `gates.yaml:unbounded_endpoints.pages_before_confirm`, and it exists because for these
  endpoints a human between pages is the only real ceiling. `people_search()` is the sole
  exception to the *shape* of the problem, since its `limit` bounds a page, but the total
  is still unbounded and it is page-gated with the rest.
- `gates.yaml:unbounded_endpoints.hard_page_ceiling` stops the run even if the user keeps
  confirming. Past it the answer is a narrower ICP, not another page.
- `gates.yaml:skills.build_prospect_list.max_pages_per_run` bounds the pages a single
  list build may accumulate across all of its searches together, so three searches cannot
  each walk to the endpoint ceiling and quietly multiply the bill.
- A page that would cross `gates.yaml:session_budget.fractions.single_call_confirm` of
  the session budget asks on its own, however little has been spent so far.
- A missing gate key reads as STOP, never as "no gate". If a gate cannot be resolved,
  the run does not continue.

Session handling differs per endpoint. Do not generalise it:

- **`lead_search()` is the only endpoint in this set with `session_id`.** Omit it on the
  first page, read `sessionId` from the response, and echo it back unchanged on every
  later page so pagination stays on one scraping resource.
- The others have no session field. Sending one is not a no-op you can be casual about;
  it is a field the endpoint does not document.
- Page numbering differs per endpoint: `people_search()` and `post_activities()` count
  from zero, everything else counts from one. Getting this wrong silently re-buys the
  first page.

After each page: dedupe, then report progress in the same breath as the running spend.

Dedupe on the LinkedIn profile URL, normalised — it is the only identifier every search
in this set returns. `lead_search()` also returns an `id`; use it as a tiebreak when the
URL is absent, never as the primary key, because the other searches do not return it.

Output goes to `gtm/lists/people/<name>.csv`, filtered through the suppression store at
write time. A suppressed contact never reaches an output list.

## Step 8 — report honestly

- **Lead with what the ICP could not express.** "Excluded sub-50-headcount client-side,
  so you paid for rows you then dropped" is the useful sentence. So is "no seniority
  filter exists on the account roster search, so these are everyone at those companies".
- **A range stays a range.** Where the response does not report its own charge the
  receipt gives a range; pass the range on rather than rounding it into one confident
  number.
- **Say how many pages were left unwalked** and what the user would pay to continue.
  A list that stopped at a gate is not a finished list, and it should not read like one.
- If the list is smaller than `gates.yaml:skills.build_prospect_list.min_rows_to_continue`,
  say so and stop. Do not hand it on. Carrying a list that thin into an enrichment
  waterfall spends the waterfall's price to learn the search was wrong. Offer the user
  two ways forward and let them pick: re-run the search wider, or (Path C) review the
  `unmatched` bucket and promote rows, or loosen the exclude terms. Either way the list
  is re-checked against the same gate before anything downstream runs.

Then hand off: a list without emails is not a list anyone can use, and enrichment is a
separate skill with its own plan and its own approval.

## What this skill will not do

- **It will not source a list it cannot suppress.** No readable suppression store means
  no run, and no output file.
- **It will not walk pages unattended.** Every one of these searches bills per result
  with no total bound, so an automatic page-walk is an open cheque. The page gate is not
  a nuisance to be flagged past.
- **It will not enrich.** No emails, no phones, no verification — those are
  `/enrich-waterfall`, priced and approved separately.
- **It will not touch LinkedIn.** No connection requests, no InMail, no profile visits,
  no scraping outside the API. Sending, dialling and LinkedIn actions are permanently
  outside this pack, not pending.
- **It will not invent a filter the API lacks.** Intent scores, technographic filters,
  headcount-growth filters and "companies hiring for X" are not in this skill's endpoint
  set. When the user asks for one, name the skill that owns that signal instead of
  approximating it with a keyword search.
- **It will not guess a label.** An unrecognised seniority, function or industry value
  is put back to the user with the closest valid options.
- **It will not schedule itself.** A weekly ICP re-run is a monitoring job, not a list
  build.

## Recipes

Ready-made chains of this pack's skills for a common job. A recipe only names the
skills and their order; each skill still runs its own dry run, gates and approval, so
no step is priced here.

### post-engagers-to-list

```yaml recipe
name: post-engagers-to-list
job: >-
  A LinkedIn post in; the people who engaged with it, qualified, verified and ready to
  send, out
input: post_url
steps:
  - build-prospect-list
  - list-hygiene
  - enrich-waterfall
  - evidence-score
  - personalize
  - sequence-builder
  - comply
  - campaign-review
  - launch
ends: send
```

**What this costs.** The engager walk is charged **per page**, and page zero is the
minimum — there is no free look at who engaged. Enrichment then charges per row you
keep, and the email lookup bills whether or not it finds an address. So the floor is one
page plus the rows that survive your headline filter, not "a few credits to try it".
Price the whole chain from the catalog at plan time; no figure is written here, because
a price typed into a document is wrong within a quarter.

Path C sources the engagers and filters them on `commenter.headline`, exclude before
include, with an `unmatched` bucket the user reviews. If the kept rows fall below
`gates.yaml:skills.build_prospect_list.min_rows_to_continue`, the recipe stops there and
reports, as Step 8 says; it continues only once the user widens the rule or promotes
enough `unmatched` rows to clear the gate. Kept rows carry `urn` (from `commenter.entityUrn`)
into `/enrich-waterfall`. Bulk profile enrichment takes URNs and returns the person's
real `linkedin_url` (plus name, headline, industry and location), but **no `title` and
no `company_name`** — the shape difference is recorded in step 7 above. A title needs a second hop, the single `enrich_profile`
on the URL bulk returned, so price this chain as two profile calls each, not one.
Kept rows carry no `linkedin_url` of their own: the engager row's `url` is the comment's
permalink, not a profile, so a profile URL for these people exists only once enrichment
has returned one. Hygiene runs before enrichment so no credit is spent on a row
that was never going to work. `/evidence-score` then ranks on the verifier's verdict,
so a row verified `ok` ranks above a `catch_all` one.

**At the gate, this is an e-mail chain.** Run `/comply` with `CHANNEL=email` (the default), because `/launch` writes a sender file and refuses a clearance for any other channel. The enrichment leaves `location_country` holding a country NAME ("United States"), not an ISO code; `/comply` Step 1a maps it, so do not hand-map a column before running the gate, and do not read an unmapped name as an unresolved row.

### domains-to-decision-makers

```yaml recipe
name: domains-to-decision-makers
job: Company domains in; named decision makers with verified work emails out
input: domains
steps:
  - account-research
  - build-prospect-list
  - list-hygiene
  - enrich-waterfall
ends: deliverable
```

**What this costs.** The people search bills **a base charge per page plus a charge per
result on that page**, so a single page is the floor and its size is not knowable before
it lands — an account fan-out multiplies that floor by the number of accounts. Read both
numbers from the catalog in the dry run, quote the page ceiling
(`gates.yaml:skills.build_prospect_list.max_pages_per_run`) alongside them, and get the
approval before the first page, not after the fan-out.

account-research resolves each domain to its company record; Path B then finds the roles the user named across those accounts in one filtered search.

## Related

- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — the next step for every list this
  skill writes: profile, work email, phone, verification.
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router, and the session-end receipt
  read from the real ledger.
- Ownership of every endpoint named here:
  [`_lib/endpoint-owners.yaml`](../../_lib/endpoint-owners.yaml). If an endpoint you want
  is owned by another skill, route to that skill rather than calling it here.
- What is built and what is not: [`../../ROADMAP.md`](../../ROADMAP.md).
