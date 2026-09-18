# /play-design

A written, re-runnable definition of one go-to-market motion: what starts it, who it
applies to, which skills run in what order, and the single number that says whether it
worked.

## The problem this solves

Someone on the team ran a campaign that worked. Nobody wrote down what they did. Two
months later three people are running three different versions of it, none of them
measured, and the one that worked is not obviously the one that survived. Meanwhile the
"playbook" is a Google Doc that describes the idea but not the steps, so re-running it
means rebuilding it.

This turns a motion into a record: a trigger, an audience, a sequence of skills the pack
already has, and a declared metric. You can save it, run it again next month, and
compare the two.

## When to use it

- "Design a play for this."
- "We should do this every time a target account starts hiring SDRs."
- "Turn this campaign into something repeatable."
- "Build us a playbook for expansion."
- "How do we run this again next quarter?"

## When NOT to use it

- **Running the play.** Designing and running are separate acts on purpose. The record
  is the deliverable; the composed skills do the work.
- **Scheduling it.** That is [`/scheduled-workflow`](scheduled-workflow.md), which runs
  a saved motion on a cadence under an approved spending envelope.
- **Reordering the pipeline.** A play may not route around
  [`/comply`](comply.md) or [`/campaign-review`](campaign-review.md), and
  [`/launch`](launch.md) stays the only writer of a sender export. A play that tries is
  refused.
- **Inventing a trigger the pack cannot see.** Intent data, review-site activity, email
  opens and CRM stage changes are not endpoints here. If the pack cannot observe it, it
  cannot start a play on it.
- **Saving a motion with no measurement.** A play with no declared number is a habit,
  and habits do not get stopped.

## What it costs

**Free to design.** The record is written locally.

The play it describes will cost something when it runs, and the design step prices the
whole motion per cycle before you save it, so you are agreeing to a recurring number
rather than discovering it. One thing it deliberately will not do: walk a page-gated
trigger endpoint to size the audience. The first page is a free probe; every page after
it is a purchase and it asks first.

## What you get

A named play record: the trigger, the audience definition, the ordered stages naming
existing skills and their parameters, and the metric. It composes
[`/signal-watch`](signal-watch.md), [`/enrich-waterfall`](enrich-waterfall.md),
[`/campaign-review`](campaign-review.md) and [`/measure`](measure.md) rather than
reimplementing any of them, so a fix to one of those is a fix to every play that uses
it.

## How to run it

> We keep winning when a target account posts a Head of Revenue Ops role. Turn that into
> a repeatable play.

No CLI verb — this is design work. The runtime verbs are `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates`.

## What it needs first

You need to know the motion is worth productising, which usually means it has run at
least once. [`/measure`](measure.md) tells you how one run went;
[`/gtm-retro`](gtm-retro.md) compares several and tells you which to keep.

An ICP helps: [`/icp-review`](icp-review.md) writes the anchor artifact that defines
who a play's audience can be drawn from.
