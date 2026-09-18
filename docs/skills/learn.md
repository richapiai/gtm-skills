# /learn

A local memory of which providers and which hops actually found things, applied to the
next run as a reordering you can see before you approve it.

## The problem this solves

Your waterfall tries the same steps in the same order every time, whether or not the first
one has found anything in six weeks. You have probably noticed the pattern yourself and
have no way to tell the tool about it, so every run pays for the same dead first step. This
skill writes down what each hop and each provider hit, decays the old observations so last
year does not outvote last week, and hands the next plan a better order with the evidence
printed next to it.

## When to use it

- "Remember what worked on that run."
- "Which provider is actually winning?"
- "Apply what we learned to this plan."
- "Reorder the waterfall based on our own data, not a vendor's marketing."
- "What do we know so far?"

## When NOT to use it

- **Anything that leaves your machine.** There is no server, no upload, no sync, no
  consent toggle and no queue in this skill. Not "later": no.
- **Making a run cheaper or bigger.** A prior may only reorder hops inside a set you have
  already approved. It cannot add a hop, drop one, or swap an endpoint, because a learning
  that changes what a run costs is a paid call nobody named. To cut spend, use
  [`/cost-optimizer`](../../skills/cost-optimizer/SKILL.md).
- **Learning from copy, templates, replies or conversions.** The pack cannot observe them.
  Sending is external, permanently. Anything it claimed to learn there would be a number
  with no source.
- **Storing anything about a person.** Observations are counts and rates. No contact, no
  row identifier, no response body, ever.
- **Deciding for you.** The ordering is advice with an attribution line attached. You
  still approve the plan.
- **Reporting a run.** That is [`/measure`](../../skills/measure/SKILL.md).

## What it costs

Free. Zero API calls and zero network of any kind. It reads a run journal on this machine
and appends to a file on this machine.

## What you get

Two things, from the same skill in two modes.

**Record** appends to `gtm/learnings.jsonl`, one JSON line per observation: a hop or
provider key, a count, a hit rate and a timestamp. Recording the same run twice appends
nothing, so you cannot inflate your own denominator by re-running it.

**Apply** takes the hops you have already approved and returns the same set in a different
order, plus one line per move. Each line names the hop, the positions it moved between,
how many hits over how many attempts across how many runs, and the decayed hit rate those
came to. If it hands back anything that is not a rearrangement of what you gave it, throw
the result away.

Three thresholds decide whether any prior is allowed to move anything: how fast an
observation's weight decays, how many decayed observations are needed before a thin sample
may steer a paid run, and how recent the newest observation has to be. If any of the three
cannot be read, nothing is reordered and the order you approved stands.

## How to run it

Say to Claude:

> Record what we learned from that run.

then, before the next one:

> Apply what we know to this plan.

There is **no `richapi learn` verb**. The runtime ships `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates`. This is a local script and Claude runs it.

The attribution lines belong **in the dry-run plan**, next to the hop that moved, before
you approve. A prior that shows up after approval is a change you did not agree to. To see
the three thresholds:

```console
$ richapi gates skills.learn
```

## What it needs first

A run journal, so anything that has already run. Pair it with
[`/measure`](../../skills/measure/SKILL.md): measure the run, record the learnings, then
apply them to the next plan from
[`/enrich-waterfall`](../../skills/enrich-waterfall/SKILL.md). On a fresh install the
honest answer for the first several runs is "no prior cleared the floors yet", and the
skill says that rather than inventing an opinion.
