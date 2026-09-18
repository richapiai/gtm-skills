// tests/evals/personalize/low-confidence.test.mjs
//
// ADVERSARIAL CASE 2: *a fact present but low-confidence.*
//
// The fact is in the brief. It is probably even true. The only thing wrong with it is
// that nobody could stand behind it — and the copywriter's instinct is to keep the
// sentence and soften the verb. That instinct is the failure: a hedged claim is still
// a claim made to a stranger, and it is a worse one because it also reads as unsure.
//
// The rule under test is `fallback.hedged_claim_allowed: false` in the
// ```yaml personalize-rules block. There is no "emit, but carefully" decision.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates } from '../../../_lib/gates.mjs';
import {
  loadPersonalizeRules, loadEvidenceRules, planClaim, checkDraft,
  EMIT, REFUSE, WEAK, NOT_VERIFIABLE, NULL_ENUM,
} from '../../skills/personalize/harness.mjs';
import {
  brief, verified, NOW, PINNED_GATES, gatesWithout,
} from '../../skills/evidence-score/helpers.mjs';

const RULES = loadPersonalizeRules();
const EVIDENCE = loadEvidenceRules();
const GATES = loadGates();
const ctx = { rules: RULES, evidenceRules: EVIDENCE, gates: GATES, now: NOW };
const FLOOR = PINNED_GATES.evidence_score.emit_min_confidence;
const MAX_AGE = PINNED_GATES.evidence_score.evidence_max_age_days;

const withConfidence = (c) => verified(brief(), 'recent_funding', 'a Series B',
  { confidence: c, source: 'https://acme.example/press/series-b' });

test('at the floor the claim is emitted, so the refusals below are about the number', () => {
  const p = planClaim(withConfidence(FLOOR), 'recent_funding', ctx);
  assert.equal(p.decision, EMIT);
});

test('below the floor the claim is REFUSED with not_verifiable, not softened into prose', () => {
  for (const c of [0, 0.2, 0.5, FLOOR - 0.01]) {
    const p = planClaim(withConfidence(c), 'recent_funding', ctx);
    assert.equal(p.decision, REFUSE, `confidence ${c} was emitted`);
    assert.equal(p.result, NOT_VERIFIABLE);
    assert.equal(p.grade, WEAK);
    assert.ok(NULL_ENUM.includes(p.result));
  }
});

test('the rules table forbids the hedge outright — there is no third decision', () => {
  assert.equal(RULES.fallback.hedged_claim_allowed, false);
  assert.equal(RULES.fallback.soften_refusal_into_prose, false);
  assert.equal(RULES.fallback.on_refused_claim, 'claim_free_opener');
  assert.deepEqual(RULES.decisions, [EMIT, REFUSE]);
});

test('a draft built on a below-floor claim produces no text', () => {
  const res = checkDraft({
    template: 'Congrats on {{funding}} — nice milestone.',
    slots: [{ name: 'funding', field: 'recent_funding', section: 'first_line' }],
    brief: withConfidence(0.4),
    ...ctx,
  });
  assert.equal(res.decision, REFUSE);
  assert.equal(res.text, null);
  assert.ok(res.violations.includes('claim_not_supported:funding:not_verifiable'),
    JSON.stringify(res.violations));
});

test('stale evidence is refused — congratulating somebody on a role they already left', () => {
  const stale = new Date(NOW.getTime() - (MAX_AGE + 30) * 24 * 60 * 60 * 1000).toISOString();
  const b = verified(brief(), 'job_change_recent', 'the new VP Ops role',
    { source: 'https://linkedin.example/in/ada', fetched_at: stale });
  const p = planClaim(b, 'job_change_recent', ctx);
  assert.equal(p.decision, REFUSE);
  assert.equal(p.result, NOT_VERIFIABLE);
  assert.ok(p.reasons.includes('evidence_stale'), JSON.stringify(p.reasons));
});

test('with the shipped gates.yaml a well-evidenced claim is emitted', () => {
  // `skills.evidence_score` is merged, so the grader /personalize delegates to can
  // actually reach `supported` and this skill can actually write a sentence. Stated
  // explicitly, because while this suite was written the only reachable outcome
  // was the refusal below — correct, and indistinguishable from a skill that refuses
  // everything.
  const p = planClaim(withConfidence(0.99), 'recent_funding', ctx);
  assert.equal(p.decision, EMIT);
  assert.notEqual(p.failed_closed, true);
});

test('strip skills.evidence_score and nothing is asserted — the drafter fails closed', () => {
  // Was "with the real gates.yaml — no skills.evidence_score block yet". The block is
  // merged, so the missing-key state is staged by deleting it. The property is the one
  // that matters most in this skill: with no threshold to certify a claim against, the
  // copywriter writes no claim. A merge that dropped the block must not turn the Iron
  // Law into a formality.
  const p = planClaim(withConfidence(0.99), 'recent_funding',
    { ...ctx, gates: gatesWithout(GATES, 'skills.evidence_score') });
  assert.equal(p.decision, REFUSE);
  assert.equal(p.result, NOT_VERIFIABLE);
  assert.equal(p.failed_closed, true);
});

test('two weak signals do not average into one confident claim', () => {
  // The tempting arithmetic: 0.5 from the press page plus 0.5 from a job post is
  // surely 1.0 between them. It is not. Each claim is graded on its own evidence.
  const b = brief();
  verified(b, 'recent_funding', 'a Series B', { confidence: 0.5, source: 'https://a.example/1' });
  verified(b, 'hiring_surge', 'a hiring push', { confidence: 0.5, source: 'https://a.example/2' });
  for (const field of ['recent_funding', 'hiring_surge']) {
    assert.equal(planClaim(b, field, ctx).decision, REFUSE);
  }
});
