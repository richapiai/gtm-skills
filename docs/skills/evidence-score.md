# /evidence-score

Ranks a list 0-100 on evidence you can point at, and refuses to score a record it knows
too little about instead of guessing a middling number.

## The problem this solves

You have 250 leads and a rep with time for 30 of them this week. Somebody has to decide
the order. The usual answer is a lead score out of a tool that nobody can explain, so when
the rep asks "why is this one above that one" the honest answer is "the model said so".
This skill scores on five things (fit, timing, influence, engagement, reachability), and
every point it awards names the signal and the source line it came from. If the research
behind a record is thin, it says the total is refused rather than reporting a confident 44.

It also answers the question asked right before an email goes out: "can I actually say
they just raised a Series B?" Three answers, no fourth: supported, weak, unsupported.

## When to use it

- "Who should the team call first out of these 250?"
- "Rank this list. And I want to be able to defend the ranking in the pipeline review."
- "Can I say in this email that they use Snowflake, or did we infer that?"
- "These all look the same to me. What actually separates the top ten?"
- "The scores from our old tool put someone with no email address at the top."

## When NOT to use it

- **You want every record to get a number.** A dimension with no supported signal scores
  zero and says `not_found`. There is no list median, no imputation, no "similar records
  scored 14". Below the minimum number of measured dimensions, the total is refused, and
  that refusal is the useful output.
- **You want a value the research already recorded as not found to be reconsidered.**
  Asking a second time until the answer changes is not research. The null carries through.
- **You want something a model guessed to count.** Inferred values grade `weak` and are
  never assertable, however confident the model sounded.
- **There is no research to score.** Scoring an empty file gives you zeros with reasons.
  Run [`/account-research`](../../skills/account-research/SKILL.md) first for timing and
  engagement evidence, and [`/icp-review`](../../skills/icp-review/SKILL.md) so fit is
  measured against something written down.
- **You want the outreach written.** Grading a claim and asserting it are different jobs.
  [`/personalize`](../../skills/personalize/SKILL.md) writes the copy, and it may only
  assert what this skill graded supported.
- **You want clearance to contact someone.** A high score is not permission. That is
  [`/comply`](../../skills/comply/SKILL.md).

## What it costs

Free, with one opt-in paid call.

The grading and the scoring are arithmetic over evidence somebody already fetched. No API
key is needed and no endpoint is reached. No model is asked to grade anything either: the
grader is a fixed table, and the same table is what the test suite executes.

The one paid endpoint is `profile_social_metrics`, and it exists for a single gap, an
engagement dimension with no activity evidence at all. It is opt-in, it is priced by the
free dry run first, and the skill's own rule is to run it on a shortlist that is already
competitive on the other four dimensions. Buying an engagement signal for a record that
scores zero on fit changes nothing about the order. No credit price is written on this
page: it comes from `_lib/api-catalog.json` and is printed by the dry run.

## What you get

- **A ranked file** with the total, the five sub-scores, and a `why_` column per dimension
  carrying the signal and its source line. A short list comes back as a table in chat; a
  long one is written to CSV with the `why_` columns kept. A scored file without them is
  unauditable.
- **A band per record**: hot, warm, watch or drop. One rule sits on top: a record nobody
  can reach cannot be banded hot however well it scores everywhere else, because the top
  of the list is the one slot a rep actually looks at.
- **A summary that leads with what could not be measured**, like this:

```
Scored 247 records
  measured on all five dimensions      41
  total refused, too few dimensions    62
  Engagement not_found across the file 190   <- the finding
```

That third line is usually the real result. It says the file needs research run over it,
not a better sort.

- **A verdict on a single claim**, when that is what you asked for: supported, weak or
  unsupported, with the reason.

Every threshold (the confidence floor, how old evidence can be, how many dimensions a
total needs, the band cutoffs, the reachability floor) lives under `skills.evidence_score`
in `_lib/gates.yaml`. Read one rather than trusting a quoted number:

```console
$ richapi gates skills.evidence_score.band_hot_min
```

## How to run it

Ask Claude in plain English:

> "Score these leads and tell me who to contact first."

> "Rank this list and show me why each one is where it is."

> "Is this claim supported by the research, or are we guessing?"

There is no CLI verb for scoring. The one command here is the optional engagement top-up,
and it starts with a free dry run:

```console
$ richapi call profile_social_metrics --in shortlist.csv --out engagement.csv --dry-run
```

## What it needs first

- [`/icp-review`](../../skills/icp-review/SKILL.md), so fit is scored against a written
  ICP rather than a hunch.
- [`/account-research`](../../skills/account-research/SKILL.md), which fetches the timing
  and engagement evidence. Skip it and those dimensions score zero, correctly.
- [`/enrich-waterfall`](enrich-waterfall.md), which fills the reachability gaps. An
  unreachable record cannot band hot.
- [`/list-hygiene`](list-hygiene.md) before any of it. Scoring duplicates ranks the same
  person twice, and a ranked list of people you may not contact is a trap.
