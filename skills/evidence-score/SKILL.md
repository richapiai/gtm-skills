---
name: evidence-score
version: 2.0.0
description: >
  Grades how well-evidenced a claim about an account or person actually is, and rolls
  those grades into an auditable 0-100 readiness score across fit, timing, influence,
  engagement and reachability. Every point traces to a signal with a source line; a
  dimension with no signal scores zero and says so. Use when asked to "score these
  leads", "rank by signal", "who should I contact first", "prioritise this list", "is
  this claim supported", or "can I say this in an email". Proactively invoke before
  /personalize — copy may only assert what this skill graded supported. (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write
triggers:
  - score these leads
  - rank by signal
  - who should i contact first
  - prioritise this list
  - hottest leads
  - is this claim supported
  - can i say this in an email
  - evidence based ranking
---

# Grade the evidence, then score the record

You are the person who gets asked "why is this one ranked above that one" and has to
answer with a pointer, not an adjective. A score you cannot trace to a signal is a
number you made up, and a made-up number is worse than no ranking at all — it launders
a guess into a priority list somebody then works through on a Monday morning.

There are two jobs here and the small one comes first.

1. **Grade a claim.** Given a research brief and a fact somebody wants to use — "they
   just raised a Series B", "they use Snowflake", "she runs the RevOps team" — say
   whether the brief actually supports it. Four answers, no fifth.
2. **Score a record.** Roll the grades into 0-100 across five dimensions and band the
   result. A dimension with no supported signal scores zero. It is never estimated,
   never interpolated from neighbouring records, and never softened into "probably
   mid-range".

The first job exists because of the second's downstream consumer.
[`/personalize`](../personalize/SKILL.md) writes sentences that go to a stranger under
the user's name, and it is only allowed to assert what this skill graded `supported`.
That makes this file the pack's fabrication boundary.

## Before anything else

```bash
richapi-skills-preflight
```

- `CATALOG_OK: no` — regenerate with `richapi catalog gen`. The one paid call this
  skill can make is priced from that catalog and from nowhere else.
- `API_KEY_SET: no` — not a blocker. Grading and scoring are pure arithmetic over
  evidence somebody already fetched. Only the optional engagement top-up below spends
  anything, and it is opt-in.
- `SUPPRESSION: STOP` — not a blocker for grading, but do not hand a ranked list onward
  until [`/list-hygiene`](../list-hygiene/SKILL.md) or [`/comply`](../comply/SKILL.md)
  has screened it. A prioritised list of people you may not contact is a trap.

## Where inference runs — and it is not in this skill

**Inference mode: none. This skill runs no LLM hop at all, local or remote, and never
calls `ai_enrich`.**

The reason is the whole point of the skill. Grading is a lookup — is the field present,
does it carry a source line, is the source attributable, is it fresh, is its confidence
above the floor — and scoring is addition. Ask a model to do either and you get a
plausible number with nothing behind it, which is precisely the failure this file
exists to catch. So the grading engine is deterministic, and it is the same code path
the evals run.

This skill does **read** values that a model produced upstream. Those arrive marked
`ai_inferred` and are handled by rule, not by taste: an inferred value is never mixed
into a verified field, and it is never assertable. See the provenance table below.

## The four answers, and there is no fifth

A grade is one of `supported`, `weak`, `unsupported`. When the grade is not
`supported`, the caller must emit one of the three explicit nulls from
`_lib/dual-contract.schema.json` — `not_found`, `not_verifiable`, `not_applicable` —
and nothing else. A blank, a dash, an *unknown*, an *N.A.* and a *no data* are all the
same fabrication wearing a different hat: they read to a downstream skill as *nothing
to report here* when the truth is *we did not find out*.

| Situation | Grade | Explicit null |
|---|---|---|
| The brief has no such field at all | `unsupported` | `not_found` |
| The brief already recorded an explicit null | `unsupported` | that same null, carried through |
| Present, but the source line is missing or unattributable | `weak` | `not_verifiable` |
| Present and verified, but below the confidence floor | `weak` | `not_verifiable` |
| Present and verified, but older than the freshness window | `weak` | `not_verifiable` |
| Present, but the provenance is `ai_inferred` | `weak` | `not_verifiable` |
| The model's response failed the dual contract | `unsupported` | `not_found` |
| Present, verified, sourced, fresh, confident | `supported` | — |

Two rows in that table are the ones people get wrong.

**A brief's own explicit null is the answer.** If the research step already wrote
`not_found` for a funding round, the grade is `unsupported` and the null is `not_found`.
Do not re-ask, do not "have another look", and above all do not upgrade it because a
second source *feels* likelier. A null that gets re-litigated until it turns into a
value is a fabrication with extra steps.

**A malformed model response is not a soft signal.** `_lib/dual-contract.mjs`
quarantines it in `artifact.ai_inferred_invalid[]`; `readArtifactField()` then reports
the field as absent, so it grades `not_found`. There is no code path that renders it.
That is deliberate: `ai_enrich`'s `output_schema` is specified as *guiding* structured
output, not enforcing it, so the pack validates the shape itself and a response that
fails validation never becomes a claim.

## The grading table

This block **is** the grader. You apply it by hand: every step below is a lookup or an
addition, so no script is needed to score a record. The same table is executed by
`score.mjs`, which ships next to this file. A user with `node` can run it over a JSON
file holding one brief or an array of briefs:

```
node <pack>/skills/evidence-score/score.mjs briefs.json
```

It reads this block and `_lib/gates.yaml` and prints one result per brief. The pack's
evals run adversarial briefs through that same file and assert the grade and the
explicit null, so editing a rule here changes what they see, and an edit that fails
open turns them red.

Numbers are deliberately absent. Every threshold names the `gates.yaml` key it is read
from at run time, and a key that does not resolve is a STOP for the check that needed it
— never "no threshold" (law 5). The scoring rubric's point weights are the algorithm
rather than a tunable policy, so they live here where the evals execute them.

```yaml evidence-rules
schema_version: 1

# Law 5. Anything this table does not enumerate grades unsupported.
default_grade: unsupported
grades: [supported, weak, unsupported]
null_enum: [not_found, not_verifiable, not_applicable]

# The null a caller must emit when it cannot assert. A supported claim has none.
grade_null:
  weak: not_verifiable
  unsupported: not_found

# An explicit null already written into the brief is the answer. It is carried
# through unchanged, never re-asked and never upgraded to a value.
carry_through_brief_nulls: true

# Only `verified` is assertable. LLM-derived values are marked ai_inferred, are
# never mixed into verified fields, and are never asserted as fact by any skill.
provenance:
  verified:            {assertable: true}
  ai_inferred:         {assertable: false, grade: weak, null: not_verifiable}
  ai_inferred_invalid: {assertable: false, reads_as: absent}
  absent:              {assertable: false, grade: unsupported, null: not_found}

# A source string the dual contract cannot attribute to anything outside the model
# itself. `model_prior` is the contract's own name for "the model used nothing but
# itself"; an empty source is the same thing with the label missing.
unattributable_sources: [model_prior, self, prior, memory, general_knowledge]
missing_source_grade: weak
missing_source_null: not_verifiable

# Thresholds. Key names only — the value is read from _lib/gates.yaml at run time.
thresholds:
  min_confidence:
    gate_key: skills.evidence_score.emit_min_confidence
    on_missing_key: stop
    stop_grade: weak
    stop_null: not_verifiable
  max_age_days:
    gate_key: skills.evidence_score.evidence_max_age_days
    on_missing_key: stop
    stop_grade: weak
    stop_null: not_verifiable
  min_dimensions_scored:
    gate_key: skills.evidence_score.min_dimensions_scored
    on_missing_key: stop
  band_hot_min:
    gate_key: skills.evidence_score.band_hot_min
    on_missing_key: stop
  band_warm_min:
    gate_key: skills.evidence_score.band_warm_min
    on_missing_key: stop
  band_watch_min:
    gate_key: skills.evidence_score.band_watch_min
    on_missing_key: stop
  priority_reachability_min:
    gate_key: skills.evidence_score.priority_reachability_min
    on_missing_key: stop

# An unparseable or absent timestamp on a verified fact is STALE, not fresh.
undated_evidence_is: stale

# --- the rubric ----------------------------------------------------------------
# Each signal names a brief field. A signal contributes its points only when that
# field grades `supported`. Everything else contributes nothing — a dimension with
# no supported signal scores zero and reports not_found. Never guess a dimension.
dimensions:
  fit:
    max: 20
    kind: additive
    signals:
      - {field: icp_seniority_match,    points: 6}
      - {field: icp_function_match,     points: 5}
      - {field: icp_industry_match,     points: 4}
      - {field: icp_company_size_match, points: 3}
      - {field: icp_geography_match,    points: 2}

  timing:
    max: 20
    kind: additive
    signals:
      - {field: job_change_recent,      points: 10}
      - {field: hiring_surge,           points: 6}
      - {field: funding_event_recent,   points: 6}
      - {field: exec_pain_post,         points: 5}
      - {field: company_topic_post,     points: 3}

  influence:
    max: 20
    kind: banded
    band_field: seniority_band
    value_points:
      founder: 20
      cxo: 20
      owner: 20
      svp: 16
      vp: 16
      director: 12
      senior_ic: 8
      ic: 4
      junior: 4
    unmapped_value_points: 0
    adjustments:
      - {field: function_is_buying_centre, points: 4}

  engagement:
    max: 20
    kind: additive
    signals:
      - {field: authored_post_on_topic, points: 10}
      - {field: commented_on_topic,     points: 6}
      - {field: reacted_to_topic,       points: 2}
      - {field: follows_category,       points: 2}

  # The verifier's verdict, which the enrichment run writes to the
  # `email_verification_status` column. NOT the finder's `email_status`, which is a
  # different answer. `ok` is the value recorded from the live endpoint; the others are
  # unrecorded names kept so a differently spelled verdict still ranks in order. An
  # unlisted value scores 0: add it here when a recording shows it.
  reachability:
    max: 20
    kind: banded
    band_field: email_verification_status
    value_points:
      ok: 12
      valid: 12
      catch_all: 6
      risky: 6
      unknown: 0
      invalid: 0
    unmapped_value_points: 0
    adjustments:
      - {field: phone_present,        points: 4}
      - {field: linkedin_url_present, points: 4}

# A total is only reported when this many dimensions carry at least one supported
# signal. Below it the total is refused: a 0-100 built out of one dimension is not a
# score, it is a coincidence with a decimal point.
total_requires_min_dimensions: true

bands:
  order: [hot, warm, watch, drop]
  hot:   {min_gate_key: skills.evidence_score.band_hot_min}
  warm:  {min_gate_key: skills.evidence_score.band_warm_min}
  watch: {min_gate_key: skills.evidence_score.band_watch_min}
  drop:  {min: 0}
  # A record cannot be banded hot on paper it cannot be contacted through.
  hot_requires_reachability_gate_key: skills.evidence_score.priority_reachability_min
```

### The gate keys this skill reads, and what happens if one goes missing

The seven keys above live under `gates.yaml:skills.evidence_score`. If any one of them
is ever absent, `gateValue()` throws `MissingGateKey`, the check that needed it returns
`stop`, and the grader downgrades the claim rather than certifying it. A missing key
reads as STOP, never as "no threshold" (law 5) — so the failure direction is refusing to
vouch for something, which is the right way round for a skill whose whole job is
deciding what counts as known.

Read a value rather than quoting one:

```bash
richapi gates skills.evidence_score.emit_min_confidence
```

The structural half of the grader — absent field, carried-through null, missing source
line, unattributable source, `ai_inferred` provenance, quarantined malformed response —
needs no key at all. What the keys gate is the *promotion* of a claim to `supported`,
so a gates file that loses one makes this skill stricter rather than looser.

## Score the record

Walk the five dimensions in the rubric. For each one:

1. Grade every signal it names against the brief.
2. Add the points for the signals that graded `supported`. Nothing else contributes —
   not `weak`, not `ai_inferred`, not "it's obviously true".
3. Cap at the dimension maximum.
4. Record the **single highest-scoring supported signal** and its source line. That is
   the `why_` column, and it is what makes the score arguable rather than oracular.

Two rules that people talk themselves out of:

- **A dimension with no supported signal is zero, and the reason is `not_found`.** Not
  the list median, not "average for this seniority", not carried over from last month's
  run. An unmeasured dimension pulls a score down, and that is correct — the record
  genuinely is less evidenced than one you measured.
- **Do not double-count.** A recent job change is a Timing signal. It is not also an
  Influence signal because the new title is senior; that is what the Influence band
  already read.

The total is reported only when enough dimensions carry a supported signal — see
`gates.yaml:skills.evidence_score.min_dimensions_scored`. Below that, report the dimensions you
could grade and say the total is refused. Users accept "I could only measure two of
five" and act on it. They cannot act on a confident 44.

## Where Fit comes from, because this skill does not know your ICP

Fit is the one dimension whose signals are not facts about the prospect. `industry` is a
fact; `icp_industry_match` is a **comparison** between that fact and a definition of who
you sell to, and this skill is never given that definition. It takes briefs and a rubric.
It reads no `gtm/icp.yaml`, it asks the user nothing, and it makes no call that could
tell it.

So the rule is the same one that governs every other value here: **the five
`icp_*_match` fields must already be in the brief, graded, with a source line naming the
ICP they were matched against and its version.** Whoever builds the briefs does that
matching — locally, for free, against the personas
[`/icp-review`](../icp-review/SKILL.md) owns — before scoring runs.

When they are absent, Fit scores **zero and reports `not_found`**, exactly like any
other unmeasured dimension, and the missing 20 points pull the total down. That is not a
defect to be worked around: a record whose fit to your ICP nobody has established is
genuinely less evidenced than one where somebody has. Do not infer a match here from a
title or an industry string — that is a model asserting a judgement the user never
stated, which is the one thing this skill exists to refuse. Say "Fit is unscored because
the briefs carry no ICP match; run /icp-review and re-brief" and let the total be
refused under `gates.yaml:skills.evidence_score.min_dimensions_scored` if that is what
it comes to.

## Bands, and the reachability floor

Bands come from the three `band_*_min` keys. One extra rule sits on top of the hot band:
a record whose Reachability sub-score is under
`gates.yaml:skills.evidence_score.priority_reachability_min` cannot be banded hot however well it
scores everywhere else. The best-fit, best-timed prospect in the file is not actionable
if there is no way to reach them, and putting them at the top of the list wastes the one
slot a rep actually looks at.

## The one paid call, and it is opt-in

Everything above is free. There is exactly one endpoint this skill owns, and it exists
for a single gap: the Engagement dimension when the brief carries no activity evidence
at all.

`profile_social_metrics()` returns the public engagement footprint for one profile URL.
It is metered, so law 3 applies in full and there is no shortcut around it:

```bash
richapi call profile_social_metrics --in shortlist.csv --out engagement.csv --dry-run
```

`profile_social_metrics` has no response map, so the output carries the raw body in a
`response_json` column (`response` in JSONL) with `response_mapped: false` — read the
engagement numbers from there.

The dry run makes zero calls and prints the plan with the per-call cost read from the
generated catalog. Show that plan, take one approval for the whole batch, then run it
without `--dry-run`. A batch large enough to cross
`gates.yaml:session_budget.fractions.single_call_confirm` asks on its own, however
little the session has spent.

Three rules on this call, all of them about not spending to learn nothing:

- **Shortlist only.** Run it on the records that are already competitive on the other
  four dimensions. Buying an engagement signal for a record that scores zero on Fit
  changes nothing about the ranking.
- **Never to break a tie you invented.** If Engagement is zero for everybody because
  nobody pulled activity, that is a gap in the brief, and the honest move is to say so
  rather than to buy a number for the top of the list.
- **The result is evidence like any other.** It lands in the brief with its source and
  its timestamp and is graded by the same table. It is not a licence to assert anything
  the response did not actually say.

Everything else this skill reads was fetched by somebody else:
[`/enrich-waterfall`](../enrich-waterfall/SKILL.md) for reachability,
[`/account-research`](../account-research/SKILL.md) for timing and engagement, and
[`/icp-review`](../icp-review/SKILL.md) for what Fit is even being measured against.

## Report honestly

For a short list, an inline table: rank, total, the five sub-scores, and one `why_`
line per dimension carrying the source. For a long one, the top slice inline and the
whole thing written to a CSV that keeps the `why_` columns — a scored file without them
is unauditable, and an unauditable score is an opinion in a numeric costume.

Lead the summary with what you could **not** measure:

```
Scored 247 records
  measured on all five dimensions      41
  total refused, too few dimensions    62
  Engagement not_found across the file 190   <- the finding
```

That third line is usually the real output. A file where nine records in ten have no
engagement evidence is not a file that needs a better ranking; it needs
[`/account-research`](../account-research/SKILL.md) run over it first, and saying so is
more useful than sorting noise.

Never round a refusal into a number. "Total refused" is a result. Reporting it as 0
puts the record at the bottom of a sorted list, which reads as "measured and bad" rather
than "not measured", and that is the same lie the whole skill exists to avoid.

## What this skill will not do

- **It will not guess a dimension.** Zero signals is zero points and `not_found`. There
  is no imputation, no list median, no "similar records scored 14".
- **It will not assert an `ai_inferred` value as fact,** and it will not merge one into
  a verified field. Inferred values are graded `weak` and carry `not_verifiable`, no
  matter how confident the model was.
- **It will not upgrade an explicit null.** A `not_found` in the brief comes out as
  `not_found`. Asking a second time until the answer changes is not research.
- **It will not invent a source line.** A verified value with no source is `weak`, and
  the fix is fetching the source, not writing a plausible one.
- **It will not rank on affordability.** A cheap-to-reach record is not a better-fit
  record; Reachability is one dimension of five and it gates the hot band rather than
  buying its way into it.
- **It will not write copy.** Grading a claim and asserting it are different jobs, and
  the second one belongs to [`/personalize`](../personalize/SKILL.md).
- **It will not clear a contact for sending.** Lawful basis, suppression and regional
  rules belong to [`/comply`](../comply/SKILL.md); a high score is not permission.
- **It will not send, and it will not write an export for a sending tool.** Sending
  execution is external to this pack, permanently. The final artifact belongs to
  [`/launch`](../launch/SKILL.md) alone.

## Related

- Write copy from these grades: [`/personalize`](../personalize/SKILL.md). It asserts
  only what graded `supported`; everything else becomes an explicit null or nothing.
- Fill the reachability gaps first:
  [`/enrich-waterfall`](../enrich-waterfall/SKILL.md).
- Clean before you score: [`/list-hygiene`](../list-hygiene/SKILL.md). Scoring
  duplicates ranks the same person twice.
- Build the list this scores: [`/build-prospect-list`](../build-prospect-list/SKILL.md).
- Fetch the account evidence the Timing and Engagement dimensions read:
  [`/account-research`](../account-research/SKILL.md).
- What Fit is measured against, and where it is versioned:
  [`/icp-review`](../icp-review/SKILL.md).
- Permission, not priority: [`/comply`](../comply/SKILL.md).
- Sign-off and the export: [`/campaign-review`](../campaign-review/SKILL.md) then
  [`/launch`](../launch/SKILL.md).
- Session start, routing and the closing receipt:
  [`/richapi-gtm`](../richapi-gtm/SKILL.md).
- The one explicit null enum and why it is enforced rather than requested:
  `_lib/dual-contract.schema.json`.
- Every threshold, printed with the key it came from: `richapi gates`.
