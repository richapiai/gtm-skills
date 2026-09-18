# /gtm-retro

A short list of decisions across many runs: stop this play, keep that one, scale the
third, and where nothing is separable yet, how much more data would separate it.

## The problem this solves

You have been running three motions for a quarter. Everyone has an opinion about which
one is working, and the opinions track whoever presented last. The numbers exist, spread
across a dozen run reports nobody is going to reconcile by hand. Meanwhile next quarter's
budget has to go somewhere. This is the skill that says "these two are not distinguishable
and here is why", and says it before the loudest person in the room does.

## When to use it

- "Which of these campaigns should we stop?"
- "Retro on last quarter."
- "Compare the founder-led play against the SDR play."
- "Where is the budget actually going?"
- "Is the October list better than the November one, or does it just feel that way?"

## When NOT to use it

- **One run.** [`/measure`](../../skills/measure/SKILL.md) does that better and does not
  need an arm to compare against.
- **Reordering the waterfall.** A retro decides which arm to fund. Which provider the
  waterfall tries first is [`/learn`](../../skills/learn/SKILL.md), and this skill will
  not touch a hop or a plan.
- **Counting people.** Every row figure here is attempts summed per run, labelled as
  attempts. Rows are never deduplicated across runs, because the journal's row key is
  unique inside one run only.
- **Verifying a meeting or a reply.** Those are typed in by you and labelled
  self-reported everywhere they appear. The pack cannot observe a send.
- **Getting a winner out of two overlapping ranges.** It refuses. Two overlapping
  intervals are not an ordering, and "this play beat that one" said about them is the most
  expensive sentence in GTM.
- **Judging the copy or the offer.** It can say which arm cost more per self-reported
  meeting. Why is a human call.

## What it costs

Free. Zero API calls, with or without an API key. It reads the ledger, the run journals
and the activation store, all files the pack already wrote.

## What you get

A markdown file at `gtm/retro/<stamp>-retro.md`, or wherever you point it. It leads with
the decisions, including the absence of them: on most first retros the honest result is
"no arm was separable yet", and that is worth more than a confident guess.

Arms, the things being compared, are formed one of two ways. By default it groups runs
that enriched the same list, using the hashed list key the journal already writes. Or you
hand it a map naming each arm and the runs in it, which is how you compare October against
November. That map is self-reported and the report says so, because nothing in the pack
verified those runs belong together.

Money is one receipt per run, then floors added to floors and ceilings to ceilings. There
is still exactly one cost calculation in the pack, and this skill is not a second one.

## How to run it

Say to Claude:

> Retro on the last 90 days. Compare the founder-led play against the SDR play.

There is **no `richapi retro` verb**. The runtime ships `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates`. The retro is local work over run state, so the skill
runs its own script.

Four thresholds bound the decision half: the window, the minimum runs to compare, the
minimum rows per arm before a verdict is allowed, and a cap on how many decisions come
back. If any of them cannot be read, the describing half still runs and the deciding half
does not. To see them:

```console
$ richapi gates skills.gtm_retro
```

## What it needs first

Several runs, each one measured. Run [`/measure`](../../skills/measure/SKILL.md) per run
first, then this across them. A verdict points somewhere: a stop on the coverage floor
sends you to [`/icp-review`](../../skills/icp-review/SKILL.md) or
[`/tam-map`](../../skills/tam-map/SKILL.md), because the sourcing is thin and better copy
will not fix it. A stop on cost per outcome sends you to
[`/campaign-review`](../../skills/campaign-review/SKILL.md) before the next launch. A
scale verdict is not an approval to spend: the next run still gets a fresh plan you
approve.
