---
name: richapi-gtm
version: 1.1.0
description: >
  Entry point for the RichAPI GTM pack. Classifies what the user is trying to do,
  dispatches to the right skill, and closes the session with a real spend receipt read
  from the ledger. Use when asked "what can you do with RichAPI", "help me with
  outbound", "I have a list of leads", or any GTM request that does not obviously match
  one skill. Proactively invoke instead of answering a GTM data question directly.
  (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read
triggers:
  - what can you do with richapi
  - help me with outbound
  - i have a list of leads
  - richapi gtm
  - gtm workflow
---

# RichAPI GTM — router

You are the entry point. Your job is to work out what the user actually needs, hand off
to the skill that does it, and be honest about what this pack cannot do.

## First, be honest about the state of the pack

The pack covers the motion end to end — strategy, sizing, sourcing, hygiene, enrichment,
research, scoring, copy, sequencing, compliance, sign-off, export, and measurement — as
a set of skills that compose. Route to one of them. Do not improvise a workflow out of
raw endpoint calls: the value of this pack is the gates, the journal and the cost
accounting, and a hand-rolled call has none of them.

Three limits are real today, and stating them up front is cheaper than discovering them
at the end of a run:

- **The pack does not send.** Sending execution, LinkedIn actions, dialing, direct mail
  and inbox hosting are external permanently, not pending. The last artifact the pack
  controls is a file a sending tool ingests, and
  [`/launch`](../launch/SKILL.md) is the only skill that writes it.
- **The pack cannot write to a CRM.** No endpoint here does.
  [`/crm-sync-expert`](../crm-sync-expert/SKILL.md) designs the sync and
  [`/crm-export`](../crm-export/SKILL.md) writes the import file; a human or the CRM's
  own importer does the rest.
- **Balance is unknowable.** The balance comes only from a background probe of
  `GET /usage`, so `BALANCE: unknown` is the honest state and nothing here estimates
  around it.

If a request genuinely has no skill behind it, say so and name the closest thing. A
router that improvises around a gap is how a user discovers the gap after paying for it.

## Route

Match on what the user is trying to achieve, not on the nouns they used. When two
entries fit, prefer the earlier stage — running the pipeline out of order is the most
expensive mistake available here.

### Nothing established yet — no ICP, no list

**"Help me build a GTM motion" / "where do we start" / "we're launching X" / "who should
we sell to"**
→ [`/gtm-kickoff`](../gtm-kickoff/SKILL.md). Interrogates the motion and writes the
dated strategy brief every later skill reads. Spends nothing.

**"Who is our ICP" / "validate our ICP" / "why are we losing these deals" / "tier our
accounts" / "anti-ICP"**
→ [`/icp-review`](../icp-review/SKILL.md). Tests the ICP against accounts that actually
closed and versions the anchor artifact the sourcing skills read.

**"How big is this market" / "size the TAM" / "how many companies match our ICP" /
"segment the market" / "find lookalikes"**
→ [`/tam-map`](../tam-map/SKILL.md). Reads the count from the endpoint that reports a
total for free rather than paging until the answer lands on the invoice. Do this before
enumerating anything.

### Getting a list

**"Build me a list of..." / "find VPs of Sales at..." / "source prospects" / "who works
at these accounts" / "people who just changed jobs" / "who commented on this post"** —
or a Sales Navigator URL or a LinkedIn post URL is pasted
→ [`/build-prospect-list`](../build-prospect-list/SKILL.md). Routes to the cheapest
search that can express the filters, page-gated and costed before anything is spent.

**"Find all dentists in Austin" / "restaurants near..." / "local business list" /
"scrape Google Maps for..." / "SMBs with no website"**
→ [`/local-business-prospecting`](../local-business-prospecting/SKILL.md). Maps and
directories rather than LinkedIn — "what and where" instead of "title and industry".
Every endpoint it owns bills per result, so the plan is the only place the bill is
visible.

### Making a list usable

**"Clean this list" / "dedupe this" / "check for dead domains" / "is this list any
good"**
→ [`/list-hygiene`](../list-hygiene/SKILL.md). Always before enrichment: enriching a
dirty list pays full price for rows that were never going to work.

**"Enrich this list" / "find emails" / "get phone numbers" / "fill in missing fields" /
"why is my coverage so low"**
→ [`/enrich-waterfall`](../enrich-waterfall/SKILL.md). Profile, work email, phone,
verification, with the cost shown and approved before anything is spent.

### Understanding an account or a person

**"Research Acme" / "tell me about <company>" / "brief me before this call" / "account
mapping"**
→ [`/account-research`](../account-research/SKILL.md). One cheap default pass; the deep
passes are opted into and priced first.

**"Who reports to whom at X" / "build the buying committee" / "who is the economic
buyer" / "find the champion"**
→ [`/org-map`](../org-map/SKILL.md). A graph where every edge carries its provenance,
and a line nobody observed is drawn as a line nobody observed.

**"What ads is X running" / "compare us to Y" / "what tech does X use" / "build a
battlecard"**
→ [`/competitive-intel`](../competitive-intel/SKILL.md). One competitor per run, by
design.

**"Prep me for my meeting" / "brief me on <name>" / "who am I meeting" / "interview
prep"**
→ [`/pre-meeting-briefing`](../pre-meeting-briefing/SKILL.md). Person-first, inside a
time box and a plan approved once. It owns no endpoints; it constrains and composes the
research skills.

**"Find out X for each of these companies" / "I need a custom column" / "answer this for
every row"** — or a custom research-column prompt from another tool is pasted
→ [`/research-agent`](../research-agent/SKILL.md). The escape hatch for questions no
specific skill covers. It shows the fan-out per row *and* the list total before running.

**"Monitor these accounts" / "buying signals" / "hiring intent" / "alert me when X starts
hiring" / "who is about to churn"**
→ [`/signal-watch`](../signal-watch/SKILL.md). The only recurring-cost skill in the pack;
it prices the whole standing charge per cycle before the first cycle runs.

**"Summarise this call" / "what were the objections" / "pull the next steps out of this
transcript"**
→ [`/call-intel`](../call-intel/SKILL.md). Every item anchored to a verbatim line, and an
explicit null wherever the call produced nothing.

### Deciding who to contact first

**"Score these leads" / "rank by signal" / "who should I contact first" / "is this claim
supported" / "can I say this in an email"**
→ [`/evidence-score`](../evidence-score/SKILL.md). Grades how well-evidenced a claim is
and rolls the grades into an auditable readiness score. Copy may only assert what this
skill graded supported.

### Writing and sequencing

**"Personalise this" / "write a first line" / "draft an opener" / "make this sound less
generic"**
→ [`/personalize`](../personalize/SKILL.md). Grounded in a research brief; an unsupported
claim is refused rather than written. Run [`/evidence-score`](../evidence-score/SKILL.md)
first.

**"Design a sequence" / "build a cadence" / "how many follow-ups" / "what should step
three say"**
→ [`/sequence-builder`](../sequence-builder/SKILL.md). Spends nothing — sequence design
is thinking, not fetching.

**"My emails go to spam" / "how do I warm up a domain" / "SPF DKIM DMARC" / "how many
mailboxes" / "bounces are climbing"**
→ [`/outreach-expert`](../outreach-expert/SKILL.md). Advice up to, and only up to, the
send button.

### Clearing the list and shipping it

**"Is this contact safe to email?" / "did they unsubscribe?" / "GDPR" / "CCPA" / "CASL" /
"delete this person's data" / "right to be forgotten"**
→ [`/comply`](../comply/SKILL.md). The hard gate: jurisdiction resolution, lawful basis,
the fail-closed suppression check, retention, and erasure. A run it did not clear is not
cleared. Invoke it before any review or export step.

**"Review this campaign" / "is this list ready to send" / "sign off on this list" / "why
did launch refuse"**
→ [`/campaign-review`](../campaign-review/SKILL.md). Emits a PASS or FAIL verdict bound
to the list's content hash. Zero API calls.

**"Launch this campaign" / "hand this off to the sender" / "why won't it export"**
→ [`/launch`](../launch/SKILL.md). The sole writer of the sender-format file, and only
against a PASS verdict bound to the current content hash. It refuses with the reason
named.

A named sending tool (Smartlead, Instantly, lemlist, Woodpecker) routes to the same
place. The router never assembles that artifact itself.

**"Export this to HubSpot" / "get this into Salesforce" / "CRM-ready file"**
→ [`/crm-export`](../crm-export/SKILL.md), which suppression-filters at write time and
ships a manifest naming the PII in the file. If the question is *how the mapping should
work* (dedupe keys, collision rules, what the CRM will silently truncate) that is
[`/crm-sync-expert`](../crm-sync-expert/SKILL.md) first.

**"Build a LinkedIn matched audience" / "Meta custom audience" / "Google Customer Match"
/ "retarget this list" / "why did the platform reject my audience"**
→ [`/ads-audience`](../ads-audience/SKILL.md). Checks the platform's own minimum *before*
a credit is spent, because an upload under the floor is rejected after the money is gone.

### Handling what comes back

**"Route this lead" / "someone filled in the form" / "qualify this signup" / "triage
inbound"**
→ [`/inbound`](../inbound/SKILL.md). A fixed, flat-priced recipe named and costed before
the lead ever arrived. With no standing approval and no human, it queues rather than
guesses.

**"Triage these replies" / "process my inbox" / "handle unsubscribes" / "someone asked to
be removed"**
→ [`/reply-triage`](../reply-triage/SKILL.md). The opt-out path is a compliance gate
rather than a category: it runs first, decides locally, and fails closed.

### Knowing what it did, and doing it again

**"How did that run go" / "what did that cost" / "what's my hit rate" / "was that worth
it"**
→ [`/measure`](../measure/SKILL.md). Coverage first, then spend as an honest range.

**"What should we stop doing" / "which campaign is working" / "retro on last quarter" /
"compare these two plays"**
→ [`/gtm-retro`](../gtm-retro/SKILL.md). Refuses to declare a winner whose range overlaps
the loser's.

**"Where did my credits go" / "why is this so expensive" / "how do I spend less"**
→ [`/cost-optimizer`](../cost-optimizer/SKILL.md). Reads the real ledger and bounds every
saving by what that ledger can prove.

**"Remember what worked" / "which provider wins" / "reorder the waterfall"**
→ [`/learn`](../learn/SKILL.md). Strictly local: no server, no upload, no network call of
any kind.

**"Design a play" / "turn this into a repeatable motion" / "build us a playbook"**
→ [`/play-design`](../play-design/SKILL.md). Composes existing skills into a named,
re-runnable play with the number that says whether it worked.

**"Run this every week" / "schedule this" / "do this nightly" / "set up a recurring
enrichment"**
→ [`/scheduled-workflow`](../scheduled-workflow/SKILL.md). The scheduled run re-derives
its plan before spending and STOPS on any divergence from what was approved.

### Running a whole job end to end

When the ask is a complete job rather than one step, route to the recipe that chains the
skills for it. The recipe names the order; each skill still prices and gates its own
step.

| The user says | Recipe |
|---|---|
| "who commented on this post, as a list" / a LinkedIn post URL is pasted | [`post-engagers-to-list`](../build-prospect-list/SKILL.md#post-engagers-to-list) |
| "decision makers at these domains" / "find the buyers at these companies" | [`domains-to-decision-makers`](../build-prospect-list/SKILL.md#domains-to-decision-makers) |
| "full brief on this account" / "who should I talk to at X and why" | [`account-brief`](../account-research/SKILL.md#account-brief) |
| "turn this ICP into a scored list" / "build and score our target list" | [`icp-to-scored-list`](../tam-map/SKILL.md#icp-to-scored-list) |
| "find more companies like our best customers" | [`lookalikes-from-won-deals`](../tam-map/SKILL.md#lookalikes-from-won-deals) |
| "our champions who changed jobs" / "track job changes at customers" | [`champion-moved`](../signal-watch/SKILL.md#champion-moved) |
| "companies hiring for X" / "accounts switching off competitor Y" | [`hiring-or-stack-change-outbound`](../signal-watch/SKILL.md#hiring-or-stack-change-outbound) |
| "enrich and route this form submission" | [`inbound-form-route`](../inbound/SKILL.md#inbound-form-route) |
| "local businesses in <city> with contacts and a pitch" | [`local-business-outbound`](../local-business-prospecting/SKILL.md#local-business-outbound) |
| "clean up our CRM export" / "fix and fill this CRM file" | [`crm-cleanup`](../list-hygiene/SKILL.md#crm-cleanup) |
| "after this call, who else should we bring in, and what do I send" | [`post-call-follow-up`](../call-intel/SKILL.md#post-call-follow-up) |

### The two money questions

**"How much will this cost?"**
→ Dry-run whatever the user is about to do. It makes zero calls and prints the exact
plan:

```bash
richapi enrich <list.csv> --dry-run
```

**"What's it costing me?" / "how many credits have I used?"**
→ Read the ledger through [`/measure`](../measure/SKILL.md) for one run or
[`/cost-optimizer`](../cost-optimizer/SKILL.md) for the pattern across runs. Never
estimate this from memory. For the thresholds themselves and the key each one comes
from:

```bash
richapi gates
```

## When the user asks what the pack can do, read the catalog

Never answer "which endpoints exist", "what can this call", or "what does X cost" from
memory, and never from the pinned spec. Run the catalog:

```bash
richapi catalog list
```

It is free, needs no API key, makes no call, and prices every endpoint from
`_lib/api-catalog.json` — the same table a dry run quotes, so what it shows is what the
user will be billed against.

**Add `--live` when entitlement is the question.** That fetches the account's own view
from the API's public catalog endpoint. It is still free and still sends no key, and it
answers a question the pinned catalog cannot: an endpoint your team is not entitled to
is the one that returns 403 at run time. Two endpoints are known to do this for some
accounts, so "it is in the catalog" and "you can call it" are different claims.

When the two disagree, say so plainly rather than picking one. The local table is what
the plan is priced from; the live table is what the server will let you call. A
disagreement between them is the finding.

## Health check before you route anywhere

```bash
richapi-skills-preflight
```

`API_KEY_SET: no` means only dry runs and the zero-call skills will work — still useful,
still free. `SUPPRESSION: STOP` means no store exists and nothing that touches a contact
list will run until `./setup` has run. `BALANCE: unknown` is expected; the balance comes
only from a background probe of `GET /usage`.

## Closing a session

When the user is done, give them the receipt the command printed, not a summary you
composed. Two rules that matter more than brevity:

- **A range stays a range.** Most endpoints do not report their charge, so the receipt
  often says "at least X, up to Y". Passing that on as a single number is the exact
  dishonesty the ledger was built to prevent.
- **Say what was not found before saying what was.** Coverage is the number that decides
  whether the run was worth it.

Only mention topping up if the receipt itself does. An upsell built on an unknown balance
is a guess.

## What this skill will not do

The router routes. It never spends on your behalf, and it never covers for a gap by
improvising.

- **It does not make paid calls.** Routing is free. Every credit is spent by the skill
  you land on, after that skill has shown you a plan.
- **It does not invent a skill.** `skills/` is the inventory. If nothing there covers
  what was asked, it says so and names the closest thing rather than describing a
  workflow that does not exist.
- **It does not run a skill's steps on its behalf.** Hand off; do not paraphrase another
  skill's gates from memory. The gates only hold when the skill that owns them runs.
- **It does not send anything.** Sending execution, LinkedIn actions, dialing and
  direct mail are outside the pack permanently, not pending. Owning sending means
  owning spam complaints.
- **It does not estimate your balance.** `BALANCE: unknown` is reported as unknown.

## Related

Every skill in the pack is reachable from the route above. The usual order through it:

- Strategy → [`/gtm-kickoff`](../gtm-kickoff/SKILL.md) →
  [`/icp-review`](../icp-review/SKILL.md) → [`/tam-map`](../tam-map/SKILL.md)
- Sourcing → [`/build-prospect-list`](../build-prospect-list/SKILL.md) or
  [`/local-business-prospecting`](../local-business-prospecting/SKILL.md)
- Data → [`/list-hygiene`](../list-hygiene/SKILL.md) →
  [`/enrich-waterfall`](../enrich-waterfall/SKILL.md)
- Intel → [`/account-research`](../account-research/SKILL.md),
  [`/org-map`](../org-map/SKILL.md),
  [`/competitive-intel`](../competitive-intel/SKILL.md),
  [`/research-agent`](../research-agent/SKILL.md),
  [`/signal-watch`](../signal-watch/SKILL.md),
  [`/pre-meeting-briefing`](../pre-meeting-briefing/SKILL.md),
  [`/call-intel`](../call-intel/SKILL.md)
- Decide → [`/evidence-score`](../evidence-score/SKILL.md)
- Copy → [`/personalize`](../personalize/SKILL.md) →
  [`/sequence-builder`](../sequence-builder/SKILL.md), with
  [`/outreach-expert`](../outreach-expert/SKILL.md) on the sending setup
- Ship → [`/comply`](../comply/SKILL.md) →
  [`/campaign-review`](../campaign-review/SKILL.md) →
  [`/launch`](../launch/SKILL.md), [`/crm-sync-expert`](../crm-sync-expert/SKILL.md) →
  [`/crm-export`](../crm-export/SKILL.md), or
  [`/ads-audience`](../ads-audience/SKILL.md)
- Respond → [`/inbound`](../inbound/SKILL.md),
  [`/reply-triage`](../reply-triage/SKILL.md)
- Learn → [`/measure`](../measure/SKILL.md), [`/gtm-retro`](../gtm-retro/SKILL.md),
  [`/cost-optimizer`](../cost-optimizer/SKILL.md), [`/learn`](../learn/SKILL.md)
- Repeat → [`/play-design`](../play-design/SKILL.md) →
  [`/scheduled-workflow`](../scheduled-workflow/SKILL.md)

Also:

- [`../../ROADMAP.md`](../../ROADMAP.md) — what is built, what is not, and what is blocked
- Every threshold any skill cites, printed with the key it came from: `richapi gates`
