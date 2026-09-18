// tests/evals/evidence-score/unattributable-source.test.mjs
//
// ADVERSARIAL CASE 3: *a fact from a source the dual contract cannot attribute.*
//
// The dual contract requires a `source`: "a URL, an endpoint name, or `model_prior`
// when the model used nothing but itself". `model_prior` is a VALID dual-contract
// response — it passes the schema — and that is exactly the trap. A well-formed answer
// whose only provenance is the model's own memory is the most convincing fabrication
// available, because everything about its shape looks right.
//
// The rule: attribution is not the same as validity. A claim whose source cannot be
// pointed at is `weak` and `not_verifiable`, and it is never asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates } from '../../../_lib/gates.mjs';
import { validateDualContract } from '../../../_lib/dual-contract.mjs';
import {
  loadEvidenceRules, gradeClaim,
  SUPPORTED, WEAK, NOT_VERIFIABLE, NULL_ENUM,
} from '../../skills/evidence-score/harness.mjs';
import {
  brief, verified, inferred, NOW,
} from '../../skills/evidence-score/helpers.mjs';

const RULES = loadEvidenceRules();
const GATES = loadGates();

test('a model_prior answer is a VALID dual-contract response — which is why it needs its own rule', () => {
  const res = validateDualContract({
    result: 'Series B, March 2026', confidence: 0.95,
    reasoning: 'I recall reading about this round.', source: 'model_prior',
  });
  assert.equal(res.valid, true, 'the schema accepts it; the grader is what must not');
});

test('an ai_inferred value is weak and not_verifiable, however confident the model was', () => {
  const b = inferred(brief(), 'recent_funding', {
    result: 'Series B, March 2026', confidence: 0.99,
    reasoning: 'Widely reported.', source: 'model_prior',
  });
  const g = gradeClaim(b, 'recent_funding', { rules: RULES, gates: GATES, now: NOW });

  assert.equal(g.grade, WEAK);
  assert.equal(g.null, NOT_VERIFIABLE);
  assert.ok(NULL_ENUM.includes(g.null));
  assert.equal(g.assertable, false);
  assert.ok(g.reasons.includes('provenance_ai_inferred'), JSON.stringify(g.reasons));
  assert.ok(g.reasons.includes('source_unattributable'), JSON.stringify(g.reasons));
});

test('an ai_inferred value with a real URL is STILL not assertable — inferred is inferred', () => {
  // Web grounding buys a lead to go verify. It does not buy a sentence.
  const b = inferred(brief(), 'recent_funding', {
    result: 'Series B, March 2026', confidence: 1,
    reasoning: 'Found on the company press page.', source: 'https://acme.example/press/series-b',
  });
  const g = gradeClaim(b, 'recent_funding', { rules: RULES, gates: GATES, now: NOW });
  assert.equal(g.assertable, false);
  assert.equal(g.grade, WEAK);
  assert.equal(g.null, NOT_VERIFIABLE);
  assert.deepEqual(g.reasons, ['provenance_ai_inferred']);
});

test('a verified fact with NO source line is weak and not_verifiable', () => {
  const b = brief();
  b.verified.recent_funding = { value: 'Series B, March 2026', fetched_at: '2026-08-20T00:00:00Z' };
  const g = gradeClaim(b, 'recent_funding', { rules: RULES, gates: GATES, now: NOW });
  assert.equal(g.grade, WEAK);
  assert.equal(g.null, NOT_VERIFIABLE);
  assert.ok(g.reasons.includes('source_line_missing'), JSON.stringify(g.reasons));
});

test('a bare value with no evidence record around it carries no source, so it is refused', () => {
  // The lazy shape: somebody wrote the answer straight into the brief. It has no
  // source and no timestamp, so it cannot be checked and it is not asserted.
  const b = brief();
  b.verified.recent_funding = 'Series B, March 2026';
  const g = gradeClaim(b, 'recent_funding', { rules: RULES, gates: GATES, now: NOW });
  assert.equal(g.assertable, false);
  assert.equal(g.null, NOT_VERIFIABLE);
  assert.ok(g.reasons.includes('source_line_missing'));
});

test('every unattributable source name in the table is refused, and a URL is not', () => {
  for (const src of RULES.unattributable_sources) {
    const b = verified(brief(), 'recent_funding', 'Series B', { source: src });
    const g = gradeClaim(b, 'recent_funding', { rules: RULES, gates: GATES, now: NOW });
    assert.equal(g.grade, WEAK, `source "${src}" graded ${g.grade}`);
    assert.equal(g.null, NOT_VERIFIABLE);
    assert.ok(g.reasons.includes('source_unattributable'));
  }
  const ok = verified(brief(), 'recent_funding', 'Series B',
    { source: 'https://acme.example/press/series-b' });
  assert.equal(gradeClaim(ok, 'recent_funding', { rules: RULES, gates: GATES, now: NOW }).grade, SUPPORTED);
});

test('the brief\'s own explicit null is carried through, never upgraded into a value', () => {
  // The research step already looked and found nothing. Asking again until the answer
  // changes is not research, and `not_applicable` is a real answer, not a failure.
  for (const nul of ['not_found', 'not_verifiable', 'not_applicable']) {
    const b = verified(brief(), 'recent_funding', nul, { source: 'https://acme.example/press' });
    const g = gradeClaim(b, 'recent_funding', { rules: RULES, gates: GATES, now: NOW });
    assert.equal(g.assertable, false);
    assert.equal(g.null, nul, `the brief said ${nul} and the grader said ${g.null}`);
    assert.deepEqual(g.reasons, ['brief_recorded_explicit_null']);
  }
});
