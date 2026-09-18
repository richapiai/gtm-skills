// tests/evals/evidence-score/malformed-response.test.mjs
//
// ADVERSARIAL CASE 4: *a malformed LLM response.* It must be stored
// `ai_inferred_invalid`, never as verified, and it must not be readable as a claim.
//
// This is one of the five critical gaps the plan names as having no test AND no error
// handling AND being silent today: "non-conforming LLM response stored as verified".
// `ai_enrich`'s `output_schema` is specified as *guiding* structured output rather
// than enforcing it, so the shape is validated by the pack or it is not validated at
// all.
//
// The assertion is deliberately stronger than "it was flagged". A flagged value is
// still a value somebody renders. The requirement is that the field reads as ABSENT,
// so the grader returns not_found and no code path exists to put it in a sentence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates } from '../../../_lib/gates.mjs';
import {
  storeLlmResult, readArtifactField, STATUS_INVALID, STATUS_VALID,
} from '../../../_lib/dual-contract.mjs';
import {
  loadEvidenceRules, gradeClaim, UNSUPPORTED, NOT_FOUND, NULL_ENUM,
} from '../../skills/evidence-score/harness.mjs';
import { brief, NOW } from '../../skills/evidence-score/helpers.mjs';

const RULES = loadEvidenceRules();
const GATES = loadGates();

// What a model actually emits when it has no answer, plus the shape errors that come
// from a schema that only *guided* the output. Every one of these is a fabrication
// dressed as an answer.
const MALFORMED = [
  { label: 'a null alias as the result',    res: { result: 'N/A', confidence: 0.9, reasoning: 'r', source: 's' } },
  { label: 'an empty string',               res: { result: '', confidence: 0.9, reasoning: 'r', source: 's' } },
  { label: 'the word unknown',              res: { result: 'unknown', confidence: 0.9, reasoning: 'r', source: 's' } },
  { label: 'an empty array',                res: { result: [], confidence: 0.9, reasoning: 'r', source: 's' } },
  { label: 'a string confidence',           res: { result: 'Series B', confidence: 'high', reasoning: 'r', source: 's' } },
  { label: 'confidence out of range',       res: { result: 'Series B', confidence: 42, reasoning: 'r', source: 's' } },
  { label: 'no reasoning',                  res: { result: 'Series B', confidence: 0.9, source: 's' } },
  { label: 'no source',                     res: { result: 'Series B', confidence: 0.9, reasoning: 'r' } },
  { label: 'an extra property',             res: { result: 'Series B', confidence: 0.9, reasoning: 'r', source: 's', extra: 1 } },
  { label: 'not an object at all',          res: 'Series B, March 2026' },
];

for (const { label, res } of MALFORMED) {
  test(`a malformed response (${label}) is quarantined and grades not_found`, () => {
    const b = brief();
    const stored = storeLlmResult(b, 'recent_funding', res);

    // 1. It is stored invalid, and nothing reached `verified`.
    assert.equal(stored.status, STATUS_INVALID);
    assert.equal(stored.valid, false);
    assert.notEqual(stored.status, STATUS_VALID);
    assert.deepEqual(b.verified, {}, 'an LLM value must never enter verified');
    assert.equal(b.ai_inferred_invalid.length, 1);
    assert.equal(b.ai_inferred_invalid[0].field, 'recent_funding');
    assert.ok(b.ai_inferred_invalid[0].errors.length > 0, 'the quarantine keeps the reasons');

    // 2. It is not readable as a field AT ALL — not even as a weak one.
    assert.equal(readArtifactField(b, 'recent_funding').provenance, 'absent');
    assert.equal(readArtifactField(b, 'recent_funding').value, undefined);

    // 3. So the grader refuses it with the explicit null.
    const g = gradeClaim(b, 'recent_funding', { rules: RULES, gates: GATES, now: NOW });
    assert.equal(g.grade, UNSUPPORTED);
    assert.equal(g.null, NOT_FOUND);
    assert.ok(NULL_ENUM.includes(g.null));
    assert.equal(g.assertable, false);
    assert.equal(g.quarantined, true, 'the refusal must know it was a quarantine, not an empty brief');
    assert.deepEqual(g.reasons, ['response_quarantined_ai_inferred_invalid']);
  });
}

test('a quarantined answer cannot be rescued by asking again with the same bad shape', () => {
  const b = brief();
  storeLlmResult(b, 'recent_funding', { result: 'N/A', confidence: 0.9, reasoning: 'r', source: 's' });
  storeLlmResult(b, 'recent_funding', { result: 'unknown', confidence: 0.9, reasoning: 'r', source: 's' });
  assert.equal(b.ai_inferred_invalid.length, 2, 'both attempts are kept for the audit trail');
  assert.deepEqual(b.verified, {});
  assert.equal(gradeClaim(b, 'recent_funding', { rules: RULES, gates: GATES, now: NOW }).null, NOT_FOUND);
});

test('a WELL-formed response is stored ai_inferred — and is still not assertable', () => {
  // The contrast case. Conforming to the contract earns storage, not authority.
  const b = brief();
  const stored = storeLlmResult(b, 'recent_funding', {
    result: 'Series B, March 2026', confidence: 0.95, reasoning: 'From the press page.',
    source: 'https://acme.example/press/series-b',
  });
  assert.equal(stored.status, STATUS_VALID);
  assert.deepEqual(b.verified, {}, 'valid does not mean verified');
  assert.equal(readArtifactField(b, 'recent_funding').provenance, 'ai_inferred');
  assert.equal(gradeClaim(b, 'recent_funding', { rules: RULES, gates: GATES, now: NOW }).assertable, false);
});
