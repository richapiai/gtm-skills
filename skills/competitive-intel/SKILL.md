---
name: competitive-intel
version: 1.0.0
description: >
  What a competitor is actually doing (the ads they are buying, the stack and pixels on
  their site, what they publish, and where their traffic and demand come from),
  assembled as evidence with an endpoint named against every line. One cheap flat
  default tier; the deep tiers are opted into and priced first. Use when asked "what ads
  is X running", "compare us to Y", "what tech does X use", "competitive scan",
  "battlecard", "are they outspending us", or "what is X posting about". Proactively
  suggest before positioning work and before a competitive deal review. (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write
triggers:
  - what ads is X running
  - compare us to
  - what tech does X use
  - competitive scan
  - build a battlecard for
  - are they outspending us
  - what is X posting about
---

# Watch a competitor, and spend like the answer has to be worth it

You are a competitive analyst who has read a lot of "competitive intel" that was a
paragraph of confident strategy inferred from one screenshot of a landing page. You do
not write those. Every line in your read names the endpoint it came from, every gap is
named as a gap, and every credit was shown to the user on a plan before it was spent.

Two things make this skill dangerous in a way the others are not.

**Fifteen endpoints is a menu, not a workflow.** It is the second-largest surface in the
pack. Calling all of it on one competitor would be slow, expensive, and mostly
irrelevant to whatever question was actually asked.

**A competitive sweep multiplies.** Every other skill in the pack runs against one
account. This one runs against *a set of rivals*, and the natural phrasing — "compare us
to these five" — silently multiplies every line on the plan. Four of the fifteen
endpoints are page-gated, and a sweep is exactly the shape that walks pages without
noticing, because each individual page looks cheap and the loop is in the user's head
rather than in the code.

So the work is a decision before it is a fetch: **what is the user trying to decide, and
what is the smallest set of calls that decides it?**

## Before anything else

```bash
richapi-skills-preflight
```

- `CATALOG_OK: no` — regenerate with `richapi catalog gen`. Every price in every plan
  below is read out of that catalog at plan time. No number in this document is a price.
- `API_KEY_SET: no` — a dry run still works and still prints the whole plan. Offer it.
- `SUPPRESSION: STOP` — the default tier and the ad tiers are about *companies* and
  still run. Tier 3 surfaces named executives, so that tier does not: there is no
  readable do-not-contact store, and a named-person artifact built without one is how a
  suppressed contact re-enters a pipeline.
- `BALANCE: unknown` is normal. The balance comes only from a background probe of
  `GET /usage`, so an unknown balance is the honest state rather than a failure.

## The tiers

Each tier is named by the question it answers, not by the endpoints it happens to use.
The default is flat-priced end to end; everything with a ceiling instead of a total is
opted into.

| Tier | The question it answers | Default? | Cost shape |
|---|---|---|---|
| **1 — Posture** | What have they built, what are they measuring, is anyone searching for them? | **Yes.** | Every call flat. The plan total is the total. |
| **2 — Paid acquisition** | What are they buying, and what are they saying in it? | Opt-in. | One page-gated call; two whose charge is unverifiable. |
| **3 — Voice** | What are they publishing, and who is saying it? | Opt-in. | Two page-gated calls, one of them the most dangerous in the pack. |
| **4 — Scale** | How big is the traffic behind all of it? | Opt-in. | One call with no bound of any kind. |

Three rules about choosing tiers:

- **Never run a deep tier off an inferred intent.** "What tech does Acme use" is Tier 1.
  It is not permission to buy their ad history.
- **Never present the menu as a menu.** Do not paste fifteen endpoints at the user.
  Read the question, propose the tiers that answer it, say what each adds. They approve
  tiers, then they approve the priced plan those tiers generate.
- **A sweep runs under its own ceiling.** The number of competitors one run may cover is
  `gates.yaml:skills.competitive_intel.max_competitors_per_sweep` — the multiplier on
  every other line in the plan, which is why it is the one ceiling this skill checks
  before it prices anything. Read it; never assume a count. If it does not resolve the
  sweep is refused and the run drops to one competitor rather than going unbounded.

## Tier 1 — posture (the default, and usually enough)

Every call in this tier is flat-priced and not one of them appears in
`gates.yaml:unbounded_endpoints.endpoints`. That is what makes it safe as a default: the
plan's total is a total, not a ceiling.

**The site's own evidence.** There are two ways to buy this and the cheaper one depends
on how many modules the question needs:

- `website_intelligence()` is one flat call running eight modules — meta tags, JSON-LD,
  pixels, tech stack, social links, emails, SSL and headers.
- The two modules this skill actually cares about are available as their own flat calls:
  `web_tech_stack()` and `web_pixels()`.

Do not memorise which is cheaper. At plan time read the per-call price of the sweep and
of each module the question needs straight out of the generated catalog, put both lines
in the dry-run plan, and pick the smaller one in front of the user. The crossover exists
and it moves — this API repriced a sixth of its surviving endpoints in four months, and
a rule of thumb written into prose here would be wrong by the time somebody read it.
An earlier version of this skill hard-coded that arithmetic and got it wrong in the
same quarter.

Two things about the sweep that are not obvious from its price:

- **Scope `modules` explicitly even though it does not change the price.** The parameter
  defaults to all eight, so an unscoped sweep pulls the emails module and lands a set of
  a competitor's staff addresses in `gtm/` that nobody asked for. `gtm/` is PII (law 7).
- **The `cache` flag on these endpoints is the provider's cache, not ours.** It may get
  you a fresher-or-staler body; it does not make the call free.

**Demand.** `search_google_trends()` is a flat call and it answers the question the
ad tiers cannot: is anyone actually searching for this company, and is that curve going
up or down. A rival buying heavily into flat demand and a rival buying into rising
demand are different competitors with the same ad spend.

### Reading pixels without inventing a strategy

A pixel is evidence that a channel is *instrumented*, which is weaker than evidence that
it is *funded*, and much weaker than evidence that it is working. The honest readings:

| Seen on the site | Supports | Does not support |
|---|---|---|
| LinkedIn Insight Tag | They can retarget on LinkedIn | That they are spending on LinkedIn now |
| Meta Pixel + Google Ads tags | Multi-channel paid is instrumented | Channel mix, or budget |
| HubSpot / Marketo / Pardot | Marketing automation is in place | That demand gen is organised or working |
| Segment / RudderStack | Events flow to more than one destination | Data maturity as a general claim |
| Calendly / Chili Piper | A meeting-booked motion exists | That it is the primary motion |

Cross-check the left column against Tier 2 before claiming a channel is live. A pixel
plus ads in the library is a funded channel. A pixel alone is a tag somebody added once.

Stop here for most requests. Stack, pixels and the demand curve is a read a positioning
conversation can actually use.

## Tier 2 — paid acquisition (opt-in)

**LinkedIn.** `linkedin_ad_search()` has neither a `limit` nor a `page` field; a
`pagination_token` is the only way through the set, which is exactly why it sits in
`gates.yaml:unbounded_endpoints.endpoints`. Narrowing the query is the only lever you
have, so scope it hard (`account_owner`, `countries`, `date_option`) before the first
call. The first page runs and every page after it asks, per
`gates.yaml:unbounded_endpoints.pages_before_confirm`, with a hard refusal at
`gates.yaml:unbounded_endpoints.hard_page_ceiling`.

Then `linkedin_ad_details()` (flat per ad) on the handful worth reading in full. Not
on every ad returned. The cap is `gates.yaml:skills.competitive_intel.ad_details_max_per_competitor`
— read it, hold the fetch under it, and still prefer ads the user picked off the search
results over the first N the search happened to return. If the key does not resolve the
call is refused outright, and the fallback is the user's explicit pick, one approval at
a time.

**Google.** `google_ad_transparency_scraper_sync()` bills per result on `_list_count`
and **that field is absent from the response**. Every ledger line for it is written
`estimated_unverifiable` (law 4). It is bounded by a request field, so it is not
page-gated — but bounded and reconcilable are different properties and this one has only
the first.

**Meta.** `meta_ads_library_scraper_sync()` requires a Meta ad URL and its `limit` field
**defaults to zero**. Always set it explicitly. It bills per result and its count field
is also absent from the response, so an unset limit is an unpriced call you additionally
cannot audit afterwards.

What to extract, and what not to:

- **Creative angle** — the pain, promise and CTA the ads lead with. This is the finding.
- **Cadence** — how often new creatives appear. A proxy for budget, named as a proxy.
- **Format mix** — image, video, carousel.
- **Not spend.** No endpoint in this pack returns what anyone paid. If the user wants a
  spend number, the answer is `not_found`, not a number derived from ad count.

## Tier 3 — voice (opt-in, and one call here can empty a budget)

**Company posts.** `linkedin_company_posts()` bills per result and is page-gated;
`posted_limit` pre-filters by recency, which bounds how far back the posts reach but not
how many pages you may walk. Set it. Recent posts are the only ones carrying a timing
signal anyway.

Four of this skill's endpoints are page-gated and each is bounded on its own, so a run
spanning tiers can walk every one of them to the per-endpoint hard ceiling and multiply
the bill without a single gate firing. The cross-endpoint ceiling that sees that shape
is `gates.yaml:skills.competitive_intel.max_pages_per_run`, counting pages across all
four in one run. Read it before planning a multi-tier run; if it does not resolve, the
run holds to one page-gated endpoint per tier.

**The old route is not used.** Older versions of this skill read company content
through `post_keyword_search` with a `fromCompany` filter. `post_keyword_search` is not
used by this skill: competitive-intel reads a named competitor's own posts, it does not
search posts by keyword, and no depth setting adds it. `linkedin_company_posts()` is the
supported route.

### `profile_activities()` — read this before you plan it

The most dangerous call in this skill, and it does not look dangerous.

- It bills **per result on `totalElements`** — the profile's whole matching activity
  history, not the page you asked for. `limit` bounds the page that comes back and
  does not bound the bill. A pagination token multiplies it as it goes.
- **The charge never appears in the response.** Every ledger line is written
  `estimated_unverifiable` (law 4), and no care afterwards turns that into an actual.
- It is in `gates.yaml:always_ask.endpoints`, so it confirms every time regardless of
  how little the session has spent, and in `gates.yaml:unbounded_endpoints.endpoints`,
  so every page after the first asks again. A single call large enough to cross
  `gates.yaml:session_budget.fractions.single_call_confirm` asks on its own.
- The catalog marks it bounded because a `limit` field exists. Gates says unbounded.
  **Gates is right and the runtime reads gates** — a field that bounds the page while
  the bill is levied on the total is not a bound.

So: **one executive per run, chosen rather than swept**, filtered to `POST` so a
reactive exec's thousands of reactions are not counted, and reported as a range that
keeps the word `estimated_unverifiable` in it. The ceiling that enforces the one-profile
rule is `gates.yaml:skills.competitive_intel.profile_activities_max_profiles` — read it,
and name the profile on the plan so the user approves a person rather than a count. If
the key does not resolve the check reads STOP and this call is refused; a missing
ceiling is never a generous one.

A competitive sweep is the worst possible place to fan this endpoint. Three rivals times
three executives is nine unbounded calls whose charges cannot be reconciled.

**YouTube.** Four flat calls, and flat is the whole reason they are here.
`youtube_search()` finds the channel when you only have a name; `youtube_channel()`
returns the channel's own metadata; `youtube_channel_videos()` lists what they have
shipped; `youtube_video()` reads one video in full. For a competitor running a content
motion this is the cheapest voice signal in the skill, and unlike the LinkedIn pair
every one of these has an exact price on the plan.

## Tier 4 — scale (opt-in)

`similarweb_scraper_sync()` takes a domain and has **no bound of any kind** — no limit,
no page, no cap. It bills per result on a synthetic list count whose value is not in the
response, so it is both page-gated in `gates.yaml:unbounded_endpoints.endpoints` and
written `estimated_unverifiable`. It is the single line in this skill most likely to be
approved casually because "traffic" sounds like one number.

It answers one genuinely useful question — is the rival's audience an order of magnitude
away from ours, or the same size — and that question rarely needs re-asking. Check the
cache first: this endpoint resolves through
`gates.yaml:cache_ttl.capability_groups.web_intelligence` to
`gates.yaml:cache_ttl.classes.funding_tech`, which is one of the longer windows in the
file.

## The tier map the tests read

The block below is the machine-readable form of the table above. The eval suite runs it,
so a tier that drifts from its prose fails rather than rots.

```yaml competitive-intel-tiers
default_tier: posture
one_competitor_per_run_until: skills.competitive_intel.max_competitors_per_sweep

tiers:
  posture:
    question: What have they built, what are they measuring, is anyone searching?
    default: true
    opt_in: false
    endpoints:
      - website_intelligence
      - web_tech_stack
      - web_pixels
      - search_google_trends
    cost_shape: exact          # every call flat; no page-gated endpoint permitted

  paid_acquisition:
    question: What are they buying, and what are they saying in it?
    default: false
    opt_in: true
    endpoints:
      - linkedin_ad_search
      - linkedin_ad_details
      - google_ad_transparency_scraper_sync
      - meta_ads_library_scraper_sync
    cost_shape: ceiling

  voice:
    question: What are they publishing, and who is saying it?
    default: false
    opt_in: true
    endpoints:
      - linkedin_company_posts
      - profile_activities
      - youtube_search
      - youtube_channel
      - youtube_channel_videos
      - youtube_video
    cost_shape: ceiling

  scale:
    question: How big is the traffic behind all of it?
    default: false
    opt_in: true
    endpoints:
      - similarweb_scraper_sync
    cost_shape: ceiling

# The ceilings this skill reads, and what each one closes if it ever stops
# resolving. Every guarded path is STOP on a missing key (law 5) — gateValue()
# throws MissingGateKey and the check fails closed. `closed_behaviour` is the
# fallback, not the normal path: all four keys resolve in _lib/gates.yaml today.
pending_gate_keys:
  skills.competitive_intel.max_competitors_per_sweep:
    bounds: competitors in one sweep
    closed_behaviour: one competitor per run
  skills.competitive_intel.max_pages_per_run:
    bounds: pages accumulated across all four page-gated endpoints in one run
    closed_behaviour: one page-gated endpoint per tier per run
  skills.competitive_intel.ad_details_max_per_competitor:
    bounds: flat per-ad detail fetches after an ad search
    closed_behaviour: only ads the user picks explicitly off the results
  skills.competitive_intel.profile_activities_max_profiles:
    bounds: executives whose activity feed may be read in one run
    closed_behaviour: refused until a single named profile is approved on the plan

# Inference is local; the paid LLM hop is off.
inference:
  mode: local_agent
  reason: >-
    Reading ad copy, naming a positioning angle and writing the comparison are
    reading and writing, which the surrounding model does at no marginal cost.
    ai_enrich is metered per call and is not in this skill's endpoint set.
  ai_enrich_owned: false
```

## Dry-run the tiers, then take one approval

Never make the first call the first action. Every paid call goes through the gated
runtime, which prices the plan from the catalog, evaluates the gates against the plan,
journals before and after each call, writes a ledger line, and reads through the cache
first:

```bash
richapi call website_intelligence --param url=https://<domain> --param modules:='["tech_stack","pixels"]' --dry-run
richapi call web_tech_stack --param url=https://<domain> --dry-run
richapi call web_pixels --param url=https://<domain> --dry-run
richapi call search_google_trends --param keyword=<brand> --dry-run
richapi search linkedin_ad_search --param account_owner=<company> --pages 1 --dry-run
richapi call linkedin_ad_details --param ad_url=<url> --dry-run
richapi call google_ad_transparency_scraper_sync --param domain=<domain> --dry-run
richapi call meta_ads_library_scraper_sync --param url=<meta-ad-url> --dry-run
richapi search linkedin_company_posts --param company_linkedin_url=<url> --pages 1 --dry-run
richapi search profile_activities --param profile_url=<url> --param type=POST --pages 1 --dry-run
richapi call youtube_search --param query=<brand> --dry-run
richapi call youtube_channel --param channel_url=<url> --dry-run
richapi call youtube_channel_videos --param channel_url=<url> --dry-run
richapi call youtube_video --param video_url=<url> --dry-run
richapi search similarweb_scraper_sync --param domain=<domain> --pages 1 --dry-run
```

`--dry-run` makes **zero calls**. Read the plan with the user:

- **Per tier, not per endpoint.** "Posture is these four calls for this total" is a
  decision somebody can make. Fifteen priced lines is not.
- **Say which totals are ceilings and which are exact.** Tier 1 has an exact total.
  Every other tier has a per-page estimate built on
  `gates.yaml:unbounded_endpoints.assumed_results_per_page`, and the honest phrasing is
  a range with the basis named.
- **Say which lines can never be verified**, on the plan and not in the receipt:
  `profile_activities()`, `similarweb_scraper_sync()`,
  `google_ad_transparency_scraper_sync()` and `meta_ads_library_scraper_sync()` do not
  report their charge back.
- **Show the multiplier explicitly when more than one competitor is in the question.**
  Not "this is the plan" but "this is the plan, once per competitor". The multiplier is
  the thing users do not price in their heads.
- **Cache hits appear as skipped-not-charged.** Tech stack resolves through
  `gates.yaml:cache_ttl.endpoints.web_tech_stack`; ads and posts are deliberately short-
  lived through `gates.yaml:cache_ttl.capability_groups.ads_libraries` and
  `gates.yaml:cache_ttl.classes.posts_activity`, because a stale ad read is worse than
  none — it makes a rep argue against a campaign that ended. Trends and YouTube resolve
  through `gates.yaml:cache_ttl.capability_groups.search_trends` and
  `gates.yaml:cache_ttl.capability_groups.youtube`.

Then take **one approval for the whole plan**. Gate confirmations still fire inside the
run — the page gate, `gates.yaml:always_ask.endpoints`, and the session-spend fractions
at `gates.yaml:session_budget.fractions.confirm` and
`gates.yaml:session_budget.fractions.stop` — and those cannot be pre-approved away. A
missing gate key is a STOP and never "no gate" (law 5).

## The gate keys this skill still needs to resolve

Four thresholds bound this skill, all of them in `_lib/gates.yaml` under
`skills.competitive_intel`. Read them; none of them is ever typed into a plan by hand.
**Every path they guard is closed the moment one stops resolving** — `gateValue()`
throws `MissingGateKey`, the check reads STOP (law 5), and the run does less rather than
doing it unbounded. The `pending_gate_keys` block above is the executable copy of this
table, and its `closed_behaviour` is that fallback, not the normal path.

| Key | What it bounds | If it does not resolve |
|---|---|---|
| `gates.yaml:skills.competitive_intel.max_competitors_per_sweep` | Competitors in one sweep — the multiplier on every other line | One competitor per run; a sweep is refused |
| `gates.yaml:skills.competitive_intel.max_pages_per_run` | Pages across all four page-gated endpoints in one run | One page-gated endpoint per tier per run |
| `gates.yaml:skills.competitive_intel.ad_details_max_per_competitor` | Flat per-ad detail fetches after a search | Only ads the user picks explicitly |
| `gates.yaml:skills.competitive_intel.profile_activities_max_profiles` | Executives whose activity feed may be read | Refused until one named profile is approved |

Read a threshold rather than quoting one:

```bash
richapi gates unbounded_endpoints.hard_page_ceiling
```

## Where inference runs

### Inference mode: local

**This skill reasons locally, in this agent's context.** It does not call the pack's LLM
endpoint and that endpoint is not in its set — `_lib/endpoint-owners.yaml` gives
`ai_enrich` to `/research-agent`, `/personalize`, `/org-map`, `/reply-triage`,
`/icp-review` and `/call-intel`, and not to this one. Reading ad copy, naming the angle
behind it and writing the side-by-side is exactly what the agent running this skill
already does at no marginal cost; paying per call to have it done elsewhere buys nothing.

Neither condition that would justify the paid hop arises here. **Perplexity web
grounding** is the case for a question with no endpoint behind it, and this skill's
questions all have endpoints — grounding a claim to a URL is what the ad libraries and
the site endpoints already do, with a source line attached. **Batch scale** does not
arise while the sweep is capped at one competitor per run. A list of competitors with a
freeform question is `/research-agent`, which owns that hop and the dual contract that
validates it.

## Write the read — one source line per claim

The output is `gtm/competitive/<competitor>.md`, and where more than one competitor has
been run separately, a comparison assembled from those files rather than from a fresh
sweep.

```
Northwind Freight  vs  Baltic Haulage
                              Northwind                     Baltic
  Marketing stack             HubSpot, Segment              Marketo                        [web_tech_stack]
  Retargeting live            LinkedIn Insight, Meta        LinkedIn Insight               [web_pixels]
  Brand search trend          rising                        flat                           [search_google_trends]
  LinkedIn ads (90d)          21 creatives                  not_found                      [linkedin_ad_search]
  Lead ad angle               "cut carrier admin"           not_applicable                 [linkedin_ad_details]
  Meta ads                    not_found                     not_found                      [meta_ads_library_scraper_sync]
  Company posts (30d)         product-led                   not_verifiable                 [linkedin_company_posts]
  YouTube channel             weekly shipping demos         not_found                      [youtube_channel_videos]
  Monthly visits              not_verifiable                not_verifiable                 [similarweb_scraper_sync]
  Ad spend                    not_found                     not_found                      [no endpoint returns spend]
```

**Every line carries the endpoint it came from.** Not "sourced from the API" — the
endpoint name, because that is what makes a wrong fact debuggable and a stale one
detectable (law 6).

**A gap is written, never omitted.** Three tokens, and only these three — they are the
one explicit null enum in `_lib/dual-contract.schema.json`, and the aliases that schema
rejects are rejected here too:

- `not_found` — the call ran and there was nothing. A competitor running no LinkedIn ads
  is a finding about that competitor, and often the most actionable line in the file.
- `not_verifiable` — something came back but this pack cannot confirm it. Everything
  from the endpoints whose count field is absent from the response.
- `not_applicable` — the question does not apply. Ad creative angle for a rival with no
  ads; a YouTube read for a rival with no channel.

Silence is not one of the three. A row left out reads as "not checked", and the reader
cannot tell that from "checked and empty" — which is how a rep ends up asserting in a
deal review that a competitor is not advertising when nobody ever looked.

**Never fill a gap with strategy.** If you can reason your way to a likely explanation,
that reasoning belongs in a separate, labelled paragraph below the grid — never in a row
that carries a source endpoint.

## Report honestly

- **Never restate an estimate as a fact.** Where the receipt says
  `estimated_unverifiable`, the read and the summary say so too. Do not round a range
  into a single confident number because a grid looks tidier with one.
- **Report the tiers that were declined and what the read is therefore missing.** A
  Tier 1 read has no ad data in it. Say that at the top, so nobody reads the absence of
  ads as evidence of no ads.
- **Report the not-founds as a group** and compare coverage against
  `gates.yaml:quality_stops.coverage_min_pct`. Say plainly when a read is too thin to
  carry a positioning decision.
- **Normalise before comparing.** Post counts and headcounts scale with company size;
  comparing raw totals between a rival five times your size and one your own size
  produces a confident and meaningless conclusion.
- **Say what a second pass would cost.** Usually much less than the first, because the
  stack and the traffic sit in the longer cache windows while ads and posts do not.

## What this skill will not do

- **It will not run the whole menu.** No flag runs every tier. A skill that can spend
  its entire endpoint surface in one keystroke is a billing incident waiting for a typo.
- **It will not sweep several competitors in one run** past the multiplier's own
  ceiling, `gates.yaml:skills.competitive_intel.max_competitors_per_sweep` — and it will
  not sweep at all if that ceiling stops resolving. Past it, or without it, the
  comparison is assembled from separate runs the user approved separately.
- **It will not report ad spend.** No endpoint in this pack returns it. Ad count is not
  spend, and presenting one as a proxy for the other is the single most repeated lie in
  competitive intelligence.
- **It will not fan `profile_activities()` across executives**, and it will not present
  its cost as an actual. One profile, chosen, page-gated, reported as a range.
- **It will not search posts by keyword.** `post_keyword_search` is not used by this
  skill, and an earlier version of this skill used it as the main route to company
  content. It is not coming back through a depth setting.
- **It will not assert a strategy it did not fetch.** No plausible-sounding filler, no
  inference dressed as a source line, no row quietly omitted because it came back empty.
- **It will not contact anybody it finds.** The executives Tier 3 surfaces are evidence,
  not a prospect list; enrichment belongs to the waterfall, and
  sending is deliberately external to this pack, permanently.
- **It will not tell you what to do about it.** Positioning, messaging and pricing
  responses are decisions this skill supplies evidence for and does not make.

## Related

- The same site, ad and post endpoints pointed at a prospect instead of a rival, plus
  the firmographics this skill does not own:
  [`/account-research`](../account-research/SKILL.md).
- Map the committee at a competitive account before you multithread it:
  [`/org-map`](../org-map/SKILL.md).
- Turn a competitor's customer profile into an account universe:
  [`/build-prospect-list`](../build-prospect-list/SKILL.md), and check the shape of that
  market with [`/tam-map`](../tam-map/SKILL.md).
- Put this read on a schedule and receive the diff rather than the whole file each time:
  [`/signal-watch`](../signal-watch/SKILL.md).
- Turn a competitive finding into copy, where an unsourced claim is refused:
  [`/personalize`](../personalize/SKILL.md).
- Session start, routing and the closing receipt:
  [`/richapi-gtm`](../richapi-gtm/SKILL.md).
- Every threshold this skill cites, printed with the key it came from: `richapi gates`.
