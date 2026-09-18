# /measure

A written report of what one run actually did: how many contacts it failed to find, what
it cost as an honest range, and which hops and providers earned their keep.

## The problem this solves

You ran a list of 500 contacts through enrichment. Something came back. Now your VP asks
what it cost and whether it was worth it, and the only answer you have is "it seemed to
work". Worse, the tempting answer is the hit-rate table, which quietly buries the 180 rows
that came back with nothing. This skill puts the misses first and the money second,
because the misses are what decide whether you run that list again.

## When to use it

- "How did that run go?"
- "What did that actually cost me?"
- "What's my hit rate on this list?"
- "I need a number for credits per meeting."
- "I want to forward the results to my manager without forwarding anyone's contact data."

## When NOT to use it

- **Comparing two campaigns or two months.** This skill reports one run and refuses to
  merge several, because the row key it counts with is only unique inside a single run.
  Cross-run comparison is [`/gtm-retro`](../../skills/gtm-retro/SKILL.md).
- **Turning the hit rates into a better next run.** That is
  [`/learn`](../../skills/learn/SKILL.md).
- **Finding out where the credits leaked.** That is
  [`/cost-optimizer`](../../skills/cost-optimizer/SKILL.md).
- **Sends, replies, meetings and deals.** The pack never sees them. Sending is external,
  permanently. You can type outcome counts in, and the report labels every one of them
  self-reported.
- **Deciding whether the offer or the copy was any good.** The report can say what a run
  cost and what it found. The judgement is yours.

## What it costs

Free. It makes zero API calls, metered or free, and works with no API key set. Everything
in the report is arithmetic over files the pack already wrote: the ledger, the run journal
and the local activation store.

## What you get

A markdown file at `gtm/measure/<run-id>-report.md`, written in a fixed order:

1. **Coverage first.** Rows in the run, rows not found, rows in flight, rows dropped by
   suppression, and the coverage gate's verdict.
2. **Spend.** Stated as a range when the endpoints involved never reported their charge,
   which is the normal case. The script refuses to print a figure the ledger cannot
   support, and it crashes rather than shipping one.
3. **What worked**, by hop and by provider, with the sample size carried on every rate.
4. **Outcomes**, if you supplied counts, always marked self-reported.
5. **Activation and kill/scale bands.**

Set `SHARE=1` and you also get `gtm/measure/<run-id>-share.md`. That second file is built
from counts and percentages only, never from journal lines, and it is re-inspected before
it hits disk. Forward that one. Do not forward the first one because it looks fine.

## How to run it

Say to Claude:

> Measure my last run.

or name it: "measure run-2026-08-28-abc and include the share file."

There is **no `richapi measure` verb**, by design. The runtime ships `enrich`, `call`,
`search`, `preflight`, `catalog` and `gates`. Measuring is local work over files you
already have, so the skill runs its own script. Claude will run it for you. Two things
worth knowing about the exit code if you script around it: exit 2 means there was nothing
to measure, exit 3 means the report was written but coverage came in under the floor.

To see the thresholds it judges against:

```console
$ richapi gates
```

## What it needs first

A run has to have happened. Anything that wrote a journal under `gtm/runs/` can be
measured, most often
[`/enrich-waterfall`](../../skills/enrich-waterfall/SKILL.md). Nothing else is required.
Run this after every run, because [`/learn`](../../skills/learn/SKILL.md) and
[`/gtm-retro`](../../skills/gtm-retro/SKILL.md) both build on top of what it reads.
