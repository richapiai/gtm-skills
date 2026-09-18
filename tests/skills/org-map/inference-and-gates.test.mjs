// tests/skills/org-map/inference-and-gates.test.mjs
//
// Two things that are only real if the closed direction is exercised:
//
//   Inference is LOCAL. `ai_enrich` is 2 credits and this pack runs inside a
//   model that ranks job titles for free, so the paid hop is reachable for exactly two
//   reasons and inferring the hierarchy is not one of them.
//
//   LAW 5 — the three `skills.org_map` keys are MERGED into _lib/gates.yaml now, so
//   the working path is the live one and is asserted against the shipped file. The
//   fail-closed direction is asserted against STRIPPED, a copy of the shipped gates
//   with `skills.org_map` deleted: a missing key reads as STOP no matter which key
//   goes missing or when. That strip is itself asserted (`gatesWithout` throws on a
//   no-op, and one test below proves nothing under the block resolves afterwards), so
//   the fail-closed input cannot decay into a vacuous pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  skillBody, section, catalog, gatesWithRequestedKeys, gatesWithout, REQUESTED_GATES,
} from './helpers.mjs';
import { loadGates, gateValue, hasGate, isUnbounded } from '../../../_lib/gates.mjs';
import {
  loadOrgMapRules, inferenceMode, aiEnrichDecision, peopleEndpointBudget, bulkEnrichDecision,
  planManagerEdge, INFERRED, STOP,
} from './harness.mjs';

const RULES = loadOrgMapRules();
const BODY = skillBody();
const CATALOG = catalog();
const GATES = loadGates();
const MERGED = gatesWithRequestedKeys(GATES);
/** The shipped gates with this skill's whole block deleted — the law-5 input. */
const STRIPPED = gatesWithout(GATES, 'skills.org_map');

// ---------------------------------------------------------------------------
// Where inference runs.
// ---------------------------------------------------------------------------

test('the skill states its inference mode and why', () => {
  assert.equal(inferenceMode(RULES), 'local_agent');
  assert.match(BODY, /Inference mode: local/i, 'a local-inference skill states its mode in the prose too');
  assert.match(RULES.inference.reason, /no marginal cost|metered/i);
});

test('ai_enrich is reachable for exactly two reasons, and hierarchy is not one of them', () => {
  assert.deepEqual(RULES.inference.ai_enrich_allowed_when, ['perplexity_web_grounding', 'batch_scale']);
  for (const banned of RULES.inference.ai_enrich_never_for) {
    assert.equal(aiEnrichDecision({ reason: banned, rules: RULES, gates: MERGED }).decision, STOP,
      `${banned} reached the paid LLM hop`);
  }
  assert.ok(RULES.inference.ai_enrich_never_for.includes('inferring_the_hierarchy'),
    'the one job this skill would be tempted to buy must be on the never list');
  // An unlisted reason is refused too — the allow-list is the gate, not the deny-list.
  assert.equal(aiEnrichDecision({ reason: 'seems_useful', rules: RULES, gates: MERGED }).decision, STOP);
});

test('the Perplexity-only parameters are named, because choosing another provider drops them', () => {
  assert.deepEqual(RULES.inference.perplexity_only_params,
    ['search_domain_filter', 'search_recency_filter']);
  const s = section(/grounding/i);
  assert.match(s.text, /Perplexity-only/);
  for (const p of RULES.inference.perplexity_only_params) assert.ok(s.text.includes(p));
});

test('batch scale fails CLOSED without its key, and opens once the key resolves', () => {
  const key = RULES.inference.batch_scale_gate_key;
  assert.equal(key, 'skills.org_map.ai_enrich_batch_min_rows');
  assert.equal(RULES.inference.batch_scale_on_missing_key, 'stop');

  // Fail closed. Was: "the key is unmerged, so the shipped file refuses". It is merged
  // now, so the refusal is proven against a gates object with the key STRIPPED — the
  // same MissingGateKey -> STOP path, but true for every future key too. Ten thousand
  // rows is deliberately far over any plausible floor: without the floor, the escape
  // is shut regardless of how obviously it "should" have opened.
  assert.equal(hasGate(STRIPPED, key), false, 'the strip must actually remove the key');
  const closed = aiEnrichDecision({ reason: 'batch_scale', rowCount: 10_000, rules: RULES, gates: STRIPPED });
  assert.equal(closed.decision, STOP);
  assert.equal(closed.failed_closed, true);
  assert.equal(closed.gate, key);

  // And on the SHIPPED file the route behaves as designed in both directions.
  assert.equal(hasGate(GATES, key), true, 'the key must resolve now that it is merged');
  const min = gateValue(GATES, key);
  assert.equal(min, REQUESTED_GATES.org_map.ai_enrich_batch_min_rows,
    'this suite is calibrated to that floor; reconcile a change deliberately');
  assert.equal(aiEnrichDecision({ reason: 'batch_scale', rowCount: min - 1, rules: RULES, gates: GATES }).decision, STOP);
  assert.equal(aiEnrichDecision({ reason: 'batch_scale', rowCount: min, rules: RULES, gates: GATES }).decision, 'allow');
  assert.equal(aiEnrichDecision({ reason: 'batch_scale', rowCount: min, rules: RULES, gates: MERGED }).decision, 'allow');
});

test('nothing the paid hop returns can become an observed edge', () => {
  assert.equal(RULES.inference.ai_enrich_output_provenance, 'ai_inferred');
  assert.equal(RULES.inference.ai_enrich_output_assertable, false);
  assert.equal(RULES.inference.ai_enrich_edge_provenance, INFERRED);

  const allowed = aiEnrichDecision({ reason: 'perplexity_web_grounding', rules: RULES, gates: GATES });
  assert.equal(allowed.decision, 'allow');
  assert.equal(allowed.edge_provenance, INFERRED);
  assert.equal(allowed.requires_plan, true, 'law 3: the hop is metered, so it is planned first');

  const plan = planManagerEdge({
    report: { name: 'B. Marek', title: 'Sales Development Representative' },
    roster: [{ name: 'B. Marek', title: 'Sales Development Representative' }],
    rules: RULES,
    evidence: [{ report: 'B. Marek', manager: 'A. Okonkwo', kind: 'ai_enrich_grounded', source: 'ai_enrich' }],
  });
  assert.equal(plan.provenance, INFERRED);
  assert.equal(plan.assertable, false);
});

test('ai_enrich is never served from cache, so the local route stays the cheap one', () => {
  assert.equal(gateValue(GATES, 'cache_ttl.endpoints.ai_enrich'), '0d');
  assert.ok(BODY.includes('gates.yaml:cache_ttl.endpoints.ai_enrich'),
    'the skill must cite the TTL that makes a re-run of the paid hop pay again');
});

// ---------------------------------------------------------------------------
// LAW 5 — the keys that are not there yet.
// ---------------------------------------------------------------------------

test('the keys this skill reads resolve, at the values this suite is calibrated to', () => {
  // Was: "they genuinely do not resolve, so the closed path is the live one". They are
  // merged, so the assertion inverts — and it pins the VALUES, not just their presence,
  // because a ceiling edited in gates.yaml would otherwise re-plan every run below
  // while these tests stayed green.
  for (const [k, expected] of Object.entries(REQUESTED_GATES.org_map)) {
    const dotted = `skills.org_map.${k}`;
    assert.equal(hasGate(GATES, dotted), true, `${dotted} does not resolve`);
    assert.equal(gateValue(GATES, dotted), expected,
      `${dotted} shipped as ${gateValue(GATES, dotted)}, not ${expected} — this suite's `
      + 'plan arithmetic is calibrated to the second number; reconcile it deliberately');
  }
});

test('strip the block and not one of them resolves — the fail-closed input is real', () => {
  // The guard on the guard, after tests/skills/evidence-score/rules-block.test.mjs.
  // Every law-5 test below feeds STRIPPED; if the strip ever became a no-op — the
  // block renamed, moved, nested differently — they would pass while proving nothing.
  for (const k of Object.keys(REQUESTED_GATES.org_map)) {
    assert.equal(hasGate(STRIPPED, `skills.org_map.${k}`), false,
      `skills.org_map.${k} survived the strip`);
  }
});

test('without max_pages_per_run a run may walk ONE page-gated people endpoint', () => {
  const one = peopleEndpointBudget({ endpoints: ['linkedin_company_employees_search'], gates: STRIPPED });
  assert.equal(one.decision, 'allow');
  assert.equal(one.failed_closed, true);

  const both = peopleEndpointBudget({
    endpoints: ['linkedin_company_employees_search', 'lead_search'], gates: STRIPPED,
  });
  assert.equal(both.decision, STOP);
  assert.equal(both.failed_closed, true);
  assert.equal(both.gate, 'skills.org_map.max_pages_per_run');

  // With the key present — on the SHIPPED file — both may be planned under one
  // shared ceiling.
  const merged = peopleEndpointBudget({
    endpoints: ['linkedin_company_employees_search', 'lead_search'], gates: GATES,
  });
  assert.equal(merged.decision, 'allow');
  assert.equal(merged.failed_closed, false);
  assert.equal(merged.max_pages, REQUESTED_GATES.org_map.max_pages_per_run);
});

test('without committee_max_profiles the unverifiable bulk hop is refused outright', () => {
  const closed = bulkEnrichDecision({ shortlistSize: 1, gates: STRIPPED });
  assert.equal(closed.decision, STOP);
  assert.equal(closed.failed_closed, true);
  assert.match(closed.reason, /charge is absent from the response/);

  // And on the shipped file the ceiling is a ceiling: at it, allowed; one over, STOP.
  const max = REQUESTED_GATES.org_map.committee_max_profiles;
  assert.equal(bulkEnrichDecision({ shortlistSize: max, gates: GATES }).decision, 'allow');
  assert.equal(bulkEnrichDecision({ shortlistSize: max + 1, gates: GATES }).decision, STOP);
  assert.equal(bulkEnrichDecision({ shortlistSize: max, gates: MERGED }).decision, 'allow');
});

// ---------------------------------------------------------------------------
// Cost discipline the skill must state, and that gates.yaml must agree with.
// ---------------------------------------------------------------------------

test('gates.yaml and the catalog agree on which of these endpoints are page-gated', () => {
  const owned = ['ai_enrich', 'enrich_profiles_bulk', 'lead_search',
    'linkedin_company_employees_search', 'slack_channel_members'];
  const pageGated = owned.filter(e => isUnbounded(GATES, e)).sort();
  assert.deepEqual(pageGated, ['lead_search', 'linkedin_company_employees_search'],
    'the page-gated subset of this skill moved — re-read Step 1 before shipping');
  for (const e of owned) {
    assert.equal(CATALOG.endpoints[e].pricing.page_gated === true, pageGated.includes(e),
      `${e}: the catalog and gates.yaml disagree, and the runtime reads gates`);
  }
});

test('the skill is honest that its default pass is page-gated rather than flat', () => {
  const s = section(/^Step 1\b/);
  assert.match(s.text, /no flat-priced way/i,
    'unlike /competitive-intel this skill has no flat default; pretending otherwise is the lie');
  assert.ok(s.text.includes('gates.yaml:unbounded_endpoints.endpoints'));
  assert.ok(s.text.includes('gates.yaml:unbounded_endpoints.assumed_results_per_page'));
  assert.ok(s.text.includes('gates.yaml:unbounded_endpoints.pages_before_confirm'));
  assert.ok(s.text.includes('gates.yaml:unbounded_endpoints.hard_page_ceiling'));
  assert.ok(s.text.includes('gates.yaml:session_budget.fractions.single_call_confirm'));
});

test('the endpoint whose charge is absent from the response is named on the plan', () => {
  // 2026-09-17: false for every endpoint, because the flag is now derived from
  // recorded responses and not one carries a charge. enrich_profiles_bulk stays the
  // line the plan must mark — it is the per-result one whose SIZE is also unknown
  // before the call — but it is no longer the only unverifiable row.
  const unverifiable = ['ai_enrich', 'enrich_profiles_bulk', 'lead_search',
    'linkedin_company_employees_search', 'slack_channel_members']
    .filter(e => CATALOG.endpoints[e].pricing.billing_field_present_in_response === false).sort();
  assert.deepEqual(unverifiable, ['ai_enrich', 'enrich_profiles_bulk', 'lead_search',
    'linkedin_company_employees_search', 'slack_channel_members']);
  const plan = section(/Dry-run/i);
  assert.ok(plan.text.includes('enrich_profiles_bulk()'),
    'the dry-run section must mark the unverifiable line before the run, not after it');
  assert.match(BODY, /estimated_unverifiable/, 'law 4: that row is written estimated_unverifiable');
});

test('the cache claim is only made where gates.yaml actually grants one', () => {
  for (const key of ['cache_ttl.capability_groups.people_search',
    'cache_ttl.classes.people_lists',
    'cache_ttl.capability_groups.enrichment',
    'cache_ttl.capability_groups.social']) {
    assert.ok(BODY.includes(`gates.yaml:${key}`), `the skill never cites gates.yaml:${key}`);
    assert.doesNotThrow(() => gateValue(GATES, key));
  }
});
