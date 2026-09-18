# /tam-map

A market size you can defend in a meeting, split into segments, with every number
labelled by how it was obtained.

## The problem this solves

Somebody asks how big the market is. The number that ends up on the slide usually came
from paging a search endpoint until the results ran out, which is an expensive way to
buy a figure that page one already reported for free. Then that number gets mixed with a
scraped sample and a back-of-envelope multiple, and three months later nobody can tell
which part was measured. This skill counts what can be counted, buys rows only when you
actually want rows, and writes the difference on the page.

## When to use it

- "The board wants a TAM number on Thursday and I do not want to invent one."
- "How many companies actually match our ICP, before we go build a list?"
- "Which axis moves the number: industry, headcount band, or region?"
- "How much of that market is still available after we remove customers and open opps?"
- "Find lookalikes for our best twelve customers."

## When NOT to use it

- **You want the people inside those companies.** This skill stops at the company. No
  titles, no seniority, no emails, no phones. That is
  [`/build-prospect-list`](build-prospect-list.md), planned and approved separately.
- **You want a local business list, not a local market size.** The Maps endpoints return
  the number of places you asked for, which is your own request parameter coming back.
  Buying rows off the high street is
  [`/local-business-prospecting`](local-business-prospecting.md).
- **You gave it a city name and expect a precise geography.** Geo-ID resolution is owned
  by [`/build-prospect-list`](build-prospect-list.md). Run that first, or accept a count
  labelled geographically ambiguous.
- **You want firmographics or contact fields on the accounts.** That is
  [`/enrich-waterfall`](enrich-waterfall.md), and per-account detail is
  [`/account-research`](account-research.md).
- **You want a count for an ICP attribute the search cannot express.** The counted
  source takes five filters and no more. Everything else is dropped, and the report says
  which attributes went and which way that biases the figure. Wider, always.
- **You want one confident number.** Most of the sources never report their own charge
  and never report a total, so their contribution is a floor or a range. The report
  keeps it that way.

## What it costs

Paid. The counted part is deliberately cheap: one page.

- **The count.** `linkedin_company_search` is the only endpoint in this skill's set that
  hands you a total on page one, next to the page you paid for. One page per segment
  probe buys the whole segment's total. Walking further buys rows, not a better number.
- **The six that report no total.** `directory_yellowpages` for the long tail,
  `google_maps_places_scraper_keyword` and `google_maps_places_scraper_sync_using_url`
  for local density, `similarweb_scraper_sync` for lookalikes,
  `crunchbase_company_scraper_sync` for a funding overlay, and
  `find_website_by_company_name` as the dedupe join key. These are priced as what they
  are, which is a sample or an overlay, never as a measurement.

No credit price appears on this page. Prices live in `_lib/api-catalog.json` and are
read at plan time, into the dry run, which makes zero calls, needs no API key, costs
nothing, and always runs first.

The shape of your segmentation is a spending decision before it is an analytical one. A
four-by-three-by-three cross-tab is thirty-six page-one probes; the marginals are ten
and answer the question a first pass is really asking. Four ceilings in `_lib/gates.yaml`
bound the run, all under `skills.tam_map`: `max_count_probes`, `max_pages_per_run`,
`min_segment_size`, and `directory_max_pages_per_request`. Read the live values rather
than trusting a number in a doc:

```console
$ richapi gates skills.tam_map.max_count_probes
```

A key that does not resolve reads as STOP, so the probe does not run.

## What you get

`gtm/tam-report.md`, and `gtm/lists/accounts/<name>.csv` if you bought rows as well as
counts. The report sorts every figure into three classes and never sums across them
without saying so:

- **Counted.** A total read from the one source that reports one.
- **Enumerated.** Rows actually bought, deduped and written. A floor on the universe,
  because it stopped where the page gate or the budget stopped it.
- **Estimated.** A sample times an assumption, with the assumption and the gate key it
  came from on the same line as the number.

It also tells you what was not bought: segments left unprobed, pages left unwalked, and
what continuing would cost. And it restates the ICP attributes the count could not
express, which is the sentence that stops a wide number being quoted as a precise one.

## How to run it

Ask Claude in plain English:

> "Size the market for our ICP and break it out by industry and headcount."

> "How many Series B fintechs in Germany match this?"

> "Which segment is biggest, and what did you have to leave out of the filter?"

There is no `richapi tam-map` command. Underneath it uses the shared verbs, and each of
these makes zero calls:

```console
$ richapi search linkedin_company_search --param search_query="<icp keywords>" --param company_size="201-500" --pages 1 --dry-run
$ richapi call similarweb_scraper_sync --param domain=example.com --expect 1 --dry-run
```

## What it needs first

`./setup` once, so there is a readable do-not-contact store. Check with
`richapi preflight`: `SUPPRESSION: OK` is the line that matters, and an account universe
this skill cannot suppress is one it will not write.

Then [`/icp-review`](icp-review.md), which writes `gtm/icp.yaml`. A TAM built on an
untested ICP sizes the wrong market precisely. If your segments are
geographic, a run of [`/build-prospect-list`](build-prospect-list.md) first gets you
resolved geo IDs and makes every count here unambiguous.
