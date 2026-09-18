// tests/evals/evidence-score/low-confidence.test.mjs
//
// ADVERSARIAL CASE 2: *a fact present but low-confidence.*
//
// This is the harder half of the Iron Law. Case 1 is easy to get right — there is
// nothing in the brief, so there is nothing to write. Here the fact IS there, it is
// probably even correct, and the only thing wrong with it is that nobody could stand
// behind it. The tempting move is to round a 0.4 up to "close enough" and write the
// sentence. It must grade `weak` and return `not_verifiable`.
//
// Freshness is the same failure with a clock instead of a number: a fact that WAS true
// is not a fact that IS true, and stale evidence about a job change is how you
// congratulate somebody on a role they left in March.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates } from '../../../_lib/gates.mjs';
import {
  loadEvidenceRules, gradeClaim,
  SUPPORTED, WEAK, NOT_VERIFIABLE, NULL_ENUM,
} from '../../skills/evidence-score/harness.mjs';
import {
  brief, verified, NOW, FRESH, PINNED_GATES, gatesWithout,
} from '../../skills/evidence-score/helpers.mjs';

const RULES = loadEvidenceRules();
const GATES = loadGates();
const FLOOR = PINNED_GATES.evidence_score.emit_min_confidence;
const MAX_AGE = PINNED_GATES.evidence_score.evidence_max_age_days;

const withConfidence = (c) => verified(brief(), 'recent_funding',
  'Series B, March 2026', { confidence: c, source: 'https://acme.example/press/series-b' });

test('at the floor the claim is supported, so the refusals below are about the number', () => {
  const g = gradeClaim(withConfidence(FLOOR), 'recent_funding', { rules: RULES, gates: GATES, now: NOW });
  assert.equal(g.grade, SUPPORTED);
  assert.equal(g.null, null);
});

test('below the floor the claim is weak and returns not_verifiable — never rounded up', () => {
  for (const c of [0, 0.1, 0.4, FLOOR - 0.01]) {
    const g = gradeClaim(withConfidence(c), 'recent_funding', { rules: RULES, gates: GATES, now: NOW });
    assert.equal(g.grade, WEAK, `confidence ${c} graded ${g.grade}`);
    assert.equal(g.null, NOT_VERIFIABLE, `confidence ${c} returned ${g.null}`);
    assert.ok(NULL_ENUM.includes(g.null));
    assert.equal(g.assertable, false);
    assert.ok(g.reasons.includes('below_confidence_floor'), JSON.stringify(g.reasons));
  }
});

test('a below-floor claim is still refused when everything else about it is perfect', () => {
  // Verified provenance, a real URL as the source, fetched this week. One number is
  // wrong and that is enough — the gate is a conjunction, not a score.
  const b = verified(brief(), 'recent_funding', 'Series B, March 2026',
    { confidence: 0.55, source: 'https://reuters.example/acme-series-b', fetched_at: FRESH });
  const g = gradeClaim(b, 'recent_funding', { rules: RULES, gates: GATES, now: NOW });
  assert.equal(g.assertable, false);
  assert.equal(g.null, NOT_VERIFIABLE);
});

test('evidence older than the freshness window is weak and not_verifiable', () => {
  const stale = new Date(NOW.getTime() - (MAX_AGE + 1) * 24 * 60 * 60 * 1000).toISOString();
  const b = verified(brief(), 'job_change_recent', true,
    { source: 'https://linkedin.example/in/ada', fetched_at: stale });
  const g = gradeClaim(b, 'job_change_recent', { rules: RULES, gates: GATES, now: NOW });
  assert.equal(g.grade, WEAK);
  assert.equal(g.null, NOT_VERIFIABLE);
  assert.ok(g.reasons.includes('evidence_stale'), JSON.stringify(g.reasons));
});

test('an undated fact is STALE, not fresh — a missing timestamp is not a young one', () => {
  const b = brief();
  b.verified.job_change_recent = { value: true, source: 'https://linkedin.example/in/ada' };
  const g = gradeClaim(b, 'job_change_recent', { rules: RULES, gates: GATES, now: NOW });
  assert.equal(g.grade, WEAK);
  assert.equal(g.null, NOT_VERIFIABLE);
  assert.ok(g.reasons.includes('evidence_undated'), JSON.stringify(g.reasons));
});

test('with the shipped gates.yaml a well-evidenced claim is certified', () => {
  // The merged half, stated once so the refusal below is a contrast rather than the
  // only thing this file can demonstrate. `skills.evidence_score` is in _lib/gates.yaml
  // now, so the thresholds resolve and a 0.99 claim with a source line and a date is
  // exactly what `supported` is for.
  const b = verified(brief(), 'recent_funding', 'Series B, March 2026',
    { confidence: 0.99, source: 'https://reuters.example/acme-series-b', fetched_at: FRESH });
  const g = gradeClaim(b, 'recent_funding', { rules: RULES, gates: GATES, now: NOW });
  assert.equal(g.grade, SUPPORTED);
  assert.equal(g.assertable, true);
  assert.equal(g.failed_closed, false);
  assert.deepEqual(g.reasons, []);
});

test('a missing gate key is STOP for the check that needed it, never "no threshold"', () => {
  // Law 5, staged by DELETING the merged block rather than by the real file lacking it.
  // The keys landed, so reading the shipped file no longer stages anything; what still
  // has to hold — forever, and the reason the block is add-only — is that a lost merge
  // hunk makes this grader refuse to certify rather than certify unconditionally.
  const bare = gatesWithout(GATES, 'skills.evidence_score');
  const g = gradeClaim(withConfidence(0.99), 'recent_funding', { rules: RULES, gates: bare, now: NOW });
  assert.equal(g.assertable, false, 'a claim was certified with no threshold to certify it against');
  assert.equal(g.grade, WEAK);
  assert.equal(g.null, NOT_VERIFIABLE);
  assert.equal(g.failed_closed, true);
  assert.ok(g.reasons.some(r => r.startsWith('gate_missing:skills.evidence_score.')),
    JSON.stringify(g.reasons));
});

test('losing only the freshness key still refuses — one key at a time, not just the block', () => {
  // The block vanishing is the loud case. The quiet one is a single leaf lost to a
  // merge, which must be just as closed: a claim that clears every other check is
  // still refused when the clock it would be judged against is gone.
  const b = verified(brief(), 'recent_funding', 'Series B, March 2026',
    { confidence: 0.99, source: 'https://reuters.example/acme-series-b', fetched_at: FRESH });
  const g = gradeClaim(b, 'recent_funding', {
    rules: RULES, gates: gatesWithout(GATES, 'skills.evidence_score.evidence_max_age_days'), now: NOW,
  });
  assert.equal(g.assertable, false);
  assert.equal(g.failed_closed, true);
  assert.ok(g.reasons.includes('gate_missing:skills.evidence_score.evidence_max_age_days'),
    JSON.stringify(g.reasons));
});
