---
name: play-design
version: 1.0.0
description: >
  Designs a repeatable GTM play — the trigger that starts it, the audience it applies
  to, the sequence of existing skills that runs, and the number that says whether it
  worked. Writes a named play record the team can save, re-run and measure; composes
  /signal-watch, /enrich-waterfall, /campaign-review and /measure rather than
  reimplementing any of them. Use when asked to "design a play", "turn this into a
  repeatable motion", "we should do this every time X happens", "productise this
  campaign", "build us a playbook", or "how do we run this again next month".
  (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write
triggers:
  - design a play
  - repeatable motion
  - we should do this every time
  - productise this campaign
  - build a playbook
  - run this again next month
  - named play
---

# A play is a composition, not a new skill

You are the person who watches a team have a good quarter, notice why, and then fail
to do it again — because "the thing that worked" lived in one rep's head as a sequence
of ad-hoc steps nobody wrote down, with no definition of the trigger that starts it and
no number that says whether it is still working.

A **play** is that motion written down: a named trigger, a named audience, an ordered
sequence of skills that already exist, and one measurement. It is saved, re-run and
compared against its own last run.

This is also the reason the pack does not need two hundred skills. The pack
rules that new motions become **plays, not skills**, and this file is what makes that
true. A new motion is almost never a new capability; it is a new *ordering* of
capabilities the pack already has, with a trigger bolted to the front and a number
bolted to the back. Writing it as a skill duplicates six files. Writing it as a play
duplicates nothing.

## Before anything else

```bash
richapi-skills-preflight
```

- `CATALOG_OK: no` — regenerate with `richapi catalog gen`. Designing a play prices
  the whole motion end to end, and every price in it comes from that catalog.
- `API_KEY_SET: no` — mostly not a blocker. Design, the play record and the cost model
  are all free; only the trigger probe below spends anything, and it is opt-in.
- `SUPPRESSION: STOP` — not a blocker for design, because designing a play contacts
  nobody. It IS a blocker for the play's own run, and the play record says so: the
  compliance stage is not optional and cannot be designed out.

`BALANCE: unknown` is normal and not a blocker.

## What this skill produces, and what it deliberately does not

It produces **one file**: `gtm/plays/<play-name>.yaml`. That file names the trigger,
the audience, the stages, the guardrails and the measurement. It does not contain
enrichment logic, copy rules, compliance rules or a scoring rubric, because every one
of those already exists in a skill that owns it, tests it and gates it.

The rule that keeps this honest, and the one this skill is most likely to break:

> **A stage names a skill. It never re-describes what that skill does.**

If a play stage starts explaining how to pick between the two people-search endpoints,
or how to grade a claim, or what makes an email list sendable, the play has begun to
reimplement [`/build-prospect-list`](../build-prospect-list/SKILL.md),
[`/evidence-score`](../evidence-score/SKILL.md) and
[`/campaign-review`](../campaign-review/SKILL.md) — and it will drift from them
silently, because a play has no tests of its own. Stages carry a skill name and the
parameters that skill already accepts. Nothing else.

## The five stages

Every play has the same five, in this order. A play missing one of them is not a play;
it is a step somebody will forget.

| Stage | The question it answers | Composed from |
|---|---|---|
| **1 — Trigger** | What makes a row enter this play, and when? | [`/signal-watch`](../signal-watch/SKILL.md) on a schedule via [`/scheduled-workflow`](../scheduled-workflow/SKILL.md) |
| **2 — Audience** | Which of the triggered rows qualify? | [`/icp-review`](../icp-review/SKILL.md) for the definition, [`/build-prospect-list`](../build-prospect-list/SKILL.md) for the people, [`/evidence-score`](../evidence-score/SKILL.md) for the order |
| **3 — Prepare** | What has to be true before anyone is contacted? | [`/enrich-waterfall`](../enrich-waterfall/SKILL.md), then [`/list-hygiene`](../list-hygiene/SKILL.md) |
| **4 — Act** | What actually goes out, and who cleared it? | [`/personalize`](../personalize/SKILL.md) → [`/sequence-builder`](../sequence-builder/SKILL.md) → [`/comply`](../comply/SKILL.md) → [`/campaign-review`](../campaign-review/SKILL.md) → [`/launch`](../launch/SKILL.md) |
| **5 — Measure** | Did it work, and better or worse than last time? | [`/measure`](../measure/SKILL.md) per run, [`/gtm-retro`](../gtm-retro/SKILL.md) across runs, [`/learn`](../learn/SKILL.md) for the priors |

Three things about that table are load-bearing.

**Stage 4 is a chain, not a menu.** The order is the pack's own gate order and a play
may not reorder it. Copy is written from graded evidence, compliance clears the
contacts, review binds a verdict to the list's content hash, and
[`/launch`](../launch/SKILL.md) is the sole writer of the export. A play that skips a
link in that chain is a play that will be refused at the end of it anyway.

**Stage 5 is what makes it a play rather than a campaign.** A campaign runs once. A
play is compared against its own previous run, which is why the measurement is part of
the definition and not a thing somebody does afterwards if they remember.

**Stage 1 is the only stage this skill spends on**, and only to size the trigger
before the play is designed around it.

## The play record

This block is the schema. `tests/skills/play-design/harness.mjs` parses it out of this
file and validates every play against it, and the composition rules below are enforced
rather than described. A stage naming a skill that does not exist, an endpoint outside
this skill's own two, or a missing stage all fail here.

```yaml play-spec
schema_version: 1

# Law 5. A play that does not satisfy every rule below is not saved.
default_decision: refuse

required_stages: [trigger, audience, prepare, act, measure]
stage_order_fixed: true

# A stage RUNS a skill. It never re-describes one. Every name here must be a real
# directory under skills/ — a play that names a skill the pack does not have is a
# play that silently does nothing at that stage.
stages:
  trigger:
    runs: [signal-watch]
    schedule_via: scheduled-workflow
    writes: triggers.jsonl
    design_time_probe_allowed: true
  audience:
    runs: [icp-review, build-prospect-list, evidence-score]
    reads: gtm/icp.yaml
  prepare:
    runs: [enrich-waterfall, list-hygiene]
  act:
    runs: [personalize, sequence-builder, comply, campaign-review, launch]
    order_fixed: true
    order_reason: >-
      The pack's gate order. Copy is written from graded evidence, compliance clears
      the contacts, review binds a verdict to the list content hash, and /launch is
      the sole writer of the export.
  measure:
    runs: [measure, gtm-retro, learn]
    required: true
    required_reason: >-
      A motion with no measurement is a campaign that happens to repeat. The number
      is part of the definition, not an afterthought.

# ---------------------------------------------------------------------------
# COMPOSITION RULES. These are what stop a play from becoming a shadow skill.
# ---------------------------------------------------------------------------
composition:
  stage_must_name_an_existing_skill: true
  stage_may_redefine_composed_behaviour: false
  play_may_call_endpoints: [linkedin_job_search, web_tech_stack]
  play_may_call_endpoints_reason: >-
    The two endpoints _lib/endpoint-owners.yaml gives this skill, and they are for the
    design-time trigger probe only. Every other paid call in a play is made by the
    skill that owns it, under that skill's gates, cache class and receipt.
  forbidden_in_a_play_record:
    - endpoint routing decisions that belong to a composed skill
    - copy rules, scoring rubrics, compliance rules, verification thresholds
    - a sender export written by anything other than /launch
    - a stage that runs no skill

# ---------------------------------------------------------------------------
# TRIGGER. The only stage this skill spends on, and only to size it.
# ---------------------------------------------------------------------------
trigger_probe:
  purpose: >-
    Answer one question before the play is designed: how many rows does this trigger
    actually produce per cycle? A play built on a trigger that fires twice a quarter
    is a play nobody will keep running, and a play built on one that fires for half
    the list is an unbudgeted standing charge.
  endpoints:
    hiring:
      endpoint: linkedin_job_search
      unbounded: true
      unbounded_note: >-
        Listed in gates.yaml:unbounded_endpoints.endpoints. It bills per result and
        exposes only `page`, so walking pages multiplies the charge without limit.
        The probe reads the first page and stops.
      page_gate: gates.yaml:unbounded_endpoints.pages_before_confirm
      hard_ceiling: gates.yaml:unbounded_endpoints.hard_page_ceiling
      estimate_basis: gates.yaml:unbounded_endpoints.assumed_results_per_page
      max_pages_gate: skills.play_design.trigger_probe_max_pages
    tech_change:
      endpoint: web_tech_stack
      unbounded: false
      note: Flat per call and bounded. One domain per call; the probe samples, never sweeps.
      sample_only: true
  on_missing_key: stop

# ---------------------------------------------------------------------------
# GUARDRAILS a play carries with it, so a re-run cannot quietly grow.
# ---------------------------------------------------------------------------
guardrails:
  min_audience_gate: skills.play_design.min_audience_rows
  min_audience_reason: >-
    Below it the play is not worth a cycle, and running it anyway trains the team to
    ignore the play's own report.
  max_age_gate: skills.play_design.play_max_age_days
  max_age_reason: >-
    A play whose ICP, prices and trigger definition are older than this is re-approved
    before it re-runs. Prices move: 16 of 53 surviving endpoints repriced in four
    months.
  require_measure_before_rerun_gate: skills.play_design.require_measure_before_rerun
  require_measure_before_rerun_reason: >-
    A play that re-runs before its last run was measured is an unmeasured standing
    charge. The point of a play is the comparison.
  budget_fraction_confirm: gates.yaml:session_budget.fractions.confirm
  budget_fraction_stop: gates.yaml:session_budget.fractions.stop
  single_call_confirm: gates.yaml:session_budget.fractions.single_call_confirm
  watchlist_ceiling: gates.yaml:watchlist.max_entities
  on_missing_key: stop

# ---------------------------------------------------------------------------
# MEASUREMENT. One primary number, declared before the play runs.
# ---------------------------------------------------------------------------
measurement:
  declared_before_first_run: true
  declared_before_first_run_reason: >-
    A metric chosen after the numbers are in is a metric chosen to make the numbers
    look good.
  primary_metric_from: measure
  comparison_from: gtm-retro
  comparison_rule: >-
    /gtm-retro refuses to declare a winner whose range overlaps the loser's. A play
    does not get to declare one either.
  cost_is_a_range: true
  cost_is_a_range_reason: >-
    Several endpoints omit the billing field from the response and their ledger lines
    are written estimated_unverifiable (law 4). A play's cost per outcome inherits
    that and stays a range.

inference:
  mode: local
  paid_hop: none
  reason: >-
    Inference is local under the local-inference rule. This skill owns no LLM endpoint and does not call one. Designing a play is
    composition and arithmetic over the catalog and the ledger, both of which the
    agent running this skill reads directly. There is no question here whose answer is
    on the web, so the Perplexity grounding case does not arise, and there is no batch
    to scale: a play is one document.
```

### The gate keys this skill reads

Four keys under `skills.play_design` bound this skill:
`gates.yaml:skills.play_design.trigger_probe_max_pages`,
`gates.yaml:skills.play_design.min_audience_rows`,
`gates.yaml:skills.play_design.play_max_age_days` and
`gates.yaml:skills.play_design.require_measure_before_rerun`. In the block above they
appear **without** the `gates.yaml:` prefix because there the value of the field is a
key path handed to `gateValue()`, not a citation — a prefix would become part of the
lookup and would not resolve. Read all four; if any one of them stops resolving,
`gateValue()` throws and every check that reads it returns STOP, which is the right
direction: a play whose guardrails cannot be read does not get saved.

Read a threshold rather than quoting it:

```bash
richapi gates unbounded_endpoints.hard_page_ceiling
```

## Step 1 — probe the trigger before you design around it

The design conversation is free. The one thing worth paying for before the play exists
is the trigger's actual volume, because every other number in the play — cost per
cycle, audience size, whether the motion is worth a standing charge — is derived from
it.

```bash
richapi search linkedin_job_search --param title="RevOps" --pages 1 --dry-run
richapi call web_tech_stack --in sample-accounts.csv --dry-run
```

`--dry-run` makes **zero calls**. Two rules on the probe, and they are the difference
between sizing a trigger and buying one:

- **`linkedin_job_search()` is page-gated and unbounded.** It appears in
  `gates.yaml:unbounded_endpoints.endpoints`: it bills per result and exposes only a
  page parameter, so walking pages multiplies the charge without limit. The probe
  reads the first page, reports the volume, and stops. Every page after the first asks
  under `gates.yaml:unbounded_endpoints.pages_before_confirm`, with a hard refusal at
  `gates.yaml:unbounded_endpoints.hard_page_ceiling`, and the pre-call estimate is
  built on `gates.yaml:unbounded_endpoints.assumed_results_per_page` — say that it is
  an estimate basis and not an actual.
- **`web_tech_stack()` samples, it does not sweep.** Flat per call, bounded, and
  cached under `gates.yaml:cache_ttl.endpoints.web_tech_stack`. A tech-change trigger
  is sized from a sample of the target list, not by running the whole list once "to
  see". Sweeping the list is the play's own Prepare stage, and it happens after
  approval, under [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) and
  [`/signal-watch`](../signal-watch/SKILL.md).

If the trigger is already being watched, there is nothing to probe: read the volume
out of `triggers.jsonl` that [`/signal-watch`](../signal-watch/SKILL.md) already
writes, and spend nothing.

## Step 2 — price the whole motion, per cycle, before it is saved

A play's cost is not the probe. It is what one cycle costs when every stage runs, and
that number is the honest thing to put in front of a user who is about to make a
motion recurring.

Build it by asking each composed skill for its own dry-run plan and adding them up:

```bash
richapi call web_tech_stack --in triggered.csv --dry-run
richapi enrich triggered.csv --dry-run
```

Present it as three lines, never one:

- **Per cycle.** What one firing of this play costs end to end, with each stage's
  contribution named and attributed to the skill that owns it.
- **Per week and per month.** A play is recurring by definition, so the standing
  charge is the number that matters. [`/signal-watch`](../signal-watch/SKILL.md) is the
  only other skill in the pack with a recurring cost and it prices the same three ways;
  a play that reuses its trigger inherits that charge rather than adding a new one, and
  the plan says which.
- **Which lines are ranges.** Page-gated stages produce estimates, and several
  endpoints omit the billing field from the response entirely. Those stay ranges in
  the play record and in every report the play ever produces.

Then take one approval for the play as a whole. Approving a play is not approving its
runs: every cycle still re-derives its plan and still fires the session-spend gates at
`gates.yaml:session_budget.fractions.confirm` and
`gates.yaml:session_budget.fractions.stop`.

## Step 3 — write the record, do not run the play

Write `gtm/plays/<play-name>.yaml` against the schema above and stop. Designing and
running are separate acts, and conflating them is how a "let's see what this would
look like" turns into a live motion.

The record carries, at minimum: the play name, the trigger and its measured volume,
the audience definition and the ICP version it was built against, the five stages with
their parameters, the guardrails, the declared primary metric, the per-cycle cost as a
range, and the date it was approved.

Two rules on naming, because a play is a thing people will talk about:

- **Name it for the trigger and the audience**, not for the tactic. "New RevOps hire
  at a Series B account" survives a change of sequence. "Q3 email blast" does not.
- **A play is versioned, never edited in place.** Comparing this quarter against last
  quarter is the whole point, and an edited definition makes the comparison a lie. A
  changed trigger or audience is a new version with its own record.

To make it recurring, hand the saved record to
[`/scheduled-workflow`](../scheduled-workflow/SKILL.md), which re-derives the plan
before every run and STOPS on any divergence — a repricing, a bigger plan, an
exhausted envelope, an expired approval. That skill owns the schedule; this one does
not reimplement it.

## Step 4 — measure, then decide whether it runs again

After a cycle, [`/measure`](../measure/SKILL.md) reports what that run did and
[`/gtm-retro`](../gtm-retro/SKILL.md) compares it against the play's previous runs.
Neither is optional, and the guardrail
`gates.yaml:skills.play_design.require_measure_before_rerun` — read it, and STOP the
re-run if it cannot be read — exists so a play cannot quietly become an unmeasured
standing charge.

Report the play's result the way the retro does: coverage first, then cost as a range,
then the primary metric with its comparison. And carry the retro's refusal rule into
the play — a winner whose range overlaps the loser's is not a winner. "This play beat
that one" said about two overlapping ranges is the most expensive sentence in GTM.

Three honest outcomes, and a play should be allowed all three: **keep** it running,
**change** it (which means a new version, re-approved and re-priced), or **stop** it.
A play that can only ever be kept is a subscription, not a decision.

## What this skill will not do

- **It will not reimplement a skill it composes.** A stage names a skill and its
  parameters. It does not re-describe enrichment routing, scoring, copy rules or
  compliance rules, and a play record that tries to is refused by the schema above.
- **It will not run the play.** Designing and running are separate acts. The record is
  the deliverable; execution belongs to the composed skills and the schedule belongs
  to [`/scheduled-workflow`](../scheduled-workflow/SKILL.md).
- **It will not reorder the Act chain.** Evidence, copy, compliance, review, launch.
  [`/launch`](../launch/SKILL.md) is the sole writer of the sender export, and no
  play may route around [`/comply`](../comply/SKILL.md) or
  [`/campaign-review`](../campaign-review/SKILL.md).
- **It will not save a play with no measurement.** A motion with no declared number is
  a habit, and habits do not get stopped.
- **It will not walk the page-gated trigger endpoint to size a trigger.** The first
  page is the probe; pages after it are a purchase, and they ask.
- **It will not invent a trigger the pack cannot observe.** Intent data, review-site
  activity, email opens and CRM stage changes are not endpoints in this catalog. A
  trigger has to be something [`/signal-watch`](../signal-watch/SKILL.md) can actually
  see, and saying so at design time is cheaper than discovering it at cycle three.
- **It will not send, dial, post or connect.** Sending execution and LinkedIn actions
  are deliberately external to this pack, permanently. A play's last controlled
  artifact is the export.
- **It will not promise a lift.** The measurement says what happened. Predicting what
  a play will do before it has run once is the thing this file was written to replace.

## Related

- The trigger, watched over time and written as dated diffs:
  [`/signal-watch`](../signal-watch/SKILL.md).
- Put the saved play on a schedule, with divergence detection:
  [`/scheduled-workflow`](../scheduled-workflow/SKILL.md).
- The audience definition the play is built against:
  [`/icp-review`](../icp-review/SKILL.md), then
  [`/build-prospect-list`](../build-prospect-list/SKILL.md) and
  [`/evidence-score`](../evidence-score/SKILL.md).
- The Prepare stage: [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) and
  [`/list-hygiene`](../list-hygiene/SKILL.md).
- The Act chain, in order: [`/personalize`](../personalize/SKILL.md),
  [`/sequence-builder`](../sequence-builder/SKILL.md),
  [`/comply`](../comply/SKILL.md), [`/campaign-review`](../campaign-review/SKILL.md),
  [`/launch`](../launch/SKILL.md).
- The Measure stage: [`/measure`](../measure/SKILL.md) per run,
  [`/gtm-retro`](../gtm-retro/SKILL.md) across runs, [`/learn`](../learn/SKILL.md) for
  the priors the next run starts from.
- A one-off question a play does not cover, answered across a list:
  [`/research-agent`](../research-agent/SKILL.md).
- Where a running play's credits are going:
  [`/cost-optimizer`](../cost-optimizer/SKILL.md).
- Session start, routing and the closing receipt:
  [`/richapi-gtm`](../richapi-gtm/SKILL.md).
- Every threshold this skill cites, printed with the key it came from: `richapi gates`.
