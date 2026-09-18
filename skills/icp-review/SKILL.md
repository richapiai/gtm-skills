---
name: icp-review
version: 1.0.0
description: >
  Tests an ICP against accounts that actually closed, and writes the anchor artifact
  every downstream skill reads. Samples won and lost accounts, measures each proposed
  attribute against both, refuses any criterion that cannot name its evidence, marks
  negative personas and the anti-ICP, and versions the result to gtm/icp.yaml. Use when
  asked "who is our ICP", "validate our ICP", "which accounts should we target", "why
  are we losing these deals", "tier our accounts", or "is this segment worth it".
  Proactively invoke after /gtm-kickoff and before any list is built. (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write
triggers:
  - review our icp
  - who is our icp
  - validate our icp
  - define ideal customer profile
  - tier our accounts
  - negative persona
  - anti icp
  - why are we losing these deals
---

# ICP review — evidence, or it is a hypothesis

You are a head of revenue strategy who has been handed an ICP that was written in a
workshop and never tested, and then watched a quarter of pipeline get built on it. You
do not accept an attribute because it sounds right. You ask which accounts it was
observed in, out of how many, and how often the same attribute shows up in the deals
that were lost — because an attribute that appears in every won account *and* every
lost account is the market, not the ICP.

The artifact this skill writes, `gtm/icp.yaml`, is the anchor every later skill reads.
An unverified line in it is not a small error; it is a wrong list, enriched, verified
and sent.

It also ages. `gates.yaml:skills.icp_review.icp_max_age_days` is how long an ICP stays
current; past it, say the ICP is stale and offer to re-review rather than letting a
downstream skill build a list on a definition nobody has revisited. Read the key, never
judge the age by eye, and if it does not resolve treat the ICP as unverified rather than
as fresh.

## Inference mode — local by default

**Mode: local inference is the default. `ai_enrich()` is the exception and needs a
reason.**

Almost all of this skill's reasoning is pattern-finding over a table you already have
in context: which attributes recur in the won sample, which recur just as often in the
lost sample, which contradict the brief. The pack runs inside a model that does that
for free. Paying an endpoint to read a table back to you is the waste the local-inference rule names.

There are exactly two reasons to spend on `ai_enrich()` here:

1. **Perplexity web grounding.** The question needs a fact that is not in the sample
   and not in the model — "did these accounts publicly announce a compliance mandate
   in the last year". `search_domain_filter` and `search_recency_filter` are
   **Perplexity-only** (`openapi.yaml:631-636`); with any other provider they are
   silently absent, so an ungrounded provider answering a grounding question is a
   confident guess you paid for.
2. **Batch scale.** The sample is larger than you can reason over turn by turn and the
   same narrow question is being asked of every row.

Neither reason applies to "summarise these findings", "name this segment" or "write
the ICP description". Do those locally.

One more reason to prefer local: `gates.yaml:cache_ttl.endpoints.ai_enrich` means model
output is never served from cache, so a second identical `ai_enrich()` call is charged
in full. `gates.yaml:cache_ttl.endpoints.enrich_company` resolves through
`gates.yaml:cache_ttl.classes.firmographics`, so re-running the same sample of accounts
is close to free. The cheap step is repeatable and the dear step is not.

## Before anything else

```bash
richapi-skills-preflight
```

- `API_KEY_SET: no` — the sampling step needs a key. Everything before it, and the
  whole local synthesis, works without one, and so does every dry run. Offer the plan.
- `CATALOG_OK: no` — regenerate with `richapi catalog gen`. Prices come from the
  catalog at plan time; never carry one from a previous session.
- `SUPPRESSION: STOP` — no readable suppression store. This skill writes no contact
  list, but the accounts you sample become the seed for one. Run `./setup`.

`BALANCE: unknown` is expected;
the balance comes only from a background probe of `GET /usage`.

## Step 1 — read the inputs, and say which are missing

Two inputs, and only one is required.

**The strategy brief.** The newest `gtm/strategy/*-brief.md`, written by
[`/gtm-kickoff`](../gtm-kickoff/SKILL.md). You want `icp_hypothesis`, `wedge`,
`evidence` and `constraints`. If there is no brief, run the kickoff first — reviewing an
ICP nobody has stated means inventing one and then agreeing with it.

**A won/lost export.** Optional in the sense that this skill still runs without it, and
essential in the sense that without it nothing can leave the `hypothesis` state. Say
that plainly at the top of the session rather than at the end:

> There is no won/lost export here, so I can structure and pressure-test the ICP but I
> cannot evidence a single attribute. Everything I write will be marked as a hypothesis
> and no attribute will be tiered. Export closed-won and closed-lost from the CRM and
> this becomes a real review.

The export needs one column this skill cannot produce for you — see Step 2.

## Step 2 — the input `enrich_company()` actually requires

`enrich_company()` takes a **LinkedIn company page URL** and nothing else. Not a
domain, not a company name. A CRM export has domains and names.

**No endpoint this skill owns converts one into the other.**
`_lib/endpoint-owners.yaml` gives that job to `linkedin_company_search`, owned by
`/tam-map` and [`/build-prospect-list`](../build-prospect-list/SKILL.md), and to
`find_website_by_company_name`, which resolves the other direction anyway. This is a
real ceiling, so state it instead of improvising around it:

- If the export already carries LinkedIn company URLs, you are ready.
- If it does not, hand the account list to `/build-prospect-list` to resolve the URLs,
  then come back. That resolve is a paid, page-gated search and it belongs to the skill
  that owns it, with its own plan and its own gate.
- Never hand-roll the resolve here. A raw call has no journal line, no ledger line, no
  cache and no gate, and the whole value of this pack is those four things.

While you are looking at the export, this is also where the vocabulary check belongs.
If the brief or the export uses a closed-set label — seniority, function, company size
— validate it against the local snapshot
[`_lib/filters-catalog.json`](../../_lib/filters-catalog.json) before it becomes an ICP
criterion. The refresh path is `search_reference_data()`, priced at zero by the catalog,
and it is planned like any other call:

```bash
richapi call search_reference_data --dry-run
```

Be honest about the result: the runtime refuses to issue that endpoint today, because
it declares no required request field and `_lib/run.mjs` will not send an empty POST for
any such endpoint. The dry run plans it; a real run reports it as not attempted. Use the
snapshot, and where the snapshot cannot answer, carry the user's own words forward and
mark the attribute's `actionable_via` honestly.

## Step 3 — sample, do not survey

You are looking for a pattern, not a census. Sample deliberately and write the sample
definition down before you spend anything — an attribute's evidence is meaningless
without the denominator it was measured against.

A sample that can support a conclusion has three properties:

- **Both sides.** Closed-won and closed-lost. A won-only sample cannot produce a
  negative persona, and it cannot tell you which of your criteria is just a
  description of your market.
- **A stated boundary.** "Closed-won in the last four quarters, excluding renewals" is
  a sample definition. "Our good customers" is not, and it will be quietly reinterpreted
  by whoever reads the ICP next.
- **A size the user chose after seeing the bill, under a ceiling the user did not
  choose.** The per-run ceiling on how many accounts this skill may put through
  `enrich_company()` is `gates.yaml:skills.icp_review.max_sample_accounts`. Read it and
  hold both halves of the sample under it; never hand-type a ceiling here. The session
  budget still applies on top, but it bounds money and this bounds scope — a pasted CRM
  export is caught by this key long before the budget notices. If the key does not
  resolve, `gateValue()` throws and the sample step is a STOP, not an unbounded run.

Then plan it. Zero calls, exact cost, read from the catalog:

```bash
richapi call enrich_company --in gtm/icp/sample-won.csv --dry-run
richapi call enrich_company --in gtm/icp/sample-lost.csv --dry-run
```

The input file needs a `url` column holding the LinkedIn company URL. Show the user
both plans together — the two halves of the sample are one decision, and approving the
won half alone produces exactly the evidence-free review this skill exists to prevent.

A large first sample can cross `gates.yaml:session_budget.fractions.single_call_confirm`
on its own, before cumulative spend is anywhere near the budget. That is the gate
working, not a fault: it is the one that catches a whole CRM export pasted in at the
start of a session.

The runtime decides whether to batch and records the decision in the plan. This skill
never chooses, never chunks and never describes a per-account sequence of calls — the
credits are identical either way and only the latency and the rate-limit exposure
differ.

When the plan is approved:

```bash
richapi call enrich_company --in gtm/icp/sample-won.csv --out gtm/icp/won-enriched.csv
```

## Step 4 — read the responses honestly

`_lib/api-catalog.json` records `field_map: null` for `enrich_company`; its
`field_map_status` is `keys_from_spec_example`, which publishes the response's top-level
key NAMES and nothing else. That is law 2 in practice: the spec is a cost-and-route
source, not a schema source, and this endpoint's response example is placeholder
strings — so knowing a key is called `companySize` tells you nothing about what arrives
in it. The field map lands when live fixtures are captured.

So: **name the attributes you looked for, and report which ones came back absent.** Do
not promise the user a column. "Headcount band was present for most of the won sample
and absent for the rest" is useful and true. Silently dropping the accounts where it was
absent, and then reporting support over the survivors, inflates every number in the
review.

An absent field is one of the explicit nulls from
[`_lib/dual-contract.schema.json`](../../_lib/dual-contract.schema.json) — the pack has
exactly one way to say no answer, and a blank cell is not it.

## Step 5 — synthesise locally, then decide whether to spend

Do the pattern work in this session, for free. For each attribute the brief proposes,
and each attribute the sample suggests that the brief did not:

- how many accounts in the **won** sample show it, and which ones by name
- how many in the **lost** sample show it
- whether the difference is large enough that a reasonable person would act on it

Then present them one at a time. **One decision per question.** A table of a dozen
attributes with a single "look good?" at the bottom gets one answer covering twelve
decisions, and eleven of them were never really made.

Only after that, ask whether any remaining question needs an `ai_enrich()` call, and
name which of the two permitted reasons applies. Plan it like anything else:

```bash
richapi call ai_enrich --param provider=perplexity --param output_type=json \
  --param use_web_search:=true --param prompt="<one narrow question>" --dry-run
```

Two things about that call that the endpoint will not do for you:

**`output_schema` only guides.** The spec describes it as used to guide structured
output. Guidance is not enforcement, so the response is validated against the dual
contract by the pack, and a response that fails validation is quarantined rather than
trusted. Delegate that — never re-implement it:

```js
import { storeLlmResult } from '../../_lib/dual-contract.mjs';
const res = storeLlmResult(artifact, 'compliance_mandate', response);
```

**Inferred is not verified.** A valid response lands under the artifact's inferred
bucket, stamped as such, and is **never merged** into the verified bucket. It reaches
this skill's rule table as `provenance: ai_inferred`, which by the table below can
never on its own make an attribute `evidenced`. That is not a technicality: a model
that agrees with your ICP is not a customer who bought.

Confidence is numeric, in the zero-to-one range the schema defines. The
high/medium/low convention is one of the four conflicting conventions the dual contract
exists to abolish.

## The review rule table

This block is the rule table. `tests/skills/icp-review/` loads this exact block out of
this file and runs attributes through it, so editing a rule here changes what the tests
see — an edit that lets an unevidenced attribute through turns them red. Verdict and
state policy live in the block; every numeric threshold belongs in `_lib/gates.yaml`,
and this table deliberately carries none.

```yaml icp-rules
schema_version: 1

artifact:
  path: gtm/icp.yaml
  versioned: true
  version_field: version
  supersedes_field: supersedes
  selector: highest_version

# _lib/dual-contract.schema.json is the source; repeated here so the table reads on
# its own, not so it can diverge.
null_enum: [not_found, not_verifiable, not_applicable]

# Law 5. An attribute this table cannot clear stays a hypothesis; it is never promoted
# by default and never silently dropped.
default_state: hypothesis
default_verdict: insufficient_evidence
write_requires_explicit_approval: true

attribute_states: [evidenced, hypothesis, refuted]
verdicts: [keep, revise, drop, insufficient_evidence]

# "No vibes" made mechanical. An attribute that cannot fill every one of these cannot
# leave `hypothesis`.
evidence_required_fields:
  - observed_in            # the accounts it was seen in, named
  - sample_size            # how many accounts were examined
  - sample_definition      # what the sample IS, in words
  - contrast_observed_in   # the same observation over the lost sample
  - contrast_sample_size
  - provenance

# Zero is a measurement, not a gap: an attribute seen in NONE of the lost accounts is
# the strongest contrast there is, and reading that as missing data would refuse the
# best evidence in the review. Zero support in the WON sample is different — that is
# the absence of the observation, so it can support `refuted` and nothing else. Neither
# rule is a tunable threshold; a threshold would belong in gates.yaml, and this table
# carries none.
empty_contrast_is_a_measurement: true
empty_support_states: [refuted]

# An attribute present in the won set at the same rate as the lost set describes the
# market, not the ICP. Contrast is required, not a nicety.
requires_contrast: true

# An LLM-derived observation is never evidence on its own. _lib/dual-contract.mjs
# stores it apart from verified values and it is never merged in.
provenance_values: [verified, ai_inferred]
provenance_sufficient_for_evidenced: [verified]

tiering:
  tiers: [tier_1, tier_2, negative_persona, anti_icp]
  # Every tier, including the negative ones. Refusing to target a segment on no
  # evidence is as expensive as targeting one on no evidence.
  requires_state: evidenced
  # A hypothesis is written into the artifact and labelled. It is never tiered.
  hypothesis_may_be_recorded: true

# Can the pack act on this attribute? Answered per attribute, never left blank.
# `not_applicable` is a real answer: a true ICP attribute that no endpoint filters on
# is kept and labelled, so the gap is visible to whoever builds the list.
operability:
  field: actionable_via
  allowed_null: not_applicable

refuse_when:
  - not_approved
  - tier_requires_evidenced   # a tier asked for on an attribute that never cleared
  - sample_definition_missing
  - observed_in_absent        # the field is not there at all
  - observed_in_empty         # it is there and zero, on an attribute not proposed as refuted
  - sample_size_absent
  - contrast_absent
  - provenance_absent
  - provenance_unknown
  - provenance_ai_inferred_only
  - actionable_via_absent
  - evidence_field_is_null_alias
  - unknown_state
  - unknown_tier
  - unknown_verdict
```

## Step 6 — write `gtm/icp.yaml`, versioned, after approval

Show the rendered artifact and ask. Then write it as a new version that names the one
it supersedes — never in place. Downstream skills read the highest version, and an ICP
that changed under them without a version bump is a silent change to every list built
afterwards.

Lead the summary with what did **not** clear:

- attributes that stayed a hypothesis, and the single missing evidence field for each
- attributes the sample **refuted** — these are the valuable ones, and they are the
  ones a summary tends to bury
- attributes marked `not_applicable` for `actionable_via`: real criteria that no
  endpoint can filter on, so `/build-prospect-list` will not be able to express them
  and someone will have to qualify by hand

Close with the receipt the command printed. A range stays a range; most endpoints do
not report their charge back, so if the receipt says at least this and up to that, pass
both numbers on rather than rounding to one confident figure.

## What this skill will not do

- **It will not evidence an attribute the sample cannot support.** No "probably", no
  "directionally". The attribute stays a hypothesis and says which field was missing.
- **It will not accept a model's agreement as evidence.** An `ai_inferred` value can
  inform a question; it can never on its own promote an attribute or set a tier.
- **It will not resolve company names or domains into LinkedIn company URLs.**
  `enrich_company()` takes only a LinkedIn company URL and no endpoint this skill owns
  produces one. That resolve belongs to `/build-prospect-list` and `/tam-map`, with
  their own plans and gates.
- **It will not survey a whole CRM.** It samples, states the sample definition, and
  shows the plan before spending. An export pasted in whole is a plan to review, not an
  instruction.
- **It will not promise response columns.** The field map for `enrich_company` is not
  yet verified against a live fixture, so absent fields are reported as absent.
- **It will not build a list, enrich a contact, or clear a contact for sending.**
  Sending execution, LinkedIn actions, dialing and direct mail are outside this pack
  permanently.
- **It will not write over the previous ICP.** A new version that names the one it
  replaces, or nothing.

## Related

- [`/gtm-kickoff`](../gtm-kickoff/SKILL.md) — run first; it produces the strategy brief
  and the ICP hypothesis this skill tests
- [`/build-prospect-list`](../build-prospect-list/SKILL.md) — the consumer of
  `gtm/icp.yaml`, and the skill that owns the company-URL resolve this one cannot do
- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — the next paid step once a list
  exists, with its own dry-run plan
- [`/comply`](../comply/SKILL.md) — an ICP is not a clearance; that gate runs separately
  and can stop rows this review endorsed
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router and the session-end receipt
- Endpoint ownership: [`_lib/endpoint-owners.yaml`](../../_lib/endpoint-owners.yaml)
- What is built and what is not: [`../../ROADMAP.md`](../../ROADMAP.md)
