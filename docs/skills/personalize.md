# /personalize

Writes the personalised first line or short email body for each contact, and hands you a
refusal instead of a sentence whenever the research does not actually support the claim.

## The problem this solves

Your reps are sending 200 emails a week that all open with the same three lines, so
nothing gets read. The obvious fix is to have a model write an opener per contact, and
that fix has a failure mode nobody plans for: it writes "congrats on the Series B" to a
company that never raised one. The generic opener gets deleted. The invented one gets
screenshotted and forwarded, with your rep's name on it. This skill only writes a claim
the research brief already carries, with the source line attached, and tells you plainly
which contacts it would not write for.

## When to use it

- "These emails all sound the same. Make them specific to the person."
- "Write me a first line for each of these 300 contacts."
- "Can I say in this email that they just raised, or did we make that up?"
- "I want the copy, but I do not want anyone claiming something we cannot show."
- "Which of these contacts do we actually know enough about to personalise?"

## When NOT to use it

- **You want a line about a fact the research does not have.** There is no flag and no
  override for this. It returns `not_found` and offers a claim-free opener instead. Go
  get the fact with [`/account-research`](account-research.md), then come back.
- **You want it to hedge.** "I think you may have raised recently" is still a claim made
  to a stranger, and a worse one. It refuses rather than softens.
- **You want a guess to count because the model sounded confident.** Anything a model
  inferred is stored as inferred and is never assertable in copy.
- **You want the claims graded.** That is
  [`/evidence-score`](evidence-score.md). A writer marking its own homework is how the
  rule gets talked around.
- **You want the cadence.** Steps, spacing and channel are
  [`/sequence-builder`](sequence-builder.md). This skill fills the slots that design
  leaves.
- **You want to know whether you may contact these people at all.** That is
  [`/comply`](../../skills/comply/SKILL.md). Well-sourced copy to someone with no lawful
  basis is still a violation.
- **You want it sent, or an export a sending tool can read.** The pack stops at the send
  button. The export is [`/launch`](../../skills/launch/SKILL.md), and only that.

## What it costs

Free for the writing. Drafting happens in the agent you are already talking to, which
costs nothing per contact, so this skill does not call an endpoint to write a sentence.

There is one paid endpoint, `ai_enrich`, and it exists for two narrow jobs: fetching a
fact off the web that the brief is missing, and handling a list large enough that holding
it all in the agent's context stops working. That threshold is a gate key, not a number
somebody remembers:

```console
$ richapi gates skills.personalize.ai_enrich_batch_min_rows
```

Both paid routes start with the free dry run, which makes zero API calls, works without
an API key, and prints the per-call cost from `_lib/api-catalog.json`. No credit price is
written on this page on purpose: prices in this API are read at run time, not quoted from
a doc.

One thing the paid route does not buy you: a fact fetched off the web comes back marked
inferred, and inferred facts still cannot be asserted in copy. Grounding gives you a lead
to go verify. It does not give you a sentence to send.

## What you get

- **A draft per contact** at `gtm/copy/<play>/<contact>.yaml`, carrying the claim, the
  field it came from, its grade and the source line. That trail is what answers "where
  did we get that" when the reply arrives.
- **A refusal count, stated as loudly as the drafts.** Something like: 40 contacts, 12
  drafted, 28 refused, split into the contacts the brief says nothing about and the ones
  whose only source is a model. No draft is written for the refusals.
- **No draft at all for a suppressed contact**, and no draft for anyone if the
  do-not-contact store cannot be read.

The refusal count is usually the finding. A file that is 70% refusals is telling you the
research is thin, not that the copy is.

## How to run it

Ask Claude in plain English:

> "Personalise these emails using the research brief. Show me who you could not write
> for."

> "Write a first line for each of these contacts, one claim each, nothing we cannot
> source."

There is no CLI verb for drafting. The only command here is the optional grounded fetch,
and it starts free:

```console
$ richapi call ai_enrich --in briefs.csv --out grounded.csv --dry-run
```

## What it needs first

1. `./setup` has been run, so there is a readable do-not-contact store. Without one this
   skill will not draft anything. `richapi preflight` tells you.
2. A research brief to write from: [`/account-research`](account-research.md) for account
   facts, [`/enrich-waterfall`](enrich-waterfall.md) for contact data.
3. [`/evidence-score`](evidence-score.md) over the claims you intend to make. This skill
   asserts only what that one graded supported.
4. [`/sequence-builder`](sequence-builder.md) if you want the drafts to land in a cadence
   rather than in a one-off blast. It costs nothing and it decides what each step is for.
