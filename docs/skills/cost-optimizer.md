# /cost-optimizer

A list of where your credits went, what produced nothing, and how much of that you could
have kept, with the ledger lines under each finding.

## The problem this solves

Your credit balance dropped faster than the number of contacts you got, and nobody can
say why. Somewhere in there is a hop that has never once returned an email, a list you
enriched twice in the same fortnight because a flag was left on, and a paged search that
kept buying empty pages. None of that is visible from a spreadsheet of results. It is
visible from the ledger, which records every call the pack made and what it was charged.

## When to use it

- "Where did my credits go this month?"
- "Why is this list so expensive to enrich?"
- "I have a budget conversation on Thursday and I need to show a plan to spend less."
- "Something is burning credits and I cannot find it."
- "Are we paying twice for the same contacts?"

## When NOT to use it

- **Reporting one run.** One run, coverage first, is
  [`/measure`](../../skills/measure/SKILL.md). This is the money view across runs.
- **Deciding which campaign to stop funding.** That is
  [`/gtm-retro`](../../skills/gtm-retro/SKILL.md), which compares arms and ends in a
  decision.
- **Actually making the change.** This skill reads the ledger and writes a file. It does
  not edit a workflow, disable an endpoint or clear a cache. Those have consequences and
  they stay with you.
- **Cost per meeting or per reply.** The pack cannot see a send or a meeting. Supply the
  counts to [`/measure`](../../skills/measure/SKILL.md), where they are labelled
  self-reported.
- **Getting told whether the spend was worth it.** It reports what was charged and what
  it produced. Whether that was a good trade is not a number the pack holds.
- **Hoping batching will cut the bill.** It will not, and the skill says so. The catalog
  prices the single and bulk forms the same, so batching buys latency and loses
  accountability. It books zero credits saved.

## What it costs

Free. Zero API calls, metered or free, with or without an API key. Auditing your spend by
spending would be its own first finding.

## What you get

A markdown file at `gtm/cost/optimizer.md`. It contains a small number of findings, each
one naming the ledger lines it rests on, and each saving stated as a range whose floor is
what the ledger can actually prove. For the endpoints that never report their charge, that
floor is zero, and the report says so in those words rather than quoting a friendlier
ceiling.

The patterns it looks for:

- **Cache TTLs you are not benefiting from.** The same endpoint charged for the same row
  twice, closer together than that endpoint's own TTL.
- **Waterfall hops that never hit.** Charged, and returned nothing, every time.
- **Pages that came back empty.** On a page-priced endpoint an empty page still costs the
  base rate.
- **Charged twice for the same unit.** Usually a run killed mid-call.
- **Bulk variants**, reported as an anti-recommendation with zero credits booked.

Two findings can match the same charged call. The later one loses the credit and the
report says it was reduced, because a savings report that double-counts ends up larger
than the run it audits.

## How to run it

Say to Claude:

> Where did my credits go? Audit my spend.

There is **no `richapi cost` verb**. The runtime ships `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates`. Cost analysis is local work over the ledger, so the
skill runs its own script and Claude runs it for you.

To see the two thresholds that decide what counts as a finding at all, the evidence floor
and the noise floor:

```console
$ richapi gates skills.cost_optimizer
```

## What it needs first

At least one run that actually spent credits, so there is a ledger to read. Nothing else.
Findings from this report are hypotheses until a dry run proves them, so take a
recommendation back to [`/enrich-waterfall`](../../skills/enrich-waterfall/SKILL.md) and
re-plan, then check the next run with [`/measure`](../../skills/measure/SKILL.md). A run
that got cheaper and found nothing is not an improvement.
