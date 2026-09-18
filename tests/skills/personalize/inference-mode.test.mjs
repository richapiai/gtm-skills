// tests/skills/personalize/inference-mode.test.mjs
//
// Local inference, and /personalize is the headline case. `ai_enrich` costs credits per call while
// this pack already runs inside a model that infers for free, so calling it to draft
// copy charges the user, per contact, for something they were getting for nothing.
//
// The plan allows exactly two exceptions: Perplexity web grounding and batch scale.
// This file asserts that the shipped rules table says so and that the harness enforces
// it — including that the batch-scale threshold is a gate key which fails closed, so
// the default when nothing is configured is local drafting rather than spending.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadGates, STOP, gateValue } from '../../../_lib/gates.mjs';
import {
  loadPersonalizeRules, inferenceMode, aiEnrichDecision,
} from './harness.mjs';
import { REPO_ROOT, PINNED_GATES, gatesWithout } from './helpers.mjs';

const RULES = loadPersonalizeRules();
const GATES = loadGates();
const MIN_ROWS = PINNED_GATES.personalize.ai_enrich_batch_min_rows;

test('the declared mode is local agent inference, with the reason stated', () => {
  assert.equal(inferenceMode(RULES), 'local_agent');
  assert.match(RULES.inference.reason, /metered|free|no marginal cost/i,
    'the mode without the reason is a label, not a decision');
});

test('exactly two reasons are allowed, and they are the two the plan names', () => {
  assert.deepEqual([...RULES.inference.ai_enrich_allowed_when].sort(),
    ['batch_scale', 'perplexity_web_grounding']);
});

test('drafting is named explicitly as a reason ai_enrich is NEVER called for', () => {
  const never = RULES.inference.ai_enrich_never_for;
  for (const r of ['drafting_copy', 'rewriting_a_draft', 'grading_a_claim',
                   'filling_a_gap_the_brief_left']) {
    assert.ok(never.includes(r), `${r} is not on the never list`);
  }
});

test('the harness refuses ai_enrich for drafting, however it is asked', () => {
  for (const reason of RULES.inference.ai_enrich_never_for) {
    const d = aiEnrichDecision({ reason, rowCount: 100000, rules: RULES, gates: GATES });
    assert.equal(d.decision, STOP, `${reason} was allowed`);
  }
});

test('an unrecognised reason is refused — the allow list is a list, not a hint', () => {
  for (const reason of ['because the user asked', 'polish', '', undefined, 'web_grounding']) {
    assert.equal(aiEnrichDecision({ reason, rules: RULES, gates: GATES }).decision, STOP);
  }
});

test('web grounding is allowed, and it still requires a plan before it spends', () => {
  const d = aiEnrichDecision({ reason: 'perplexity_web_grounding', rules: RULES, gates: GATES });
  assert.equal(d.decision, 'allow');
  assert.equal(d.requires_plan, true, 'law 3 — every paid call is named and costed first');
});

test('batch scale is allowed only above the threshold, and it is a gate key', () => {
  assert.equal(aiEnrichDecision({ reason: 'batch_scale', rowCount: MIN_ROWS, rules: RULES, gates: GATES }).decision, 'allow');
  const below = aiEnrichDecision({ reason: 'batch_scale', rowCount: MIN_ROWS - 1, rules: RULES, gates: GATES });
  assert.equal(below.decision, STOP);
  assert.match(below.reason, /below the batch-scale floor/);
});

test('a missing batch-scale gate key is STOP, so the default is local drafting', () => {
  // The key HAS since been merged, so this is driven from a gates file with the
  // block stripped rather than from the shipped one. Keeping it that way matters:
  // the property is "the pack cannot start spending on ai_enrich by accident when
  // nobody has set the floor", and that has to stay true for every future key,
  // not just for the window before this one landed.
  const d = aiEnrichDecision({
    reason: 'batch_scale', rowCount: 1e6, rules: RULES,
    gates: gatesWithout('skills.personalize.ai_enrich_batch_min_rows'),
  });
  assert.equal(d.decision, STOP);
  assert.equal(d.failed_closed, true);
  assert.equal(d.gate, 'skills.personalize.ai_enrich_batch_min_rows');
});

test('with the key merged, a large batch is permitted and a small one still is not', () => {
  // The other half. Without this, stripping the key above would leave the merged
  // path completely untested — the test would pass whether or not the skill ever
  // reads the real value.
  const gates = loadGates();
  const floor = gateValue(gates, 'skills.personalize.ai_enrich_batch_min_rows');

  const big = aiEnrichDecision({ reason: 'batch_scale', rowCount: floor + 1, rules: RULES, gates });
  assert.notEqual(big.decision, STOP, 'past the floor, the batch route is available');
  assert.notEqual(big.failed_closed, true);

  const small = aiEnrichDecision({ reason: 'batch_scale', rowCount: floor - 1, rules: RULES, gates });
  assert.equal(small.decision, STOP,
    'below the floor, drafting stays local — that is the whole point of the floor');
});

test('whatever ai_enrich returns is ai_inferred, never verified and never assertable', () => {
  assert.equal(RULES.inference.ai_enrich_output_provenance, 'ai_inferred');
  assert.equal(RULES.inference.ai_enrich_output_assertable, false);
  assert.equal(RULES.inference.malformed_response_storage, 'ai_inferred_invalid');
});

test('the Perplexity-only parameters are named, and they really are Perplexity-only', () => {
  assert.deepEqual([...RULES.inference.perplexity_only_params].sort(),
    ['search_domain_filter', 'search_recency_filter']);
  // Law 6: the claim in the skill is checked against the pinned spec, not remembered.
  const spec = readFileSync(join(REPO_ROOT, 'spec', 'openapi.yaml'), 'utf8');
  for (const p of RULES.inference.perplexity_only_params) {
    const at = spec.indexOf(p);
    assert.ok(at > -1, `${p} is not in the pinned spec at all`);
    const around = spec.slice(Math.max(0, at - 600), at + 600);
    assert.match(around, /perplexity/i,
      `${p} appears in the spec with no Perplexity-only note nearby — recheck the claim`);
  }
});

test('the pack agrees this skill may reach for ai_enrich at all', () => {
  const owners = readFileSync(join(REPO_ROOT, '_lib', 'endpoint-owners.yaml'), 'utf8');
  const block = owners.slice(owners.indexOf('ai_enrich:'));
  assert.match(block.split('\n').slice(0, 3).join(' '), /personalize/,
    '_lib/endpoint-owners.yaml no longer lists personalize as an ai_enrich owner');
});
