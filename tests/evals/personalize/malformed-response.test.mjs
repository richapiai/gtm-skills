// tests/evals/personalize/malformed-response.test.mjs
//
// ADVERSARIAL CASE 4: *a malformed LLM response.* It must be stored
// `ai_inferred_invalid`, never as verified — and here, at the copy layer, it must
// produce no sentence.
//
// The plan lists "non-conforming LLM response stored as verified" as one of five gaps
// with no test AND no error handling AND silent behaviour today. /personalize is where
// that gap would have been paid for: a quarantined answer that leaked through as a
// weak-but-usable value becomes a claim in an email to a stranger.
//
// The assertion chain is deliberately end to end: quarantined -> unreadable ->
// refused -> no text.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates } from '../../../_lib/gates.mjs';
import {
  storeLlmResult, readArtifactField, STATUS_INVALID,
} from '../../../_lib/dual-contract.mjs';
import {
  loadPersonalizeRules, loadEvidenceRules, planClaim, checkDraft,
  REFUSE, UNSUPPORTED, NOT_FOUND, NULL_ENUM,
} from '../../skills/personalize/harness.mjs';
import { brief, verified, NOW } from '../../skills/evidence-score/helpers.mjs';

const RULES = loadPersonalizeRules();
const EVIDENCE = loadEvidenceRules();
const GATES = loadGates();
const ctx = { rules: RULES, evidenceRules: EVIDENCE, gates: GATES, now: NOW };

const MALFORMED = [
  ['a null alias',            { result: 'N/A', confidence: 0.9, reasoning: 'r', source: 'https://a.example' }],
  ['an empty string',         { result: '', confidence: 0.9, reasoning: 'r', source: 'https://a.example' }],
  ['a string confidence',     { result: 'a Series B', confidence: 'high', reasoning: 'r', source: 'https://a.example' }],
  ['no reasoning',            { result: 'a Series B', confidence: 0.9, source: 'https://a.example' }],
  ['no source',               { result: 'a Series B', confidence: 0.9, reasoning: 'r' }],
  ['a bare string response',  'a Series B, March 2026'],
];

for (const [label, response] of MALFORMED) {
  test(`a malformed grounding response (${label}) is quarantined and writes no copy`, () => {
    const b = brief();
    const stored = storeLlmResult(b, 'recent_funding', response);

    assert.equal(stored.status, STATUS_INVALID);
    assert.deepEqual(b.verified, {}, 'an LLM value must never enter verified');
    assert.equal(b.ai_inferred_invalid.length, 1);
    assert.equal(readArtifactField(b, 'recent_funding').provenance, 'absent');

    const p = planClaim(b, 'recent_funding', ctx);
    assert.equal(p.decision, REFUSE);
    assert.equal(p.result, NOT_FOUND);
    assert.equal(p.grade, UNSUPPORTED);
    assert.ok(NULL_ENUM.includes(p.result));

    const res = checkDraft({
      template: 'Congrats on {{funding}} — big quarter.',
      slots: [{ name: 'funding', field: 'recent_funding', section: 'first_line' }],
      brief: b, ...ctx,
    });
    assert.equal(res.decision, REFUSE);
    assert.equal(res.text, null, 'a quarantined answer must not reach a rendered draft');
  });
}

test('the rules table names the quarantine, so deleting it is a red run', () => {
  assert.equal(RULES.inference.malformed_response_storage, 'ai_inferred_invalid');
  assert.equal(RULES.pre_emit.every_claim_supported, true);
  assert.equal(RULES.pre_emit.every_claim_has_source_line, true);
  assert.equal(RULES.pre_emit.no_unresolved_slots, true);
});

test('a quarantined claim does not poison the claims the brief DOES support', () => {
  // The refusal is per claim. A bad grounding call must not silently disable
  // personalisation for the whole contact, or the failure mode becomes "quietly
  // generic" instead of "reported".
  const b = brief();
  storeLlmResult(b, 'recent_funding', { result: 'N/A', confidence: 0.9, reasoning: 'r', source: 's' });
  verified(b, 'tech_stack', 'SAP', { source: 'https://acme.example/careers' });

  assert.equal(planClaim(b, 'recent_funding', ctx).result, NOT_FOUND);
  const ok = planClaim(b, 'tech_stack', ctx);
  assert.equal(ok.decision, 'emit');
  assert.equal(ok.result, 'SAP');
});
