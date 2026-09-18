# /gtm-kickoff

A dated strategy brief on disk, with at least one of your assumptions written down as an
assumption, produced before a single credit is spent.

## The problem this solves

You are standing up a new motion, or a new segment, or a new product, and the first
instinct is to go build a list. The list is the cheapest part to build and the most
expensive part to be wrong about: a quarter of enrichment spend can go into an ICP that
was decided in a workshop and never checked against a deal. This skill sits you down
first and asks six questions, one at a time, then argues with at least one of your
answers. It writes nothing until you have read the brief and said yes.

## When to use it

- "We are launching next quarter and nobody has written down who we sell to."
- "Where do we even start?"
- "Everyone on this team would describe our ICP differently."
- "I want someone to tell me why this plan will not work, before I spend on it."
- "New segment, new geography, new product. Same question."

## When NOT to use it

- **You want the ICP decided, not recorded.** This skill captures a hypothesis and labels
  it as one. Deciding needs evidence it does not gather. That is
  [`/icp-review`](icp-review.md), which tests the hypothesis against accounts that closed.
- **You want facts from outside the room.** It owns one endpoint and that endpoint returns
  filter labels. It cannot size a market ([`/tam-map`](tam-map.md)), read a competitor
  ([`/competitive-intel`](competitive-intel.md)), or check whether something you asserted
  is true ([`/research-agent`](research-agent.md)). Gaps stay visible in the brief's
  `open_questions` rather than being filled in.
- **You want a list.** No list exists yet, which is the point.
  [`/build-prospect-list`](build-prospect-list.md) comes later.
- **You want a draft to edit later.** It does not write the brief without approval. An
  unapproved artifact gets read downstream as a settled decision.
- **You used a filter word you are not sure about.** It will not guess a nearby label. An
  unrecognised term is carried through as your own words and resolved at search time by
  [`/build-prospect-list`](build-prospect-list.md).
- **You want the constraints in the brief to count as compliance clearance.** They do not.
  [`/comply`](../../skills/comply/SKILL.md) is a separate gate and can stop a run this
  brief endorsed.

## What it costs

Free. The interview happens inside the agent, over what you type, and reaches no
endpoint. It owns exactly one endpoint, `search_reference_data`, which
`_lib/api-catalog.json` prices at **0 credits per call** (that number is read out of the
catalog, not typed here). In practice even that call does not go out: the runtime refuses
to send an empty request body for any endpoint that declares no required field, so the
dry run plans the call and a real run reports it as not attempted. The label check is
answered from the local snapshot in `_lib/filters-catalog.json` instead, which is a file
read.

This is also the session where the budget conversation belongs, because it is the only
moment in the pack when nothing has been spent yet. You name the number. The prompt
offers a suggestion from `gates.yaml:session_budget.suggestion_credits` and it is a
suggestion, never a default.

## What you get

`gtm/strategy/<date>-brief.md`, markdown with a YAML front-matter block. Downstream skills
find the current brief by taking the newest date in that directory, so there is no pointer
file to go stale.

Nine fields, and four of them cannot be left empty: `motion`, `icp_hypothesis`,
`constraints`, and `premise_challenges`. That last one is the point of the whole session.
Each challenge records what was put to you, what you said back, and whether it changed
anything. A challenge you rejected still goes in, because that is the line someone reads
in three months when the number came in low. Every claim in `evidence` names its source,
and `assertion` is a permitted source: a belief with a label on it is honest, a belief
that reads like a finding is how a bad ICP survives to the enrichment bill.

The brief ages. `gates.yaml:skills.gtm_kickoff.brief_max_age_days` is how long one stays
current, and past it a downstream skill says the anchor is stale rather than inventing its
own view of when a strategy expires.

## How to run it

Say to Claude:

> Help me build a GTM motion for this product.

> We are launching in Germany next quarter. Where do we start?

There is no `richapi gtm-kickoff` command. The runtime ships `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates`, and an interview is not one of them. Two commands the
session uses, both free:

```console
$ richapi call search_reference_data --dry-run
$ richapi gates skills.gtm_kickoff.brief_max_age_days
```

## What it needs first

Nothing. This is the first skill in the pack and it runs with no API key.

Run `./setup` at some point in this session anyway. It costs nothing, and
`SUPPRESSION: STOP` is not a blocker here (no contact list is written) but it blocks
everything downstream. Setup is cheaper to run at kickoff than at the moment the first
list is due.

Next stop is [`/icp-review`](icp-review.md), which tests this brief's ICP hypothesis and
is the first skill in the chain that spends anything. If you have no won and lost history
to test against, say so: the honest next step is a deliberately small
[`/build-prospect-list`](build-prospect-list.md) run against the hypothesis, understood as
an experiment rather than a campaign.
