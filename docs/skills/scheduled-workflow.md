# /scheduled-workflow

Runs a saved motion on a cadence, inside a spending envelope you approved in advance —
and stops the moment reality stops matching what you agreed to.

## The problem this solves

You want the list refreshed every Monday. The obvious way to do that is a cron job with
your API key in it, and the obvious failure is the one nobody sees until the invoice:
the vendor reprices an endpoint, or your list grows, or a lookup starts returning ten
results where it used to return one, and the job that cost 40 credits a week has been
costing 400 for a month.

This runs the work on a schedule and re-derives the plan every single time before it
spends. If the new plan does not match what you approved, it stops and tells you. It
does not adapt, and it does not "carry on and reconcile later".

## When to use it

- "Refresh this list every Monday."
- "Run the enrichment nightly."
- "Set up a recurring check on these accounts."
- "Automate this and tell me if anything changes."
- "Stop my schedule." (it handles that too)

## When NOT to use it

- **Designing the motion.** That is [`/play-design`](play-design.md). This runs
  something already defined.
- **Anything that would have asked a human.** Every always-ask endpoint, and every page
  past the free one, is a confirmation — and unattended, a confirmation is a stop. This
  is the constraint people most want relaxed and it is the one that is not negotiable.
- **Squeezing a run to fit the envelope.** There is no partial mode. A half-bought list
  is a full charge for work nobody approved, and the pack cannot tell you which half
  arrived. If the plan is over, the run does not start.
- **Watching accounts for buying signals.** That is [`/signal-watch`](signal-watch.md),
  which is built for standing observation and prices its own recurring cost.

## What it costs

**The skill itself makes zero API calls** — arming, checking, recording and reporting
are arithmetic over files the pack already wrote.

The scheduled work costs whatever its dry run says, and that is the point of the
envelope: you approve a bounded total for a named piece of work, and every cycle is
measured against it before anything is spent.

It stops on any of these, by design:

- the price of an endpoint moved
- the plan got bigger than the one you approved
- the envelope is exhausted
- the approval expired
- any gate that would have asked a human

A repricing is not something it works around. Sixteen of the endpoints in this API were
repriced inside four months and one went up more than eight times, so "proceed and
reconcile afterwards" is how you find out too late.

## What you get

A schedule that either does exactly the work you approved, or does nothing and tells you
why. When you come back, you get a report of what ran, what it cost against the
envelope, and whether the schedule is still armed or has halted.

## How to run it

> Run this enrichment every Monday morning, with a ceiling of 500 credits a month.

There is **no `richapi schedule` verb** — the runtime ships `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates`, and the skill says so itself rather than pointing
you at a command that does not exist. The scheduling is a small local script the skill
sets up, driven by your own cron or launchd.

## What it needs first

A dry run of the work you want repeated, so there is a plan to approve. In practice
that means the underlying skill has been run manually at least once and you know what
it costs and what it produces.

[`/play-design`](play-design.md) if you want the motion itself written down first.
