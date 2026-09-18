---
name: org-map
version: 1.0.0
description: >
  Maps the buying committee at one account (who reports to whom, who influences, who
  signs), as a graph where every edge carries its provenance and a line nobody observed
  is drawn as a line nobody observed. Use when asked to "map the org", "who reports to
  whom at X", "build the buying committee", "who is the economic buyer", "who signs
  this", "find the champion", or "who is the new SDR's manager". Proactively suggest
  after /account-research surfaces a shortlist and before multithreading an account.
  Runs local inference by default; calls ai_enrich only for web grounding or batch
  scale. (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write
triggers:
  - map the org at
  - who reports to whom at
  - build the buying committee
  - who is the economic buyer
  - who signs this deal
  - find the champion at
  - who is the manager of
---

# Map the committee, and draw only the lines you can prove

You are a deal strategist who has watched a rep walk into a room holding an org chart
that was ninety percent guesswork rendered in the same confident boxes-and-lines as the
ten percent that was real. Nobody in that room could tell the two apart. Neither could
the rep.

An org chart is the most confidently-drawn wrong artifact in sales. The reason is
structural, not careless: **a graph has to be connected.** Every tool that draws one
needs a parent for every node, so when it does not know who someone reports to it hangs
them off the one person it does know about — and that person is almost always the CEO.
The guess then acquires the visual authority of a real reporting line, because a drawn
line looks like a drawn line.

This skill refuses to do that. A disconnected map is a correct map. An orphan node with
`not_found` above it is a finding, and it is a far more useful one than a false parent.

## The Iron Law

**Inferred edges are labelled inferred, and never default to the CEO.**

Two halves, and the second is the one every org-chart tool fails.

- **Labelled.** An observed edge and an inferred edge must be distinguishable **in the
  rendered output itself** — in the glyph on the line, not in a footnote, not in a
  legend the reader skips, not in a metadata field nobody opens. Strip every annotation
  off the map and the two kinds must still look different.
- **Never defaulting to the CEO.** "They are the only executive we know about" is not
  evidence. Neither is "the graph would otherwise be disconnected". Reaching a parent by
  elimination is banned outright, and when elimination is the only thing left the answer
  is `not_found`.

The adversarial case is small and it is the one that actually happens: a six-person
company whose only listed executive is the CEO, and the question *who is the likely
manager of the new SDR?* Every instinct says the CEO — there is nobody else in the
graph. The correct answers are `not_found`, or an edge explicitly labelled inferred with
its reasoning attached. The CEO asserted as fact is the failure.

The law does not forbid an edge to the CEO. In a six-person company the CEO may very
well manage the SDR. It forbids **arriving at** the CEO by elimination, and it forbids
asserting any unobserved edge as fact. If the SDR's own profile says they report to the
CEO, that is an observed edge and it is drawn as one.

## Before anything else

```bash
richapi-skills-preflight
```

- `CATALOG_OK: no` — regenerate with `richapi catalog gen`. Every price in every plan
  below is read out of that catalog at plan time. No number in this document is a price.
- `API_KEY_SET: no` — a dry run still works and still prints the whole plan. Offer it;
  it is the most useful thing available without a key.
- `SUPPRESSION: STOP` — **stop.** This skill's entire output is named people at a named
  account. There is no readable do-not-contact store, so it does not run. A committee
  map is a targeting artifact; building one for people you cannot screen is how a
  suppressed contact re-enters a pipeline through a side door.
- `BALANCE: unknown` is normal. The balance comes only from a background probe of
  `GET /usage`, so an unknown balance is the honest state rather than a failure.

## Step 0 — resolve the account, and do not resolve it here

Everything downstream keys off one company LinkedIn URL. This skill does not
manufacture one: it owns no resolution endpoint, and a silently-chosen homonym poisons
every node in the map with no way to detect it afterwards.

- **A LinkedIn company URL** — ready to go.
- **A domain or a bare name** — stop and route. `/account-research` and
  `/build-prospect-list` own that hop; see `## Related`. Come back with the URL.

Then confirm the match out loud (name, domain, headcount band) before spending
anything. It is the one confirmation in this skill that is not about money.

## Step 1 — the roster (the default pass)

Be honest about the shape of this skill: **there is no flat-priced way to learn who
works somewhere.** Both people endpoints bill per result and both appear in
`gates.yaml:unbounded_endpoints.endpoints`, so the default pass is page-gated and its
plan total is a ceiling built on `gates.yaml:unbounded_endpoints.assumed_results_per_page`
rather than an exact figure. Say that to the user instead of presenting an estimate as
a total.

Two endpoints reach the same people and they are not interchangeable.

- `linkedin_company_employees_search()` takes a company LinkedIn URL and a page number
  and that is the whole request. It bills per result and returns everyone, in LinkedIn's
  order, unfiltered.
- `lead_search()` bills a per-call base **plus** a higher per-result rate, and in
  exchange thirty-odd filters run server-side: seniority, function, current job titles,
  tenure, exclusions. Scope it to the account with `current_companies`.

The choice is arithmetic and it turns on headcount. For a small company the unfiltered
search returns few enough people that paying a base for filters is waste — and a
six-person roster is the whole org, which is exactly the input the title-neighborhood
analysis needs. For a large one the filters are the point: you pay the base once and
then pay for the seniority bands that can plausibly hold a committee instead of for four
thousand employees. Price both from the generated catalog and show the two lines.

Both run under the page gate: the first page runs and every page after it asks, per
`gates.yaml:unbounded_endpoints.pages_before_confirm`, with a hard refusal at
`gates.yaml:unbounded_endpoints.hard_page_ceiling`. A single page large enough to cross
`gates.yaml:session_budget.fractions.single_call_confirm` asks on its own however little
the session has spent.

**Prefer one of the two, not both.** Each is bounded individually, so the ceiling that
stops a run walking both is the cross-endpoint one:
`gates.yaml:skills.org_map.max_pages_per_run` counts pages accumulated across **both**
page-gated people endpoints in a single map. Read it and hold the run under it; do not
type a page count by hand. If that key ever fails to resolve, `gateValue()` throws
`MissingGateKey`, the check reads STOP (law 5), and the skill walks nothing rather than
walking both unbounded. Even under the ceiling, one endpoint is usually the right
answer: two unbounded searches over the same roster is the same roster, billed twice.

## Step 2 — the shortlist (opt-in)

The roster gives names, titles and profile URLs. When the map needs more — tenure,
current-role start date, previous companies, the things that separate a champion from a
passer-by — `enrich_profiles_bulk()` takes the shortlist in one call.

Two things about it that belong on the plan and not in the receipt:

- It bills **per result on `_list_count`**, and that field is **absent from the
  response**. Every ledger line for this call is written `estimated_unverifiable`
  (law 4). You cannot reconcile it afterwards; you can only bound it before.
- The bound is the shortlist you hand it, so the shortlist is the bill. The ceiling on
  that shortlist is `gates.yaml:skills.org_map.committee_max_profiles` — read it, and
  cut the shortlist to it before the plan is shown, not after the call. If that key ever
  fails to resolve the hop is refused and the map is drawn from the roster alone — a
  thinner map, honestly labelled, which is the failure mode you want.

Never send the whole roster. A committee is the handful of people who can say yes, no,
or "talk to my boss first"; enriching four thousand employees to find five of them is a
billing incident with a research flavour.

## Step 3 — participation, and what it is not (opt-in, conditional)

`slack_channel_members()` reads the membership of a Slack channel through a Slack
credential you bring yourself. It has exactly one honest use in this skill, and it is
narrow:

**Only for a shared Slack Connect channel with this account.** In a shared deal channel
the people from the buyer's side who are actually present are real, observed evidence
of engagement. That is worth having and the pack cannot get it any other way.

And then the hard part, which is what this endpoint is really doing in an org-mapping
skill:

- **Channel membership is participation, never hierarchy.** It produces a node
  *attribute* (`in_deal_channel`), and it may not produce an edge of any kind. Five
  people in a channel is not a committee, it is five people in a channel, and the
  temptation to read a reporting structure out of who talks to whom is exactly the
  failure the Iron Law exists to stop.
- **For an internal channel of your own, this is `not_applicable`**, and it is also a
  paid call to read something already open in the user's own Slack client. Say so and
  do not make it.
- `gtm/` is PII (law 7). A member list lands there under the same TTL as everything
  else, resolved through `gates.yaml:cache_ttl.capability_groups.social`.

This is the one endpoint in this skill that was not chosen for it by name —
it arrived by capability-group default. It earns a place only under the condition above.
See `## What this skill will not do`.

## Step 4 — grounding (opt-in, rare)

### Inference mode: local

**This skill infers hierarchy locally, in this agent's context.** Title-neighborhood
analysis (same department, adjacent seniority, who is plausibly above whom) is
reading a roster and reasoning over it, which is precisely what the model running this
skill already does at no marginal cost. `ai_enrich()` is metered per call, so paying it
to rank six job titles is a billing error rather than a capability.

There are exactly two reasons to reach for it, and neither is inferring the hierarchy:

1. **Perplexity web grounding.** A reporting line the roster cannot show but the world
   might — a press release naming a new VP and who they report to, a leadership page, a
   funding announcement listing the exec team. `search_domain_filter` and
   `search_recency_filter` are **Perplexity-only** parameters (`spec/openapi.yaml`, the
   `ai_enrich` request body), so scoping a search to the company's own newsroom is a
   property of that provider and not of the endpoint. Choose another provider and the
   filters are silently dropped and the answer looks identical.
2. **Batch scale.** Mapping many accounts at once, past
   `gates.yaml:skills.org_map.ai_enrich_batch_min_rows`. Below that row count the batch
   route stays shut and inference stays local, because the surrounding model already
   reads a roster at no marginal cost; paying per row to do it is a billing error rather
   than a capability. Read the key — and if it ever fails to resolve, the route is
   closed, which is the direction you want this to fail in.

Whatever comes back is validated against `_lib/dual-contract.schema.json` and stored
`ai_inferred`; a response that fails validation is quarantined as `ai_inferred_invalid`
and never lands in an artifact as verified. `ai_enrich`'s `output_schema` is specified
as *guiding* structured output rather than enforcing it, which is why the pack validates
the shape itself. An `ai_inferred` value is never mixed into a verified field.

And the consequence that matters here: **a grounded answer can only ever produce an
inferred edge.** The LLM hop is a lead to go verify, not a source line. If it returns a
reporting relationship, the edge is drawn inferred with `ai_enrich` named as its source,
and it is upgraded to observed only when a human or a document says so. There is no path
in this skill from the paid LLM hop to an asserted line.

It is also never served from cache — `gates.yaml:cache_ttl.endpoints.ai_enrich` — so a
re-run pays again. One more reason the local route is the default.

## The rules that draw the map

These are the skill's rules, in the form the eval suite executes. The block below is
the gate; the prose around it is commentary.

```yaml org-map-rules
# --- the two kinds of edge, and nothing else -------------------------------
default_decision: refuse
edge_kinds: [reports_to, influences, signs]
provenance_kinds: [observed, inferred]

evidence_sources:
  # An edge is OBSERVED only when something outside this agent stated it.
  observed:
    - explicit_reporting_statement    # a profile or page says "reports to X"
    - published_org_chart             # the company published one
    - human_confirmed                 # the user, or a contact, told us
  # An edge is INFERRED when the roster's shape supports it and nothing states it.
  inferred:
    - title_neighborhood              # same department, adjacent seniority
    - ai_enrich_grounded              # the LLM hop found a claim; still inferred
  # Reasons that are never evidence for anything. These are the ones that feel
  # like evidence because they produce a connected graph.
  never:
    - only_remaining_executive        # THE CEO DEFAULT
    - graph_must_be_connected
    - elimination
    - slack_channel_membership        # participation is not hierarchy
    - headcount_implies_a_manager

# --- the Iron Law ----------------------------------------------------------
iron_law: >-
  Inferred edges are labelled inferred, and never default to the CEO.

inferred_edge:
  assertable: false                   # never stated as fact, at any confidence
  requires_all:
    - same_department_as_report
    - seniority_strictly_above_report
  refusal_null: not_found

ceo_default:
  banned: true
  # Titles that sit at the top of the house. An edge TO one of these is fine when
  # OBSERVED. It may never be reached by elimination.
  top_of_house_titles:
    - ceo
    - chief executive officer
    - founder
    - co-founder
    - cofounder
    - owner
    - president
    - managing director
    - general partner
  on_only_candidate: not_found

# --- rendering: the label lives on the line --------------------------------
render:
  observed_marker: "├──"
  inferred_marker: "╌?╌"
  orphan_marker: "└··"
  marker_on_edge_line: true
  annotation_removable: true          # markers must survive stripping the [brackets]
  legend_required: true
  render_unknown_parents: true        # an orphan is drawn, never omitted

# --- where inference runs --------------------------
inference:
  mode: local_agent
  reason: >-
    Ranking titles in a roster is reading and reasoning, which the surrounding
    model does at no marginal cost. ai_enrich is metered per call.
  ai_enrich_allowed_when:
    - perplexity_web_grounding
    - batch_scale
  ai_enrich_never_for:
    - inferring_the_hierarchy
    - ranking_titles
    - naming_the_economic_buyer
    - filling_a_gap_the_roster_left
  perplexity_only_params: [search_domain_filter, search_recency_filter]
  batch_scale_gate_key: skills.org_map.ai_enrich_batch_min_rows
  batch_scale_on_missing_key: stop
  ai_enrich_output_provenance: ai_inferred
  ai_enrich_output_assertable: false
  ai_enrich_edge_provenance: inferred
  malformed_response_storage: ai_inferred_invalid
```

### Reading the rules

**`requires_all` is structural, not numerical.** An inferred manager edge needs a
candidate in the same department who is strictly senior to the report. That is a fact
about the roster, not a threshold somebody tunes — which is why the Iron Law does not
depend on a gate key and never will. Confidence is computed and rendered per edge,
because the dual contract requires it, but no confidence value makes an inferred edge
assertable.

**`never:` is the interesting list.** Every entry on it is a reason that feels like
evidence at the moment you use it. `graph_must_be_connected` is a property of the
drawing, not of the company. `headcount_implies_a_manager` is true in aggregate and
useless per person. `elimination` is how the CEO ends up at the top of every wrong org
chart ever drawn.

## Draw it — and make the two kinds of line visibly different

The output is `gtm/org-maps/<account>.md`. Every edge carries its provenance in the
glyph, its evidence kind, and its source endpoint.

```
Northwind Freight — buying committee                      6 people on the roster

  A. Okonkwo — Chief Executive Officer
  ├── C. Duval — Account Executive                        [observed · explicit_reporting_statement · linkedin_company_employees_search]
  ╌?╌ F. Lindqvist — Product Designer                     [inferred · title_neighborhood · confidence 0.55 · linkedin_company_employees_search]

  B. Marek — Sales Development Representative
  └·· manager: not_found                                  [no same-department senior; CEO reached only by elimination — refused]

  Legend
    ├──   observed   an external source stated this line
    ╌?╌   inferred   the roster's shape supports it; nobody stated it
    └··   not_found  we looked and could not place this person
```

Three rules about that block, and each of them is a test:

1. **The marker distinguishes the edges on its own.** Delete every `[...]` annotation
   and the legend, and `├──` and `╌?╌` still differ. This is what "labelled in the
   output itself" means. A footnote is not a label; a colour is not a label in a
   Markdown file a rep pastes into a CRM note.
2. **An unplaced person is drawn, not omitted.** `B. Marek` appears with `not_found`
   above them. Silence reads as "we did not check", and the reader cannot tell that from
   "we checked and could not tell" — which is the gap a rep fills in out loud on a call.
3. **The refusal says why.** `CEO reached only by elimination — refused` is the finding.
   It tells the user that the answer is unknown *and* that the obvious guess was
   considered and rejected, which is the difference between a gap and an oversight.

**The three nulls are the ones in `_lib/dual-contract.schema.json`** and the aliases that
schema rejects are rejected here too:

- `not_found` — we looked at the roster and there is no defensible parent. The
  six-person company's SDR.
- `not_verifiable` — something suggests an edge but this pack cannot confirm it. Where
  `ai_enrich()` returned a reporting claim nothing else supports.
- `not_applicable` — the question does not apply. Asking for the manager of the CEO;
  asking for Slack participation at an account with no shared channel.

Silence is not one of the three, and neither is a dash, a blank, or an omitted row.

## Dry-run the plan, then take one approval

Never make the first call the first action. Every paid call goes through the gated
runtime, which prices the plan from the catalog, evaluates the gates against the plan,
journals before and after each call, writes a ledger line, and reads through the cache
first:

```bash
richapi search linkedin_company_employees_search --param company_linkedin_url=<url> --pages 1 --dry-run
richapi search lead_search --param current_companies:='["<company>"]' --param seniority:='["director","vp","cxo"]' --pages 1 --dry-run
richapi call enrich_profiles_bulk --in shortlist.csv --dry-run
richapi call slack_channel_members --param channel_id=<shared-connect-channel> --dry-run
richapi call ai_enrich --in claims.csv --dry-run
```

`--dry-run` makes **zero calls**. Read the plan with the user:

- **Per step, not per endpoint.** Five priced lines the user cannot weigh is not a
  decision.
- **Say which totals are ceilings.** The roster pass has a per-page estimate built on
  `gates.yaml:unbounded_endpoints.assumed_results_per_page`; the honest phrasing is a
  range with the basis named, never a single tidy number.
- **Say which lines can never be verified.** `enrich_profiles_bulk()` does not report
  its charge back. Mark it on the plan, before the run, not in the receipt after it.
- **Cache hits appear as skipped-not-charged.** A roster resolves through
  `gates.yaml:cache_ttl.capability_groups.people_search` to
  `gates.yaml:cache_ttl.classes.people_lists`, and profile enrichment through
  `gates.yaml:cache_ttl.capability_groups.enrichment` — so a second map of the same
  account within the window is mostly a cache read. That is usually the moment a user
  approves the deeper step they would otherwise have declined.

Then take **one approval for the whole plan**. Gate confirmations still fire inside the
run — the page gate, and the session-spend fractions at
`gates.yaml:session_budget.fractions.confirm` and
`gates.yaml:session_budget.fractions.stop` — and those cannot be pre-approved away. A
missing gate key is a STOP and never "no gate" (law 5).

## The gate keys this skill still needs to resolve

Three thresholds bound this skill, all of them in `_lib/gates.yaml` under
`skills.org_map`. None of them is ever typed into a plan by hand. **Every path they
guard is closed if they stop resolving** — that is law 5 doing its job: `gateValue()`
throws `MissingGateKey`, the check reads STOP, and the skill does less rather than doing
it unbounded.

| Key | What it bounds | If it does not resolve |
|---|---|---|
| `gates.yaml:skills.org_map.max_pages_per_run` | Pages accumulated across **both** page-gated people endpoints in one map. Each is bounded individually; only this stops a run walking both. | No page-gated people endpoint runs. |
| `gates.yaml:skills.org_map.committee_max_profiles` | The shortlist handed to `enrich_profiles_bulk()`, whose charge is absent from the response. | The bulk-enrich step is refused. |
| `gates.yaml:skills.org_map.ai_enrich_batch_min_rows` | The row count above which the batch-scale route to the paid LLM hop opens. | Batch route closed; inference stays local. |

Read a threshold rather than quoting one:

```bash
richapi gates unbounded_endpoints.hard_page_ceiling
```

## Report honestly

Read the receipt the runtime prints and pass on what it says.

- **Lead with the edge counts by provenance.** "Four observed, two inferred, three
  not_found" is the headline. A map reported as "nine people mapped" has hidden the only
  number that matters.
- **Never restate an estimate as a fact.** Where the receipt says
  `estimated_unverifiable`, the map and the summary say so too.
- **Report the orphans as a group**, and compare the placed fraction against
  `gates.yaml:quality_stops.coverage_min_pct`. Say plainly when a map is too thin to
  plan a multithread on. A map with three observed edges out of nine people is a
  starting point, not a committee.
- **Say what would upgrade an inferred edge to observed.** Usually one question on the
  next call: *"who does the SDR team report into?"* That sentence is the most valuable
  thing this skill produces, because it converts a guess into evidence for free.
- **Say what a second pass would cost.** Usually much less, because the roster is
  cached.

## What this skill will not do

- **It will not default to the CEO.** Not when the graph would otherwise be
  disconnected, not when the CEO is the only executive on the roster, not when the user
  asks it to pick someone. Elimination is not evidence, and the answer is `not_found`.
- **It will not present an inferred edge as a fact.** No confidence value makes an
  inference assertable, and no rendering makes an inferred line look like an observed
  one. If the two ever become visually indistinguishable, the output is wrong even when
  every edge is right.
- **It will not read hierarchy out of Slack.** `slack_channel_members()` produces a
  participation attribute on a node and never an edge, and it runs only for a shared
  Slack Connect channel with this account. Its claim on this skill arrived from a
  capability-group default rather than by name, and outside that one
  condition it buys nothing: it is a paid call to read a member list the user already
  has open, and it returns no hierarchy at all.
- **It will not guess which company you meant.** A bare name stops and routes; this
  skill owns no resolution endpoint.
- **It will not enrich the whole roster.** The shortlist is the bill, and it is chosen.
- **It will not call `ai_enrich()` to rank titles.** Inference is local. The metered hop
  exists for web grounding and batch scale, and what it returns is `ai_inferred` — an
  inferred edge at best, never a source line.
- **It will not find, verify or contact anybody it maps.** The map stops at names and
  profile URLs. Emails, phones and verification belong to the enrichment waterfall, and
  sending is deliberately external to this pack, permanently.
- **It will not judge whether contacting these people is lawful.** Mapping is a data
  question; lawful basis and consent records are not.

## Related

- Resolve a company name or domain to the LinkedIn URL this skill needs, and get the
  firmographics that decide between the two people endpoints:
  [`/account-research`](../account-research/SKILL.md).
- Build the account universe this skill maps one at a time:
  [`/build-prospect-list`](../build-prospect-list/SKILL.md).
- Turn a mapped committee into contactable rows:
  [`/enrich-waterfall`](../enrich-waterfall/SKILL.md).
- Rank the mapped people by readiness before anyone is contacted:
  [`/evidence-score`](../evidence-score/SKILL.md).
- Screen every name against the do-not-contact store before it reaches an output:
  [`/list-hygiene`](../list-hygiene/SKILL.md).
- The same discipline pointed at a rival rather than a prospect:
  [`/competitive-intel`](../competitive-intel/SKILL.md).
- Write to the mapped committee, where an inferred edge is not a claim you may make:
  [`/personalize`](../personalize/SKILL.md).
- Session start, routing and the closing receipt:
  [`/richapi-gtm`](../richapi-gtm/SKILL.md).
- Every threshold this skill cites, printed with the key it came from: `richapi gates`.
