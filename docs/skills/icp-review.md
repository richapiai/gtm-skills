# /icp-review

A versioned `gtm/icp.yaml` where every criterion either names the accounts it was
observed in, or is labelled a hypothesis and left out of the tiering.

## The problem this solves

Your ICP was written in a workshop and nobody has held it next to a closed deal since.
Most of what is on that list describes your market rather than your best customers:
"mid-market", "uses Salesforce", "has a RevOps team" turn up in every account you won
*and* every account you lost. Nobody notices, because the next step is to build a list
off it, enrich it and send it, so the bill and the reply rate both arrive after the
decision was made. This skill puts the won sample beside the lost sample and asks each
criterion which of the two it actually separates.

## When to use it

- "Three people here would describe our ICP three different ways, and we are about to
  spend on a list."
- "We keep losing the same kind of deal and I want to know what they have in common."
- "I have a closed-won and a closed-lost export. Tell me what is really in them."
- "Which accounts are tier 1, and which should we stop working entirely?"
- "The ICP came out of a planning offsite. Has anyone checked it against a deal?"

## When NOT to use it

- **You have no won/lost history.** It still runs, but nothing leaves the hypothesis
  state and no attribute gets tiered. It says so at the top of the session rather than
  the end. The honest next step is a deliberately small
  [`/build-prospect-list`](build-prospect-list.md) run, treated as an experiment.
- **Your export has company names and domains but no LinkedIn company URLs.** The
  endpoint it samples with takes a LinkedIn company page URL and nothing else, and no
  endpoint this skill owns converts one to the other. That resolve belongs to
  [`/build-prospect-list`](build-prospect-list.md) and [`/tam-map`](tam-map.md), each
  with its own plan and its own gate. Do it there, then come back.
- **You want to know how big the market is.** That is [`/tam-map`](tam-map.md).
- **You want the list itself.** This skill writes the definition, not the rows.
  [`/build-prospect-list`](build-prospect-list.md) reads `gtm/icp.yaml` and builds from
  it.
- **You want a model to confirm the ICP.** An AI-inferred observation is stored apart
  from the verified ones and never merged in. It can inform a question. It can never on
  its own promote an attribute or set a tier. A model agreeing with you is not a
  customer buying from you.
- **You want your whole CRM run through it.** It samples. The per-run ceiling on how
  many accounts reach the paid step is
  `gates.yaml:skills.icp_review.max_sample_accounts`, and a full export pasted in is
  caught by that key long before your budget notices.
- **You want permission to contact these accounts.** An ICP is not a clearance. That is
  [`/comply`](comply.md), and it can stop rows this review endorsed.

## What it costs

Paid, and the paid part is one step: sampling the won and lost accounts with
`enrich_company`. Two other endpoints can appear. `search_reference_data` checks a
closed-set label like seniority or company size. `ai_enrich` is opt-in for exactly two
reasons: a fact that needs live web grounding, or one narrow question asked across a
sample too large to read by hand. Naming a segment, summarising findings and writing the
ICP description are done locally and cost nothing.

Every number you act on comes from the dry run, which makes zero API calls, needs no API
key, and always runs before anything is spent. `_lib/api-catalog.json` prices
`enrich_company` at 1 credit per call, `ai_enrich` at 2, and `search_reference_data` at
0, read out of that file on 2026-09-01. Prices are read live at plan time, so believe the
dry run over this page: one endpoint in this pack repriced by more than eight times
inside a single quarter.

Two ceilings bound the run, both from `_lib/gates.yaml`:

```console
$ richapi gates skills.icp_review.max_sample_accounts   # accounts the sample may cost you
$ richapi gates skills.icp_review.icp_max_age_days      # how long the ICP counts as current
```

## What you get

`gtm/icp.yaml`, written only after you approve the rendered version, and written as a
**new version naming the one it supersedes**, never over the top of the old one.
Downstream skills read the highest version, so an ICP that changed underneath them
without a version bump is a silent change to every list built afterwards.

Each attribute carries the accounts it was observed in by name, the sample size, the
sample definition in words, the same observation measured over the lost sample, where it
came from, and one of three states: `evidenced`, `hypothesis`, `refuted`. Only an
`evidenced` attribute can be tiered, into `tier_1`, `tier_2`, `negative_persona` or
`anti_icp`. A hypothesis is recorded and labelled, never tiered.

Every attribute also answers `actionable_via`: which endpoint can filter on it. "None" is
a real answer. A true criterion no search can express is kept and labelled, so whoever
builds the list knows they are qualifying it by hand.

The summary leads with what did **not** clear: the attributes that stayed a hypothesis
and the one evidence field each is missing, and the attributes the sample refuted. Those
are the valuable ones, and they are the ones a summary usually buries.

## How to run it

Say to Claude:

> Review our ICP against these closed-won and closed-lost exports.

> Why do we keep losing deals that look like this?

There is no `richapi icp-review` command. The runtime ships `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates`, and a review is not one of them. The commands the
session uses:

```console
$ richapi preflight
$ richapi call enrich_company --in gtm/icp/sample-won.csv --dry-run
$ richapi call enrich_company --in gtm/icp/sample-lost.csv --dry-run
$ richapi call enrich_company --in gtm/icp/sample-won.csv --out gtm/icp/won-enriched.csv
```

Each input file needs a `url` column holding the LinkedIn company URL. You are shown both
plans together, because the two halves of the sample are one decision: approving the won
half alone produces exactly the evidence-free review this skill exists to prevent.

## What it needs first

1. `./setup`, once. This skill writes no contact list, but the accounts you sample become
   the seed for one, and `SUPPRESSION: STOP` blocks everything downstream.
2. [`/gtm-kickoff`](gtm-kickoff.md), which writes the dated brief whose `icp_hypothesis`
   is the thing this skill tests. Reviewing an ICP nobody has stated means inventing one
   and then agreeing with it.
3. A closed-won and a closed-lost export from your CRM, carrying LinkedIn company URLs.
   If it carries domains and names instead, resolve them through
   [`/build-prospect-list`](build-prospect-list.md) first.
4. An API key, but only for the sample. The interview, the local synthesis and every dry
   run work without one.

Next stop is [`/build-prospect-list`](build-prospect-list.md), which reads the artifact
this skill just wrote.
