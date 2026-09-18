# /build-prospect-list

A deduplicated list of named people who match your ICP, sourced through the cheapest
search that can actually express your filters, with the bill shown before it is spent.

## The problem this solves

You need forty Directors of Engineering at Series B fintechs in Berlin, and the fastest
way is to fire the most powerful search you have and page until you have enough names.
That search is also the dearest, it charges a per-call base again on every page, and half
your filters could have been served by a cheaper endpoint. The other failure is quieter:
you type an exclusion the API cannot express, the request accepts it, ignores it, and you
pay for rows you then delete by hand. This skill picks the route, says which filter forced
the expensive one, and shows you the floor and the ceiling before a page is bought.

## When to use it

- "Find me 40 VPs of Sales at 200 to 1000 person software companies."
- "Here are our 60 target logos. Get me the buying committee at each."
- "One of our champions left. Find where they landed, and who else moved recently."
- "I pasted a Sales Navigator URL. Turn it into a list I can enrich."
- "Who works at these companies? I have the LinkedIn company URLs already."

## When NOT to use it

- **You want emails and phones.** It stops at names and profile URLs. Contact data is
  [`/enrich-waterfall`](enrich-waterfall.md), priced and approved on its own.
- **You want to know how big the market is.** Sizing is cheaper than enumerating, and it
  is [`/tam-map`](tam-map.md). Buying a list to count it is the mistake that page exists
  to stop.
- **Your prospects are businesses with an address and a phone before they have a
  LinkedIn page.** Dentists, restaurants, contractors. That is
  [`/local-business-prospecting`](local-business-prospecting.md).
- **You want a filter the API does not have.** Intent scores, technographics, headcount
  growth, "companies hiring for X". The skill names the endpoint that owns the signal
  instead of faking it with a keyword search.
- **You want the reporting lines inside one account.** That is [`/org-map`](org-map.md).
- **You want this to re-run every Monday.** A weekly ICP sweep is a monitoring job, not
  a list build. That is [`/signal-watch`](signal-watch.md).
- **You want the pages walked unattended.** Every search here bills per result with no
  bound on the total, so the page gate asks a human between pages.
- **You want to know whether you may lawfully contact these people.** A list is a data
  question. Permission is [`/comply`](comply.md).

## What it costs

Paid, and the routing decision is the whole cost story.

- **`people_search`** is broad discovery on industry, title, location, domain and an
  employee-count range. It is the only search in the family that takes a `limit`, so a
  page is genuinely bounded, and it is the first thing to reach for. `profile_search`
  covers a named person, an exact title string, or one company.
- **`lead_search`** is the only endpoint that expresses seniority, function, company-size
  bands, experience, tenure, language, exclusions, a Sales Navigator URL, and
  `recently_changed_jobs`. It is also the only one priced with a per-call base on top of
  a per-result charge, and that base repeats on every page. The plan states, in one
  sentence, which filter forced the escalation.
- **`linkedin_company_search`** turns account criteria or fuzzy names into real company
  records. Skip it if you already have the company LinkedIn URLs.
- **`linkedin_company_employees_search`** walks one company's employees with no title or
  seniority filter of any kind. It returns everyone, which on a large account is a lot of
  pages to buy to find four people.
- **`geo_id_search`** resolves a place name to a LinkedIn geo ID. Flat per call, once per
  distinct location, reused for the whole run. `search_reference_data` validates
  seniority, function and industry labels; the catalog prices it at zero and it still
  appears in the plan, because every call gets named.

No credit price appears on this page. Prices live in `_lib/api-catalog.json`, read at
plan time into the plan artifact, which makes zero calls, needs no API key, and is free.

Three page ceilings bound a run: `unbounded_endpoints.pages_before_confirm`,
`unbounded_endpoints.hard_page_ceiling`, and
`skills.build_prospect_list.max_pages_per_run`, which counts pages across every search in
one build so three searches cannot each walk to the endpoint ceiling.
`skills.build_prospect_list.min_rows_to_continue` is the floor below which the answer is
to re-run the search, not to enrich what came back. Read them live:

```console
$ richapi gates skills.build_prospect_list.max_pages_per_run
```

## What you get

Two files. `gtm/plans/<list-name>.plan.md` first, which is this skill's dry run: the
endpoint per search, the exact request body, the pricing model read from the catalog,
pages planned, and a floor and a ceiling. You approve that, not a number said out loud.

Then `gtm/lists/people/<name>.csv`, deduplicated on the normalised LinkedIn profile URL
and suppression-filtered at write time. The report with it leads with what your ICP could
not express: which exclusions were applied client-side to rows you had already paid for,
how many pages were left unwalked, and what continuing would cost.

## How to run it

Ask Claude in plain English:

> "Build me a list of 40 Heads of Engineering at 201 to 500 person fintechs in Berlin."

> "Here are 60 company LinkedIn URLs. Find the RevOps people at each."

> "Which of our closed-won champions changed jobs recently?"

There is no `richapi build-prospect-list` command. Underneath it uses the shared verbs,
and both of these make zero calls:

```console
$ richapi search people_search --param title=CTO --pages 1 --dry-run
$ richapi search lead_search --param seniority=Director --pages 3 --dry-run
```

## What it needs first

`./setup` once, for a readable do-not-contact store. Check with `richapi preflight`:
`SUPPRESSION: OK`. A list it cannot suppress is a list it will not write.

Nothing else is required. It works from a plain-English description, and better after
[`/icp-review`](icp-review.md), which writes the ICP the search is built from, and
[`/tam-map`](tam-map.md), which says whether the segment is big enough to be worth
enumerating.
