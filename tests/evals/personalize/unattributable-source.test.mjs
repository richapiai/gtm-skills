// tests/evals/personalize/unattributable-source.test.mjs
//
// ADVERSARIAL CASE 3: *a fact from a source the dual contract cannot attribute.*
//
// This is the case that makes local-inference-by-default a safety rule rather than a
// billing one. The user
// pays 2 credits per contact for `ai_enrich`, the model returns a perfectly well-formed
// dual-contract object with `source: model_prior` and `confidence: 0.99`, and the
// sentence writes itself. The response is VALID. It is simply not attributable to
// anything outside the model.
//
// The Iron Law is "no claim in copy without a source line in the research brief", and
// `model_prior` is the contract's own way of saying there is no source line.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates } from '../../../_lib/gates.mjs';
import { validateDualContract } from '../../../_lib/dual-contract.mjs';
import {
  loadPersonalizeRules, loadEvidenceRules, planClaim, planInapplicableClaim, checkDraft,
  REFUSE, WEAK, NOT_VERIFIABLE, NOT_APPLICABLE, NOT_FOUND, NULL_ENUM,
} from '../../skills/personalize/harness.mjs';
import {
  brief, verified, inferred, NOW,
} from '../../skills/evidence-score/helpers.mjs';

const RULES = loadPersonalizeRules();
const EVIDENCE = loadEvidenceRules();
const GATES = loadGates();
const ctx = { rules: RULES, evidenceRules: EVIDENCE, gates: GATES, now: NOW };

const MODEL_PRIOR = {
  result: 'a Series B', confidence: 0.99,
  reasoning: 'I recall reading about this round.', source: 'model_prior',
};

test('the model_prior answer passes the dual contract — the schema is not the gate', () => {
  assert.equal(validateDualContract(MODEL_PRIOR).valid, true);
});

test('a model_prior claim is REFUSED with not_verifiable, at maximum confidence', () => {
  const p = planClaim(inferred(brief(), 'recent_funding', MODEL_PRIOR), 'recent_funding', ctx);
  assert.equal(p.decision, REFUSE);
  assert.equal(p.result, NOT_VERIFIABLE);
  assert.equal(p.grade, WEAK);
  assert.ok(NULL_ENUM.includes(p.result));
  assert.ok(p.reasons.includes('source_unattributable'), JSON.stringify(p.reasons));
});

test('an ai_inferred claim with a real URL is still refused — grounding is a lead, not a sentence', () => {
  const b = inferred(brief(), 'recent_funding', {
    result: 'a Series B', confidence: 1, reasoning: 'On the press page.',
    source: 'https://acme.example/press/series-b',
  });
  const p = planClaim(b, 'recent_funding', ctx);
  assert.equal(p.decision, REFUSE);
  assert.equal(p.result, NOT_VERIFIABLE);
  assert.ok(p.reasons.includes('provenance_ai_inferred'), JSON.stringify(p.reasons));
});

test('the rules table says so structurally: only verified provenance is assertable', () => {
  assert.deepEqual(RULES.claim_gate.assertable_provenance, ['verified']);
  assert.deepEqual(RULES.claim_gate.assertable_grades, ['supported']);
  assert.equal(RULES.claim_gate.require_source_line, true);
  assert.equal(RULES.inference.ai_enrich_output_assertable, false);
  assert.equal(RULES.inference.ai_enrich_output_provenance, 'ai_inferred');
});

test('a verified fact with no source line at all is refused', () => {
  const b = brief();
  b.verified.recent_funding = { value: 'a Series B', fetched_at: '2026-08-20T00:00:00Z' };
  const p = planClaim(b, 'recent_funding', ctx);
  assert.equal(p.decision, REFUSE);
  assert.equal(p.result, NOT_VERIFIABLE);
  assert.ok(p.reasons.includes('source_line_missing'), JSON.stringify(p.reasons));
});

test('a draft on an unattributable claim writes nothing', () => {
  const res = checkDraft({
    template: 'Congrats on {{funding}}.',
    slots: [{ name: 'funding', field: 'recent_funding', section: 'first_line' }],
    brief: inferred(brief(), 'recent_funding', MODEL_PRIOR),
    ...ctx,
  });
  assert.equal(res.decision, REFUSE);
  assert.equal(res.text, null);
  assert.ok(res.violations.includes('claim_not_supported:funding:not_verifiable'));
});

test('an explicit null in the brief comes out unchanged — all three of them', () => {
  for (const nul of ['not_found', 'not_verifiable', 'not_applicable']) {
    const b = verified(brief(), 'recent_funding', nul, { source: 'https://acme.example/press' });
    const p = planClaim(b, 'recent_funding', ctx);
    assert.equal(p.decision, REFUSE);
    assert.equal(p.result, nul, `the brief said ${nul} and the plan said ${p.result}`);
  }
});

test('a claim that cannot apply to the record returns not_applicable, which is a real answer', () => {
  const p = planInapplicableClaim('recent_funding', { rules: RULES });
  assert.equal(p.decision, REFUSE);
  assert.equal(p.result, NOT_APPLICABLE);
  assert.notEqual(p.result, NOT_FOUND, 'not_applicable and not_found are different findings');
  assert.equal(RULES.claim_gate.inapplicable_null, NOT_APPLICABLE);
});
