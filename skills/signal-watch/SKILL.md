---
name: signal-watch
version: 1.0.0
description: >
  Watches a list of accounts for the moment they become buyable (hiring, ads, posts,
  tech-stack moves, funding, news, champion departures) and writes each change to
  `triggers.jsonl` as a dated digest of diffs rather than a wall of static facts. The
  only recurring-cost skill in the pack: it prices the whole standing charge per cycle,
  per week and per month before the first cycle runs, and re-prices it when the catalog
  moves. Also runs in customer mode over accounts that already pay you, for expansion
  and churn. Use when asked to "monitor these accounts", "watch this list", "buying
  signals", "hiring intent", "trigger digest", "alert me when X starts hiring", "who is
  about to churn", or "what changed this week". (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write
triggers:
  - monitor these accounts
  - watch this list for buying signals
  - hiring intent
  - trigger digest
  - alert me when <company> starts hiring
  - what changed this week
  - watch my customers for churn signals
---

# Watch a list of accounts, and know exactly what the watching costs per week

You are the person who owns a standing charge. Every other skill in this pack is a
purchase: a human asks, credits are spent, the receipt closes the session. This one is
a **subscription**. It spends on a clock, it keeps spending while nobody is looking,
and the number that matters is not what one cycle costs — it is what the cycle costs
multiplied by every cycle between now and whenever somebody remembers to turn it off.

So the first artifact this skill produces is not a digest. It is a price for the
subscription.

## Before anything else

```bash
richapi-skills-preflight
```

Stop and fix before continuing if:

- `CATALOG_OK: no` — regenerate with `richapi catalog gen`. Every price in the
  subscription line below is read out of that catalog at plan time. Nothing in this
  document is a price, and a standing charge quoted from stale prices is worse than no
  quote at all.
- `API_KEY_SET: no` — a dry run still works and still produces the whole subscription
  line. Offer that: pricing a watch you have not started is the most useful thing you
  can do without a key, and it is the decision the user actually has to make.
- `SUPPRESSION: STOP` — the people watch surfaces named individuals, so it does not
  run against an unreadable store. The company-level watches still do.

`BALANCE: unknown` is normal and not a blocker. The balance comes only from a background
probe of `GET /usage`, so an unknown balance is the honest state rather than a failure.
It is also the reason the subscription line matters more here than anywhere else in the
pack: there is no running total the user can glance at to notice a watch that has been
quietly billing since spring.

## The thing that makes this skill different: three multipliers, one ceiling

A cycle's cost is a product, not a sum:

```
cost_per_cycle = entities  ×  watches_enabled  ×  price_per_watch(catalog)
cost_per_week  = cycles_per_week  ×  cost_per_cycle
cycles_per_week = hours_in_a_week / interval_hours
```

`gates.yaml:watchlist.max_entities` bounds the first multiplier. Nothing in
`gates.yaml` bounds the product. Doubling the cadence doubles the bill without
touching a single ceiling, and adding one more watch to a large list is a bigger
change than adding fifty entities to a small one.

That gap is deliberate and it is why this skill exists in the shape it does: the
control is not a threshold, it is **a number stated out loud, in the unit the user
actually pays in, before the clock starts** — and restated in every digest afterwards.
A gate the user never sees fire is not a control. A weekly figure they read every
Monday is.

## Step 0 — the watchlist and its two ceilings

A watchlist is a named set of entities plus the identifiers each enabled watch needs.
Store it at `gtm/signals/watchlists/<id>.json`; snapshots go to
`gtm/signals/snapshots/<id>.json` and the trigger feed to `gtm/signals/triggers.jsonl`.

**Resolve identity once, at watchlist creation, not per cycle.** Each watch needs a
different key and none of them are manufactured here:

- **A LinkedIn company URL or universal name** — the posts watch and the hiring watch.
- **A domain** — the stack watch.
- **A company name** — the ads watch (`account_owner`) and the news watch.
- **A Crunchbase organisation URL** — the money watch. If you do not have that URL you
  do not have that watch for that entity; say so at creation rather than discovering it
  every cycle. Guessing a slug is how a subscription silently watches nothing.

An entity missing the identifier a watch needs is recorded `not_applicable` for that
watch, permanently and visibly, so a quiet account and an unwatchable one never look
alike.

**Then check the size against the real engine, never against your memory of it.**
`checkWatchlistSize` in `_lib/gates.mjs` reads `gates.yaml:watchlist.max_entities` and
`gates.yaml:watchlist.max_entities_hard_stop` and returns allow, confirm or stop. Do
not restate those ceilings as prose numbers and do not compare against them by hand —
a missing key there is a STOP, not "no ceiling" (law 5), and hand-comparison converts a
fail-closed stop into a fail-open shrug.

Two more ceilings shape the cycle rather than the list:

- `gates.yaml:watchlist.max_refresh_batch` — one cycle is executed in batches of at
  most that many entities. Each batch is journaled before and after every call and is
  resumable, so a cycle killed halfway does not re-charge the entities already done.
  The batch is also the blast radius of a mistake: a mis-scoped query costs one batch,
  not one watchlist.
- `gates.yaml:watchlist.min_refresh_interval_hours` — the floor on cadence. It is a
  floor, not a recommendation, and Step 2 explains why most watches should sit well
  above it.

## Step 1 — choose the watches

Seven watches. Each is named by the question it answers, and each is independently
priced, independently cadenced and independently toggled. Never present this as a menu
of endpoints; read what the user is trying to catch, propose the watches that catch it,
and let the subscription line do the arguing.

| Watch | The question it answers | Endpoint | Price shape | Default? |
|---|---|---|---|---|
| **W1 — News** | did anything public get said about them | `search_bing()` | flat per call, page-gated — exact at page one | **Yes** |
| **W2 — Stack** | did they add or drop a tool | `web_tech_stack()` | flat per call — exact | **Yes** |
| **W3 — Hiring** | are they buying headcount | `linkedin_job_search()`, then `linkedin_job_detail()` selectively | per result, page-gated + flat | Opt-in |
| **W4 — Ads** | are they spending to create demand | `linkedin_ad_search()` | per result, page-gated | Opt-in |
| **W5 — Voice** | are they saying something new themselves | `linkedin_company_posts()` | per result, page-gated | Opt-in |
| **W6 — Money** | did they raise, and did anyone write it up | `crunchbase_company_scraper_sync()`, `google_search_scraper_sync()` | flat + per result unverifiable | Opt-in |
| **W7 — People** | did a champion arrive or leave | `lead_search()` | base + per result, page-gated | Opt-in |

**The default set is the exactly-priceable one, and that is the whole reason it is the
default.** W1 and W2 are flat per call. Their subscription line is a total, not a
ceiling: the user approves a figure that is the figure. Every other watch is charged
per result on a count nobody can predict, so its weekly number is an estimate built on
`gates.yaml:unbounded_endpoints.assumed_results_per_page` — and an estimate compounded
over a schedule is how a monthly bill becomes a surprise.

An earlier version of this skill defaulted to hiring plus ads, which are the two
page-gated per-result endpoints in its set, and then printed a single confident weekly
figure for them. That default is reversed here on purpose. Hiring is usually the most
valuable watch and it should be the first thing a user adds — but it is added
knowingly, with a range and a named basis, not switched on by a word like "monitor".

Five of the seven watches (W1, W3, W4, W5, W7) are in
`gates.yaml:unbounded_endpoints.endpoints`. W1 is there because `search_bing()` takes
`page`: its price is flat per call, but each page is a separate call, so page one is
still an exact total and page two is a new charge that asks first. On a schedule that matters more than it
does anywhere else in the pack: an unbounded call made once is a decision, and an
unbounded call made every cycle is a policy.

## Step 2 — a watch cannot usefully run faster than its own cache TTL

This is the rule that surprises people, and it is the one that saves the most money.

The pack checks a read-through cache before every paid call. Poll a watch faster than
its cached fact expires and exactly one of two things happens, both bad:

- the call is served from cache — free, and it detects nothing, because it is the same
  body you already diffed; or
- you pass `--no-cache` to force a fetch — full price, every cycle, for a fact that
  has not moved.

So each watch has a **cadence floor equal to its own TTL**, and one watchlist runs its
watches on different clocks:

- News and the news half of money resolve through
  `gates.yaml:cache_ttl.capability_groups.search_trends`, and ads through
  `gates.yaml:cache_ttl.capability_groups.ads_libraries` — the short classes. These are
  the watches that can honestly run often.
- Voice resolves through `gates.yaml:cache_ttl.capability_groups.posts_activity`.
- Hiring and people resolve through
  `gates.yaml:cache_ttl.capability_groups.people_search`.
- Stack has its own entry at `gates.yaml:cache_ttl.endpoints.web_tech_stack`, and
  funding at `gates.yaml:cache_ttl.endpoints.crunchbase_company_scraper_sync`. Both sit
  in a long class, because a company does not swap its analytics vendor weekly. A
  daily stack watch is a daily bill for a monthly fact.
- The hiring detail hop, `linkedin_job_detail()`, is catalogued under enrichment and so
  resolves through `gates.yaml:cache_ttl.capability_groups.enrichment`, the longest
  class in the file. A job posting's description does not change after it is posted,
  which is exactly why that is right — and why re-reading the same posting across
  cycles costs nothing.

Read those keys with `richapi gates`, do not recite them, and set each watch's interval
to at least its own floor and never below
`gates.yaml:watchlist.min_refresh_interval_hours`. Where a user asks for everything
daily, this is the honest answer: two of the watches would be re-billing them for a
fact that changes monthly, and the answer costs less as well as being true.

## Step 3 — the subscription line, before the first cycle

**No cycle runs until this exists and has been approved.** Not the first cycle, not a
"quick look", not a one-shot scan that happens to touch the same endpoints.

Dry-run every enabled watch. `--dry-run` makes **zero calls** and prices the plan from
the generated catalog:

```bash
richapi call search_bing --param query="<entity> funding OR launch" --param limit=10 --dry-run
richapi call web_tech_stack --param url=https://<domain> --dry-run
richapi search linkedin_job_search --param company=<entity> --pages 1 --dry-run
richapi search linkedin_ad_search --param account_owner=<entity> --param date_option=last-30-days --pages 1 --dry-run
richapi search linkedin_company_posts --param linkedin_company_url=<url> --param posted_limit=week --pages 1 --dry-run
richapi search lead_search --param past_companies:='["<company-url>"]' --param recently_changed_jobs=true --pages 1 --dry-run
richapi call crunchbase_company_scraper_sync --param crunchbase_company_url=<url> --dry-run
richapi call google_search_scraper_sync --param search_query="<entity> raises" --param limit=1 --dry-run
```

Then assemble one artifact and show it. Nothing in it is typed; every figure is the
dry-run's own total multiplied out:

```
Watchlist "enterprise-q3"  —  N entities
  W1 News     search_bing            every <news floor>     exact
  W2 Stack    web_tech_stack         every <stack floor>    exact
  W3 Hiring   linkedin_job_search    every <hiring floor>   RANGE, page-gated
  ---------------------------------------------------------------------------
  per cycle   W1 <exact>  W2 <exact>  W3 <low>-<high>
  per week    <cycles_per_week × per cycle>, by watch
  per month   <weeks_per_month × per week>
  of which unverifiable: <the W6 news half, always>

  This is a STANDING charge. It repeats every cycle until you stop it.
  Estimate basis for the ranged rows: gates.yaml:unbounded_endpoints.assumed_results_per_page
```

Four rules about how that is presented:

- **Per week and per month, always, even when the user asked for one cycle.** A cycle
  cost is the number that feels small. The weekly figure is the number the user is
  actually agreeing to, and it is the one they will recognise on an invoice.
- **Exact rows and ranged rows are visually different.** W1 and W2 are totals. W3, W4,
  W5 and W7 are ranges whose basis is
  `gates.yaml:unbounded_endpoints.assumed_results_per_page` — a stated assumption, not
  an actual, and never rounded into a single confident figure because it looks tidier.
- **Name the unverifiable rows on the plan, not in the receipt afterwards.**
  `google_search_scraper_sync()` bills per result on a count field the response does
  not carry, so its ledger line is written `estimated_unverifiable` (law 4) every
  cycle, forever. A watch you can never reconcile is a fine thing to buy and a terrible
  thing to buy silently.
- **The approval is a standing approval, and it expires when its inputs change.**
  Re-take it whenever the watchlist grows, a watch is enabled, a cadence is shortened,
  or the catalog reprices an endpoint underneath it. That last case is not theoretical:
  a sixth of the surviving endpoints in this API repriced inside four months and
  `phone_finder` moved by more than eight-fold. Re-project on the cycle count in
  `gates.yaml:skills.signal_watch.reproject_every_cycles` and put the delta in the digest.

Then take **one approval for the subscription**, not a nod per call. Gate confirmations
still fire inside every cycle — the page gate, and the session-spend fractions at
`gates.yaml:session_budget.fractions.confirm` and
`gates.yaml:session_budget.fractions.stop` — and **a subscription approval cannot
pre-approve any of them.**

That is narrower than it may read, and the distinction is worth stating because
[`/scheduled-workflow`](../scheduled-workflow/SKILL.md) reaches the opposite conclusion
for its own case, correctly.

A subscription approval is given against a *projection*: entities times watches times
cycles, where several watches are priced from
`gates.yaml:unbounded_endpoints.assumed_results_per_page` and are therefore a range, not
a number. Approving a range cannot be consent to any particular later charge, so a
confirm inside a cycle is a real question that only a human can answer.

A scheduled run's envelope is the other shape: one run, one plan, one exact total the
user typed back to arm it. There, a `session_budget` confirm asks *"do you want to spend
this much of the budget you set?"* — and the envelope approval already is that answer.
So `/scheduled-workflow` accepts that one confirm unattended and stops on every other,
which is the narrower reading of the two. If these ever have to become one rule, take
that one.

Neither reading softens `always_ask`: those endpoints confirm regardless of remaining
budget, so no approval of any kind reaches them.

## Step 4 — the first cycle is a baseline, not a digest

On a watchlist's first cycle everything looks new, because nothing has been seen
before. A digest of five hundred "new" rows is noise wearing the costume of signal, and
it teaches the user to skim the second one. So the first cycle captures state, emits no
triggers, and says so: *baseline established, real triggers start next cycle.*
`gates.yaml:skills.signal_watch.baseline_first` holds that as policy rather than as habit.

The impatient case has an honest answer for some watches and not for others, and the
difference is in the request bodies:

- `linkedin_ad_search()` takes `date_option` (and a custom `start_date` / `end_date`),
  so a first cycle can legitimately look back and call what it finds recent.
- `linkedin_company_posts()` takes `posted_limit` and `scrape_posted_limit`, both
  recency pre-filters, so the same applies.
- `search_bing()` and `google_search_scraper_sync()` are queries; recency lives in the
  query text and in what a human judges to be current.
- **`linkedin_job_search()` has no date field at all.** Title, company, location,
  geoId, jobType, experienceLevel, page — that is the whole request body. There is no
  `datePosted`, whatever older versions of this skill claimed. Hiring recency here is
  produced *only* by diffing against a previous snapshot, which means the hiring watch
  genuinely cannot deliver a real trigger on cycle one. Say that instead of presenting
  a full board of open roles as a set of triggers.

## Step 5 — run a cycle

Order the watches cheapest-first so the cost debt is visible as it accumulates, and run
in batches of `gates.yaml:watchlist.max_refresh_batch`.

- **The page gate applies per endpoint, per entity, every cycle.** Page one runs and
  every page after it asks, per `gates.yaml:unbounded_endpoints.pages_before_confirm`,
  with a hard refusal at `gates.yaml:unbounded_endpoints.hard_page_ceiling`. On a
  schedule the correct posture is page one only: a watch is looking for *what changed*,
  and change shows up at the top of a freshly sorted result set. Walking pages on a
  recurring sweep buys history you already have in the snapshot.
- **Bound the cycle across endpoints too.** Each page-gated endpoint is bounded
  individually, so one entity can walk five different unbounded watches to the ceiling
  and multiply the bill fourfold without any single gate firing.
  `gates.yaml:skills.signal_watch.max_pages_per_run` is the cross-endpoint ceiling for one cycle.
- **Set every bounding field explicitly, and know which ones bound the bill.** Two
  request fields in this skill are both called `limit` and they do opposite things:
  `search_bing()` is flat per call, so its `limit` changes what comes back and not what
  you pay; `google_search_scraper_sync()` is per result with a `limit` that defaults to
  zero and counts *pages*, so leaving it unset is an unpriced call you also cannot
  audit afterwards. Always set it.
- **Scope the ads watch hard before the first call.** `linkedin_ad_search()` has no
  limit and no page field; `pagination_token` is the only way through the set, which is
  why it is page-gated. `account_owner`, `countries` and `date_option` are the only
  real levers, and narrowing the query is cheaper than gating the walk.
- **Use `linkedin_job_detail()` as a scalpel, not a sweep.** It is flat per call and it
  is the right way to read one posting properly — but only for roles whose title
  matches the high-signal pattern the user defined at watchlist creation. Pulling the
  description of every junior opening, every cycle, forever, is the single easiest way
  to make this skill expensive. `gates.yaml:skills.signal_watch.max_job_details_per_cycle` caps it.
- **Resume rather than restart.** A killed cycle resumes from the journal and pays only
  for the entities it did not finish. Restarting a cycle from the top re-charges the
  batch that already succeeded.

## Step 6 — the diff, the digest, and `triggers.jsonl`

**A trigger is a change, not a state.** Read the new snapshot against the previous one
and emit only the delta. Then write the new snapshot.

Every trigger line in `gtm/signals/triggers.jsonl` carries the endpoint it came from,
the cycle it was found in, and both sides of the change — plays downstream read this
file and a play cannot be debugged from a trigger that does not say where it came from
(law 6).

```
{"entity":"acme.com","watch":"hiring","endpoint":"linkedin_job_search",
 "change":"added","before":null,"after":{"job_id":"...","title":"VP RevOps"},
 "cycle":"2026-08-29T09:00:00Z","cost_status":"verified"}
```

**A watch that could not run is written, never omitted.** Three tokens, and only these
three — they are the explicit null enum in `_lib/dual-contract.schema.json`:

- `not_found` — the watch ran and there was no change. Silence from a live watch is a
  finding about the account.
- `not_verifiable` — something came back but the pack cannot confirm it. The news half
  of the money watch is written this way every cycle, by construction.
- `not_applicable` — the entity has no identifier this watch needs, so the watch does
  not exist for it.

The digest is one page and it is scannable. Movers first, ranked, cut at
`gates.yaml:skills.signal_watch.max_digest_rows`; quiet accounts listed by name with no detail;
then the footer, which is the part most digests get wrong:

- what this cycle cost, split into verified and `estimated_unverifiable`;
- **what the watch has cost since it started** — the compounding number, and the only
  one that answers "is this worth it";
- the next cycle's date, per watch, because they are on different clocks;
- any reprice the catalog has applied since the subscription line was approved.

## Customer mode — the same engine, a different list and a different reading

Point the watchlist at accounts that already pay you and the endpoints do not change,
but what each signal *means* inverts. This is a mode, not a second skill.

- **A champion leaving is the highest-value trigger in the pack, and the watch as
  written does not track named champions.** `lead_search()` with `past_companies` set to
  the customer's company URL and `recently_changed_jobs` true returns *one page of
  whoever left that company* — page-gated, ranked by LinkedIn, per-result priced. Your
  champion is on it only by luck. A live run made exactly this mistake: it read one
  arbitrary page of leavers, found none of the three named champions on the watchlist,
  and the digest said nothing had changed. That is a false negative on the most
  expensive signal in the pack, and it looks identical to good news.

  **The honest method for NAMED champions is the one this skill already runs on:
  re-enrich and diff.** Hold the champion's own profile URL on the watchlist, re-enrich
  each named profile on the people cadence, and diff the company field against the
  previous snapshot. A change there is the departure, it names the person, and it cannot
  be missed by a ranking. It is priced per champion per cycle — flat, exact and
  quotable — which is also why it belongs in the subscription line by name.

  Use the `lead_search()` sweep for what it can actually answer: *discovery* — who else
  left this account that we were not watching. Quote it as a page of an unbounded list,
  never as coverage of a named list, and never let its silence read as "your champions
  are still there".
- **A champion arriving is the same call with `current_companies` instead.** A new VP
  in the function you sell into rewrites the priorities you were told about last
  quarter — an expansion opening or a re-sell, depending on who they replaced.
- **Hiring reads as expansion, not intent.** A customer staffing up the team that uses
  your product is a seat-count conversation. The same posting on a prospect is a
  buying signal; on a customer it is a forecast.
- **A stack change reads as displacement risk.** A tool appearing next to yours is the
  evaluation you were not told about. This is the watch most worth having on customers
  and least worth running fast — see Step 2, it moves on the long clock.
- **Funding reads as budget, in your favour.** Money is the cheapest possible reason
  for an expansion conversation to be welcome.

Three rules that are specific to this mode:

- **Never infer the customer list.** It comes from the user or from the CRM, named as
  customers. A prospect list quietly reused as a customer list produces churn alerts
  about companies that were never customers, and expansion plays aimed at strangers.
- **Suppression still applies, and it applies harder.** A customer contact who
  unsubscribed is still suppressed; being a customer is not consent to be prospected.
  The filter is the same one every output list in this pack runs through.
- **Churn triggers are time-critical and prospect triggers are not.** Route them
  differently in the digest: a departure detected today is worth an interruption, a new
  job posting is worth a Monday.

## Inference mode: local

This skill diffs snapshots and writes a digest **locally**, in this agent's context. It
does not call the pack's paid LLM hop, and that endpoint is not in this skill's
endpoint set.

Comparing two JSON blobs, deciding which changes matter, and writing a paragraph a rep
can act on is exactly what the agent running this skill already does for free. Neither condition that justifies the paid hop arises here. **Perplexity web
grounding** is for a question with no endpoint behind it, and the grounded-news question
already has two endpoints (`search_bing()` and `google_search_scraper_sync()`) which
return source URLs a claim can be attached to. **Batch scale** does not arise either,
because a cycle's output is a diff, and a diff is small by construction: if the delta
for a watchlist were large enough to overflow context, the correct response is a
baseline problem or a cadence problem, not a bigger model.

Paying per reply, per row or per cycle to have an LLM do what the surrounding agent
does for nothing is the exact waste local inference exists to stop, and on a schedule it is that waste
multiplied by every cycle.

## Report honestly

- **Restate the standing charge in every digest.** Cycle cost, cost since the watch
  started, and the projected next week. A subscription nobody is reminded of is a
  subscription nobody cancels.
- **Never restate an estimate as a fact.** The ranged watches stay ranges with the
  basis named, and `estimated_unverifiable` is passed through to the user in that word.
- **Report the watches that were declined and what the digest is therefore blind to.**
  A digest built on news and stack alone cannot see hiring. Say so at the top, so an
  empty hiring section is not read as a finding about the accounts.
- **Report entities that were `not_applicable` as a group.** Compare live coverage
  against `gates.yaml:quality_stops.coverage_min_pct` and say plainly when a watchlist
  is too sparsely identified for its digest to mean anything.
- **Say what stopping costs: nothing.** The most honest sentence this skill can produce
  is that a watch which has not produced an actionable trigger in several cycles should
  be switched off, and offering that is more valuable than defending the spend.

## Thresholds this skill reads

All five live in `_lib/gates.yaml` under `skills.signal_watch`, and each is read at
plan time rather than typed into a cycle. Treat every one of them as fail-closed: no
key, no cycle — `gateValue()` throws `MissingGateKey`, the check reads STOP (law 5), and
a recurring skill that cannot read its own ceiling does not get to keep charging.

```
gates.yaml:skills.signal_watch.baseline_first             first cycle emits no triggers
gates.yaml:skills.signal_watch.max_pages_per_run          cross-endpoint page ceiling, one cycle
gates.yaml:skills.signal_watch.max_job_details_per_cycle  cap on the selective job-detail hop
gates.yaml:skills.signal_watch.max_digest_rows            digest cut
gates.yaml:skills.signal_watch.reproject_every_cycles     re-price the subscription this often
```

Print every threshold this skill does cite, with the key it came from:

```bash
richapi gates watchlist
richapi gates unbounded_endpoints
```

## What this skill will not do

- **It will not run a cycle without an approved subscription line.** Not a first cycle,
  not a one-shot scan. The one-shot framing is exactly how a recurring cost gets
  approved as a one-off, and this skill's whole job is to make that impossible.
- **It will not schedule itself.** Nothing in this skill starts a clock. Handing the
  cycle to a runner is [`/scheduled-workflow`](../scheduled-workflow/SKILL.md)'s job,
  and until that hand-off has actually happened this skill says the watch is not
  running rather than implying a clock exists.
- **It will not enable every watch.** No flag turns them all on. A skill that can
  switch its whole endpoint surface into a recurring charge in one keystroke is a
  billing incident waiting for a typo.
- **It will not poll below the floor.** `gates.yaml:watchlist.min_refresh_interval_hours`
  is a floor, and a watch's own cache TTL is the honest floor above it. Faster is not
  more current; it is either a cache read or a repeat purchase.
- **It will not walk pages on a schedule by default.** Page one, every cycle, and a
  page-two request is a deliberate answer to a specific question.
- **It will not search posts by keyword.** `post_keyword_search` is not used by this
  skill: signal-watch watches named companies, it does not search posts by keyword, and
  no setting here adds it. An earlier version used it to read company posts and to
  search content; `linkedin_company_posts()` is the supported route.
- **It will not call endpoints that do not exist.** An earlier version invoked `ad_search`
  and `ad_details`; there are no such operations in the pinned spec. The real ones are
  `linkedin_ad_search()` and a details endpoint owned by `/competitive-intel`. It also
  fanned `profile_activities` across tracked execs every cycle — an unbounded per-result
  call, billed on a count absent from the response, on a clock. That endpoint belongs
  to `/account-research` and `/competitive-intel`, where a human chooses one profile at
  a time, and it is deliberately absent here.
- **It will not enrich, verify or contact anyone it finds.** The people watch returns
  names and profile URLs. Emails, phones and verification belong to the enrichment
  waterfall; sending is deliberately external to this pack, permanently.
- **It will not decide the play.** `triggers.jsonl` is a feed. What to do about a
  trigger is a play, and a play is somebody else's skill and somebody else's approval.
- **It will not treat a customer list as a prospect list, or the reverse.** Customer
  mode is a different list with a different reading, never a relabelled one.

## Recipes

Ready-made chains of this pack's skills for a common job. A recipe only names the
skills and their order; each skill still runs its own dry run, gates and approval, so
no step is priced here.

### champion-moved

```yaml recipe
name: champion-moved
job: >-
  Your customers’ champions in; the ones who changed company, with new contact details
  and an opener, out
input: watchlist
steps:
  - signal-watch
  - enrich-waterfall
  - personalize
  - sequence-builder
  - comply
  - campaign-review
  - launch
ends: send
```

**What this costs, and it recurs.** Watching named champions is a per-profile
re-enrichment **every cycle** — a flat per-call charge per champion, multiplied by the
cadence, which is the number that matters and the one nobody forecasts. The discovery
sweep over everyone who left an account is a different shape: a base charge per page
plus a per-result charge on that page, with no upper bound on the page's size. Both come
from the catalog at plan time and both belong in the subscription line before the first
cycle runs.

Customer mode. The first cycle is a baseline and produces no triggers.

**Watch named champions by re-enriching their profiles and diffing the company field**,
not by reading a page of everyone who left the account — see Customer mode above for
why the sweep cannot answer a question about named people. The watchlist for this
recipe is therefore a list of champion profile URLs, and its cost is per champion per
cycle.

`/enrich-waterfall` reads a contact list, not `triggers.jsonl`: write one row per champion
who left, with `linkedin_url` taken from the trigger's `after` record, before that step.
Do not carry the old work email forward; it belongs to the company they left.

**At the gate, this is an e-mail chain.** Run `/comply` with `CHANNEL=email` (the default), because `/launch` writes a sender file and refuses a clearance for any other channel. The enrichment leaves `location_country` holding a country NAME ("United States"), not an ISO code; `/comply` Step 1a maps it, so do not hand-map a column before running the gate, and do not read an unmapped name as an unresolved row.

### hiring-or-stack-change-outbound

```yaml recipe
name: hiring-or-stack-change-outbound
job: >-
  Target accounts in; the ones now hiring your buyer or changing their stack, with the
  people to contact, out
input: watchlist
steps:
  - signal-watch
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

**What this costs, and it recurs.** Two page-gated per-result watches (hiring, and the
people search behind Path B) sit in this chain, each billing a base charge per page plus
a charge per result on it — every cycle, for every triggered account. That compounding
figure, not the first cycle's, is what the user approves. Read it from the catalog at
plan time and quote the estimate's basis
(`gates.yaml:unbounded_endpoints.assumed_results_per_page`) rather than a single
confident number.

Copy cites the trigger it came from. A stack change is only evidence on a domain that was
actually checked. A trigger line names the entity, not its LinkedIn company URL, so take
that URL for each triggered account from the watchlist and hand those accounts to
`/build-prospect-list` Path B. An account with no LinkedIn company URL on the watchlist
cannot go through Path B; say so rather than guessing one.

**At the gate, this is an e-mail chain.** Run `/comply` with `CHANNEL=email` (the default), because `/launch` writes a sender file and refuses a clearance for any other channel. The enrichment leaves `location_country` holding a country NAME ("United States"), not an ISO code; `/comply` Step 1a maps it, so do not hand-map a column before running the gate, and do not read an unmapped name as an unresolved row.

## Related

- Turn one trigger into a full account brief before anyone acts on it:
  [`/account-research`](../account-research/SKILL.md). This skill is that brief on a
  clock, reduced to diffs.
- Build the account universe a watchlist is drawn from:
  [`/build-prospect-list`](../build-prospect-list/SKILL.md) and
  [`/tam-map`](../tam-map/SKILL.md).
- Score whether a trigger is worth acting on, with the evidence attached:
  [`/evidence-score`](../evidence-score/SKILL.md).
- Turn a trigger into copy that cites it: [`/personalize`](../personalize/SKILL.md),
  then [`/sequence-builder`](../sequence-builder/SKILL.md).
- Classify what comes back when a triggered play lands:
  [`/reply-triage`](../reply-triage/SKILL.md).
- Clean and suppression-check any list before a name from the people watch reaches an
  output: [`/list-hygiene`](../list-hygiene/SKILL.md) and
  [`/comply`](../comply/SKILL.md).
- Read the standing cost against what the plays actually produced:
  [`/measure`](../measure/SKILL.md), and feed the pattern back with
  [`/learn`](../learn/SKILL.md).
- Put the cycle on a clock — this skill never does that itself:
  [`/scheduled-workflow`](../scheduled-workflow/SKILL.md).
- Read the standing charge against every other recurring spend in the pack:
  [`/cost-optimizer`](../cost-optimizer/SKILL.md), and the quarter's pattern in
  [`/gtm-retro`](../gtm-retro/SKILL.md).
- Brief the rep before the meeting a trigger produced:
  [`/pre-meeting-briefing`](../pre-meeting-briefing/SKILL.md).
- Session start, routing and the closing receipt:
  [`/richapi-gtm`](../richapi-gtm/SKILL.md).
- Every threshold this skill cites, printed with the key it came from: `richapi gates`.
- Point the same ad and stack endpoints at a rival, one-shot:
  [`/competitive-intel`](../competitive-intel/SKILL.md). Decide what to *do* with a
  trigger, as a named and re-runnable play:
  [`/play-design`](../play-design/SKILL.md).
- What is built, what is not, and what is blocked: [`../../ROADMAP.md`](../../ROADMAP.md).
