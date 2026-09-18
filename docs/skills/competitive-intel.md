# /competitive-intel

What a rival is actually running: the ads, the stack, the pixels, the posts, the traffic,
with the endpoint named against every line and the things nobody could find written down
as not found.

## The problem this solves

You lost three deals to the same competitor this quarter and the battlecard is eighteen
months old. Someone screenshots their homepage, writes a paragraph about their strategy,
and the sales team argues from it for a year. Half of it was true when it was written.
This skill goes and looks: what is on their site, what they are buying, what they are
publishing, how big the audience behind it is. It writes down what it found, what it
could not find, and what it cannot verify, so a deal review argues from evidence instead
of from a confident paragraph.

## When to use it

- "What ads is Acme running right now, and what angle are they leading with?"
- "Are they outspending us, or does it just feel that way?"
- "What is in their stack? Are they even instrumented for paid?"
- "Build me a battlecard for these two before the QBR."
- "Is anyone actually searching for them, or are we the only ones who talk about them?"
- "What have they been posting since the funding round?"

## When NOT to use it

- **You want their ad spend.** No endpoint in this pack returns what anyone paid. The
  answer is `not_found`, never a number derived from ad count. Presenting one as a proxy
  for the other is the most repeated lie in competitive intelligence.
- **You want it to tell you what to do about it.** Positioning, messaging and pricing
  responses are decisions this skill supplies evidence for and does not make.
- **You want to sweep a dozen rivals in one go.** A sweep multiplies every line on the
  plan, so it runs under its own ceiling, and past that ceiling the comparison is
  assembled from separate runs you approved separately.
- **You want several of their execs' posting histories.** It reads one chosen profile's
  activity per run. Three rivals times three execs is nine unbounded calls nobody can
  reconcile, and it refuses.
- **You want the same read every Monday as a diff.** Same ad and stack endpoints, on a
  cadence, with the standing charge named up front: [`/signal-watch`](signal-watch.md).
- **You want this pointed at a prospect instead of a rival.** Same site, ad and post
  endpoints, plus the firmographics this skill does not own:
  [`/account-research`](account-research.md).
- **You want to prospect the executives it surfaces.** They are evidence, not a list.
  Contact data is [`/enrich-waterfall`](enrich-waterfall.md), and nothing here sends
  anything.
- **You want the copy that uses the finding.** That is
  [`/personalize`](../../skills/personalize/SKILL.md), which refuses an unsourced claim.

## What it costs

Paid, in four tiers. Tier 1 is the default and it is flat-priced end to end, so its plan
total is a total. Everything else is opted into and quoted as a ceiling.

- **Tier 1, posture.** `website_intelligence` as one sweep, or `web_tech_stack` and
  `web_pixels` as their own calls, plus `search_google_trends` for whether demand for
  the brand is rising or flat. The skill prices the sweep against the individual modules
  from the catalog at plan time and picks the cheaper one in front of you, because the
  crossover moves.
- **Tier 2, paid acquisition.** `linkedin_ad_search`, then `linkedin_ad_details` on the
  handful of ads worth reading in full, plus
  `google_ad_transparency_scraper_sync` and `meta_ads_library_scraper_sync`.
- **Tier 3, voice.** `linkedin_company_posts`, `profile_activities`, and the four flat
  YouTube calls: `youtube_search`, `youtube_channel`, `youtube_channel_videos`,
  `youtube_video`.
- **Tier 4, scale.** `similarweb_scraper_sync`.

Every number comes from the dry run, which makes zero calls, costs nothing, needs no API
key, and always runs first. No credit price is written on this page: prices live in
`_lib/api-catalog.json` and are read at plan time.

Three things to look for on that plan:

- **The multiplier.** With more than one rival in the question, the plan is not the
  plan. It is the plan, once per competitor. That is the cost users do not price in
  their heads.
- **Four lines can never be reconciled.** `profile_activities`,
  `similarweb_scraper_sync`, `google_ad_transparency_scraper_sync` and
  `meta_ads_library_scraper_sync` do not report what they charged. They are marked on
  the plan before the run, not in the receipt after it.
- **`profile_activities` is the dangerous one.** It bills on the profile's whole
  matching history rather than the page you asked for, and the charge never appears in
  the response. It confirms every time regardless of how little the session has spent.

Four ceilings bound this skill, all in `_lib/gates.yaml` under `skills.competitive_intel`:
`max_competitors_per_sweep`, `max_pages_per_run` across the four page-gated endpoints,
`ad_details_max_per_competitor`, and `profile_activities_max_profiles`. Print them
yourself rather than trusting a number in a doc:

```console
$ richapi gates skills.competitive_intel.max_competitors_per_sweep
```

If one stops resolving, the path it guards closes: the sweep drops to one competitor,
the ad detail fetch drops to ads you picked by hand, the activity read is refused until
you name a profile on the plan.

## What you get

`gtm/competitive/<competitor>.md`, one file per rival, and a side-by-side comparison
assembled from those files rather than from a fresh sweep. The grid carries the endpoint
on every row:

```
                              Northwind                Baltic
  Marketing stack             HubSpot, Segment         Marketo            [web_tech_stack]
  Brand search trend          rising                   flat               [search_google_trends]
  LinkedIn ads (90d)          21 creatives             not_found          [linkedin_ad_search]
  Ad spend                    not_found                not_found          [no endpoint returns spend]
```

Gaps are written in one of three words, never left blank: `not_found` (the call ran and
there was nothing, which for a rival running no ads is often the most useful line in the
file), `not_verifiable` (something came back and this pack cannot confirm it), or
`not_applicable` (a YouTube read for a rival with no channel). A missing row reads as
"not checked", and that is how a rep ends up asserting in a deal review that a
competitor is not advertising when nobody ever looked.

There is also a read on the pixels that stays honest about what a pixel proves. A
LinkedIn Insight Tag means they *can* retarget on LinkedIn. It does not mean they are
spending there now. A pixel plus ads in the library is a funded channel. A pixel alone is
a tag somebody added once.

The report says which tiers you declined and what the read is therefore missing, so
nobody reads the absence of ad data as evidence of no ads. If coverage falls under
`quality_stops.coverage_min_pct` in `_lib/gates.yaml`, it says the read is too thin to
carry a positioning decision.

## How to run it

Ask Claude in plain English:

> "What ads is Acme running on LinkedIn, and what is the angle?"

> "Compare our stack and their stack. Are they instrumented for paid?"

> "Build a battlecard for Acme before Thursday's deal review."

There is no `richapi competitive-intel` command. Underneath, the skill prices each tier
with the shared verbs, and every one of these makes zero calls:

```console
$ richapi call web_tech_stack --param url=https://<domain> --dry-run
$ richapi call search_google_trends --param keyword=<brand> --dry-run
$ richapi search linkedin_ad_search --param account_owner=<company> --pages 1 --dry-run
```

## What it needs first

`./setup` once. Tier 1 and the ad tiers are about companies and run without a
do-not-contact store. Tier 3 surfaces named executives, so that tier does not. Check
with `richapi preflight`.

Then the identifiers, and bring what you have: a domain gets you Tier 1 and Tier 4, a
company LinkedIn URL gets you the ad search and the posts, a Meta ad URL is required for
the Meta library, and a YouTube channel is found from the brand name. A missing
identifier is a `not_applicable` row, not a guess.
