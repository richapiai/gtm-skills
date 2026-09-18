# /account-research

A written brief on one company where every line names the endpoint it came from, and
every fact nobody could find is written down as missing instead of quietly left out.

## The problem this solves

You have a call at 2pm with a company you have never heard of. The last person who
"researched" it sent you three paragraphs that read well and cited nothing, so you have
no idea which parts are real. Meanwhile the honest version takes forty minutes of tab
work: their site, their LinkedIn, their careers page, who runs the function you sell to.
This skill does that work, prices it before it runs, and hands you a brief you can argue
from because you can see where each line came from.

## When to use it

- "Brief me before this call."
- "Tell me about Acme. Are they a real company or a five-person shell?"
- "Who should I talk to at this account, and who signs?"
- "What are they running? Is our integration already in their stack?"
- "Do not write me an email yet. Tell me what we actually know first."

## When NOT to use it

- **You gave it a company name and nothing else.** It stops and asks rather than picking
  an Acme. Every fact downstream inherits that choice and none of them can detect it was
  wrong. Resolve the name first with
  [`/build-prospect-list`](../../skills/build-prospect-list/SKILL.md).
- **You want the reporting lines drawn out.** Pass 2 returns names, titles and profile
  URLs in a list. Who reports to whom, with provenance on each edge, is
  [`/org-map`](org-map.md).
- **You want emails and phone numbers for the people it finds.** It stops at names on
  purpose. Contact data is [`/enrich-waterfall`](enrich-waterfall.md), and nothing in
  this pack sends anything.
- **You want posting history across the whole committee.** It reads one chosen profile's
  activity, gated, and refuses to fan that across five people. The reason is under what
  it costs.
- **You want the same brief every Monday without asking.** That is
  [`/signal-watch`](signal-watch.md), which watches and reports diffs.
- **You want the same question asked across a list of accounts.** This skill researches
  one. Many is [`/research-agent`](../../skills/research-agent/SKILL.md).
- **You want the outreach copy.** A brief is evidence. Copy is
  [`/personalize`](../../skills/personalize/SKILL.md), which will not ship a claim
  without a source line in the brief behind it.
- **You want a ruling on whether you may contact these people.** Research is a data
  question. Lawful basis belongs to [`/comply`](../../skills/comply/SKILL.md).

## What it costs

Paid, and how much depends entirely on how deep you go. The skill is one cheap default
pass plus four you opt into, and it never runs the whole menu.

- **Pass 0, resolve the account.** `web_social_links` where you only have a domain.
- **Pass 1, the brief. This is the default.** `enrich_company` for firmographics, then
  either `website_intelligence` as one sweep or the modules on their own
  (`web_tech_stack`, `web_pixels`, `web_meta_tags`, `web_json_ld`, `web_social_links`,
  `web_emails`), plus `find_sitemap_urls` and `web_scrape` when the brief needs what one
  specific page says. Every call here is flat-priced, so the plan total is the total.
- **Pass 2, the committee.** `linkedin_company_employees_search` or `lead_search`, then
  `profile_social_metrics` on the shortlist.
- **Pass 3, the voice.** `linkedin_company_posts`, `post_details`, `post_activities`,
  `profile_activities`.
- **Pass 4, the market.** `crunchbase_company_scraper_sync`, `similarweb_scraper_sync`,
  `linkedin_ad_search`, `meta_ads_library_scraper_sync`,
  `google_maps_reviews_scraper_sync`.

Every number comes from the dry run, which makes zero calls, costs nothing, needs no API
key, and always runs first. No credit price is written on this page on purpose: prices
live in `_lib/api-catalog.json` and are read at plan time.

Three things worth knowing before you approve a deep pass:

- **Pass 1 has an exact total. Passes 2, 3 and 4 have ceilings.** Those endpoints bill
  per result on a count nobody can predict, so the plan quotes a range and names the
  assumption behind it. Four of them never report what they charged at all
  (`profile_activities`, `similarweb_scraper_sync`, `meta_ads_library_scraper_sync`,
  `google_maps_reviews_scraper_sync`) and the plan marks those lines before the run.
- **`profile_activities` is the one that can empty a budget.** It bills on the profile's
  whole matching history, not the page you asked for. It runs on one chosen profile,
  confirms every page, and is reported as a range that keeps the word
  `estimated_unverifiable` in it.
- **A second pass on the same account is mostly free.** Firmographics and the website
  sweep sit in the long cache windows, so the dry run shows those hops as skipped and
  not charged. Voice does not, because that is the part that moves.

## What you get

`gtm/research/<account>.md`. Prose a rep can read, over a fact table where every row
carries the endpoint that produced it, like `Marketing stack | HubSpot, Segment |
[web_tech_stack]`.

Gaps are written, never dropped, in one of three words: `not_found` (we looked and it is
not there), `not_verifiable` (something came back and this pack cannot confirm it), or
`not_applicable` (the question does not apply, like store reviews for a software
company). A row left blank would read as "not checked", and you cannot tell that apart
from "checked and empty" on a live call.

You also get a coverage line, which passes were declined and what the brief is therefore
missing, and what a second pass would cost. If coverage falls under the floor in
`_lib/gates.yaml` at `quality_stops.coverage_min_pct`, it says the brief is too thin to
carry a call rather than handing it over anyway. Print the floor with
`richapi gates quality_stops.coverage_min_pct`.

## How to run it

Ask Claude in plain English:

> "Research Acme before my call tomorrow. Here is their LinkedIn URL."

> "What is in their stack, and are they retargeting?"

There is no `richapi account-research` command. Underneath, the skill prices each pass
with the shared verbs, and every one of these makes zero calls:

```console
$ richapi call enrich_company --param url=<linkedin-company-url> --dry-run
$ richapi search linkedin_company_employees_search --param company_linkedin_url=<url> --pages 1 --dry-run
```

## What it needs first

`./setup` once, so there is a readable do-not-contact store. Without it the
company-level passes still run and the committee pass does not, because it surfaces
named people. Check with `richapi preflight`.

Bring one of two identifiers: a LinkedIn company URL, or a domain. A bare company name
is not enough and the skill will say so. Nothing else needs to have run first, and this
is usually the thing that runs before [`/org-map`](org-map.md),
[`/personalize`](../../skills/personalize/SKILL.md) and any outreach step.
