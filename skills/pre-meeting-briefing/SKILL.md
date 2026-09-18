---
name: pre-meeting-briefing
version: 1.0.0
description: >
  A call sheet on the humans you are about to meet, built inside a ten-minute box and a
  plan you approve once. Person-first, not company-first: who is in the room, what
  changed at their company since anyone last looked, and one honest opener. Use when
  asked to "prep me for my meeting", "brief me on <name>", "call with X tomorrow",
  "who am I meeting", "who is this person", or "interview prep". It owns no endpoints
  and fetches nothing itself — it constrains and composes /account-research and
  /enrich-waterfall, and it never runs the market pass. (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write
triggers:
  - prep me for my meeting
  - brief me on
  - call with X tomorrow
  - who am I meeting
  - who is this person
  - pre-meeting
  - interview prep
---

# Brief the humans in the room, in the time you actually have

You are the person who hands a rep a single page thirty seconds before they join a
call. The page has to be right, it has to be short, and it has to be finished before
the call starts. A brief that arrives late is worth nothing, and a brief that is
merely plausible is worth less than nothing, because the rep will say it out loud.

## Before anything else

```bash
richapi-skills-preflight
```

Stop and fix before continuing if:

- `CATALOG_OK: no` — regenerate with `richapi catalog gen`. Every price in the plan you
  are about to show is read from that catalog at plan time. Nothing in this document is
  a price.
- `API_KEY_SET: no` — a dry run still works and still shows the whole plan. Offer it.
  Very often the honest answer before a call is "here is what a brief would cost and
  what it would tell you", and that answer takes no key.

`SUPPRESSION: STOP` is not a blocker for the brief itself, and it is a blocker for one
line of it. See **the do-not-contact line** below, which fails closed on its own.

`BALANCE: unknown` is normal.
The balance comes only from a background probe of `GET /usage`.

## Why this is not `/account-research` with a stopwatch

[`/account-research`](../account-research/SKILL.md) owns twenty-three endpoints and
already writes tiered account briefs. If this skill were "that, but shorter", it should
not exist, and the honest thing would be to say so. Three differences make it a
different job, and each one is a constraint rather than a feature:

**The unit is a person, not an account.** `/account-research` resolves a company first
and treats people as its Pass 2 output. Here the input is an attendee list off a
calendar invite (two names, maybe a LinkedIn URL, maybe only an email domain), and the
company is context those people happen to share. The first thing that can go wrong is
therefore different: not "which Acme did you mean", but "is this the right David Chen".
That gate lives here and nowhere else.

**The pass selection is fixed, not offered.** `/account-research` is deliberately a menu
whose passes the user opts into, and that is right for research. It is wrong before a
call, because the person asking has no time to read a menu. This skill makes the
selection for them, always the same way, and the market pass is not on the list at all.

**The artifact is different.** A research brief is evidence a rep reads once and files.
A call sheet is a page a rep glances at while a Zoom window is loading: the humans, the
two things that changed, one opener, one watch-out. Same facts, different document, and
the difference is what the reader does with it in the next sixty seconds.

If what the user actually wants is the account — its committee, its market, its ad
history — this is the wrong skill and you should say so and route, rather than growing
a second research skill by degrees. That is the failure mode this section exists to
prevent.

## What it owns, and what it borrows

**It owns no endpoints.** `_lib/endpoint-owners.yaml` assigns this skill none, and that
is correct rather than an omission: every fact a call sheet needs is already owned by a
skill that fetches it properly, with its own dry-run, its own page gate and its own
cache. A second owner for `enrich_profile` or `linkedin_company_posts` would be a second
place for the discipline around them to rot.

So this skill fetches nothing itself. It composes, and here is exactly what it borrows:

| What the call sheet needs | Whose job it is | What this skill adds |
|---|---|---|
| The right human, confirmed | [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) identity hops | The wrong-person gate below |
| Company context | [`/account-research`](../account-research/SKILL.md) Pass 0 + Pass 1 | Scoped modules; usually a cache read |
| What changed recently | `/account-research` Pass 3, sliced | One profile, chosen; company posts preferred |
| The committee | `/account-research` Pass 2 | **Skipped.** You are meeting who you are meeting |
| Money, traffic, ads | `/account-research` Pass 4 | **Forbidden.** See the box below |

Every paid call therefore runs through the gated runtime the owning skill already uses
— `richapi call` and `richapi search`, priced from the catalog, journalled, ledgered and
read through the cache. This skill invents no verb and no route of its own.

## The box, and what "forbidden" means

The box is not a wall-clock timer; it is a shape. Three rules, and none of them has an
override:

1. **The market pass never runs.** `similarweb_scraper_sync`, `linkedin_ad_search`,
   `meta_ads_library_scraper_sync`, `crunchbase_company_scraper_sync` and
   `google_maps_reviews_scraper_sync` are out of scope for a call sheet, permanently.
   Three of them cannot be reconciled after the fact and one has no bound of any kind,
   so a "quick brief" is the worst possible place to reach for them. Where a funding
   round genuinely matters to the meeting, route to `/account-research` and let the user
   approve that pass with their eyes open.
2. **The committee pass never runs.** You already know who is in the room. Walking
   `linkedin_company_employees_search` or `lead_search` to find more people is an
   account-mapping job, and both are page-gated under
   `gates.yaml:unbounded_endpoints.endpoints` for good reason.
3. **The activity call is singular.** `profile_activities` is charged on a count field
   that is absent from the response, so its ledger line is written
   `estimated_unverifiable` and no care afterwards makes it an actual. At most one
   profile per brief, chosen rather than swept — the ceiling is
   `gates.yaml:skills.account_research.profile_activities_max_profiles`, inherited from
   the skill that owns the endpoint. It is also in `gates.yaml:always_ask.endpoints`, so
   it confirms every time however little the session has spent.

Everything else the brief may reach is flat-priced or bounded, which is what makes the
plan total a total rather than a ceiling. Where a page-gated call is unavoidable, it
inherits `gates.yaml:unbounded_endpoints.pages_before_confirm` and the cross-endpoint
ceiling at `gates.yaml:skills.account_research.max_pages_per_run`.

### Inference mode: local

This skill synthesises the call sheet **locally**, in this agent's context. It does not
call the pack's LLM endpoint, and `ai_enrich` is not in its endpoint set.

An `ai_enrich` synthesis pass was once proposed for this skill. It predates the
local-inference rule and it is declined here, deliberately and not silently: turning a handful
of fetched facts into four short paragraphs is exactly what the model running this skill
already does at no charge, and paying an endpoint to do it buys a second model, a second
failure mode and a validated-output contract the brief does not need.

The two conditions that would justify the paid hop do not arise. **Perplexity web
grounding** answers questions with no endpoint behind them; every question on a call
sheet has an endpoint behind it, and grounding a claim to a URL is what `web_scrape` and
`find_sitemap_urls` already do with a source line attached. **Batch scale** does not
arise either: a meeting has a handful of attendees, and a handful of attendees is one
context. Briefing a whole day of meetings is the same skill run several times, not a
batch — and if that is the ask, the run still costs what the runs cost, so plan it as
several plans rather than reaching for a batch hop to hide the total.

## Step 1 — the humans, and the wrong-person gate

Take the attendee list from wherever the user has it: the invite, the thread, a name and
a company. Then, before anything is spent on activity or context:

- **A LinkedIn profile URL is the only identifier that needs no resolution.** If the
  user has it, use it.
- **An email or a name plus a company resolves through
  [`/enrich-waterfall`](../enrich-waterfall/SKILL.md)**, which owns
  `find_linkedin_url_by_email`, `find_linkedin_url_by_name` and `enrich_profile` and
  prices each hop on its own plan. Hand it the attendees and let it plan; do not
  improvise a lookup here.
- **A bare common name with no company stops and asks.** Do not guess.

**Then confirm the match before spending anything on activity.** Show the name, the
headline, the current employer and the tenure, and get a yes. This is the one
confirmation in the skill that is not about money, and it is the highest-value gate in
the file: every downstream fact inherits the identity choice, nothing downstream can
detect that it was wrong, and a rep who opens a call by referencing the wrong person's
job change has done more damage than no brief at all.

If two candidates are plausible, present both and stop. Two names is a question a human
answers in three seconds. A silently chosen homonym is a call that goes badly for
reasons nobody traces back to this file.

## Step 2 — the two things that changed

A call sheet does not want a history. It wants what a well-prepared human would have
noticed this week, and preferably two of them.

**Prefer the company's own voice, because it is flat-priced.** `linkedin_company_posts`
is page-gated, so take the first page and stop; `post_details` reads one post in full
for a flat call, and `post_activities` returns who commented and reacted for a flat call
per page and reports the size of the set in the body before you decide to walk it. For a
meeting brief, one recent announcement read properly beats six skimmed.

**Reach a person's own activity only for the one person who matters.** Run
`/account-research`'s cheap pre-check first — `profile_social_metrics` is a flat call and
tells you whether the profile is active at all — and only then consider
`profile_activities`, filtered by type, for a single chosen attendee, under the ceiling
in rule 3 above. An exec with a dormant profile is not worth an unbounded call, and this
is how you find that out for a flat price.

**Freshness is not a preference here, it is the point.** The pack's read-through cache
gives posts and activity the shortest class in the file —
`gates.yaml:cache_ttl.endpoints.profile_activities` resolves to
`gates.yaml:cache_ttl.classes.posts_activity` — precisely because a stale post makes a
rep sound like they prepared last quarter. Firmographics sit in the longest class,
`gates.yaml:cache_ttl.classes.firmographics`, so the company context is very often a
cache read and costs nothing. Say both things to the user: the context is nearly free,
the recency is not, and the recency is the part they are paying for.

## Step 3 — one plan, one approval, before the call

Never make the first call the first action. Aggregate everything Steps 1 and 2 would buy
into a single dry-run plan and show it once:

```bash
richapi call enrich_profile --param url=<linkedin-profile-url> --dry-run
richapi search linkedin_company_posts --param company_linkedin_url=<url> --pages 1 --dry-run
```

`--dry-run` makes **zero calls**. Read the plan with the user the way a person with a
meeting in ten minutes needs to read it:

- **One total, and whether it is a total or a ceiling.** Every flat-priced hop has an
  exact number. A page-gated hop has an estimate built on
  `gates.yaml:unbounded_endpoints.assumed_results_per_page`, and the honest phrasing is a
  range with the basis named.
- **Name the line that can never be verified.** If `profile_activities` is on the plan,
  it is marked on the plan, not discovered in the receipt.
- **Show the cache hits.** On an account somebody researched recently, most of Step 2's
  context is a skipped-not-charged line, and that is usually the moment a user approves
  the one call they would otherwise have declined.

Then take **one approval for the whole plan**. Gate confirmations still fire inside the
run — the page gate, the always-ask endpoints, and the session fractions at
`gates.yaml:session_budget.fractions.confirm`,
`gates.yaml:session_budget.fractions.stop` and
`gates.yaml:session_budget.fractions.single_call_confirm` — and none of them can be
pre-approved away. A missing gate key is a STOP and never "no gate" (law 5).

If the plan does not fit the time or the money the user has, cut Step 2 and ship Step 1
plus cached context. A one-paragraph brief that is true and on time is a good outcome.

## Write the call sheet

The output is `gtm/research/pre-meeting/<date>-<attendee>.md`. It is one page, and every
claim on it names the endpoint it came from, because that is what makes a wrong fact
debuggable and a stale one detectable (law 6).

```
CALL SHEET  2026-08-29 14:00  ·  Acme Corp
Purpose     intro call, inbound demo request

IN THE ROOM
  Dana Ruiz     VP Engineering, 2y1m            [enrich_profile]  confirmed ✓
                prev. Staff Eng at Bletchley    [enrich_profile]
  Sam Okafor    Head of Procurement             [enrich_profile]  confirmed ✓

THE COMPANY
  Headcount band    501-1000                    [enrich_company]
  Marketing stack   HubSpot, Segment            [web_tech_stack]
  Published pricing not_found                   [find_sitemap_urls, web_scrape]

WHAT CHANGED
  · Announced a SOC 2 Type II completion        [linkedin_company_posts]
  · Dana commented on that post                 [post_activities]

OPENER
  One honest sentence that references the SOC 2 post, because Dana engaged with it.

WATCH-OUT
  Sam is on the do-not-contact store — see below.

NOT CHECKED
  Buying committee beyond the two attendees; funding; traffic; ad history.
  Market pass not run — this is a call sheet, not account research.
```

Four rules about that page:

- **A gap is written, never omitted.** Three tokens and only these three, the same
  explicit null enum `_lib/dual-contract.schema.json` defines: `not_found` (the call ran
  and the fact was not there), `not_verifiable` (something came back that this pack
  cannot confirm), `not_applicable` (the question does not apply). Silence reads as "not
  checked", and a rep cannot tell that from "checked and empty".
- **`NOT CHECKED` is a required block, not a courtesy.** A call sheet is defined by what
  it left out. Absence of a committee is not a finding about the company.
- **The opener references something real or it is omitted.** No "I saw you're doing great
  things in the space". If nothing in the fetched facts supports an opener, write
  `not_found` and let the rep open the way they were going to anyway.
- **Never speculate about a person.** Behaviour you can point at, with the endpoint next
  to it. No personality reads, no inferred motives, no guesses at why somebody changed
  jobs.

### The do-not-contact line

The call sheet **never carries an email address or a phone number.** You have a meeting
with these people; you do not need their contact details to walk into it, and putting
them on a page whose whole purpose is to be glanced at and forwarded is how PII spreads.
Where the user genuinely needs to reach an attendee afterwards, that is
[`/enrich-waterfall`](../enrich-waterfall/SKILL.md) and it prices itself.

What the sheet **does** carry is a flag. Cross-check every attendee against the
suppression store before writing, and where one matches, say so in `WATCH-OUT` — because
the realistic bypass is not a bulk send, it is a rep who leaves a good call and fires
off a follow-up to somebody who unsubscribed.

That check fails closed. If `SUPPRESSION: STOP` came back from the preflight, the store
could not be read, so the flag cannot be computed: write the sheet **without any
suggested follow-up**, state plainly that the do-not-contact check did not run, and tell
the user to run `./setup`. A check that could not run is not a passing check (law 5).

## Report honestly

Read the receipt the runtime prints and pass on what it says.

- **An estimate stays an estimate.** Where the receipt says `estimated_unverifiable`, the
  sheet and your summary say so too.
- **Say what the brief is missing and why**, in the same breath as what it found. "No
  committee, no market pass, both by design" is a different sentence from "we could not
  find anything".
- **Compare coverage against `gates.yaml:quality_stops.coverage_min_pct`** and say
  plainly when a sheet is too thin to carry a call. Sometimes the right answer ten
  minutes before a meeting is "we know almost nothing about these people, open with a
  question".
- **Say what a deeper pass would cost**, and route to it rather than quietly running it.

## What this skill will not do

- **It will not run the market pass.** Not with a flag, not on request, not "just the
  funding round". `/account-research` owns those endpoints and prices them where a user
  can see what they are approving.
- **It will not map the buying committee.** Two page-gated per-result endpoints reach
  more people at the account and neither belongs in a brief written under time pressure.
- **It will not fan `profile_activities` across the attendee list.** One profile, chosen,
  page-gated, reported as a range.
- **It will not guess which person you meant.** Two plausible matches stop and ask; a
  bare common name stops and asks.
- **It will not put an email address or a phone number on the sheet**, and it will not
  enrich, verify or contact anybody it briefs.
- **It will not write outreach copy, a follow-up email, or a sequence.** A brief is
  preparation; copy is a separate job with its own source-line rule.
- **It will not judge whether contacting these people afterwards is lawful.** That is
  [`/comply`](../comply/SKILL.md), and a meeting is not consent.
- **It will not dial, join, record or transcribe the call.** Dialing and live calling are
  outside this pack permanently, not pending. This skill flanks the call; it does not
  make it.
- **It will not assert a fact it did not fetch.** No plausible filler, no inference
  dressed as a source line, no field quietly dropped because it came back empty.

## Related

- [`/account-research`](../account-research/SKILL.md) — the passes this skill borrows and
  constrains, and where to route the moment the question is really about the account
- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — resolves an attendee to a profile,
  and the only route to an email or a phone number afterwards
- [`/comply`](../comply/SKILL.md) — whether these people may be contacted at all, and the
  suppression store the do-not-contact line reads
- [`/inbound`](../inbound/SKILL.md) — routes a demo request to a rep; a call sheet is the
  natural attachment when that rep books the meeting
- [`/crm-export`](../crm-export/SKILL.md) — files what the meeting produced into the CRM,
  suppression-filtered, with the PII contents named
- [`/call-intel`](../call-intel/SKILL.md) — the other side of the same call: what it
  produced, turned into structured intel
- [`/scheduled-workflow`](../scheduled-workflow/SKILL.md) — a sheet for every meeting on
  tomorrow's calendar, on a cadence, with a real per-schedule credit ledger
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router and the session receipt
- Every threshold this skill cites, printed with the key it came from: `richapi gates`
- [`/org-map`](../org-map/SKILL.md) — the committee hierarchy behind the room, with
  confidence per edge, when the call sheet is not enough
- What is built, what is not, and what is blocked: [`../../ROADMAP.md`](../../ROADMAP.md)
