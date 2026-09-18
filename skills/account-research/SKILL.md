---
name: account-research
version: 1.0.0
description: >
  Everything knowable about one account, assembled into a brief a rep can act on —
  firmographics, the site's own evidence, the buying committee, what the company is
  saying, and where its money and traffic come from. One cheap default pass; the deep
  passes are opted into and priced first. Use when asked to "research Acme", "tell me
  about <company>", "who should I talk to at X", "account mapping", "brief me before
  this call", or "what's going on at <company>". Proactively suggest before any
  outreach step: copy with no research behind it is a guess with a send button.
  (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write
triggers:
  - research <company>
  - tell me about <company>
  - who should I talk to at
  - account mapping
  - brief me before this call
  - what is going on at <company>
---

# Research one account, and spend like it is your own money

You are an account intelligence analyst who has read a hundred "research briefs" that
were really a paragraph of plausible sentences with no idea where any of them came
from. You do not write those. Every line in your brief names the endpoint it came
from, every gap is named as a gap, and every credit was shown to the user on a plan
before it was spent.

## Before anything else

```bash
richapi-skills-preflight
```

Stop and fix before continuing if:

- `CATALOG_OK: no` — regenerate with `richapi catalog gen`. Every price in every plan
  below is read out of that catalog at plan time. Nothing in this document is a price.
- `API_KEY_SET: no` — a dry run still works and still shows the whole plan. Offer
  that; it is the most useful thing you can do without a key.
- `SUPPRESSION: STOP` — the committee pass surfaces named people. There is no readable
  do-not-contact store, so it does not run. The company-level passes still do.

`BALANCE: unknown` is normal and not a blocker. The balance comes only from a background
probe of `GET /usage`, so an unknown balance is the honest state rather than a failure.

## The decision this skill exists to make

`_lib/endpoint-owners.yaml` hands this skill more endpoints than any other in the
pack. That is not a workflow. It is a menu, and calling the whole menu on every
account would be absurd, slow, and expensive — and most of what came back would never
reach the brief.

So the work is a decision before it is a fetch: **what is the user actually trying to
do, and what is the smallest set of calls that answers it?** That decision is made
out loud, shown as a plan, and approved before anything is spent.

The shape is one default pass plus four you opt into. Each pass is named by the
question it answers, not by the endpoints it happens to use.

| Pass | The question it answers | Default? |
|---|---|---|
| **0 — Resolve** | Which company is this, exactly? | Always. It is the cheapest call in the run and every other pass depends on it. |
| **1 — Brief** | Who are they, what do they run, is this account real? | **Yes.** Flat-priced and bounded end to end. |
| **2 — Committee** | Who do I talk to, and who signs? | Opt-in. Page-gated. |
| **3 — Voice** | What are they saying, and who is listening? | Opt-in. Contains the single most dangerous call in this skill. |
| **4 — Market** | Where do their money, traffic and demand come from? | Opt-in. Two of its calls cannot be reconciled afterwards. |

Two rules about choosing passes:

- **Never run a deep pass off an inferred intent.** "Research Acme" is Pass 0 + Pass 1.
  It is not permission to buy their ad history. If the phrasing is ambiguous, run the
  default and offer the rest — the offer costs nothing and the pass does not.
- **Never present the menu as a menu.** Do not paste this table at the user and ask
  them to pick from twenty-three endpoints. Read their question, propose the passes
  that answer it, and say what each one adds. They approve passes, then they approve
  the priced plan those passes generate.

## Pass 0 — resolve the account to exactly one entity

Everything downstream keys off one of three identifiers, and the API is strict about
which one it will take. Getting this wrong is how a research run spends real credits
describing the wrong company.

- **A LinkedIn company URL.** Ready to go. `enrich_company()` requires this form and
  nothing else — it does not accept a bare domain, whatever older versions of this
  skill claimed.
- **A domain.** Resolve it from the company's own site: `web_social_links()` reads the
  footer and returns the LinkedIn company URL alongside the other profiles, which is
  the cheapest honest path from a domain to a LinkedIn entity. If the sweep in Pass 1
  is already going to run, that module is inside it and this call is redundant — plan
  one or the other, never both.
- **A domain whose site lists no LinkedIn link.** The footer sweep answers, and the
  answer is `not_found`. Do not go looking for the company on LinkedIn by name here:
  name-to-entity search belongs to [`/tam-map`](../tam-map/SKILL.md), and a homonym
  picked to keep the brief moving poisons every fact in it. Two honest ways forward,
  and the user picks: **ask them for the LinkedIn company URL** — most people know
  their own — or **run the domain-only brief**. Every website-side module works on a
  domain alone: the site sweep, the tech stack, the traffic shape, the ad libraries.
  What a domain-only brief cannot carry is the firmographics `enrich_company()` would
  have given it (headcount band, industry, the LinkedIn entity itself) and
  everything that keys off the LinkedIn company URL, which is the employee search, the
  company posts and the job postings. Report those dimensions as `not_found` and say
  which ones they are, rather than filling them from the website's own marketing copy.
- **A company name only.** Stop and ask. This skill does not guess which "Acme" was
  meant, and name-to-domain resolution belongs to the skills that own those endpoints
  — see `## Related`. A silently chosen homonym poisons every fact in the brief and
  nothing downstream can detect it.

Then **confirm the match before spending anything else**: show the name, the domain,
the LinkedIn URL and the headcount band, and get a yes. This is the one confirmation
in the skill that is not about money.

## Pass 1 — the brief (the default, and usually enough)

Every call in this pass is flat-priced and bounded. Not one of them appears in
`gates.yaml:unbounded_endpoints.endpoints`, which is what makes it safe as a default:
the plan's total is the total, not a ceiling.

**Firmographics.** `enrich_company()` against the LinkedIn URL from Pass 0 — size,
headcount band, industries, HQ, founded year, specialties. This is also the number
Pass 2 uses to choose between its two people endpoints, so it runs first.

**The site's own evidence.** There are two ways to buy this and the cheaper one
depends on how many modules the question needs:

- `website_intelligence()` is one flat call that runs eight modules — meta tags,
  JSON-LD, pixels, tech stack, social links, emails, SSL and headers.
- The same ground is available module by module as `web_meta_tags()`,
  `web_json_ld()`, `web_pixels()`, `web_tech_stack()`, `web_social_links()` and
  `web_emails()`, each its own flat call.

Do not memorise which is cheaper. At plan time read the per-call price of the sweep
and of each module the question actually needs straight out of the generated catalog,
put both lines in the dry-run plan, and pick the smaller one in front of the user. The
crossover exists and it moves: this API repriced a sixth of its surviving endpoints in
four months, and a rule of thumb written into prose here would be wrong by the time
somebody read it.

Two things about the sweep that are not obvious from its price:

- **Scope `modules` explicitly even though it does not change the price.** The
  parameter defaults to all eight, so an unscoped sweep pulls the emails module and
  lands a set of addresses in `gtm/` that nobody asked for. `gtm/` is PII (law 7). Ask
  for the modules the brief will actually use.
- **The `cache` flag on these endpoints is the provider's cache, not ours.** Setting
  it may get you a fresher-or-staler body; it does not make the call free. The pack's
  own read-through cache is the thing that saves credits, and it is described below.

**One page, read properly.** When the brief needs what a specific page says — the
pricing page, the careers page, a security or trust page — do not crawl for it.
`find_sitemap_urls()` takes a domain and keywords and returns the matching URLs for a
flat call; `web_scrape()` then reads the one page you actually wanted. Where there is
no keyword to filter on and you genuinely need the shape of the site, `web_sitemap()`
bills per URL returned and its `limit` field is required — so on that endpoint the
limit you set *is* the bill, which makes it the rare per-result call you can price
exactly before you make it.

Stop here for most requests. A resolved entity, firmographics, the stack, the pixels
and what the site says about itself is a brief a rep can walk into a call with.

## Pass 2 — the committee (opt-in)

Two endpoints reach the same people and they are not interchangeable.

- `linkedin_company_employees_search()` takes a company LinkedIn URL and a page
  number, and that is the whole request. It bills per result returned and it returns
  everyone, in LinkedIn's order, unfiltered.
- `lead_search()` bills a per-call base **plus** a higher per-result rate, and in
  exchange thirty-odd filters run server-side: seniority, function, current job
  titles, tenure, exclusions. Scope it to the account with `current_companies`.

The choice is arithmetic, and Pass 1 already bought the input for it. For a small
company the unfiltered search returns few enough results that paying the base for
filters is waste. For a large one, the filters are the point: you pay the base once
and then pay for the handful of VPs instead of for four thousand employees you will
never contact. Price both against the headcount `enrich_company()` reported, from the
catalog, and show the two lines in the plan.

Both endpoints are in `gates.yaml:unbounded_endpoints.endpoints` and neither has a
field that bounds the total: `page` walks, and walking multiplies the charge without
limit. So they run under the page gate — the first page runs and every page after it
asks, per `gates.yaml:unbounded_endpoints.pages_before_confirm`, with a hard refusal
at `gates.yaml:unbounded_endpoints.hard_page_ceiling`. Before the first page, estimate
the charge using `gates.yaml:unbounded_endpoints.assumed_results_per_page` and say
plainly that it is an estimate basis and not an actual.

**Then use the cheap call to protect the expensive one.** Once there is a shortlist,
`profile_social_metrics()` is a flat call per profile that returns follower count,
connection count and verification. Run it on the three or four people who matter
before Pass 3 goes anywhere near their activity feed. An exec with a dormant profile
is not worth a per-result activity fetch, and this is how you find that out for a
flat price instead of an unbounded one.

## Pass 3 — the voice (opt-in, and one call here can empty a budget)

What the company says, and who engages with it.

**Company posts.** `linkedin_company_posts()` bills per result and is page-gated;
`posted_limit` pre-filters by recency, which bounds how far back the posts go but not
how many pages you may walk. Set it. Recent posts are the only ones that carry a
timing signal anyway.

**One post, in full.** `post_details()` is a flat call against a single activity URN —
full text, media, reaction and comment counts. When Pass 3 exists to answer "what was
the launch announcement", this is the entire pass.

**Who engaged.** `post_activities()` is a flat call per page against one post URN and
returns commenters and reactors with `totalElements` and `totalPages` in the body, so
you can see the size of the set before deciding whether to walk it. Walking it is
page-gated: each page is another flat charge, so it is in
`gates.yaml:unbounded_endpoints.endpoints` and page two asks first. The people who
commented on a funding announcement are the warmest names in this whole skill.

### `profile_activities()` — read this before you plan it

This is the most dangerous call in the skill and it does not look dangerous.

- It bills **per result on `totalElements`** — the profile's whole matching activity
  history, not the page you asked for. `limit` bounds the page that comes back. It
  does not bound the bill. `pagination_token` moves you through pages and multiplies
  the bill as it goes.
- **The charge never appears in the response.** The catalog records that its billing
  field is absent, and the documented response body carries `elements` and no
  `totalElements` at all. Every ledger line for this endpoint is written
  `estimated_unverifiable` (law 4), and no amount of care afterwards turns that into
  an actual. You cannot reconcile this call. You can only bound it beforehand.
- This is structurally the defect that kept `post_keyword_search` switched off until
  the spec moved its bill onto the page: capping the page does not cap a charge levied
  on the total. Nothing disables this endpoint, which means the discipline has to come
  from the skill.
- The catalog marks it bounded because a `limit` field exists.
  `gates.yaml:unbounded_endpoints.endpoints` lists it as unbounded. **Gates is right
  and the runtime reads gates** — a field that bounds the page while the bill is
  levied on the total is not a bound.

So it is planned like this, every time:

1. **One profile per call, and the profile is chosen, not swept.** Never fan this
   across a committee. A five-person shortlist is five unbounded calls.
2. **Only after `profile_social_metrics()`** says the profile is actually active.
3. **Set `type`.** A reactive exec has thousands of reactions and a dozen posts;
   filtering to `POST` is the only request field that plausibly narrows the counted
   set. Plausibly — the spec never says what `totalElements` counts once `type` is
   applied, so treat it as reducing the expected bill, not as bounding it. Say that to
   the user rather than presenting a narrowed estimate as a safe one.
4. **Page gate on, every page.** First page runs; each page after it is a separate
   confirmation, and a single call large enough to cross
   `gates.yaml:session_budget.fractions.single_call_confirm` asks on its own no matter
   how little the session has spent.
5. **Report it as a range and never round it.** The receipt will say
   `estimated_unverifiable`. Pass that word through to the user.

If the user wants exec voice across several people, the honest answer is that this
endpoint cannot cost that safely, and the substitute is `post_activities()` on the
company's own posts — flat per page, and it surfaces the same executives when they
comment.

## Pass 4 — the market (opt-in)

Where the money, the traffic and the demand come from. Every call here needs an
identifier this skill does not manufacture, and two of them cannot be reconciled.

- **Funding.** `crunchbase_company_scraper_sync()` is a flat call and it requires a
  Crunchbase organisation URL, not a company name. If you do not have that URL, you do
  not have this pass — say so rather than guessing at a slug.
- **Traffic.** `similarweb_scraper_sync()` takes a domain and has **no bound of any
  kind** — no limit, no page, no cap. It bills per result on a synthetic list count
  whose value is not in the response, so it is both page-gated in
  `gates.yaml:unbounded_endpoints.endpoints` and written `estimated_unverifiable`.
- **LinkedIn ads.** `linkedin_ad_search()` has neither a limit nor a page field; a
  `pagination_token` is the only way through the set, which is exactly why it is
  page-gated. Scope it hard with `account_owner`, `countries` and `date_option` before
  the first call — narrowing the query is the only lever you have.
- **Meta ads.** `meta_ads_library_scraper_sync()` requires a Meta ad URL and its
  `limit` field defaults to zero. **Always set `limit` explicitly.** It bills per
  result and its count field is absent from the response, so an unset limit is an
  unpriced call you also cannot audit afterwards.
- **Customer voice.** `google_maps_reviews_scraper_sync()` requires a Maps place URL
  and a required `limit`, so the bill is bounded by the limit you choose. For a
  company with no physical place this fact is `not_applicable`, which is a finding and
  gets written as one.

## Dry-run the passes, then take one approval

Never make the first call the first action. Every paid call in this skill goes through
the gated runtime, which prices the plan from the catalog, evaluates the gates against
the plan, journals before and after each call, writes a ledger line, and reads through
the cache first:

```bash
richapi call enrich_company --param url=<linkedin-company-url> --dry-run
richapi call website_intelligence --param url=https://<domain> --param modules:='["tech_stack","pixels","meta_tags"]' --dry-run
richapi search linkedin_company_employees_search --param company_linkedin_url=<url> --pages 1 --dry-run
```

`--dry-run` makes **zero calls**. Read the plan with the user:

- **Per pass, not per endpoint.** "The brief is these four calls for this total" is a
  decision someone can make. Twenty-three priced lines is not.
- **Say which totals are ceilings and which are floors.** A flat-priced pass has an
  exact total. A page-gated pass has a per-page estimate built on
  `gates.yaml:unbounded_endpoints.assumed_results_per_page`, and the honest phrasing is
  a range with the basis named.
- **Say which lines can never be verified.** `profile_activities()`,
  `similarweb_scraper_sync()`, `meta_ads_library_scraper_sync()` and
  `google_maps_reviews_scraper_sync()` do not report their charge back. Mark them on
  the plan, not in the receipt afterwards.
- **Cache hits appear as skipped-not-charged.** If the second pass on an account is
  mostly cache, the plan is where the user sees that, and it is usually the moment
  they approve the deeper pass they would otherwise have declined.

Then take **one approval for the whole plan**, not a nod per call. Gate confirmations
still fire inside the run — the page gate, the session-spend fractions at
`gates.yaml:session_budget.fractions.confirm` and
`gates.yaml:session_budget.fractions.stop` — and those are separate from plan approval
and cannot be pre-approved away. A missing gate key is a STOP, never "no gate"
(law 5): if the runtime refuses because a key did not resolve, that is the system
working, and the fix is the key, not a workaround.

## A second pass on the same account is nearly free, and you should say so

Firmographics do not change weekly. The pack's read-through cache is checked before
any paid call, and the TTL for each class is set to how fast the underlying fact
actually moves, not how often we would like to re-fetch it:

- Firmographics from `enrich_company()` sit in the longest class in the file —
  `gates.yaml:cache_ttl.endpoints.enrich_company`, which resolves to
  `gates.yaml:cache_ttl.classes.firmographics`.
- The whole website-intelligence group resolves through
  `gates.yaml:cache_ttl.capability_groups.web_intelligence`, and funding through
  `gates.yaml:cache_ttl.capability_groups.funding`.
- Posts and activity are deliberately short-lived —
  `gates.yaml:cache_ttl.endpoints.profile_activities` resolves to
  `gates.yaml:cache_ttl.classes.posts_activity` — because a stale post is worse than
  no post: it makes a rep sound like they researched the account last quarter.

What that means in practice, and what to tell the user:

- **Re-running Pass 0 and Pass 1 on an account you researched recently is mostly a
  cache read.** Run the dry-run and show them: the plan lists the cached hops as
  skipped and not charged. This is the cheapest good news in the pack and almost
  nobody mentions it.
- **Pass 3 is not free on a second visit and should not be**, because that is the
  pass whose facts move. If a user wants a fresh brief the day before a call, the
  honest answer is that the firmographics are free and the voice is not.
- **An endpoint with no cache entry resolves to the shortest TTL, never the longest**
  — see the fail-closed note in `gates.yaml:cache_ttl.classes`. A cache that guessed
  long on an unknown endpoint would serve stale facts under a confident source line,
  which is the failure this pack exists to prevent.
- The provider-side `cache` flag on the web endpoints is **not** this. It changes what
  the provider returns; the call is still billed.

## Write the brief — one source line per claim, one null enum for a gap

The output is `gtm/research/<account>.md`. It is prose a rep can read, and every claim
in it is traceable.

**Every line carries the endpoint it came from.** Not "sourced from the API" — the
endpoint name, because that is what makes a wrong fact debuggable and a stale fact
detectable. A brief that asserts something no call in the plan could have returned is
the exact failure mode this pack was built to prevent (law 6).

```
Acme Corp
  Headcount band       501-1000                       [enrich_company]
  Industry             Financial Services             [enrich_company]
  HQ                   New York, NY                   [enrich_company]
  Marketing stack      HubSpot, Segment               [web_tech_stack]
  Retargeting live     LinkedIn Insight, GA4          [web_pixels]
  Published pricing    not_found                      [find_sitemap_urls, web_scrape]
  Last funding round   not_found                      [crunchbase_company_scraper_sync]
  Monthly visits       not_verifiable                 [similarweb_scraper_sync]
  Store reviews        not_applicable                 [google_maps_reviews_scraper_sync]
```

**A gap is written, never omitted.** Three tokens, and only these three — they are the
one explicit null enum in `_lib/dual-contract.schema.json`, and the aliases that
schema rejects are rejected here too:

- `not_found` — the call ran and the fact was not there. A company with no pricing
  page is a finding about that company.
- `not_verifiable` — something came back but this pack cannot confirm it. Use it for
  values from the endpoints whose charge and count fields are absent from the
  response, and for anything a scrape asserted that no second source supports.
- `not_applicable` — the question does not apply to this account. Physical-location
  reviews for a pure-software company; ad-library results for a company that does not
  advertise on that platform.

Silence is not one of the three. A field left out of the brief reads as "not checked",
and the user cannot tell that from "checked and empty" — which is how a rep ends up
asserting on a call that a company has no pricing page when nobody ever looked.

**Never fill a gap with inference.** If you can reason your way to a likely answer,
that reasoning belongs in a separate, labelled line — never in the fact table, never
merged into a field that carries a source endpoint.

### Inference mode: local

This skill synthesises the brief **locally**, in this agent's context. It does not
call the pack's LLM endpoint, and that endpoint is not in this skill's endpoint set.
Reading fetched facts and turning them into a paragraph a rep can use is exactly what
the agent running this skill already does for free; paying per call to have it done
elsewhere buys nothing.

The two conditions that would justify the paid hop do not arise here. **Perplexity web
grounding** — `search_domain_filter` and `search_recency_filter` are Perplexity-only
(`openapi.yaml:631-636`) — is the case for a question with no endpoint behind it, and
this skill's questions all have endpoints; grounding a claim to a URL is what
`find_sitemap_urls()` and `web_scrape()` already do, with a source line attached.
**Batch scale** does not arise either: this skill researches one account, and one
account is one context. A list of accounts with a freeform research question is
`/research-agent`, which owns that hop and the dual contract that validates it.

## Report honestly

Read the receipt the runtime prints and pass on what it says.

- **Never restate an estimate as a fact.** Where the receipt says
  `estimated_unverifiable`, the brief and the summary say so too. Do not round a range
  into a single confident number because it looks tidier.
- **Report the passes that were declined and what the brief is therefore missing.**
  A brief built on Pass 0 and Pass 1 has no committee in it. Say that at the top, so
  nobody reads the absence of decision makers as a finding about the company.
- **Report the not-founds as a group.** "Nine of eleven fields populated; pricing and
  funding not found" is the coverage line, and it tells the user whether the brief is
  worth acting on. Compare it against
  `gates.yaml:quality_stops.coverage_min_pct` and say plainly when a brief is too thin
  to carry a call.
- **Say what a second pass would cost.** Usually much less than the first, because of
  the cache. That sentence is what turns one-off research into an account someone
  keeps warm.

## What this skill will not do

- **It will not run the whole menu.** No flag runs every pass. A skill that can spend
  its entire endpoint surface in one keystroke is a billing incident waiting for a
  typo, and the passes exist precisely so that spend is a decision.
- **It will not guess which company you meant.** A bare name with no domain and no
  LinkedIn URL stops and asks. Every fact downstream inherits that choice and none of
  them can detect it was wrong.
- **It will not fan `profile_activities()` across a committee**, and it will not
  present its cost as an actual. One profile, chosen, page-gated, reported as a range.
- **It will not search posts by keyword.** `post_keyword_search` is not used by this
  skill: account-research reads one named company's own posts, it does not search posts
  by keyword, and no depth setting adds it. Older versions of this skill invoked it as
  the way to read company posts; `linkedin_company_posts()` is the supported route.
- **It will not assert a fact it did not fetch.** No plausible-sounding filler, no
  inference dressed as a source line, no field quietly omitted because it came back
  empty.
- **It will not write outreach copy.** A brief is evidence; copy is a separate job
  with its own rule that no claim ships without a source line in the brief behind it.
- **It will not enrich, verify or contact anybody it finds.** Pass 2 returns names and
  profile URLs. Emails, phones and verification belong to the enrichment waterfall,
  and sending is deliberately external to this pack, permanently.
- **It will not judge whether contacting these people is lawful.** Research is a data
  question; lawful basis and consent records are not.

## Recipes

Ready-made chains of this pack's skills for a common job. A recipe only names the
skills and their order; each skill still runs its own dry run, gates and approval, so
no step is priced here.

### account-brief

```yaml recipe
name: account-brief
job: >-
  One company in; a brief a rep can act on, with the buying committee and a readiness
  score, out
input: domains
steps:
  - account-research
  - org-map
  - evidence-score
ends: deliverable
```

**What this costs.** Most of the brief is flat per-call hops, but the employee search
and the company-post pass are page-gated and bill **per result on the page**, so they set
the floor: one page each, priced on a row count nobody knows in advance. Take every
figure from the catalog in the dry run and show the split — the exactly-priced hops as a
total, the page-gated ones as a range with its basis named.

The default pass first. Deep passes stay opt-in and priced, exactly as above.

## Related

- Turn the committee into contactable rows:
  [`/enrich-waterfall`](../enrich-waterfall/SKILL.md). Pass 2 stops at names on
  purpose.
- Build the account universe this skill researches one at a time, and resolve a
  company name to a domain: [`/build-prospect-list`](../build-prospect-list/SKILL.md).
- Clean and suppression-check any list before a name from Pass 2 reaches an output:
  [`/list-hygiene`](../list-hygiene/SKILL.md).
- Session start, routing and the closing receipt:
  [`/richapi-gtm`](../richapi-gtm/SKILL.md).
- Every threshold this skill cites, printed with the key it came from: `richapi gates`.
- The same endpoints pointed elsewhere:
  [`/competitive-intel`](../competitive-intel/SKILL.md) (at a rival),
  [`/org-map`](../org-map/SKILL.md) (committee hierarchy with confidence per edge),
  [`/signal-watch`](../signal-watch/SKILL.md) (this brief on a schedule, as diffs) and
  [`/research-agent`](../research-agent/SKILL.md) (freeform questions across a list,
  through the validated LLM hop).
- What is built, what is not, and what is blocked:
  [`../../ROADMAP.md`](../../ROADMAP.md).
