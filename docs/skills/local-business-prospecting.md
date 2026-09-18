# /local-business-prospecting

A list of real businesses in a real place, with address, phone, rating and sometimes a
website, built off Google Maps and Yellow Pages rather than LinkedIn.

## The problem this solves

Your prospects are dentists, restaurants, plumbers and law firms. They have a storefront
and a phone number long before anyone updates a LinkedIn page, so a title-and-industry
search returns almost nothing. The query you want is "what and where": all the dental
clinics in Austin, sorted so you can see which have no website and which have angry
reviews. Every endpoint that answers that bills per result and none reports what it
charged, so the plan is the only place the bill is ever visible.

## When to use it

- "Find all the dentists in Austin, with phone numbers."
- "I need SMBs in Brooklyn with no website. That is my entire pitch."
- "Pull the restaurants near this Maps URL I already filtered."
- "Which local businesses have bad reviews, and what do people complain about?"
- "Give me the same list for the next three cities, and tell me what that costs."

## When NOT to use it

- **The request has a job title, a seniority, or a LinkedIn URL in it.** That is
  [`/build-prospect-list`](build-prospect-list.md). If you want both, source the
  businesses here and hand the domains over there. Two spends, two approvals.
- **You are asking how many there are, not who they are.** A count and a list are
  different purchases, and the result count is never the market size: you asked for a
  number of listings and got that number back. Sizing is [`/tam-map`](tam-map.md).
- **You want reviews mined across the whole sourced list.** That is refused, not warned
  about: the bill is reviews per place times number of places, the most expensive mistake
  available here. Reviews run as a second pass over a shortlist you name.
- **You want the missing websites, emails or verification filled in.** That is
  [`/enrich-waterfall`](enrich-waterfall.md); the tech stack and what the site says is
  [`/account-research`](account-research.md); normalisation is
  [`/list-hygiene`](list-hygiene.md).
- **You want people inside the business, or a personal inbox for the owner.** No titles,
  no owners by name, no committee. It stops at the business, and reaching past the
  address a business published on purpose is [`/comply`](comply.md)'s question.

## What it costs

Paid, and it is the one skill in the pack where nothing can be reconciled afterwards.
Four endpoints, all billed per result, and not one of them reports its own charge:
`google_maps_places_scraper_keyword`, `google_maps_places_scraper_sync_using_url`,
`google_maps_reviews_scraper_sync`, and `directory_yellowpages`. So every ledger line
this skill writes is `estimated_unverifiable`, the pre-call estimate is the only figure
that will ever exist for these calls, and the plan is the control rather than the
receipt. A range stays a range in the report, never rounded into a confident number.

No credit price appears on this page. Prices live in `_lib/api-catalog.json` and are read
at plan time, into the dry run, which makes zero calls, needs no API key, costs nothing,
and always runs first.

Two things the plan is strict about, because both are ways the bill outruns the approval:

- **The number of listings is asked, never defaulted.** It is the one slot that is purely
  a spending decision. Doubling it doubles the bill and does not improve the top of the
  list, because Maps returns its own ordering either way.
- **Yellow Pages paginates one page per request.** Its `max_pages` field scrapes several
  pages inside a single request, which would walk past the page gate while the gate
  counts one. `_lib/gates.yaml` clamps it at
  `skills.local_business_prospecting.directory_max_pages_per_request`, set to 1 there
  today.

The review pass has two more ceilings, shown in the plan as their product rather than as
one factor, and yours to lower and never silently raised. Read them live:

```console
$ richapi gates skills.local_business_prospecting.max_reviews_per_place
$ richapi gates skills.local_business_prospecting.max_places_per_run
```

A gate key that does not resolve reads as STOP: the request is refused, not sent unclamped.

## What you get

`gtm/lists/local/<category>-<place>.csv`, with a short
`gtm/lists/local/<category>-<place>.md` next to it saying how the list was built. Every
row carries its place id and source URL, so a wrong row is debuggable and a stale row
detectable. Gaps are written, never left out: `not_found`, `not_verifiable` or
`not_applicable`, so you can tell "checked and empty" from "not checked".

The report gives you the funnel, not only the survivors: listings bought, rows kept after
deduping on phone and street address, rows kept after your quality filter, and rows with
a usable website. The drop from the first number to the last tells you whether the next
city is worth sourcing. A second pass usually costs much less, because maps and directory
results resolve out of a long cache TTL.

## How to run it

Ask Claude in plain English:

> "Find me 50 dental clinics in Austin, TX with their phone numbers and websites."

> "Pull the businesses from this Google Maps URL. I already filtered it."

> "Take the 12 worst-rated of those and get me their most recent complaints."

There is no `richapi local-business-prospecting` command. Underneath it uses the shared
verbs, and each of these makes zero calls:

```console
$ richapi call google_maps_places_scraper_keyword --param search_query="dental clinic" --param location_query="Austin, TX" --param limit=50 --expect 50 --dry-run
$ richapi search directory_yellowpages --param search_query="plumber" --param location="Austin, TX" --pages 1 --dry-run
```

`--expect` must equal `limit` on every Maps call. Without it the plan prices the call at
an assumption and the API bills it at the limit, and that error runs in the direction
that hides itself: the plan you approved comes in under the invoice.

## What it needs first

`./setup` once, for a readable do-not-contact store. Check with `richapi preflight`:
`SUPPRESSION: OK`. A list this skill cannot suppress is a list it does not write. `gtm/`
is treated as personal data even here, because for a sole trader the business phone is a
personal phone and nothing in the response can tell the difference. Nothing upstream is
required: a category and a place is enough to start.
